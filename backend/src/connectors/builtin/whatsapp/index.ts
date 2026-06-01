import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import QR from 'qrcode';
import pino from 'pino';
import baileysPkg, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, type WASocket, type proto } from '@whiskeysockets/baileys';
const makeWASocket: any = (baileysPkg as any).default ?? baileysPkg;
import { Boom } from '@hapi/boom';
import type { Connector } from '../../types.js';
import { bus } from '../../../bus.js';
import { upsertPerson, findPersonByPhone } from '../people/index.js';
import { query } from '../../../db/index.js';

type Session = {
  sock: WASocket;
  status: 'starting' | 'qr' | 'connected' | 'closed';
  qr?: string;          // raw QR string
  qrDataUrl?: string;   // PNG data url
  me?: { jid: string; name?: string };
  startedAt: number;
};

const sessions = new Map<number, Session>(); // userId → session
const logger = pino({ level: 'warn' });

function sessionDir(userId: number): string {
  return path.join(os.homedir(), '.super-agent', 'wa-sessions', `u${userId}`);
}

function jidToPhone(jid: string): string {
  return jid.split('@')[0].replace(/\D/g, '');
}

export async function startWaForUser(userId: number): Promise<{ ok: boolean; status: string; error?: string }> {
  const existing = sessions.get(userId);
  if (existing) {
    // Keep alive if connected or already showing QR
    if (existing.status === 'connected' || existing.status === 'qr') {
      return { ok: true, status: existing.status };
    }
    // Force teardown if stuck in 'starting' or 'closed' — recreate
    try { existing.sock.end(undefined); } catch {}
    sessions.delete(userId);
  }
  const dir = sessionDir(userId);
  await fs.mkdir(dir, { recursive: true });
  // Detect partial / corrupt creds — if creds.json missing or registered=false but other key files present, wipe.
  try {
    const credsPath = path.join(dir, 'creds.json');
    let needsWipe = false;
    try {
      const raw = await fs.readFile(credsPath, 'utf8');
      const j = JSON.parse(raw);
      if (!j?.noiseKey || !j?.signedIdentityKey) needsWipe = true;
    } catch {
      // creds.json missing — check if other key files exist (orphan state)
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      if (entries.some((e) => e.endsWith('.json'))) needsWipe = true;
    }
    if (needsWipe) {
      console.log(`[wa:u${userId}] partial/orphan creds detected, wiping ${dir}`);
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
    }
  } catch {}
  // 60s cooldown between rapid pairing attempts — WA rate-limits and returns 401
  await new Promise((r) => setTimeout(r, 1500));
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  console.log(`[wa:u${userId}] auth state loaded, registered=${(state.creds as any)?.registered ?? false}`);
  // Pull latest supported WA Web protocol version
  let version: [number, number, number] | undefined;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version as any;
    console.log(`[wa:u${userId}] using WA version ${version?.join('.')}`);
  } catch (e) { console.warn(`[wa:u${userId}] could not fetch latest WA version`, e); }
  const sock = makeWASocket({
    auth: state,
    logger,
    version,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  } as any);
  const session: Session = { sock, status: 'starting', startedAt: Date.now() };
  sessions.set(userId, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u;
    console.log(`[wa:u${userId}] connection.update`, { connection, hasQr: !!qr, errMsg: (lastDisconnect?.error as any)?.message });
    if (qr) {
      session.status = 'qr';
      session.qr = qr;
      try {
        session.qrDataUrl = await QR.toDataURL(qr, { width: 320, margin: 1 });
      } catch {}
      bus.emit('wa:qr', { userId, qr: session.qrDataUrl });
      console.log(`[wa:u${userId}] QR ready`);
    }
    if (connection === 'open') {
      session.status = 'connected';
      session.me = { jid: sock.user?.id ?? '', name: sock.user?.name };
      bus.emit('wa:connected', { userId, jid: session.me.jid });
      console.log(`[wa:u${userId}] connected as ${session.me.jid}`);
    }
    if (connection === 'close') {
      session.status = 'closed';
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldRetry = code !== DisconnectReason.loggedOut;
      bus.emit('wa:closed', { userId, code });
      console.log(`[wa:u${userId}] closed (code=${code}, retry=${shouldRetry})`);
      sessions.delete(userId);
      if (shouldRetry) setTimeout(() => startWaForUser(userId).catch(() => {}), 3000);
    }
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    // Accept notify / append / others; dedup at DB level
    console.log(`[wa:u${userId}] messages.upsert type=${m.type} n=${m.messages?.length ?? 0}`);
    for (const msg of m.messages ?? []) {
      if (!msg.message || msg.key?.fromMe) continue;
      await ingestMessage(userId, msg).catch((e) => console.error(`[wa:u${userId}] ingest error`, e));
    }
  });

  // Initial history sync — Baileys emits this with chats/messages right after pairing
  // or after a reconnect with history flag.
  sock.ev.on('messaging-history.set', async (h: any) => {
    const { messages = [], chats = [], contacts = [] } = h as any;
    if (contacts?.length) await upsertContacts(contacts);
    // Persist chat skeletons so list isn't empty before any message
    for (const c of chats) {
      try { await upsertChatSkeleton(userId, c); } catch {}
    }
    let n = 0;
    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue;
      try { await ingestMessage(userId, msg); n++; } catch {}
    }
    console.log(`[wa:u${userId}] history sync: ${chats.length} chats, ${n} messages persisted`);
    bus.emit('wa:synced', { userId, count: n, chats: chats.length });
  });

  async function upsertContacts(items: any[]) {
    for (const c of items) {
      if (!c?.id) continue;
      const name = c.name ?? null;
      const notify = c.notify ?? null;
      const verifiedName = c.verifiedName ?? null;
      const lid = c.lid ?? null;
      try {
        await query(
          `INSERT INTO wa_contacts(user_id, jid, name, notify, verified_name, lid)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(user_id, jid) DO UPDATE SET
             name=COALESCE(EXCLUDED.name, wa_contacts.name),
             notify=COALESCE(EXCLUDED.notify, wa_contacts.notify),
             verified_name=COALESCE(EXCLUDED.verified_name, wa_contacts.verified_name),
             lid=COALESCE(EXCLUDED.lid, wa_contacts.lid),
             updated_at=now()`,
          [userId, c.id, name, notify, verifiedName, lid],
        );
        // Cross-index: store reverse so lid → pn lookup works
        if (lid && lid !== c.id) {
          try {
            await query(
              `INSERT INTO wa_contacts(user_id, jid, name, notify, verified_name)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(user_id, jid) DO UPDATE SET
                 name=COALESCE(EXCLUDED.name, wa_contacts.name),
                 notify=COALESCE(EXCLUDED.notify, wa_contacts.notify),
                 updated_at=now()`,
              [userId, lid, name, notify, verifiedName],
            );
          } catch {}
        }
      } catch {}
    }
  }

  sock.ev.on('contacts.upsert', upsertContacts);
  sock.ev.on('contacts.update', upsertContacts);

  // Group participants — fetch metadata to learn names
  async function ingestGroupMetadata(jid: string) {
    try {
      const md: any = await (sock as any).groupMetadata?.(jid);
      if (!md) return;
      // Store group as a "contact" with subject
      await upsertContacts([{ id: jid, name: md.subject, notify: md.subject }]);
      // Store each participant as contact stub (so we can resolve sender→name)
      const stubs = (md.participants ?? []).map((p: any) => ({ id: p.id, notify: p.notify ?? null }));
      if (stubs.length) await upsertContacts(stubs);
    } catch (e) { /* ignored */ }
  }

  sock.ev.on('groups.upsert', async (groups: any[]) => {
    for (const g of groups) { try { await upsertContacts([{ id: g.id, name: g.subject, notify: g.subject }]); } catch {} }
  });
  sock.ev.on('groups.update', async (groups: any[]) => {
    for (const g of groups) { if (g.id) await ingestGroupMetadata(g.id); }
  });

  sock.ev.on('chats.upsert', async (chats: any[]) => {
    for (const c of chats) {
      try { await upsertChatSkeleton(userId, c); } catch {}
    }
    if (chats.length) bus.emit('wa:synced', { userId, count: 0, chats: chats.length });
  });

  return { ok: true, status: 'starting' };
}

function extractText(m: proto.IMessage): string {
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return `[immagine] ${m.imageMessage.caption}`;
  if (m.videoMessage?.caption) return `[video] ${m.videoMessage.caption}`;
  if (m.documentMessage?.caption || m.documentMessage?.fileName) return `[file: ${m.documentMessage.fileName ?? 'document'}] ${m.documentMessage.caption ?? ''}`;
  if (m.audioMessage) return '[audio]';
  if (m.stickerMessage) return '[sticker]';
  return '';
}

async function ingestMessage(userId: number, msg: proto.IWebMessageInfo) {
  const text = extractText(msg.message!);
  const key = msg.key ?? {};
  const fromJid = key.remoteJid ?? '';
  const senderJid = key.participant ?? fromJid; // group messages
  const phone = jidToPhone(senderJid);
  const isGroup = fromJid.endsWith('@g.us');
  const pushName = msg.pushName ?? '';
  const ts = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;

  // Cache sender's pushName as contact (better than nothing for later UI resolve)
  if (pushName) {
    try {
      await query(
        `INSERT INTO wa_contacts(user_id, jid, notify)
         VALUES($1,$2,$3)
         ON CONFLICT(user_id, jid) DO UPDATE SET notify=COALESCE(EXCLUDED.notify, wa_contacts.notify), updated_at=now()`,
        [userId, senderJid, pushName],
      );
    } catch {}
  }

  // Link to existing person by phone, or create new one using pushName
  let person = await findPersonByPhone(userId, phone);
  if (!person && pushName) {
    const up = await upsertPerson(userId, { name: pushName, phones: [phone] });
    person = { slug: up.slug, name: pushName };
  }

  // DB-only persistence with explicit dedup. No brain note, no conductor forward.
  const date = new Date(ts);
  const id = key.id ?? `${ts}`;
  let inserted: { id: number } | undefined;
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO wa_messages(user_id, msg_id, chat_jid, sender_jid, sender_phone, sender_name, person_slug, is_group, group_jid, from_me, text, ts)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(user_id, msg_id) DO NOTHING
       RETURNING id::int`,
      [userId, id, fromJid, senderJid, phone, person?.name ?? pushName ?? null, person?.slug ?? null, isGroup, isGroup ? fromJid : null, false, text, date.toISOString()],
    );
    inserted = rows[0];
  } catch (e) { console.error('[wa] db insert failed', e); }

  // Skip downstream side-effects if message was already in DB (duplicate)
  if (!inserted) return;
  console.log(`[wa:u${userId}] new msg ${id} from ${senderJid} chat=${fromJid}`);

  bus.emit('wa:message', {
    userId,
    msg: {
      id, chat_jid: fromJid, sender_jid: senderJid, sender_phone: phone,
      sender_name: person?.name ?? pushName ?? phone,
      person_slug: person?.slug ?? null,
      is_group: isGroup, group_jid: isGroup ? fromJid : null,
      from_me: false, text, ts: date.toISOString(),
    },
  });
}

async function upsertChatSkeleton(userId: number, c: any) {
  const jid = c?.id;
  if (!jid || jid === 'status@broadcast') return;
  const isGroup = String(jid).endsWith('@g.us');
  const phone = isGroup ? null : jidToPhone(jid);
  const name = c?.name || c?.subject || c?.notify || null;
  let personSlug: string | null = null;
  if (!isGroup && phone) {
    const p = await findPersonByPhone(userId, phone);
    if (p) personSlug = p.slug;
  }
  const ts = c?.conversationTimestamp ? new Date(Number(c.conversationTimestamp) * 1000) : new Date(0);
  // Also push name into wa_contacts so JOINs resolve
  if (name) {
    try {
      await query(
        `INSERT INTO wa_contacts(user_id, jid, name, notify)
         VALUES($1,$2,$3,$3)
         ON CONFLICT(user_id, jid) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, wa_contacts.name),
           notify=COALESCE(EXCLUDED.notify, wa_contacts.notify),
           updated_at=now()`,
        [userId, jid, name],
      );
    } catch {}
  }
  await query(
    `INSERT INTO wa_messages(user_id, msg_id, chat_jid, sender_jid, sender_phone, sender_name, person_slug, is_group, group_jid, from_me, text, ts)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT(user_id, msg_id) DO UPDATE SET
       sender_name=COALESCE(EXCLUDED.sender_name, wa_messages.sender_name),
       person_slug=COALESCE(EXCLUDED.person_slug, wa_messages.person_slug),
       ts=GREATEST(wa_messages.ts, EXCLUDED.ts)`,
    [userId, `chat:${jid}`, jid, jid, phone, name, personSlug, isGroup, isGroup ? jid : null, false, '', ts.toISOString()],
  );
}

// Bonifica: pick N oldest unprocessed messages → spawn Claude run that classifies +
// upserts People + writes brain summary notes. Marks messages processed_at after run.
export async function bonifyWaMessages(userId: number, opts: { limit?: number; onlyChat?: string } = {}): Promise<{ ok: boolean; processed: number; runId?: number; cost?: number; error?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 5000);
  const whereChat = opts.onlyChat ? 'AND chat_jid=$3' : '';
  const params: any[] = [userId, limit];
  if (opts.onlyChat) params.push(opts.onlyChat);
  const rows = await query<any>(
    `SELECT id::int, msg_id, chat_jid, sender_jid, sender_phone, sender_name, person_slug, is_group, group_jid, text, ts
     FROM wa_messages
     WHERE user_id=$1 AND processed_at IS NULL AND msg_id NOT LIKE 'chat:%' AND text <> ''
     ${whereChat}
     ORDER BY ts ASC LIMIT $2`, params
  );
  if (rows.length === 0) return { ok: true, processed: 0 };

  bus.emit('wa:bonify', { userId, kind: 'start', total: rows.length, onlyChat: opts.onlyChat ?? null });

  const { runClaude } = await import('../../../claude/runner.js');
  const { getVaultRoot } = await import('../../../brain/vault.js');
  const { buildScheduledTaskContext } = await import('../../../claude/prompts.js');
  const sys = await buildScheduledTaskContext(userId);
  const vault = await getVaultRoot(userId);

  const batch = rows.map((r) => ({
    id: r.id,
    chat: r.chat_jid,
    sender: r.sender_name ?? r.sender_phone ?? r.sender_jid,
    phone: r.sender_phone,
    group: r.is_group,
    person_slug: r.person_slug,
    ts: r.ts,
    text: (r.text ?? '').slice(0, 800),
  }));
  const prompt = `${sys}\n\n=== BONIFICA WHATSAPP — BATCH DI ${batch.length} MESSAGGI ===\n\nDati grezzi:\n\`\`\`json\n${JSON.stringify(batch, null, 2)}\n\`\`\`\n\nFAI:\n1. Per ogni messaggio, classifica per rilevanza (skip spam, broadcast aziendali, OTP, conferme ordine, ecc.).\n2. Aggrega per persona/conversazione. Usa il tool upsert su People (tag con telefono) se manca.\n3. Per ogni persona con messaggi significativi (≥1 rilevante negli ultimi N), scrivi/aggiorna una nota markdown in \`people/<slug>.md\` con sezione "## Telegram/WhatsApp — <data>" che riassume contesto + topic + azioni richieste.\n4. NON scrivere una nota per ogni singolo messaggio. Aggrega.\n5. NON inviare nulla all'utente via Telegram. Lavora silenzioso.\n\nOUTPUT: solo \`SKIP\` (token) seguito da un riepilogo MOLTO breve (1-3 righe) di cosa hai aggiornato. NON ringraziare, NON narrare i passi.`;

  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(),
    timeoutMs: 900_000,
    kind: 'whatsapp-bonifica',
    meta: { count: batch.length, onlyChat: opts.onlyChat ?? null },
  });

  if (!res.ok) {
    bus.emit('wa:bonify', { userId, kind: 'error', total: rows.length, error: res.stderr?.slice(0, 300), onlyChat: opts.onlyChat ?? null });
    return { ok: false, processed: 0, runId: res.runId, cost: res.costUsd, error: res.stderr?.slice(0, 300) };
  }
  const ids = rows.map((r) => r.id);
  await query(`UPDATE wa_messages SET processed_at=now() WHERE user_id=$1 AND id = ANY($2::int[])`, [userId, ids]);
  bus.emit('wa:bonify', { userId, kind: 'done', processed: ids.length, runId: res.runId, cost: res.costUsd, durationMs: res.durationMs, onlyChat: opts.onlyChat ?? null });
  return { ok: true, processed: ids.length, runId: res.runId, cost: res.costUsd };
}

// Generate a draft reply using Claude + brain context. Does NOT send.
export async function suggestReply(userId: number, chatJid: string, opts: { hint?: string } = {}): Promise<{ ok: boolean; draft?: string; error?: string }> {
  const msgs = await query<any>(
    `SELECT sender_jid, sender_phone, sender_name, person_slug, is_group, from_me, text, ts
     FROM wa_messages WHERE user_id=$1 AND chat_jid=$2 AND msg_id NOT LIKE 'chat:%' AND text <> ''
     ORDER BY ts DESC LIMIT 30`, [userId, chatJid]
  );
  if (!msgs.length) return { ok: false, error: 'no messages in chat' };
  msgs.reverse();
  const last = msgs[msgs.length - 1];
  const personSlug = last.person_slug ?? msgs.find((m: any) => m.person_slug)?.person_slug;
  const senderName = last.sender_name ?? last.sender_phone ?? 'utente';

  // Pull person notes if available
  let personContext = '';
  if (personSlug) {
    try {
      const { readNote } = await import('../../../brain/vault.js');
      const note = await readNote(userId, `people/${personSlug}.md`);
      if (note?.content) personContext = note.content.slice(0, 6000);
    } catch {}
  }

  const transcript = msgs.map((m: any) =>
    `[${new Date(m.ts).toLocaleString('it-IT')}] ${m.from_me ? 'TU' : (m.sender_name ?? m.sender_phone)}: ${m.text}`
  ).join('\n');

  const { runClaude } = await import('../../../claude/runner.js');
  const { getVaultRoot } = await import('../../../brain/vault.js');
  const { buildScheduledTaskContext } = await import('../../../claude/prompts.js');
  const sys = await buildScheduledTaskContext(userId);
  const vault = await getVaultRoot(userId);

  const prompt = `${sys}\n\n=== SUGGERISCI RISPOSTA WHATSAPP ===\n\nDestinatario: ${senderName}${personSlug ? ` (slug: ${personSlug})` : ''}.\nChat JID: ${chatJid}.\n\n${personContext ? `CONTESTO PERSONA (dal second brain):\n\`\`\`\n${personContext}\n\`\`\`\n\n` : ''}TRANSCRIPT ULTIMI ${msgs.length} MESSAGGI:\n\`\`\`\n${transcript}\n\`\`\`\n\n${opts.hint ? `HINT UTENTE: ${opts.hint}\n\n` : ''}REGOLE:\n- Rispondi all'ULTIMO messaggio. Se è una domanda, rispondi alla domanda. Se è uno statement, reagisci appropriato.\n- Mirror del tone usato dall'utente nei suoi messaggi precedenti (vedi righe "TU").\n- Italiano informale ma asciutto. NO emoji a raffica. NO formattazione markdown.\n- Lunghezza simile ai messaggi precedenti dell'utente. Non scrivere papiri.\n- Se ti manca contesto critico, output solo: \`MISSING_CONTEXT: <cosa serve>\`.\n\nOUTPUT: solo il testo della risposta, NULL'ALTRO. Niente preamboli, niente "Ecco la risposta", niente quote.`;

  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(),
    timeoutMs: 120_000,
    kind: 'wa-suggest-reply',
    meta: { chatJid, personSlug },
  });
  if (!res.ok) return { ok: false, error: res.stderr?.slice(0, 300) };
  const draft = res.text.trim();
  if (!draft || /^MISSING_CONTEXT:/i.test(draft)) return { ok: false, error: draft || 'empty' };
  return { ok: true, draft };
}

export async function sendWaMessage(userId: number, chatJid: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, error: 'WhatsApp non connesso' };
  if (!text || !text.trim()) return { ok: false, error: 'empty text' };
  try {
    const sent: any = await (s.sock as any).sendMessage(chatJid, { text });
    // Persist as outgoing
    const id = sent?.key?.id ?? `${Date.now()}`;
    try {
      await query(
        `INSERT INTO wa_messages(user_id, msg_id, chat_jid, sender_jid, sender_phone, sender_name, person_slug, is_group, group_jid, from_me, text, ts, processed_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT(user_id, msg_id) DO NOTHING`,
        [userId, id, chatJid, s.me?.jid ?? '', null, 'TU', null, chatJid.endsWith('@g.us'), chatJid.endsWith('@g.us') ? chatJid : null, true, text, new Date().toISOString()],
      );
    } catch {}
    bus.emit('wa:message', {
      userId,
      msg: { id, chat_jid: chatJid, sender_jid: s.me?.jid ?? '', sender_phone: null, sender_name: 'TU', person_slug: null, is_group: chatJid.endsWith('@g.us'), group_jid: chatJid.endsWith('@g.us') ? chatJid : null, from_me: true, text, ts: new Date().toISOString() },
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 500) };
  }
}

// Toggle auto-bonify for a specific chat. Upserts wa_contacts row so flag persists
// even for chats whose contact has never been written before.
export async function setChatAutoBonify(userId: number, chatJid: string, enabled: boolean): Promise<{ ok: boolean }> {
  await query(
    `INSERT INTO wa_contacts(user_id, jid, auto_bonify, updated_at)
     VALUES($1, $2, $3, now())
     ON CONFLICT (user_id, jid) DO UPDATE SET auto_bonify=EXCLUDED.auto_bonify, updated_at=now()`,
    [userId, chatJid, !!enabled],
  );
  return { ok: true };
}

export async function pendingCount(userId: number): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM wa_messages WHERE user_id=$1 AND processed_at IS NULL AND msg_id NOT LIKE 'chat:%' AND text <> ''`, [userId]
  );
  return rows[0]?.n ?? 0;
}

export async function listChats(userId: number): Promise<any[]> {
  const rows = await query<any>(
    `WITH lid_map AS (
       SELECT jid AS pn_jid, lid FROM wa_contacts WHERE user_id=$1 AND lid IS NOT NULL
     ),
     resolved AS (
       SELECT m.*,
              COALESCE((SELECT pn_jid FROM lid_map WHERE lid = m.chat_jid), m.chat_jid) AS canonical_chat_jid,
              lower(trim(COALESCE(
                c_chat.name, c_chat.verified_name, c_chat.notify,
                c_sender.name, c_sender.verified_name, c_sender.notify,
                (SELECT pp.name FROM people pp
                  WHERE pp.user_id=$1 AND m.sender_phone IS NOT NULL AND m.sender_phone <> ''
                    AND m.sender_phone = ANY(pp.phones)
                  LIMIT 1),
                NULLIF(m.sender_name, '')
              ))) AS resolved_name
       FROM wa_messages m
       LEFT JOIN wa_contacts c_chat ON c_chat.user_id=$1 AND c_chat.jid = m.chat_jid
       LEFT JOIN wa_contacts c_sender ON c_sender.user_id=$1 AND c_sender.jid = m.sender_jid
       WHERE m.user_id=$1
     ),
     keyed AS (
       SELECT *,
              CASE
                WHEN is_group THEN canonical_chat_jid
                WHEN resolved_name IS NOT NULL AND resolved_name <> '' THEN 'name:' || resolved_name
                WHEN sender_phone IS NOT NULL AND sender_phone <> '' THEN 'phone:' || sender_phone
                ELSE 'jid:' || canonical_chat_jid
              END AS k
       FROM resolved
     ),
     last_per_chat AS (
       SELECT DISTINCT ON (k) chat_jid, sender_jid, sender_name, sender_phone, person_slug, is_group, group_jid, text, ts, k
       FROM keyed
       ORDER BY k, ts DESC
     ),
     stats AS (
       SELECT k,
              count(*) FILTER (WHERE msg_id NOT LIKE 'chat:%' AND text <> '') AS total,
              count(*) FILTER (WHERE msg_id NOT LIKE 'chat:%' AND text <> '' AND processed_at IS NOT NULL) AS bonified,
              count(*) FILTER (WHERE msg_id NOT LIKE 'chat:%' AND text <> '' AND processed_at IS NULL) AS pending
       FROM keyed GROUP BY k
     )
     SELECT l.chat_jid,
            COALESCE(
              c_chat.name, c_chat.verified_name, c_chat.notify,
              c_sender.name, c_sender.verified_name, c_sender.notify,
              (SELECT pp.name FROM people pp
                WHERE pp.user_id=$1 AND l.sender_phone IS NOT NULL AND l.sender_phone <> ''
                  AND l.sender_phone = ANY(pp.phones)
                LIMIT 1),
              NULLIF(l.sender_name, ''),
              CASE WHEN l.sender_phone IS NOT NULL AND l.sender_phone <> '' THEN '+' || l.sender_phone END
            ) AS sender_name,
            l.sender_phone, l.person_slug, l.is_group, l.text, l.ts,
            COALESCE(s.total, 0)::int AS total_count,
            COALESCE(s.bonified, 0)::int AS bonified_count,
            COALESCE(s.pending, 0)::int AS pending_count,
            COALESCE(c_chat.auto_bonify, false) AS auto_bonify
     FROM last_per_chat l
     LEFT JOIN wa_contacts c_chat ON c_chat.user_id=$1 AND c_chat.jid = l.chat_jid
     LEFT JOIN wa_contacts c_sender ON c_sender.user_id=$1 AND c_sender.jid = l.sender_jid
     LEFT JOIN stats s ON s.k = l.k`,
    [userId]
  );
  rows.sort((a: any, b: any) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return rows;
}

export async function chatMessages(userId: number, chatJid: string, limit = 200): Promise<any[]> {
  const rows = await query<any>(
    `SELECT m.id::int, m.msg_id, m.chat_jid, m.sender_jid, m.sender_phone,
            COALESCE(
              c.name, c.verified_name, c.notify,
              (SELECT pp.name FROM people pp WHERE pp.user_id=$1 AND m.sender_phone IS NOT NULL AND m.sender_phone <> '' AND m.sender_phone = ANY(pp.phones) LIMIT 1),
              NULLIF(m.sender_name, ''),
              CASE WHEN m.sender_phone IS NOT NULL AND m.sender_phone <> '' THEN '+' || m.sender_phone END
            ) AS sender_name,
            m.person_slug, m.is_group, m.group_jid, m.from_me, m.text, m.ts
     FROM wa_messages m
     LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid = m.sender_jid
     WHERE m.user_id=$1 AND m.chat_jid=$2 AND m.msg_id NOT LIKE 'chat:%'
     ORDER BY m.ts DESC LIMIT $3`,
    [userId, chatJid, limit],
  );
  return rows.reverse();
}

// Physically merge duplicate WhatsApp chats (same person across @lid + @s.whatsapp.net).
// Canonical = the JID that doesn't end with @lid; if both/neither LID, pick by ASCII order.
// Manual merge: rewrite all messages of dupJids[] to canonJid.
export async function mergeChats(userId: number, canonJid: string, dupJids: string[]): Promise<{ ok: boolean; touched: number; updatedChat: number; updatedSender: number; deletedCollisions: number }> {
  if (!dupJids.length) return { ok: true, touched: 0, updatedChat: 0, updatedSender: 0, deletedCollisions: 0 };
  console.log(`[wa:u${userId}] mergeChats canon=${canonJid} dups=${dupJids.join(',')}`);
  // Delete collisions on (user_id, msg_id)
  const del = await query<{ id: number }>(
    `DELETE FROM wa_messages a USING wa_messages b
     WHERE a.user_id=$1 AND b.user_id=$1 AND a.msg_id=b.msg_id
       AND a.chat_jid<>b.chat_jid
       AND (a.chat_jid = ANY($2::text[]) OR b.chat_jid = ANY($2::text[]) OR a.chat_jid=$3 OR b.chat_jid=$3)
       AND a.id>b.id
     RETURNING a.id::int`,
    [userId, dupJids, canonJid],
  );
  const r1 = await query<{ id: number }>(
    `UPDATE wa_messages SET chat_jid=$1 WHERE user_id=$2 AND chat_jid = ANY($3::text[]) RETURNING id::int`,
    [canonJid, userId, dupJids],
  );
  const r2 = await query<{ id: number }>(
    `UPDATE wa_messages SET sender_jid=$1 WHERE user_id=$2 AND sender_jid = ANY($3::text[]) RETURNING id::int`,
    [canonJid, userId, dupJids],
  );
  await query(
    `DELETE FROM wa_messages WHERE user_id=$1 AND msg_id LIKE 'chat:%' AND chat_jid NOT IN (
       SELECT DISTINCT chat_jid FROM wa_messages WHERE user_id=$1 AND msg_id NOT LIKE 'chat:%'
     )`,
    [userId],
  );
  const touched = r1.length + r2.length;
  console.log(`[wa:u${userId}] merge done: deleted=${del.length} updated_chat=${r1.length} updated_sender=${r2.length}`);
  return { ok: true, touched, updatedChat: r1.length, updatedSender: r2.length, deletedCollisions: del.length };
}

export async function dedupeChats(userId: number): Promise<{ merged: number }> {
  // Step 1: delete msg duplicates that would collide on (user_id, msg_id) after merge
  await query(
    `DELETE FROM wa_messages a USING wa_messages b
     WHERE a.user_id=$1 AND b.user_id=$1 AND a.msg_id=b.msg_id AND a.chat_jid<>b.chat_jid AND a.id>b.id`,
    [userId],
  );
  // Step 2: rewrite chat_jid + sender_jid using resolved name groups.
  // Resolve name from wa_contacts OR last sender_name in wa_messages.
  const res = await query<{ canon_jid: string; dup_jid: string }>(
    `WITH per_jid AS (
       SELECT m.chat_jid AS jid,
              lower(trim(COALESCE(
                c.name, c.verified_name, c.notify,
                (SELECT mm.sender_name FROM wa_messages mm
                  WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid
                    AND mm.sender_name IS NOT NULL AND mm.sender_name <> ''
                  ORDER BY mm.ts DESC LIMIT 1)
              ))) AS nm
       FROM wa_messages m
       LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid=m.chat_jid
       WHERE m.user_id=$1 AND m.is_group=false
       GROUP BY m.chat_jid, c.name, c.verified_name, c.notify
     ),
     groups AS (
       SELECT nm,
              array_agg(jid ORDER BY CASE WHEN jid LIKE '%@lid' THEN 1 ELSE 0 END, jid) AS jids
       FROM per_jid
       WHERE nm IS NOT NULL AND nm <> ''
       GROUP BY nm
       HAVING count(DISTINCT jid) > 1
     ),
     pairs AS (
       SELECT jids[1] AS canon_jid, unnest(jids[2:]) AS dup_jid FROM groups
     )
     SELECT canon_jid, dup_jid FROM pairs`,
    [userId],
  );
  console.log(`[wa:u${userId}] dedupe found ${res.length} merge pairs`);
  let merged = 0;
  for (const r of res) {
    try {
      const u1 = await query(`UPDATE wa_messages SET chat_jid=$1 WHERE user_id=$2 AND chat_jid=$3`, [r.canon_jid, userId, r.dup_jid]);
      const u2 = await query(`UPDATE wa_messages SET sender_jid=$1 WHERE user_id=$2 AND sender_jid=$3`, [r.canon_jid, userId, r.dup_jid]);
      merged += ((u1 as any)?.length ?? 0) + ((u2 as any)?.length ?? 0);
    } catch {}
  }
  // Step 3: clean any orphan skeleton chat: rows (msg_id like 'chat:%') of duplicates
  await query(
    `DELETE FROM wa_messages WHERE user_id=$1 AND msg_id LIKE 'chat:%' AND chat_jid NOT IN (
       SELECT DISTINCT chat_jid FROM wa_messages WHERE user_id=$1 AND msg_id NOT LIKE 'chat:%'
     )`,
    [userId],
  );
  return { merged };
}

export async function refreshContactsAndGroups(userId: number): Promise<{ ok: boolean; groups: number; merged?: number; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, groups: 0, error: 'WhatsApp non connesso' };
  try {
    // Fetch all groups + participants
    const all: any = await (s.sock as any).groupFetchAllParticipating?.();
    if (all && typeof all === 'object') {
      const groups = Object.values(all);
      for (const g of groups as any[]) {
        try {
          await query(
            `INSERT INTO wa_contacts(user_id, jid, name, notify)
             VALUES($1,$2,$3,$3)
             ON CONFLICT(user_id, jid) DO UPDATE SET name=COALESCE(EXCLUDED.name, wa_contacts.name), notify=COALESCE(EXCLUDED.notify, wa_contacts.notify), updated_at=now()`,
            [userId, g.id, g.subject ?? null],
          );
          for (const p of (g.participants ?? [])) {
            try {
              await query(
                `INSERT INTO wa_contacts(user_id, jid, notify)
                 VALUES($1,$2,$3)
                 ON CONFLICT(user_id, jid) DO UPDATE SET notify=COALESCE(EXCLUDED.notify, wa_contacts.notify), updated_at=now()`,
                [userId, p.id, p.notify ?? null],
              );
            } catch {}
          }
        } catch {}
      }
      const dedup = await dedupeChats(userId).catch(() => ({ merged: 0 }));
      return { ok: true, groups: (groups as any[]).length, merged: dedup.merged };
    }
    const dedup = await dedupeChats(userId).catch(() => ({ merged: 0 }));
    return { ok: true, groups: 0, merged: dedup.merged };
  } catch (e: any) {
    return { ok: false, groups: 0, error: String(e?.message ?? e) };
  }
}

export async function syncOneChat(userId: number, chatJid: string, batches = 3): Promise<{ ok: boolean; requested: number; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, requested: 0, error: 'WhatsApp non connesso' };
  let requested = 0;
  for (let i = 0; i < batches; i++) {
    const rows = await query<{ msg_id: string; ts: string }>(
      `SELECT msg_id, ts FROM wa_messages
       WHERE user_id=$1 AND chat_jid=$2 AND msg_id NOT LIKE 'chat:%'
       ORDER BY ts ASC LIMIT 1`, [userId, chatJid]
    );
    if (!rows.length) break;
    try {
      const key: any = { remoteJid: chatJid, id: rows[0].msg_id, fromMe: false };
      const ts = Math.floor(new Date(rows[0].ts).getTime() / 1000);
      await (s.sock as any).fetchMessageHistory?.(50, key, ts);
      requested++;
      await new Promise((res) => setTimeout(res, 600));
    } catch (e: any) {
      return { ok: false, requested, error: String(e?.message ?? e) };
    }
  }
  return { ok: true, requested };
}

export async function syncWaForUser(userId: number): Promise<{ ok: boolean; chats: number; requested: number; hint?: string; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, chats: 0, requested: 0, error: 'WhatsApp non connesso' };
  // Sync ALL chats — most-recent first, throttled.
  const PER_CHAT_DELAY_MS = 600;
  const rows = await query<{ chat_jid: string; msg_id: string; ts: string }>(
    `WITH oldest AS (
       SELECT DISTINCT ON (chat_jid) chat_jid, msg_id, ts
       FROM wa_messages WHERE user_id=$1 AND msg_id NOT LIKE 'chat:%'
       ORDER BY chat_jid, ts ASC
     ),
     last_activity AS (
       SELECT chat_jid, max(ts) AS last_ts FROM wa_messages
       WHERE user_id=$1 AND msg_id NOT LIKE 'chat:%'
       GROUP BY chat_jid
     )
     SELECT o.chat_jid, o.msg_id, o.ts
     FROM oldest o JOIN last_activity la USING (chat_jid)
     ORDER BY la.last_ts DESC`, [userId]
  );
  // Also refresh contacts + group participants for proper name resolution
  await refreshContactsAndGroups(userId).catch(() => {});

  let requested = 0;
  for (const r of rows) {
    try {
      const key: any = { remoteJid: r.chat_jid, id: r.msg_id, fromMe: false };
      const ts = Math.floor(new Date(r.ts).getTime() / 1000);
      await (s.sock as any).fetchMessageHistory?.(50, key, ts);
      requested++;
      await new Promise((res) => setTimeout(res, PER_CHAT_DELAY_MS));
    } catch {}
  }
  if (rows.length === 0) {
    return {
      ok: true,
      chats: 0,
      requested: 0,
      hint: 'Nessun messaggio ancora ricevuto. WhatsApp invia la cronologia automaticamente dopo l\'accoppiamento iniziale. Se hai paired da poco, attendi 1-2 min. Se è passato del tempo, vai in Connettori → Apri WhatsApp → Disconnetti e riscansiona il QR (importerà tutta la cronologia).',
    };
  }
  return { ok: true, chats: rows.length, requested };
}

export async function stopWaForUser(userId: number): Promise<void> {
  const s = sessions.get(userId);
  if (!s) return;
  try { s.sock.end(undefined); } catch {}
  sessions.delete(userId);
}

export async function logoutWaForUser(userId: number): Promise<void> {
  const s = sessions.get(userId);
  if (s) { try { await s.sock.logout(); } catch {} }
  sessions.delete(userId);
  try { await fs.rm(sessionDir(userId), { recursive: true, force: true }); } catch {}
  bus.emit('wa:closed', { userId, code: 'logout' });
}

export function getWaStatus(userId: number): { status: string; qr?: string; me?: any } {
  const s = sessions.get(userId);
  if (!s) return { status: 'idle' };
  return { status: s.status, qr: s.qrDataUrl, me: s.me };
}

const connector: Connector = {
  manifest: {
    name: 'whatsapp',
    title: 'WhatsApp (Baileys, multi-device)',
    description: 'Riceve messaggi WhatsApp via WhatsApp Web protocol. Li ingerisce nel brain e li collega alle persone via numero di telefono. Login con QR code, sessione persistente.',
    configSchema: [],
  },
  tools: [
    {
      name: 'status',
      description: 'Stato della sessione WhatsApp (idle/qr/connected).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => getWaStatus(ctx.userId),
    },
  ],
};

export default connector;
