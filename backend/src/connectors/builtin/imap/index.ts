import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, extname, sep } from 'node:path';
import os from 'node:os';
import type { Connector } from '../../types.js';
import { ingestEmail, emailBodyText } from '../../../brain/email.js';
import { bus } from '../../../bus.js';
import { query, getSetting } from '../../../db/index.js';

async function openClient(acc: Account) {
  const client = new ImapFlow({
    host: acc.host, port: Number(acc.port ?? 993), secure: true,
    auth: { user: acc.user, pass: acc.pass }, logger: false,
  });
  await client.connect();
  return client;
}

function pickAccount(accounts: Account[], label?: string): Account {
  if (label) {
    const a = accounts.find((x) => x.label === label);
    if (!a) throw new Error(`unknown account: ${label}`);
    return a;
  }
  if (!accounts.length) throw new Error('no accounts configured');
  return accounts[0];
}

type Account = {
  label: string;
  host: string;
  port?: number;
  user: string;
  pass: string;
  mailbox?: string;
  initialBacklog?: number; // how many recent messages to ingest on first run; default 0 = none
  // SMTP fields (optional). user/pass reused from IMAP unless smtpUser/smtpPass set.
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFromName?: string;
};

export type EmailDraft = {
  id: number;
  user_id: number;
  account_label: string | null;
  to_addr: string;
  cc_addr: string | null;
  bcc_addr: string | null;
  subject: string;
  body: string;
  in_reply_to: string | null;
  references_ids: string | null;
  status: 'pending' | 'approved' | 'denied' | 'sent' | 'error';
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  decided_at: string | null;
  sent_at: string | null;
  error: string | null;
  meta: any;
  created_at: string;
};

async function getAccountsForUser(userId: number): Promise<Account[]> {
  const rows = await query<{ config: any; enabled: boolean }>(
    `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='imap'`, [userId]
  );
  const row = rows[0];
  if (!row?.enabled) return [];
  return (row.config?.accounts ?? []) as Account[];
}

function smtpCreds(acc: Account) {
  // "imap.x.it" → "smtp.x.it" AND "imaps.x.it" → "smtps.x.it" (Aruba keeps s).
  const derived = acc.host.replace(/^imap(s?)\./i, 'smtp$1.');
  const host = acc.smtpHost || derived;
  const port = acc.smtpPort ?? (/^smtps\./i.test(host) ? 465 : 587);
  const secure = acc.smtpSecure ?? (port === 465);
  const user = acc.smtpUser || acc.user;
  const pass = acc.smtpPass || acc.pass;
  const fromName = acc.smtpFromName;
  return { host, port, secure, user, pass, fromName };
}

export async function sendTestEmail(userId: number, accountLabel: string): Promise<{ ok: boolean; to: string; account: string; error?: string }> {
  const accs = await getAccountsForUser(userId);
  const acc = accs.find((a) => a.label === accountLabel);
  if (!acc) throw new Error(`account ${accountLabel} not found`);
  const s = smtpCreds(acc);
  if (!s.host || !s.user || !s.pass) throw new Error('SMTP non configurato per questo account');
  const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass } });
  const from = s.fromName ? `"${s.fromName}" <${s.user}>` : s.user;
  try {
    await t.sendMail({ from, to: s.user, subject: `✅ super-agent SMTP test [${acc.label}]`, text: `Test inviato il ${new Date().toLocaleString()} dall'account ${acc.label}.\n\n— super-agent` });
    return { ok: true, to: s.user, account: acc.label };
  } catch (e: any) {
    return { ok: false, to: s.user, account: acc.label, error: String(e?.message ?? e).slice(0, 800) };
  }
}

// --- Attachment safety (defense-in-depth) -----------------------------------
// `attachments` are absolute filesystem paths. Without confinement an attacker
// (or a future client/multi-user/IDOR path) could exfiltrate any server file
// (/etc/passwd, ~/.ssh/id_rsa, the app .env / JWT secret) by emailing it out.
// isAbsolute + access() is NOT enough: it allows `..`, symlinks and secrets.
const ATTACH_MAX_COUNT = 10;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024; // 25MB/file — typical SMTP ceiling
const ATTACH_ALLOWED_EXT = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg',
  '.txt', '.md', '.csv', '.json', '.ics',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.rtf', '.zip',
]);
// Block credential/secret files even when they live inside the allowed roots.
const ATTACH_SECRET_RE = /(^|\/)\.(ssh|aws|gnupg|kube|docker|netrc)(\/|$)|(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx|asc|keystore|crt)$|id_rsa|id_ed25519|id_ecdsa|credentials(\.json)?$/i;

// Validate one attachment path; returns the resolved real path to attach.
async function assertSafeAttachment(p: string): Promise<string> {
  if (typeof p !== 'string' || !p.trim()) throw new Error('attachment path empty');
  if (!isAbsolute(p)) throw new Error(`attachment path must be absolute: ${p}`);
  let real: string;
  try { real = await realpath(p); } catch { throw new Error(`attachment not found: ${p}`); }
  // Confine to the user's home or the OS temp dir (where generated PDFs land).
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  const tmp = await realpath(os.tmpdir()).catch(() => os.tmpdir());
  const within = (root: string) => real === root || real.startsWith(root + sep);
  if (!within(home) && !within(tmp)) throw new Error(`attachment must be inside your home or temp directory: ${p}`);
  if (ATTACH_SECRET_RE.test(real)) throw new Error(`attachment looks like a secret/credential file — blocked: ${p}`);
  const ext = extname(real).toLowerCase();
  if (!ATTACH_ALLOWED_EXT.has(ext)) throw new Error(`attachment type not allowed: ${ext || '(none)'}`);
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`attachment is not a regular file: ${p}`);
  if (st.size > ATTACH_MAX_BYTES) throw new Error(`attachment too large (${(st.size / 1048576).toFixed(1)}MB > 25MB): ${p}`);
  return real;
}

async function safeAttachmentPaths(paths: string[]): Promise<string[]> {
  if (paths.length > ATTACH_MAX_COUNT) throw new Error(`too many attachments (max ${ATTACH_MAX_COUNT})`);
  return Promise.all(paths.map(assertSafeAttachment));
}
// ----------------------------------------------------------------------------

export async function createDraft(userId: number, accountLabel: string, draft: {
  to: string; cc?: string; bcc?: string; subject: string; body: string; inReplyTo?: string; references?: string; attachments?: string[];
}): Promise<EmailDraft> {
  const accs = await getAccountsForUser(userId);
  if (!accs.find((a) => a.label === accountLabel)) {
    const avail = accs.map((a) => `${a.label} (${a.user})`).join(', ') || 'nessuna casella configurata';
    throw new Error(`Casella "${accountLabel}" non configurata. Usa SOLO una di queste caselle dell'estensione email: ${avail}`);
  }
  // Store the resolved real paths so send-time reads exactly what was validated.
  const safePaths = draft.attachments?.length ? await safeAttachmentPaths(draft.attachments) : [];
  // meta column is JSONB NOT NULL — never pass null. Always serialize an
  // object (empty when there are no attachments).
  const meta = safePaths.length ? { attachments: safePaths } : {};
  const rows = await query<EmailDraft>(
    `INSERT INTO email_drafts(user_id, account_label, to_addr, cc_addr, bcc_addr, subject, body, in_reply_to, references_ids, status, meta)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10::jsonb) RETURNING *`,
    [userId, accountLabel, draft.to, draft.cc ?? null, draft.bcc ?? null, draft.subject, draft.body, draft.inReplyTo ?? null, draft.references ?? null, JSON.stringify(meta)],
  );
  const d = rows[0];
  bus.emit('email_draft:created', { userId, draft: d });
  try {
    const tg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
    if (tg?.chatId) {
      const { sendEmailDraftKeyboard } = await import('../../../telegram/bot.js');
      const sent = await sendEmailDraftKeyboard(userId, d);
      if (sent) {
        await query(`UPDATE email_drafts SET telegram_message_id=$1, telegram_chat_id=$2 WHERE id=$3`, [sent.message_id, sent.chat_id, d.id]);
      }
    }
  } catch (e: any) { console.error('[email] tg send failed', e?.message ?? e); }
  return d;
}

export async function listDrafts(userId: number, status?: string): Promise<EmailDraft[]> {
  if (status) return query<EmailDraft>(`SELECT * FROM email_drafts WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 100`, [userId, status]);
  return query<EmailDraft>(`SELECT * FROM email_drafts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]);
}

export async function getDraft(userId: number, id: number): Promise<EmailDraft | null> {
  const rows = await query<EmailDraft>(`SELECT * FROM email_drafts WHERE id=$1 AND user_id=$2`, [id, userId]);
  return rows[0] ?? null;
}

export async function denyDraft(userId: number, id: number): Promise<void> {
  await query(`UPDATE email_drafts SET status='denied', decided_at=now() WHERE id=$1 AND user_id=$2 AND status='pending'`, [id, userId]);
  bus.emit('email_draft:denied', { userId, id });
}

export async function sendDraft(userId: number, id: number): Promise<EmailDraft> {
  const d = await getDraft(userId, id);
  if (!d) throw new Error('draft not found');
  if (d.status === 'sent') return d;
  if (d.status !== 'pending' && d.status !== 'approved') throw new Error(`draft status ${d.status}`);
  if (!d.account_label) throw new Error('draft missing account_label');
  const accs = await getAccountsForUser(userId);
  const acc = accs.find((a) => a.label === d.account_label);
  if (!acc) throw new Error(`account ${d.account_label} not found`);
  const s = smtpCreds(acc);
  if (!s.host || !s.user || !s.pass) throw new Error('SMTP non configurato per questo account');
  const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass } });
  const from = s.fromName ? `"${s.fromName}" <${s.user}>` : s.user;
  const headers: Record<string, string> = {};
  if (d.in_reply_to) headers['In-Reply-To'] = d.in_reply_to;
  if (d.references_ids) headers['References'] = d.references_ids;
  // Re-validate at send time (meta is DB-stored; never trust it blindly).
  const attachmentPaths: string[] = await safeAttachmentPaths(d.meta?.attachments ?? []);
  const attachments = attachmentPaths.map((p) => ({ path: p }));
  const { logOutbound } = await import('../../../comm/outbound_log.js');
  // Auto-detect HTML: if the body contains real tags, send as text/html so it
  // renders instead of arriving as raw markup. Provide a plain-text fallback
  // (tags stripped) for clients that prefer it. Plain bodies stay text/plain.
  const looksHtml = /<\/?(?:p|div|br|a|span|table|tr|td|h[1-6]|ul|ol|li|img|b|strong|i|em|blockquote|font|style)\b[^>]*>/i.test(d.body);
  const bodyParts: any = looksHtml
    ? { html: d.body, text: d.body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim() }
    : { text: d.body };
  try {
    const info = await t.sendMail({ from, to: d.to_addr, cc: d.cc_addr ?? undefined, bcc: d.bcc_addr ?? undefined, subject: d.subject, ...bodyParts, headers, ...(attachments.length ? { attachments } : {}) });
    await query(`UPDATE email_drafts SET status='sent', sent_at=now(), decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [id]);
    bus.emit('email_draft:sent', { userId, id });
    // Persist into mail_messages (direction='out') under the account's REAL
    // sent folder so the email shows up in the /mail "Inviati" view. Without
    // this, Telegram-approved emails vanished from the client.
    try {
      const sentFolderRow = await query<{ name: string }>(
        `SELECT name FROM mail_folders WHERE user_id=$1 AND account_label=$2 AND kind='sent' LIMIT 1`,
        [userId, d.account_label],
      );
      const sentFolder = sentFolderRow[0]?.name ?? 'Sent';
      const mid = (info?.messageId ?? '').replace(/^<|>$/g, '');
      const toArr = String(d.to_addr ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const ccArr = String(d.cc_addr ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const bccArr = String(d.bcc_addr ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      await query(
        `INSERT INTO mail_messages(user_id, account_label, uid, message_id, in_reply_to, refs, thread_key,
           folder, direction, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, preview, body_text, body_html,
           raw_size, ts, seen)
         VALUES($1,$2,NULL,$3,$4,$5,$6,$7,'out',$8,$9,$10,$11,$12,$13,$14,$15,$16,0,now(),true)`,
        [
          userId, d.account_label, mid || null, d.in_reply_to ?? null, [],
          d.in_reply_to ?? mid ?? null, sentFolder,
          s.user, s.fromName ?? null, toArr, ccArr, bccArr, d.subject,
          (bodyParts.text ?? d.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 280),
          bodyParts.text ?? d.body, looksHtml ? d.body : null,
        ],
      );
      bus.emit('mail:flags', { userId });
    } catch (persistErr) { console.error('[imap:sendDraft] persist to mail_messages failed', persistErr); }
    await logOutbound({
      userId, channel: 'email', status: 'sent',
      recipient: d.to_addr, subject: d.subject, body: d.body,
      origin: 'user',
      meta: { draft_id: id, account: d.account_label, cc: d.cc_addr ?? null, bcc: d.bcc_addr ?? null, in_reply_to: d.in_reply_to ?? null, attachments: attachmentPaths.length },
    });
    return { ...d, status: 'sent', sent_at: new Date().toISOString() };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 800);
    await query(`UPDATE email_drafts SET status='error', error=$2, decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [id, msg]);
    bus.emit('email_draft:error', { userId, id, error: msg });
    await logOutbound({
      userId, channel: 'email', status: 'error',
      recipient: d.to_addr, subject: d.subject, body: d.body,
      origin: 'user', error: msg,
      meta: { draft_id: id, account: d.account_label },
    });
    throw e;
  }
}

const connector: Connector = {
  manifest: {
    name: 'imap',
    title: 'Email (IMAP + SMTP, multi-account)',
    description: 'Legge una o più caselle IMAP, ingerisce le email nel brain. Risponde via SMTP dello stesso account con human-in-the-loop su Telegram.',
    schedule: '*/5 * * * *',
    configSchema: [
      {
        key: 'accounts',
        label: 'Accounts',
        type: 'accounts' as any,
        required: true,
      },
    ],
  },
  async onTick(ctx) {
    const accounts: Account[] = ctx.config.accounts ?? [];
    if (!accounts.length) return;
    const state = { ...(ctx.state ?? {}) };
    state.lastUid = { ...(state.lastUid ?? {}) };

    for (const acc of accounts) {
      if (!acc.host || !acc.user || !acc.pass) continue;
      const lastUid: number = state.lastUid[acc.label] ?? 0;
      const client = new ImapFlow({
        host: acc.host,
        port: Number(acc.port ?? 993),
        secure: true,
        auth: { user: acc.user, pass: acc.pass },
        logger: false,
      });
      let maxUid = lastUid;
      try {
        await client.connect();
        const lock = await client.getMailboxLock(acc.mailbox || 'INBOX');
        try {
          // Strict servers (Aruba, privateemail) return BAD "Invalid messageset"
          // when the FETCH range is past UIDNEXT (no new msgs) instead of empty.
          // Resolve UIDNEXT first and bail out cleanly when there's nothing new.
          const status = await client.status(acc.mailbox || 'INBOX', { messages: true, uidNext: true });
          const uidNext = (status.uidNext ?? 1) as number;
          const totalMsgs = (status.messages ?? 0) as number;
          let range: string;
          if (lastUid > 0) {
            if (lastUid + 1 >= uidNext) { /* nothing new */ continue; }
            range = `${lastUid + 1}:*`;
          } else {
            if (totalMsgs === 0) continue;
            const backlog = Math.max(0, acc.initialBacklog ?? 0);
            const from = backlog > 0 ? Math.max(1, uidNext - backlog) : uidNext;
            if (from >= uidNext) { maxUid = uidNext - 1; continue; }
            range = `${from}:*`;
            maxUid = from - 1;
          }
          // Terzo param { uid: true } OBBLIGATORIO: senza, imapflow tratta il
          // range come NUMERI DI SEQUENZA, non UID. `range` è costruito su UID
          // (lastUid+1:*) → su server strict (Dovecot/privateemail) un seq-set
          // oltre il numero messaggi dà BAD "Invalid messageset"; su Gmail
          // matcha nulla in silenzio (polling incrementale rotto). Stesso fix
          // già presente in syncAccount.
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            if (msg.uid <= maxUid) continue;
            try {
              const parsed = await simpleParser(msg.source as Buffer);
              // (1) Persist to mail_messages + mail_attachments for the mail UI
              try {
                const { persistInbound } = await import('../../../mail/service.js');
                await persistInbound({
                  userId: ctx.userId, accountLabel: acc.label, uid: msg.uid, parsed,
                  folder: acc.mailbox || 'INBOX',
                  rawSize: (msg.source as Buffer)?.length ?? 0,
                });
              } catch (persistErr) {
                ctx.log('mail-persist-failed', { uid: msg.uid, err: String(persistErr) });
              }
              // (2) Index as brain note (existing behavior — used by agent)
              const ev = await ingestEmail({ userId: ctx.userId, accountLabel: acc.label, uid: msg.uid, parsed });
              bus.emit('connector:event', {
                userId: ctx.userId,
                connector: 'imap',
                kind: 'new-email',
                payload: { account: acc.label, ...ev },
              });
              ctx.log('ingested', { account: acc.label, uid: msg.uid, subj: ev.subj });
            } catch (e) {
              ctx.log('parse-failed', { uid: msg.uid, err: String(e) });
            }
            maxUid = Math.max(maxUid, msg.uid);
          }
        } finally { lock.release(); }
      } catch (e: any) {
        // "Command failed" is ImapFlow's default Error message — surface the
        // real server response so the user can act (wrong app password, 2FA,
        // mailbox missing, IP blocked, etc.).
        // Dig the human-readable BAD/NO text out of ImapFlow's response shape:
        // response = { tag, command, attributes: [{ type, section?, value? }] }
        let detail = '';
        try {
          const attrs = e?.response?.attributes ?? [];
          detail = JSON.stringify(attrs);
          for (const a of attrs) {
            if (a?.value && typeof a.value === 'string') detail = a.value;
            else if (Array.isArray(a)) detail = a.map((x: any) => x?.value ?? x).join(' ');
          }
        } catch {}
        ctx.log('account-error', {
          account: acc.label,
          host: acc.host,
          user: acc.user,
          err: String(e?.message ?? e),
          code: e?.code ?? null,
          response_command: e?.response?.command ?? null,
          response_detail: detail || null,
          response_raw: JSON.stringify(e?.response ?? null),
          authenticationFailed: !!e?.authenticationFailed,
        });
      } finally {
        await client.logout().catch(() => {});
      }
      state.lastUid[acc.label] = maxUid;
    }
    await ctx.saveState(state);
  },
  tools: [
    {
      name: 'list_accounts',
      description: 'List all configured email accounts (labels and addresses).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const accs: Account[] = ctx.config.accounts ?? [];
        return accs.map((a) => ({ label: a.label, user: a.user, host: a.host, mailbox: a.mailbox || 'INBOX' }));
      },
    },
    {
      name: 'fetch_recent',
      description: 'Fetch most recent N emails. If `account` is omitted AND more than one account is configured, fetches from ALL accounts and merges by date (each result is labeled with its account). If only one account exists, uses it. Pass `account` to target a specific one.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Account label. Omit to fetch from all accounts.' },
          n: { type: 'number', description: 'How many recent messages per account (1-25)', default: 5 },
          mailbox: { type: 'string', description: 'Mailbox name. Defaults to account mailbox.' },
        },
        additionalProperties: false,
      },
      handler: async (ctx, { account, n = 5, mailbox }) => {
        const accs: Account[] = ctx.config.accounts ?? [];
        if (!accs.length) throw new Error('no accounts configured');
        const targets = account ? [pickAccount(accs, account)] : accs;
        const limit = Math.min(Math.max(1, n), 25);
        const all: any[] = [];
        for (const acc of targets) {
          const client = await openClient(acc);
          try {
            const box = mailbox || acc.mailbox || 'INBOX';
            const lock = await client.getMailboxLock(box);
            try {
              const status = await client.status(box, { messages: true, uidNext: true });
              const total = (status.messages ?? 0) as number;
              if (!total) continue;
              const seq = `${Math.max(1, total - limit + 1)}:*`;
              for await (const msg of client.fetch(seq, { uid: true, source: true })) {
                const parsed = await simpleParser(msg.source as Buffer);
                const body = emailBodyText(parsed);
                all.push({
                  account: acc.label,
                  uid: msg.uid,
                  subject: parsed.subject ?? '',
                  from: parsed.from?.text ?? '',
                  to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join('; ') : parsed.to.text) : '',
                  date: (parsed.date ?? new Date()).toISOString(),
                  snippet: body.slice(0, 600),
                });
              }
            } finally { lock.release(); }
          } catch (e: any) {
            all.push({ account: acc.label, error: String(e?.message ?? e) });
          } finally { await client.logout().catch(() => {}); }
        }
        all.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
        return {
          accounts_queried: targets.map((a) => a.label),
          total_accounts: accs.length,
          messages: all.slice(0, limit * targets.length),
        };
      },
    },
    {
      name: 'get_by_uid',
      description: 'Fetch full body of a specific email by UID.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          uid: { type: 'number' },
          mailbox: { type: 'string' },
        },
        required: ['uid'],
        additionalProperties: false,
      },
      handler: async (ctx, { account, uid, mailbox }) => {
        const accs: Account[] = ctx.config.accounts ?? [];
        const acc = pickAccount(accs, account);
        const client = await openClient(acc);
        try {
          const box = mailbox || acc.mailbox || 'INBOX';
          const lock = await client.getMailboxLock(box);
          try {
            const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (!msg) return null;
            const parsed = await simpleParser(msg.source as Buffer);
            // Build attachment manifest — sized metadata only, no buffers, so
            // the agent can decide what to download via `download_attachment`.
            const attachments = (parsed.attachments ?? []).map((a, i) => ({
              index: i,
              filename: a.filename ?? `attachment-${i}`,
              content_type: a.contentType ?? 'application/octet-stream',
              size: a.size ?? (a.content ? a.content.length : 0),
              cid: a.cid ?? null,
            }));
            return {
              uid,
              subject: parsed.subject ?? '',
              from: parsed.from?.text ?? '',
              to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join('; ') : parsed.to.text) : '',
              date: (parsed.date ?? new Date()).toISOString(),
              body: emailBodyText(parsed),
              attachments,
            };
          } finally { lock.release(); }
        } finally { await client.logout().catch(() => {}); }
      },
    },
    {
      name: 'download_attachment',
      description: 'Scarica un allegato di un\'email su disco (vault attachments folder) e ritorna il path assoluto. Usa `get_by_uid` prima per scoprire `index` dell\'allegato che vuoi.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          uid: { type: 'number' },
          mailbox: { type: 'string' },
          index: { type: 'number', description: 'Indice 0-based dell\'allegato come ritornato da get_by_uid.attachments[]' },
        },
        required: ['uid', 'index'],
        additionalProperties: false,
      },
      handler: async (ctx, { account, uid, mailbox, index }) => {
        const accs: Account[] = ctx.config.accounts ?? [];
        const acc = pickAccount(accs, account);
        const client = await openClient(acc);
        try {
          const box = mailbox || acc.mailbox || 'INBOX';
          const lock = await client.getMailboxLock(box);
          try {
            const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
            if (!msg) throw new Error('email not found');
            const parsed = await simpleParser(msg.source as Buffer);
            const atts = parsed.attachments ?? [];
            const idx = Number(index);
            if (idx < 0 || idx >= atts.length) throw new Error(`attachment index ${idx} out of range (have ${atts.length})`);
            const a = atts[idx];
            const buf = a.content;
            if (!buf) throw new Error('attachment has no content buffer');

            // Resolve target dir: <vault>/attachments/<YYYY>/<MM>/<uid>-<sanitized-filename>
            const path = await import('node:path');
            const fs = await import('node:fs/promises');
            const os = await import('node:os');
            const { getVaultRoot } = await import('../../../brain/vault.js');
            const vault = await getVaultRoot(ctx.userId);
            const baseDir = vault ?? path.join(os.homedir(), 'super-agent-attachments');
            const date = parsed.date ?? new Date();
            const yyyy = String(date.getFullYear());
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const safeName = (a.filename ?? `attachment-${idx}`)
              .replace(/[^A-Za-z0-9._\- ]+/g, '_')
              .slice(0, 120);
            const dir = path.join(baseDir, 'attachments', yyyy, mm);
            await fs.mkdir(dir, { recursive: true });
            const outPath = path.join(dir, `uid${uid}-${safeName}`);
            await fs.writeFile(outPath, buf);
            return {
              ok: true,
              path: outPath,
              filename: a.filename ?? safeName,
              content_type: a.contentType ?? 'application/octet-stream',
              size: buf.length,
            };
          } finally { lock.release(); }
        } finally { await client.logout().catch(() => {}); }
      },
    },
    {
      name: 'search',
      description: 'Search an inbox by subject/from/text. Returns matching emails (uid, subject, from, date, snippet).',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string' },
          mailbox: { type: 'string' },
          subject: { type: 'string' },
          from: { type: 'string' },
          text: { type: 'string', description: 'Body or header text to match.' },
          since: { type: 'string', description: 'ISO date; only newer messages.' },
          limit: { type: 'number', default: 20 },
        },
        additionalProperties: false,
      },
      handler: async (ctx, { account, mailbox, subject, from, text, since, limit = 20 }) => {
        const accs: Account[] = ctx.config.accounts ?? [];
        const acc = pickAccount(accs, account);
        const client = await openClient(acc);
        try {
          const box = mailbox || acc.mailbox || 'INBOX';
          const lock = await client.getMailboxLock(box);
          try {
            const q: any = {};
            if (subject) q.subject = subject;
            if (from) q.from = from;
            if (text) q.body = text;
            if (since) q.since = new Date(since);
            const uids = await client.search(q, { uid: true });
            const slice = (uids as number[]).slice(-Math.min(limit, 50));
            const out: any[] = [];
            if (slice.length === 0) return out;
            for await (const msg of client.fetch(slice, { uid: true, source: true }, { uid: true })) {
              const parsed = await simpleParser(msg.source as Buffer);
              const body = emailBodyText(parsed);
              const attCount = (parsed.attachments ?? []).length;
              out.push({
                uid: msg.uid,
                subject: parsed.subject ?? '',
                from: parsed.from?.text ?? '',
                date: (parsed.date ?? new Date()).toISOString(),
                snippet: body.slice(0, 400),
                attachment_count: attCount,
                attachment_names: (parsed.attachments ?? []).map((a) => a.filename ?? '(unnamed)'),
              });
            }
            return out.reverse();
          } finally { lock.release(); }
        } finally { await client.logout().catch(() => {}); }
      },
    },
    {
      name: 'propose_reply',
      description: 'Crea una bozza email (nuova o risposta) e chiede approvazione all\'utente via Telegram (✅ Invia / ❌ Scarta). USA SEMPRE questo invece di rispondere direttamente. `account` = label dell\'account email da cui inviare (deve avere SMTP configurato). Setta `inReplyTo` al Message-ID dell\'email originale per il threading. Supporta ALLEGATI via `attachments` (path assoluti, es. un PDF appena generato). Firma con il nome dell\'utente.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Label dell\'account email da cui inviare (smtp dello stesso account).' },
          to: { type: 'string', description: 'Destinatario/i, comma-separated.' },
          cc: { type: 'string' },
          bcc: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Body plain text. Firma con il nome dell\'utente.' },
          inReplyTo: { type: 'string', description: 'Message-ID originale per il threading.' },
          references: { type: 'string', description: 'Header References (concatenazione dei Message-ID precedenti).' },
          attachments: {
            type: 'array',
            items: { type: 'string' },
            description: 'Path ASSOLUTI dei file da allegare (PDF/immagini/doc, max 5, 25MB cad., dentro home o /tmp). Verranno spediti come allegati reali.',
          },
        },
        required: ['account', 'to', 'subject', 'body'], additionalProperties: false,
      },
      handler: async (ctx, { account, ...rest }) => {
        const d = await createDraft(ctx.userId, account, rest);
        return { ok: true, draftId: d.id, status: d.status, awaitingApproval: true };
      },
    },
    {
      name: 'drafts_list',
      description: 'Lista bozze email con CORPO COMPLETO (pending = in attesa di approvazione utente). Usa per RILEGGERE/RISCRIVERE una bozza esistente: leggi qui il body, non dire mai "non riesco a recuperare la bozza".',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['pending', 'approved', 'denied', 'sent', 'error'] } },
        additionalProperties: false,
      },
      handler: async (ctx, { status }) => {
        const list = await listDrafts(ctx.userId, status);
        return list.map((d) => ({ id: d.id, account: d.account_label, to: d.to_addr, subject: d.subject, body: d.body, status: d.status, created_at: d.created_at }));
      },
    },
    {
      name: 'send_draft',
      description: 'Invia una bozza ORA (bypass approval). Usa solo se l\'utente ha esplicitamente detto "manda" / "invia ora" in chat.',
      inputSchema: {
        type: 'object',
        properties: { draftId: { type: 'number' } },
        required: ['draftId'], additionalProperties: false,
      },
      handler: async (ctx, { draftId }) => {
        try {
          const d = await sendDraft(ctx.userId, draftId);
          return { ok: true, status: d.status };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
    },
  ],
};

export default connector;
