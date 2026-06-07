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
  // First messaging-history.set after a fresh pair must wipe stale rows.
  // Set to true at session open until the first history batch arrives.
  needsHistoryWipe?: boolean;
};

const sessions = new Map<number, Session>(); // userId → session
// Baileys spams pino at level=50 for transient socket errors (stream:error
// conflict, init query timeout). They're noise — Baileys auto-reconnects.
// Setting `silent` mutes the JSON pino blobs that flooded the dev console.
const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

function sessionDir(userId: number): string {
  return path.join(os.homedir(), '.super-agent', 'wa-sessions', `u${userId}`);
}

function jidToPhone(jid: string): string {
  // Only @s.whatsapp.net jids carry the actual phone number in the prefix.
  // @lid jids hold an internal anonymous id — extracting it as "phone" was
  // creating fake numbers and double-personing the same human. Return ''
  // for non-phone jids; callers fall back to lid-mapping via wa_contacts.
  if (!jid.endsWith('@s.whatsapp.net')) return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

// Resolve the real phone from any jid: phone-jid → direct; lid-jid → look up
// the linked s.whatsapp.net jid in wa_contacts (lid column populated by
// chats.upsert + contacts.upsert).
async function resolvePhone(userId: number, jid: string): Promise<string> {
  const direct = jidToPhone(jid);
  if (direct) return direct;
  if (!jid.endsWith('@lid')) return '';
  try {
    const rows = await query<{ jid: string }>(
      `SELECT jid FROM wa_contacts WHERE user_id=$1 AND lid=$2 AND jid LIKE '%@s.whatsapp.net' LIMIT 1`,
      [userId, jid],
    );
    return rows[0] ? jidToPhone(rows[0].jid) : '';
  } catch { return ''; }
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
  // Fresh pair (no creds yet) = stale wa_messages/wa_contacts from a previous
  // pair must be wiped before the new history sync lands. Otherwise Baileys
  // assigns new @lid jids for the same person and we get duplicate chats.
  //
  // Detection must NOT use `creds.registered` alone — that flag is also false
  // on a legit returning session at process start (Baileys flips it on first
  // `connection: 'open'`). Real fresh pair: no `creds.me?.id` AND no signal
  // keys yet (`creds.noiseKey` is set after pair). Either present = returning.
  const credsAny = (state.creds as any) ?? {};
  const isFreshPair = !credsAny.me?.id && !credsAny.noiseKey;
  const session: Session = { sock, status: 'starting', startedAt: Date.now(), needsHistoryWipe: isFreshPair };
  sessions.set(userId, session);
  if (isFreshPair) console.log(`[wa:u${userId}] fresh pair detected — will wipe stale rows on first history batch`);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u: any) => {
    const { connection, lastDisconnect, qr } = u;
    // Only log meaningful transitions. Skip `undefined` updates AND the
    // "Stream Errored (conflict)" spam (means another WA client took over —
    // Baileys reconnects automatically, nothing to do).
    const errMsg = (lastDisconnect?.error as any)?.message ?? '';
    const isConflict = /conflict|replaced/i.test(errMsg);
    if ((connection || qr || lastDisconnect?.error) && !isConflict) {
      console.log(`[wa:u${userId}] connection.update`, { connection, hasQr: !!qr, errMsg });
    }
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
      // Kick the avatar refresher in the background — fills cached profile
      // pics for every contact and refreshes URLs older than 7 days. Throttled
      // to avoid 429s from WA.
      void refreshProfilePicsLoop(userId, sock).catch((e) => console.warn(`[wa:u${userId}] pic loop`, e?.message));
    }
    if (connection === 'close') {
      session.status = 'closed';
      const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldRetry = code !== DisconnectReason.loggedOut;
      bus.emit('wa:closed', { userId, code });
      // 440 = conflict (another client). Mute — Baileys auto-reconnects.
      if (code !== 440) console.log(`[wa:u${userId}] closed (code=${code}, retry=${shouldRetry})`);
      sessions.delete(userId);
      // Explicit logout = user disconnected from phone or pressed Reset.
      // Wipe local rows so next pair starts clean (no @lid duplicate stacking).
      if (code === DisconnectReason.loggedOut) {
        try {
          const dm = await query<{ c: number }>(`WITH d AS (DELETE FROM wa_messages WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS c FROM d`, [userId]);
          const dc = await query<{ c: number }>(`WITH d AS (DELETE FROM wa_contacts WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS c FROM d`, [userId]);
          console.log(`[wa:u${userId}] loggedOut wipe: ${dm[0]?.c ?? 0} messages, ${dc[0]?.c ?? 0} contacts removed`);
        } catch (e) { console.error(`[wa:u${userId}] loggedOut wipe failed`, e); }
      }
      if (shouldRetry) setTimeout(() => startWaForUser(userId).catch(() => {}), 3000);
    }
  });

  sock.ev.on('messages.upsert', async (m: any) => {
    // Accept notify / append / others; dedup at DB level
    console.log(`[wa:u${userId}] messages.upsert type=${m.type} n=${m.messages?.length ?? 0}`);
    // Defensive: if Baileys never emitted a clean `connection: 'open'` event
    // (some builds skip it) but messages are flowing, treat the session as
    // alive and start the avatar loop. Idempotent — guarded by picLoopRunning.
    if (session.status !== 'connected') {
      session.status = 'connected';
      if (!session.me?.jid && sock.user?.id) session.me = { jid: sock.user.id, name: sock.user.name };
      bus.emit('wa:connected', { userId, jid: session.me?.jid ?? '' });
      console.log(`[wa:u${userId}] connected (inferred from messages.upsert) as ${session.me?.jid ?? '?'}`);
    }
    if (!picLoopRunning.has(userId)) {
      void refreshProfilePicsLoop(userId, sock).catch((e) => console.warn(`[wa:u${userId}] pic loop`, e?.message));
    }
    for (const msg of m.messages ?? []) {
      if (!msg.message) continue;
      // Ingest from-me messages too (sent from another device while paired) so
      // the UI can show them on the right with proper styling.
      await ingestMessage(userId, msg).catch((e) => console.error(`[wa:u${userId}] ingest error`, e));
    }
  });

  // Initial history sync — Baileys emits this with chats/messages right after pairing
  // or after a reconnect with history flag.
  sock.ev.on('messaging-history.set', async (h: any) => {
    const { messages = [], chats = [], contacts = [] } = h as any;
    // First history batch after a fresh pair: nuke stale wa_messages + wa_contacts
    // so the rebuild does not stack onto old @lid jids and produce duplicate chats.
    if (session.needsHistoryWipe) {
      session.needsHistoryWipe = false;
      try {
        const dm = await query<{ c: number }>(`WITH d AS (DELETE FROM wa_messages WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS c FROM d`, [userId]);
        const dc = await query<{ c: number }>(`WITH d AS (DELETE FROM wa_contacts WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS c FROM d`, [userId]);
        console.log(`[wa:u${userId}] pre-sync wipe: ${dm[0]?.c ?? 0} messages, ${dc[0]?.c ?? 0} contacts removed`);
      } catch (e) { console.error(`[wa:u${userId}] pre-sync wipe failed`, e); }
    }
    if (contacts?.length) await upsertContacts(contacts);
    // Persist chat skeletons so list isn't empty before any message
    for (const c of chats) {
      try { await upsertChatSkeleton(userId, c); } catch {}
    }
    let n = 0;
    for (const msg of messages) {
      if (!msg?.message) continue;
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
  const fromMe = !!key.fromMe;
  const fromJid = key.remoteJid ?? '';
  // For outgoing messages, participant is empty in 1:1 chats; sender = me.
  // Use the paired-device JID so we don't write 'fromJid' as both sides.
  const session = sessions.get(userId);
  const meJid = session?.me?.jid ?? '';
  const senderJid = fromMe ? (meJid || fromJid) : (key.participant ?? fromJid);
  // Phone resolution: phone-jid direct, lid-jid → lookup map. Avoids fake
  // numbers that split the same human across multiple Person entries.
  const phone = await resolvePhone(userId, senderJid);
  const isGroup = fromJid.endsWith('@g.us');
  const pushName = fromMe ? 'TU' : (msg.pushName ?? '');
  const ts = Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;

  // Cache sender's pushName as contact (skip for own messages — no value).
  if (!fromMe && pushName) {
    try {
      await query(
        `INSERT INTO wa_contacts(user_id, jid, notify)
         VALUES($1,$2,$3)
         ON CONFLICT(user_id, jid) DO UPDATE SET notify=COALESCE(EXCLUDED.notify, wa_contacts.notify), updated_at=now()`,
        [userId, senderJid, pushName],
      );
    } catch {}
  }

  // Brain linking is now MANUAL only — the user explicitly cables a chat to
  // a Person via the UI (wa_contacts.linked_person_slug). We no longer auto-
  // upsert or auto-match by phone, so the chat list mirrors what's actually
  // on the user's phone. If a manual link already exists, reuse it.
  let person: any = null;
  if (!fromMe) {
    try {
      const linkRows = await query<{ slug: string }>(
        `SELECT linked_person_slug AS slug FROM wa_contacts
         WHERE user_id=$1 AND jid=$2 AND linked_person_slug IS NOT NULL`,
        [userId, fromJid],
      );
      if (linkRows[0]?.slug) person = { slug: linkRows[0].slug, name: null };
    } catch {}
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
      [userId, id, fromJid, senderJid, phone, person?.name ?? pushName ?? null, person?.slug ?? null, isGroup, isGroup ? fromJid : null, fromMe, text, date.toISOString()],
    );
    inserted = rows[0];
  } catch (e) { console.error('[wa] db insert failed', e); }

  // Skip downstream side-effects if message was already in DB (duplicate)
  if (!inserted) return;
  console.log(`[wa:u${userId}] new msg ${id} from ${senderJid} chat=${fromJid}`);

  bus.emit('wa:message', {
    userId,
    msg: {
      id, msg_id: id, chat_jid: fromJid, sender_jid: senderJid, sender_phone: phone,
      sender_name: person?.name ?? pushName ?? phone,
      person_slug: person?.slug ?? null,
      is_group: isGroup, group_jid: isGroup ? fromJid : null,
      from_me: fromMe, text, ts: date.toISOString(),
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

export async function sendWaMessage(userId: number, chatJid: string, text: string, origin: string = 'user', source: 'user' | 'ai' = 'user'): Promise<{ ok: boolean; error?: string }> {
  const { logOutbound } = await import('../../../comm/outbound_log.js');
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') {
    await logOutbound({ userId, channel: 'whatsapp', status: 'error', recipient: chatJid, body: text, origin, error: 'WhatsApp non connesso' });
    return { ok: false, error: 'WhatsApp non connesso' };
  }
  if (!text || !text.trim()) {
    await logOutbound({ userId, channel: 'whatsapp', status: 'error', recipient: chatJid, body: text, origin, error: 'empty text' });
    return { ok: false, error: 'empty text' };
  }
  // Resolve recipient display name for log
  let recipientName: string | null = null;
  try {
    const r = await query<{ name: string | null }>(
      `SELECT COALESCE(name, verified_name, notify) AS name FROM wa_contacts WHERE user_id=$1 AND jid=$2 LIMIT 1`,
      [userId, chatJid],
    );
    recipientName = r[0]?.name ?? null;
  } catch {}
  try {
    const sent: any = await (s.sock as any).sendMessage(chatJid, { text });
    const id = sent?.key?.id ?? `${Date.now()}`;
    try {
      await query(
        `INSERT INTO wa_messages(user_id, msg_id, chat_jid, sender_jid, sender_phone, sender_name, person_slug, is_group, group_jid, from_me, text, ts, processed_at, source)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13)
         ON CONFLICT(user_id, msg_id) DO NOTHING`,
        [userId, id, chatJid, s.me?.jid ?? '', null, 'TU', null, chatJid.endsWith('@g.us'), chatJid.endsWith('@g.us') ? chatJid : null, true, text, new Date().toISOString(), source],
      );
    } catch {}
    bus.emit('wa:message', {
      userId,
      msg: { id, msg_id: id, chat_jid: chatJid, sender_jid: s.me?.jid ?? '', sender_phone: null, sender_name: 'TU', person_slug: null, is_group: chatJid.endsWith('@g.us'), group_jid: chatJid.endsWith('@g.us') ? chatJid : null, from_me: true, text, ts: new Date().toISOString(), source },
    });
    await logOutbound({
      userId, channel: 'whatsapp', status: 'sent',
      recipient: chatJid, recipient_name: recipientName,
      body: text, origin,
      meta: { msg_id: id, is_group: chatJid.endsWith('@g.us') },
    });
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 500);
    await logOutbound({ userId, channel: 'whatsapp', status: 'error', recipient: chatJid, recipient_name: recipientName, body: text, origin, error: err });
    return { ok: false, error: err };
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
              -- Name priority: ONLY raw WA-supplied data unless the user has
              -- manually cabled this chat to a Person (linked_person_slug).
              -- No more auto phone-lookup against People — chat list mirrors
              -- what's on WhatsApp itself.
              lower(trim(COALESCE(
                NULLIF(c_chat.display_name, ''),
                NULLIF(c_sender.display_name, ''),
                (SELECT pp.name FROM people pp
                  WHERE pp.user_id=$1 AND c_chat.linked_person_slug IS NOT NULL
                    AND pp.slug = c_chat.linked_person_slug
                  LIMIT 1),
                NULLIF(c_chat.name, ''),
                NULLIF(c_sender.name, ''),
                NULLIF(c_chat.verified_name, ''),
                NULLIF(c_sender.verified_name, ''),
                NULLIF(c_chat.notify, ''),
                NULLIF(c_sender.notify, ''),
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
     -- Latest message per chat for the body preview / timestamp.
     last_per_chat AS (
       SELECT DISTINCT ON (k) chat_jid, sender_jid, sender_phone, person_slug, is_group, group_jid, text, ts, from_me, k
       FROM keyed
       ORDER BY k, ts DESC
     ),
     -- Latest INCOMING message per chat — its sender_name is what we want for
     -- the chat title (the counterpart, not yourself). Falls back to anything
     -- if there are no incoming yet.
     last_in_per_chat AS (
       SELECT DISTINCT ON (k) k, sender_name
       FROM keyed
       WHERE NOT from_me AND sender_name IS NOT NULL AND sender_name <> '' AND sender_name <> 'TU'
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
              -- User override wins (per-chat dialog).
              NULLIF(c_chat.display_name, ''),
              NULLIF(c_sender.display_name, ''),
              -- Manually-linked Person next (only if user clicked "cable").
              (SELECT pp.name FROM people pp
                WHERE pp.user_id=$1 AND c_chat.linked_person_slug IS NOT NULL
                  AND pp.slug = c_chat.linked_person_slug
                LIMIT 1),
              NULLIF(c_chat.name, ''),
              NULLIF(c_sender.name, ''),
              NULLIF(c_chat.verified_name, ''),
              NULLIF(c_sender.verified_name, ''),
              NULLIF(c_chat.notify, ''),
              NULLIF(c_sender.notify, ''),
              NULLIF(li.sender_name, ''),
              CASE WHEN l.sender_phone IS NOT NULL AND l.sender_phone <> '' THEN '+' || l.sender_phone END
            ) AS sender_name,
            COALESCE(NULLIF(c_chat.display_phone, ''), NULLIF(c_sender.display_phone, ''), l.sender_phone) AS sender_phone,
            c_chat.display_name AS display_name_override,
            c_chat.display_phone AS display_phone_override,
            l.person_slug, l.is_group, l.text, l.ts,
            COALESCE(c_chat.profile_pic_url, c_sender.profile_pic_url) AS profile_pic_url,
            c_chat.linked_person_slug AS linked_person_slug,
            COALESCE(s.total, 0)::int AS total_count,
            COALESCE(s.bonified, 0)::int AS bonified_count,
            COALESCE(s.pending, 0)::int AS pending_count,
            COALESCE(c_chat.auto_bonify, false) AS auto_bonify
     FROM last_per_chat l
     LEFT JOIN wa_contacts c_chat ON c_chat.user_id=$1 AND c_chat.jid = l.chat_jid
     LEFT JOIN wa_contacts c_sender ON c_sender.user_id=$1 AND c_sender.jid = l.sender_jid
     LEFT JOIN last_in_per_chat li ON li.k = l.k
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
            c.profile_pic_url AS sender_pic_url,
            m.person_slug, m.is_group, m.group_jid, m.from_me, m.text, m.ts, m.source
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

// Per-chat user override of displayed name + phone. Survives every WA sync
// (Baileys only writes `name`/`notify` — never these columns).
export async function setChatDisplayOverride(
  userId: number, chatJid: string,
  payload: { display_name?: string | null; display_phone?: string | null },
): Promise<{ ok: boolean }> {
  const dn = payload.display_name === undefined ? undefined : (payload.display_name?.trim() || null);
  const dp = payload.display_phone === undefined ? undefined : (payload.display_phone?.trim() || null);
  if (dn === undefined && dp === undefined) return { ok: true };
  await query(
    `INSERT INTO wa_contacts(user_id, jid, display_name, display_phone, updated_at)
     VALUES($1,$2,$3,$4, now())
     ON CONFLICT(user_id, jid) DO UPDATE SET
       display_name = COALESCE($3, wa_contacts.display_name),
       display_phone = COALESCE($4, wa_contacts.display_phone),
       updated_at = now()`,
    [userId, chatJid, dn ?? null, dp ?? null],
  );
  // Allow nulling explicitly when caller passed empty string.
  if (dn === null || dp === null) {
    await query(
      `UPDATE wa_contacts SET
         display_name = CASE WHEN $3::bool THEN NULL ELSE display_name END,
         display_phone = CASE WHEN $4::bool THEN NULL ELSE display_phone END
       WHERE user_id=$1 AND jid=$2`,
      [userId, chatJid, dn === null, dp === null],
    );
  }
  return { ok: true };
}

// Manually cable a WA chat to a Person in the brain. Pass slug=null to unlink.
export async function linkChatToPerson(userId: number, chatJid: string, slug: string | null): Promise<{ ok: boolean }> {
  console.log(`[wa:link] u${userId} chat=${chatJid} → slug=${slug ?? 'NULL'}`);
  if (slug !== null && typeof slug !== 'string') throw new Error('slug must be string or null');
  if (slug) {
    const exists = await query<{ slug: string }>(`SELECT slug FROM people WHERE user_id=$1 AND slug=$2 LIMIT 1`, [userId, slug]);
    if (!exists[0]) throw new Error(`person ${slug} not found`);
  }
  // Also CLEAR display_name override on link. A leftover display_name from a
  // previous Pencil-dialog save was overriding people.name in listChats COALESCE
  // and showing the wrong name on the chip after the user re-linked the chat.
  await query(
    `INSERT INTO wa_contacts(user_id, jid, linked_person_slug, display_name, updated_at)
     VALUES($1,$2,$3, NULL, now())
     ON CONFLICT(user_id, jid) DO UPDATE SET
       linked_person_slug=EXCLUDED.linked_person_slug,
       display_name=NULL,
       updated_at=now()`,
    [userId, chatJid, slug],
  );
  // Backfill person_slug on existing messages so brain search picks them up.
  await query(`UPDATE wa_messages SET person_slug=$1 WHERE user_id=$2 AND chat_jid=$3`, [slug, userId, chatJid]);
  // Verify what actually landed in DB — surfaces silent overwrites elsewhere.
  const verify = await query<{ linked_person_slug: string | null; display_name: string | null }>(
    `SELECT linked_person_slug, display_name FROM wa_contacts WHERE user_id=$1 AND jid=$2`,
    [userId, chatJid],
  );
  console.log(`[wa:link] post-write u${userId} chat=${chatJid} db.linked=${verify[0]?.linked_person_slug ?? 'NULL'} db.display=${verify[0]?.display_name ?? 'NULL'}`);
  return { ok: true };
}

// Nuke everything WhatsApp-side for this user. Next sync rebuilds from scratch.
// Keeps the Baileys session intact (still paired); just resets the local
// message/contact cache so duplicates and stale identities go away.
// Delete one or many chats from the local DB. Doesn't touch the WhatsApp
// session — just clears the UI representation. WA still has the chat upstream.
export async function deleteChats(userId: number, chatJids: string[]): Promise<{ ok: boolean; deleted_messages: number; deleted_contacts: number }> {
  if (!chatJids?.length) return { ok: true, deleted_messages: 0, deleted_contacts: 0 };
  const dm = await query<{ c: number }>(
    `WITH d AS (DELETE FROM wa_messages WHERE user_id=$1 AND chat_jid = ANY($2::text[]) RETURNING 1) SELECT count(*)::int AS c FROM d`,
    [userId, chatJids],
  );
  const dc = await query<{ c: number }>(
    `WITH d AS (DELETE FROM wa_contacts WHERE user_id=$1 AND jid = ANY($2::text[]) RETURNING 1) SELECT count(*)::int AS c FROM d`,
    [userId, chatJids],
  );
  return { ok: true, deleted_messages: dm[0]?.c ?? 0, deleted_contacts: dc[0]?.c ?? 0 };
}

export async function wipeAllChats(userId: number): Promise<{ ok: boolean; deleted_messages: number; deleted_contacts: number; deleted_threads: number }> {
  const m = await query<{ n: number }>(`WITH d AS (DELETE FROM wa_messages WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [userId]);
  const c = await query<{ n: number }>(`WITH d AS (DELETE FROM wa_contacts WHERE user_id=$1 RETURNING 1) SELECT count(*)::int AS n FROM d`, [userId]);
  let threads = 0;
  try {
    const r = await query<{ n: number }>(`WITH d AS (DELETE FROM ig_threads WHERE user_id=$1 AND false RETURNING 1) SELECT count(*)::int AS n FROM d`, [userId]);
    threads = r[0]?.n ?? 0;
  } catch {}
  console.log(`[wa:u${userId}] wipe: ${m[0]?.n ?? 0} msgs, ${c[0]?.n ?? 0} contacts`);
  return { ok: true, deleted_messages: m[0]?.n ?? 0, deleted_contacts: c[0]?.n ?? 0, deleted_threads: threads };
}

export async function dedupeChats(userId: number): Promise<{ merged: number; chats_merged: number; msg_dups_removed: number }> {
  // Step 1: delete msg duplicates that would collide on (user_id, msg_id) after merge
  const delRes = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM wa_messages a USING wa_messages b
       WHERE a.user_id=$1 AND b.user_id=$1 AND a.msg_id=b.msg_id AND a.chat_jid<>b.chat_jid AND a.id>b.id
       RETURNING 1
     ) SELECT count(*)::int AS n FROM d`,
    [userId],
  );
  const msgDupsRemoved = delRes[0]?.n ?? 0;
  // Step 2: cross-axis matching via union-find. Each chat gets all its
  // signals (phone, lid, name, notify, sender_name). Two chats end up in
  // the same group if they share ANY signal — not just the first. This
  // catches "different phone but same name" (lid migrations) and "same name
  // but different lid" cases that the cascade missed.
  const perJid = await query<{
    jid: string; phone: string | null;
    contact_name: string | null; contact_notify: string | null; contact_lid: string | null;
    msg_sender_name: string | null;
    person_slug: string | null;
    person_name: string | null;
    person_phones: string[] | null;
  }>(
    `WITH base AS (
       SELECT m.chat_jid AS jid,
              (SELECT mm.sender_phone FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.sender_phone IS NOT NULL AND mm.sender_phone <> ''
                 GROUP BY mm.sender_phone ORDER BY count(*) DESC LIMIT 1) AS phone,
              (SELECT mm.person_slug FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.person_slug IS NOT NULL AND mm.person_slug <> ''
                 GROUP BY mm.person_slug ORDER BY count(*) DESC LIMIT 1) AS person_slug,
              (SELECT mm.sender_name FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.sender_name IS NOT NULL AND mm.sender_name <> ''
                 GROUP BY mm.sender_name ORDER BY count(*) DESC LIMIT 1) AS msg_sender_name,
              c.name AS contact_name, c.notify AS contact_notify, c.lid AS contact_lid
       FROM wa_messages m
       LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid = m.chat_jid
       WHERE m.user_id=$1 AND m.is_group=false AND m.msg_id NOT LIKE 'chat:%'
       GROUP BY m.chat_jid, c.name, c.notify, c.lid
     )
     SELECT b.*,
            -- Cross-join with brain people: if the chat's phone is in any
            -- people.phones[], use that person's slug. Catches cases where
            -- ingestMessage missed (person_slug NULL on messages) but the
            -- person exists in the second brain.
            COALESCE(b.person_slug, p1.slug) AS person_slug_x,
            p1.name AS person_name,
            p1.phones AS person_phones
     FROM base b
     LEFT JOIN LATERAL (
       SELECT pp.slug, pp.name, pp.phones FROM people pp
       WHERE pp.user_id=$1 AND b.phone IS NOT NULL AND b.phone <> '' AND b.phone = ANY(pp.phones)
       LIMIT 1
     ) p1 ON true`,
    [userId],
  );
  // Override slug with x value
  for (const r of perJid as any[]) r.person_slug = r.person_slug_x ?? r.person_slug;

  // Union-find on jids. Bucket each signal value → list of jids. Any bucket
  // with size>1 unions all its members. Output: groups of >=2 jids.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    while (p !== (parent.get(p) ?? p)) p = parent.get(p) ?? p;
    parent.set(x, p);
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const row of perJid) parent.set(row.jid, row.jid);

  const buckets = new Map<string, string[]>();
  const push = (axis: string, value: string | null | undefined, jid: string) => {
    if (!value || !String(value).trim()) return;
    const k = `${axis}:${String(value).trim().toLowerCase()}`;
    const arr = buckets.get(k) ?? [];
    arr.push(jid);
    buckets.set(k, arr);
  };
  for (const r of perJid as any[]) {
    push('phone',  r.phone, r.jid);
    push('lid',    r.contact_lid, r.jid);
    push('name',   r.contact_name, r.jid);
    push('notify', r.contact_notify, r.jid);
    push('sname',  r.msg_sender_name, r.jid);
    // Brain-derived identity: if the chat resolves to a People entry, all
    // chats pointing at the same slug are the same human.
    push('person', r.person_slug, r.jid);
    // Person's alt phones — link chats whose phone matches ANY of the
    // person's recorded numbers (handles users with multiple WA accounts).
    if (r.person_phones && Array.isArray(r.person_phones)) {
      for (const ph of r.person_phones) push('phone', ph, r.jid);
    }
    if (r.person_name) push('pname', r.person_name, r.jid);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let i = 1; i < list.length; i++) union(list[0], list[i]);
  }
  // Materialize components → pairs (canon, dup). Canonical = non-@lid first.
  const comps = new Map<string, string[]>();
  for (const jid of perJid.map((r) => r.jid)) {
    const root = find(jid);
    const arr = comps.get(root) ?? [];
    arr.push(jid);
    comps.set(root, arr);
  }
  const res: { canon_jid: string; dup_jid: string }[] = [];
  for (const members of comps.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => {
      const aLid = a.endsWith('@lid') ? 1 : 0;
      const bLid = b.endsWith('@lid') ? 1 : 0;
      if (aLid !== bLid) return aLid - bLid;
      return a.localeCompare(b);
    });
    const canon = members[0];
    for (let i = 1; i < members.length; i++) res.push({ canon_jid: canon, dup_jid: members[i] });
  }
  console.log(`[wa:u${userId}] dedupe found ${res.length} merge pairs`);
  // Diagnostic dump — what signals do we have? If `with_key=0` then NO chat
  // has any identity signal (phone/name/lid/notify/sender_name) and we'll
  // never group anything; tells the user the contact roster is unhydrated.
  try {
    const diag = await query<any>(
      `WITH p AS (
         SELECT m.chat_jid AS jid,
                (SELECT mm.sender_phone FROM wa_messages mm
                   WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.sender_phone IS NOT NULL AND mm.sender_phone <> ''
                   GROUP BY mm.sender_phone ORDER BY count(*) DESC LIMIT 1) AS phone,
                c.name, c.notify, c.lid,
                (SELECT mm.sender_name FROM wa_messages mm
                   WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.sender_name IS NOT NULL AND mm.sender_name <> ''
                   GROUP BY mm.sender_name ORDER BY count(*) DESC LIMIT 1) AS sname
         FROM wa_messages m
         LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid = m.chat_jid
         WHERE m.user_id=$1 AND m.is_group=false AND m.msg_id NOT LIKE 'chat:%'
         GROUP BY m.chat_jid, c.name, c.notify, c.lid
       )
       SELECT count(*)::int AS chats,
              count(*) FILTER (WHERE phone IS NOT NULL AND phone <> '')::int AS with_phone,
              count(*) FILTER (WHERE lid IS NOT NULL AND lid <> '')::int   AS with_lid,
              count(*) FILTER (WHERE name IS NOT NULL AND name <> '')::int AS with_name,
              count(*) FILTER (WHERE notify IS NOT NULL AND notify <> '')::int AS with_notify,
              count(*) FILTER (WHERE sname IS NOT NULL AND sname <> '')::int   AS with_sname,
              (SELECT count(*)::int FROM wa_messages mm WHERE mm.user_id=$1 AND mm.person_slug IS NOT NULL) AS msgs_with_person,
              (SELECT count(DISTINCT person_slug)::int FROM wa_messages mm WHERE mm.user_id=$1 AND mm.person_slug IS NOT NULL) AS distinct_persons
       FROM p`,
      [userId],
    );
    console.log(`[wa:u${userId}] dedupe diagnostic:`, diag[0]);
  } catch {}
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
  return { merged, chats_merged: res.length, msg_dups_removed: msgDupsRemoved };
}

// =====================================================================
// AI-driven dedupe — when signal-based dedupe can't link two chats (e.g.
// "Matteo Zanini" vs "Titolare Rstars" with different phones) the agent
// reads the second brain + chat manifest and proposes merges with reasoning.
// =====================================================================
export async function aiDedupeChats(userId: number): Promise<{ ok: boolean; merged: number; pairs: number; touched: number; runId?: number; cost?: number; error?: string; reasoning?: string }> {
  // Build chat manifest: all 1:1 chats with name, phone, person_slug, sample text
  const chats = await query<any>(
    `WITH per_jid AS (
       SELECT m.chat_jid AS jid,
              (SELECT mm.sender_phone FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.sender_phone IS NOT NULL AND mm.sender_phone <> ''
                 GROUP BY mm.sender_phone ORDER BY count(*) DESC LIMIT 1) AS phone,
              (SELECT mm.person_slug FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND mm.person_slug IS NOT NULL
                 GROUP BY mm.person_slug ORDER BY count(*) DESC LIMIT 1) AS person_slug,
              (SELECT mm.sender_name FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND NOT mm.from_me AND mm.sender_name IS NOT NULL AND mm.sender_name <> ''
                 GROUP BY mm.sender_name ORDER BY count(*) DESC LIMIT 1) AS msg_sender_name,
              (SELECT mm.text FROM wa_messages mm
                 WHERE mm.user_id=$1 AND mm.chat_jid=m.chat_jid AND NOT mm.from_me AND mm.text <> ''
                 ORDER BY mm.ts DESC LIMIT 1) AS last_text,
              count(*)::int AS n_msgs,
              max(m.ts) AS last_ts
       FROM wa_messages m
       WHERE m.user_id=$1 AND m.is_group=false AND m.msg_id NOT LIKE 'chat:%'
       GROUP BY m.chat_jid
     )
     SELECT p.jid, p.phone, p.person_slug, p.msg_sender_name,
            substring(coalesce(p.last_text, '') for 200) AS last_text,
            p.n_msgs, p.last_ts,
            c.name AS contact_name, c.notify AS contact_notify, c.lid AS contact_lid,
            (SELECT pp.name FROM people pp WHERE pp.user_id=$1 AND p.phone = ANY(pp.phones) LIMIT 1) AS person_name,
            (SELECT pp.slug FROM people pp WHERE pp.user_id=$1 AND p.phone = ANY(pp.phones) LIMIT 1) AS resolved_slug
     FROM per_jid p
     LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid = p.jid
     WHERE p.n_msgs > 0
     ORDER BY p.n_msgs DESC
     LIMIT 400`,
    [userId],
  );
  if (chats.length < 2) return { ok: true, merged: 0, pairs: 0, touched: 0 };

  const emit = (phase: string, extra: any = {}) =>
    bus.emit('wa:ai_dedupe', { userId, phase, ts: new Date().toISOString(), ...extra });
  emit('start', { total: chats.length });

  const { runClaude } = await import('../../../claude/runner.js');
  const { getVaultRoot } = await import('../../../brain/vault.js');
  const { buildScheduledTaskContext } = await import('../../../claude/prompts.js');
  const sys = await buildScheduledTaskContext(userId);
  const vault = await getVaultRoot(userId);

  emit('manifest', { chats: chats.length });
  const manifest = chats.map((c) => ({
    jid: c.jid,
    contact_name: c.contact_name || null,
    contact_notify: c.contact_notify || null,
    msg_sender_name: c.msg_sender_name || null,
    person_name: c.person_name || null,
    person_slug: c.resolved_slug || c.person_slug || null,
    phone: c.phone || null,
    n_msgs: c.n_msgs,
    last_text: c.last_text || '',
  }));

  const prompt = `${sys}\n\n=== WHATSAPP DEDUPE AI ===\n\nHai ${manifest.length} chat WhatsApp 1:1. Alcune sono DUPLICATE: stessa persona apparsa con JID diversi (re-pair WA, migrazione @lid ↔ @s.whatsapp.net, alias business vs personale, soprannomi). Devi identificare i duplicati usando:\n\n1. Il brain (cerca con \`mcp__super_agent__agent_brain_search\` ogni volta che vedi un nome che potrebbe essere alias di un'altra persona)\n2. People in vault (slug match)\n3. Last message text (talvolta i due chat condividono stessa conversazione recente)\n4. Notify/sender_name (un negozio "Rstars" e una persona "Matteo Zanini" possono essere stessa entità → controlla brain)\n\nManifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nPER OGNI COPPIA DUPLICATA che identifichi, scegli un canonical JID (preferenza: \`@s.whatsapp.net\` su \`@lid\`; se entrambi @s.whatsapp.net, quello con più messaggi).\n\nOUTPUT FORMAT (rigorosamente JSON, NIENTE ALTRO):\n\`\`\`json\n{\n  "pairs": [\n    { "canon_jid": "...@s.whatsapp.net", "dup_jid": "...@lid", "reason": "stesso titolare Matteo Zanini (brain: people/matteo-zanini.md)" }\n  ]\n}\n\`\`\`\n\nSe NESSUN duplicato: \`{"pairs": []}\`. Solo pairs con evidenza brain o pattern testuale forte. NO guess.`;

  emit('asking_ai', { prompt_chars: prompt.length });
  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(),
    timeoutMs: 900_000,
    kind: 'wa-ai-dedupe',
    meta: { chats: manifest.length },
  });

  if (!res.ok) {
    emit('error', { error: res.stderr?.slice(0, 300) });
    return { ok: false, merged: 0, pairs: 0, touched: 0, runId: res.runId, cost: res.costUsd, error: res.stderr?.slice(0, 300) };
  }
  emit('parsing', { runId: res.runId, cost: res.costUsd });

  // Parse JSON output. Claude may wrap in fences; strip them.
  let pairs: { canon_jid: string; dup_jid: string; reason?: string }[] = [];
  let reasoning = '';
  try {
    const raw = res.text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*"pairs"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.pairs)) pairs = parsed.pairs;
    }
    reasoning = pairs.map((p) => `${p.canon_jid} ← ${p.dup_jid}${p.reason ? `: ${p.reason}` : ''}`).join('\n');
  } catch (e: any) {
    emit('error', { error: 'parse failed: ' + e.message });
    return { ok: false, merged: 0, pairs: 0, touched: 0, runId: res.runId, cost: res.costUsd, error: 'parse failed: ' + e.message };
  }
  emit('proposed', { pairs: pairs.map((p) => ({ canon: p.canon_jid, dup: p.dup_jid, reason: p.reason ?? '' })) });

  // Group dup_jids by canon and execute mergeChats per canonical.
  const groups = new Map<string, string[]>();
  for (const p of pairs) {
    if (!p.canon_jid || !p.dup_jid || p.canon_jid === p.dup_jid) continue;
    const arr = groups.get(p.canon_jid) ?? [];
    arr.push(p.dup_jid);
    groups.set(p.canon_jid, arr);
  }
  let touched = 0;
  let merged = 0;
  for (const [canon, dups] of groups) {
    emit('merging', { canon, dups });
    try {
      const r = await mergeChats(userId, canon, dups);
      touched += r.touched ?? 0;
      merged += dups.length;
      emit('merged', { canon, dups, touched: r.touched ?? 0 });
    } catch (e: any) {
      emit('merge_error', { canon, dups, error: String(e?.message ?? e).slice(0, 200) });
      console.warn('[wa:ai-dedupe] merge fail', e);
    }
  }
  emit('done', { merged, pairs: pairs.length, touched, runId: res.runId, cost: res.costUsd, durationMs: res.durationMs });
  return { ok: true, merged, pairs: pairs.length, touched, runId: res.runId, cost: res.costUsd, reasoning };
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

// =====================================================================
// Profile picture fetcher — periodically scans wa_contacts for jids whose
// pic is missing or older than STALE_AFTER and fetches a fresh URL. Throttle
// to BATCH_SIZE per cycle with INTER_REQ_MS spacing so we stay under WA's
// abuse heuristics.
// =====================================================================
const PIC_BATCH_SIZE = 30;
const PIC_INTER_REQ_MS = 250;
const PIC_LOOP_MS = 5 * 60_000;
const PIC_STALE_DAYS = 7;
const picLoopRunning = new Set<number>();

async function refreshProfilePicsLoop(userId: number, sock: any) {
  if (picLoopRunning.has(userId)) {
    console.log(`[wa:u${userId}] pic loop already running, skip`);
    return;
  }
  picLoopRunning.add(userId);
  console.log(`[wa:u${userId}] pic loop started`);
  try {
    while (sessions.get(userId)?.status === 'connected') {
      try {
        const rows = await query<{ jid: string }>(
          `SELECT jid FROM wa_contacts
           WHERE user_id=$1
             AND jid NOT LIKE '%@broadcast'
             AND (profile_pic_fetched_at IS NULL OR profile_pic_fetched_at < now() - ($2 || ' days')::interval)
           ORDER BY profile_pic_fetched_at NULLS FIRST
           LIMIT $3`,
          [userId, String(PIC_STALE_DAYS), PIC_BATCH_SIZE],
        );
        if (rows.length > 0) {
          console.log(`[wa:u${userId}] pic batch: ${rows.length} contacts to refresh`);
          let hits = 0;
          let misses = 0;
          for (const r of rows) {
            if (sessions.get(userId)?.status !== 'connected') break;
            let url: string | null = null;
            try {
              // 'image' = full-size avatar; throws if privacy denied / no pic.
              url = (await sock.profilePictureUrl(r.jid, 'image')) ?? null;
            } catch (e: any) {
              // Item-not-found / 401 are common when user hid pic from non-contacts.
              url = null;
            }
            if (url) hits++; else misses++;
            await query(
              `UPDATE wa_contacts SET profile_pic_url=$1, profile_pic_fetched_at=now() WHERE user_id=$2 AND jid=$3`,
              [url, userId, r.jid],
            );
            // Emit so frontend can refresh chat list incrementally.
            bus.emit('wa:contact_pic', { userId, jid: r.jid, url });
            await new Promise((res) => setTimeout(res, PIC_INTER_REQ_MS));
          }
          console.log(`[wa:u${userId}] pic batch done: ${hits} hits, ${misses} misses`);
        }
      } catch (e: any) { console.warn(`[wa:u${userId}] pic loop iter`, e?.message); }
      // Faster cycles when there's likely more to fetch (lots of nulls);
      // settle into slower cadence once the queue is short.
      await new Promise((res) => setTimeout(res, PIC_LOOP_MS));
    }
  } finally {
    picLoopRunning.delete(userId);
    console.log(`[wa:u${userId}] pic loop stopped`);
  }
}

// Manually force a refresh of profile pics for the current user (resets the
// fetched_at watermark so the next cycle revisits everyone).
export async function forceWaPicRefresh(userId: number): Promise<{ ok: boolean; queued: number }> {
  const r = await query<{ n: number }>(
    `WITH upd AS (
       UPDATE wa_contacts SET profile_pic_fetched_at = NULL
       WHERE user_id=$1 AND jid NOT LIKE '%@broadcast' AND jid NOT LIKE '%@lid'
       RETURNING 1
     ) SELECT count(*)::int AS n FROM upd`,
    [userId],
  );
  // If a connection exists, kick a loop iter immediately.
  const s = sessions.get(userId);
  if (s?.sock) void refreshProfilePicsLoop(userId, s.sock).catch(() => {});
  return { ok: true, queued: r[0]?.n ?? 0 };
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
    {
      name: 'list_chats',
      description: 'Lista chat WhatsApp recenti (anche NON bonificate). Ritorna jid, nome, ultimo messaggio, conteggio pending. Usa questo quando l\'utente menziona una chat o gruppo che non trovi nel brain.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Filtro substring sul nome chat (opzionale)' },
          limit: { type: 'number', default: 50 },
        },
        additionalProperties: false,
      },
      handler: async (ctx, { query: q, limit }) => {
        const all = await listChats(ctx.userId);
        const filtered = q ? all.filter((c: any) => (c.sender_name || '').toLowerCase().includes(String(q).toLowerCase())) : all;
        return filtered.slice(0, limit ?? 50).map((c: any) => ({
          chat_jid: c.chat_jid, name: c.sender_name, is_group: c.is_group,
          last_text: c.text, last_ts: c.ts,
          total: c.total_count, pending: c.pending_count, bonified: c.bonified_count,
        }));
      },
    },
    {
      name: 'chat_messages',
      description: 'Leggi messaggi raw di una specifica chat WhatsApp (anche NON bonificati). Usa dopo list_chats per trovare il jid giusto. Ritorna anche messaggi mai ingeriti nel brain.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_jid: { type: 'string' },
          limit: { type: 'number', default: 100 },
        },
        required: ['chat_jid'], additionalProperties: false,
      },
      handler: async (ctx, { chat_jid, limit }) => {
        const msgs = await chatMessages(ctx.userId, chat_jid, Math.min(Number(limit ?? 100), 500));
        return msgs.map((m: any) => ({
          ts: m.ts, sender: m.sender_name ?? m.sender_phone ?? m.sender_jid,
          from_me: m.from_me, text: m.text, person_slug: m.person_slug,
        }));
      },
    },
    {
      name: 'search_messages',
      description: 'Cerca testo full-text nei messaggi WhatsApp raw (anche NON bonificati). Usa quando l\'utente cita un messaggio specifico ma il brain non lo trova. Cerca case-insensitive su contenuto.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          since_days: { type: 'number', default: 30, description: 'Limita a ultimi N giorni' },
          limit: { type: 'number', default: 30 },
        },
        required: ['query'], additionalProperties: false,
      },
      handler: async (ctx, { query: q, since_days, limit }) => {
        const rows = await query<any>(
          `SELECT m.chat_jid,
                  COALESCE(c.name, c.verified_name, c.notify, m.sender_name) AS chat_name,
                  m.sender_name, m.sender_phone, m.from_me, m.text, m.ts, m.person_slug, m.is_group
           FROM wa_messages m
           LEFT JOIN wa_contacts c ON c.user_id=$1 AND c.jid=m.chat_jid
           WHERE m.user_id=$1
             AND m.text ILIKE $2
             AND m.ts > now() - ($3::int || ' days')::interval
             AND m.msg_id NOT LIKE 'chat:%'
           ORDER BY m.ts DESC
           LIMIT $4`,
          [ctx.userId, `%${q}%`, since_days ?? 30, Math.min(Number(limit ?? 30), 200)],
        );
        return rows;
      },
    },
    {
      name: 'send_message',
      description: 'Invia un messaggio WhatsApp a una chat. Usa SOLO quando l\'utente chiede esplicitamente di inviare qualcosa.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_jid: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_jid', 'text'], additionalProperties: false,
      },
      handler: async (ctx, { chat_jid, text }) => sendWaMessage(ctx.userId, chat_jid, text, 'agent', 'ai'),
    },
  ],
};

export default connector;
