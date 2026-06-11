// Mail client service. Persists IMAP-fetched messages to mail_messages +
// mail_attachments (on disk under MAIL_ATTACH_ROOT). Provides list/get/send
// helpers consumed by /api/mail/* routes.
//
// The pre-existing imap connector handles the raw IMAP polling + parsing. This
// service is invoked from its ingest hook so every new message gets persisted
// twice: (1) as a brain note for the agent, (2) as a row here for the UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { query } from '../db/index.js';
import { bus } from '../bus.js';

export type Account = {
  label: string;
  user: string;
  pass: string;
  host: string;
  port?: number;
  mailbox?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFromName?: string;
  signature?: string;
};

export const MAIL_ATTACH_ROOT = path.join(os.homedir(), 'super-agent-mail-attachments');

async function ensureRoot() {
  await fs.mkdir(MAIL_ATTACH_ROOT, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return (name || 'unnamed').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180);
}

export async function listAccounts(userId: number): Promise<Account[]> {
  // Don't gate on `enabled` flag — user may read/send from UI while polling
  // paused. Config presence with host+user+pass is enough.
  const rows = await query<{ config: any }>(
    `SELECT config FROM connectors WHERE user_id=$1 AND name='imap'`, [userId],
  );
  const raw = (rows[0]?.config?.accounts ?? []) as Account[];
  return raw.filter((a) => a && a.label && a.host && a.user && a.pass);
}

function pickAccount(accs: Account[], label: string): Account {
  const found = accs.find((a) => a.label === label);
  if (!found) throw new Error(`account '${label}' not configured`);
  return found;
}

function smtpCreds(acc: Account) {
  // Derive SMTP host from IMAP host: "imap.x.it" → "smtp.x.it" AND
  // "imaps.x.it" → "smtps.x.it" (Aruba-style hostnames keep the s suffix).
  const derived = acc.host.replace(/^imap(s?)\./i, 'smtp$1.');
  const host = acc.smtpHost || derived;
  // smtps.* hosts are implicit-TLS endpoints → port 465. Plain smtp.* → 587.
  const port = acc.smtpPort ?? (/^smtps\./i.test(host) ? 465 : 587);
  const secure = acc.smtpSecure ?? (port === 465);
  const user = acc.smtpUser || acc.user;
  const pass = acc.smtpPass || acc.pass;
  return { host, port, secure, user, pass, fromName: acc.smtpFromName };
}

function flattenAddrs(a: any): { name: string; address: string }[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: { name: string; address: string }[] = [];
  for (const obj of arr) for (const v of obj.value ?? []) if (v.address) out.push({ name: v.name || v.address, address: v.address.toLowerCase() });
  return out;
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 280);
}

function threadKey(parsed: ParsedMail, msgId: string, subject: string): string {
  // First try References chain root.
  const refs = (parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : []) as string[];
  if (refs.length) return refs[0];
  if (parsed.inReplyTo) return parsed.inReplyTo;
  if (msgId) return msgId;
  // Fallback: normalized subject (strips Re:/Fwd: prefixes)
  return subject.replace(/^(re|fwd|fw|i):\s*/gi, '').trim().toLowerCase().slice(0, 200);
}

// Persist an inbound IMAP message into mail_messages + mail_attachments. Idempotent
// on (user_id, account_label, uid). Returns the inserted row id (or existing).
export async function persistInbound(opts: {
  userId: number; accountLabel: string; uid: number; parsed: ParsedMail; folder?: string; rawSize?: number;
}): Promise<{ id: number; inserted: boolean }> {
  const { userId, accountLabel, uid, parsed } = opts;
  const folder = opts.folder ?? 'INBOX';
  // Skip if (user, account, uid) already stored (idempotent per folder).
  const existsUid = await query<{ id: number }>(
    `SELECT id FROM mail_messages WHERE user_id=$1 AND account_label=$2 AND uid=$3 AND folder=$4`,
    [userId, accountLabel, uid, folder],
  );
  if (existsUid[0]) return { id: existsUid[0].id, inserted: false };
  // Cross-folder dedup by RFC822 Message-ID. Gmail puts the SAME email in
  // INBOX and [Gmail]/All Mail with different UIDs — without this check the
  // user sees every message twice. Also covers Sent vs Sent Items, etc.
  const rawMid = (parsed.messageId ?? '').replace(/^<|>$/g, '');
  if (rawMid) {
    const existsMid = await query<{ id: number }>(
      `SELECT id FROM mail_messages WHERE user_id=$1 AND account_label=$2 AND message_id=$3 LIMIT 1`,
      [userId, accountLabel, rawMid],
    );
    if (existsMid[0]) return { id: existsMid[0].id, inserted: false };
  }

  const subject = parsed.subject ?? '(no subject)';
  const date = parsed.date ?? new Date();
  const from = flattenAddrs(parsed.from);
  const to = flattenAddrs(parsed.to);
  const cc = flattenAddrs(parsed.cc);
  const bcc = flattenAddrs((parsed as any).bcc);
  const bodyText = (parsed.text ?? '').trim();
  const bodyHtml = parsed.html === false ? null : (parsed.html as string | null);
  const msgId = (parsed.messageId ?? '').replace(/^<|>$/g, '');
  const inReplyTo = (parsed.inReplyTo ?? '').replace(/^<|>$/g, '') || null;
  const refsRaw = parsed.references;
  const refs: string[] = (Array.isArray(refsRaw) ? refsRaw : refsRaw ? [refsRaw] : []).map((r) => String(r).replace(/^<|>$/g, ''));
  const tk = threadKey(parsed, msgId, subject);
  const preview = previewOf(bodyText || (bodyHtml ?? ''));

  const rows = await query<{ id: number }>(
    `INSERT INTO mail_messages(user_id, account_label, uid, message_id, in_reply_to, refs, thread_key,
       folder, direction, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, preview, body_text, body_html,
       raw_size, ts, seen)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'in',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,false)
     RETURNING id`,
    [
      userId, accountLabel, uid, msgId || null, inReplyTo, refs, tk,
      folder,
      from[0]?.address ?? null,
      from[0]?.name ?? null,
      to.map((x) => x.address),
      cc.map((x) => x.address),
      bcc.map((x) => x.address),
      subject,
      preview,
      bodyText || null,
      bodyHtml || null,
      opts.rawSize ?? 0,
      date.toISOString(),
    ],
  );
  const msgRowId = rows[0].id;

  // Attachments to disk
  const atts = parsed.attachments ?? [];
  if (atts.length) {
    await ensureRoot();
    const dir = path.join(MAIL_ATTACH_ROOT, String(userId), accountLabel, String(uid));
    await fs.mkdir(dir, { recursive: true });
    for (let i = 0; i < atts.length; i++) {
      const a = atts[i];
      const fname = sanitizeFilename(a.filename || `attachment-${i}.bin`);
      const fpath = path.join(dir, `${i}-${fname}`);
      try {
        await fs.writeFile(fpath, a.content as Buffer);
        await query(
          `INSERT INTO mail_attachments(message_id, filename, content_type, size_bytes, cid, inline, path)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [msgRowId, fname, a.contentType ?? null, a.size ?? 0, a.cid ?? null, !!a.contentDisposition && a.contentDisposition === 'inline', fpath],
        );
      } catch (e) {
        console.error('[mail] att save failed', fname, e);
      }
    }
  }

  bus.emit('mail:new', { userId, id: msgRowId, account: accountLabel, subject, from: from[0]?.address ?? null });
  return { id: msgRowId, inserted: true };
}

// ---------------------------------------------------------------------------
// List + get
// ---------------------------------------------------------------------------
export async function listMessages(userId: number, opts: {
  account?: string; folder?: string; q?: string; unread?: boolean;
  limit?: number; offset?: number;
} = {}): Promise<{ rows: any[]; total: number; diag?: any }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  if (opts.account) { params.push(opts.account); where.push(`account_label=$${params.length}`); }
  // Special-case 'trash': show ONLY trashed rows regardless of imap folder.
  // Any other folder hides trashed. Pass through real IMAP folder names too.
  if (opts.folder === 'trash') {
    where.push(`trashed_at IS NOT NULL`);
  } else {
    where.push(`trashed_at IS NULL`);
    if (opts.folder) { params.push(opts.folder); where.push(`folder=$${params.length}`); }
  }
  if (opts.unread) where.push(`seen=false`);
  if (opts.q) {
    params.push('%' + opts.q + '%');
    const i = params.length;
    where.push(`(subject ILIKE $${i} OR preview ILIKE $${i} OR from_addr ILIKE $${i} OR from_name ILIKE $${i})`);
  }
  const w = `WHERE ${where.join(' AND ')}`;
  const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM mail_messages ${w}`, params);
  const rows = await query<any>(
    `SELECT m.id, m.account_label, m.uid, m.message_id, m.thread_key, m.folder, m.direction,
            m.from_addr, m.from_name, m.to_addrs, m.cc_addrs, m.subject, m.preview, m.ts,
            m.seen, m.flagged, m.starred,
            (SELECT count(*)::int FROM mail_attachments WHERE message_id=m.id) AS attach_count,
            -- Brain person link: pick a single person whose emails[] contains
            -- the from_addr. Lets the UI show a chip per list row.
            (SELECT p.slug FROM people p
              WHERE p.user_id = m.user_id AND lower(m.from_addr) = ANY(p.emails)
              LIMIT 1) AS from_person_slug,
            (SELECT p.name FROM people p
              WHERE p.user_id = m.user_id AND lower(m.from_addr) = ANY(p.emails)
              LIMIT 1) AS from_person_name
     FROM mail_messages m
     ${w}
     ORDER BY ts DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = totalRows[0]?.c ?? 0;
  // Diagnostic when zero hits — tell the UI which folder values DO have rows
  // for this account, so the user can spot mailbox-name mismatches (e.g.
  // server uses "Inbox" / "INBOX" / "[Gmail]/Inbox").
  let diag: any = undefined;
  if (total === 0 && opts.account) {
    try {
      const folderStats = await query<{ folder: string; cnt: number }>(
        `SELECT folder, count(*)::int AS cnt
         FROM mail_messages
         WHERE user_id=$1 AND account_label=$2 AND trashed_at IS NULL
         GROUP BY folder ORDER BY cnt DESC LIMIT 20`,
        [userId, opts.account],
      );
      const accTotal = await query<{ c: number }>(
        `SELECT count(*)::int AS c FROM mail_messages WHERE user_id=$1 AND account_label=$2 AND trashed_at IS NULL`,
        [userId, opts.account],
      );
      diag = {
        appliedFolder: opts.folder ?? null,
        accountTotal: accTotal[0]?.c ?? 0,
        folders: folderStats,
      };
    } catch {}
  }
  return { rows, total, diag };
}

// Get all messages in a thread, ordered chronologically (oldest first) so
// the UI can render a Spark/Gmail-style conversation stack.
export async function getThread(userId: number, threadKey: string): Promise<any[]> {
  const rows = await query<any>(
    `SELECT m.*, COALESCE(
       (SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes, 'inline', a.inline, 'cid', a.cid))
        FROM mail_attachments a WHERE a.message_id=m.id),
       '[]'::json) AS attachments
     FROM mail_messages m
     WHERE m.user_id=$1 AND m.thread_key=$2 AND m.trashed_at IS NULL
     ORDER BY m.ts ASC`,
    [userId, threadKey],
  );
  // Mark every unread message in the thread as seen
  const unread = rows.filter((r: any) => !r.seen).map((r: any) => r.id);
  if (unread.length) {
    await query(`UPDATE mail_messages SET seen=true WHERE id = ANY($1::bigint[])`, [unread]).catch(() => {});
    bus.emit('mail:flags', { userId, ids: unread, seen: true });
  }
  return rows;
}

export async function getMessage(userId: number, id: number): Promise<any | null> {
  const rows = await query<any>(
    `SELECT m.*, COALESCE(
       (SELECT json_agg(json_build_object('id', a.id, 'filename', a.filename, 'content_type', a.content_type, 'size_bytes', a.size_bytes, 'inline', a.inline, 'cid', a.cid))
        FROM mail_attachments a WHERE a.message_id=m.id),
       '[]'::json) AS attachments
     FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2`,
    [userId, id],
  );
  if (!rows[0]) return null;
  // Mark seen on open (idempotent)
  if (!rows[0].seen) {
    await query(`UPDATE mail_messages SET seen=true WHERE id=$1`, [id]).catch(() => {});
    bus.emit('mail:flags', { userId, id, seen: true });
  }
  return rows[0];
}

export async function getAttachment(userId: number, id: number): Promise<{ path: string; filename: string; content_type: string | null } | null> {
  const rows = await query<{ path: string; filename: string; content_type: string | null }>(
    `SELECT a.path, a.filename, a.content_type
     FROM mail_attachments a
     JOIN mail_messages m ON m.id = a.message_id
     WHERE m.user_id=$1 AND a.id=$2`, [userId, id],
  );
  return rows[0] ?? null;
}

export async function setFlags(userId: number, id: number, patch: { seen?: boolean; flagged?: boolean; starred?: boolean }): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v); sets.push(`${k}=$${params.length}`);
  }
  if (!sets.length) return;
  params.push(userId, id);
  await query(`UPDATE mail_messages SET ${sets.join(', ')} WHERE user_id=$${params.length - 1} AND id=$${params.length}`, params);
  // Notify the UI so the sidebar unread badge refreshes immediately.
  if (patch.seen !== undefined) bus.emit('mail:flags', { userId, id, seen: patch.seen });
}

export async function trashMessage(userId: number, id: number): Promise<void> {
  await query(`UPDATE mail_messages SET trashed_at=now() WHERE user_id=$1 AND id=$2`, [userId, id]);
}

// ---------------------------------------------------------------------------
// Send via SMTP
// ---------------------------------------------------------------------------
export async function sendMail(userId: number, opts: {
  accountLabel: string;
  to: string;        // comma-separated
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: { filename: string; path?: string; content?: Buffer; contentType?: string }[];
}): Promise<{ ok: boolean; messageId?: string; error?: string; id?: number }> {
  const accs = await listAccounts(userId);
  if (!accs.length) return { ok: false, error: 'nessun account email configurato' };
  const acc = pickAccount(accs, opts.accountLabel);
  const s = smtpCreds(acc);
  const transporter = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    auth: { user: s.user, pass: s.pass },
  });
  const from = s.fromName ? `${s.fromName} <${s.user}>` : s.user;
  // Defensive address sanitize — strip wrapping parens/brackets/quotes the UI
  // or pasted text may leak in ("addr@x.it)" → SMTP 550 invalid address).
  const sanitizeAddrs = (v?: string): string | undefined => {
    if (!v) return undefined;
    const out = v.split(',').map((x) => {
      const t = x.trim().replace(/^[\s<(\["']+|[\s>)\]"',;.]+$/g, '');
      const m = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      return m ? m[0] : t;
    }).filter(Boolean);
    return out.length ? out.join(', ') : undefined;
  };
  const toClean = sanitizeAddrs(opts.to) ?? '';
  const ccClean = sanitizeAddrs(opts.cc);
  const bccClean = sanitizeAddrs(opts.bcc);
  const headers: Record<string, string> = {};
  if (opts.inReplyTo) headers['In-Reply-To'] = `<${opts.inReplyTo}>`;
  if (opts.references?.length) headers['References'] = opts.references.map((r) => `<${r}>`).join(' ');
  try {
    const info = await transporter.sendMail({
      from,
      to: toClean,
      cc: ccClean,
      bcc: bccClean,
      subject: opts.subject,
      text: opts.body,
      html: opts.html,
      headers,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        path: a.path,
        content: a.content,
        contentType: a.contentType,
      })),
    });
    // Persist in mail_messages as 'out' — file it under the account's REAL
    // sent folder name (e.g. "INBOX.Sent", "[Gmail]/Posta inviata") so the
    // UI "Inviati" filter (which queries that exact name) finds it.
    const sentFolderRow = await query<{ name: string }>(
      `SELECT name FROM mail_folders WHERE user_id=$1 AND account_label=$2 AND kind='sent' LIMIT 1`,
      [userId, acc.label],
    ).catch(() => [] as { name: string }[]);
    const sentFolder = sentFolderRow[0]?.name ?? 'Sent';
    const toArr = toClean.split(',').map((x) => x.trim()).filter(Boolean);
    const ccArr = (ccClean ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const bccArr = (bccClean ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const mid = (info.messageId ?? '').replace(/^<|>$/g, '');
    const rows = await query<{ id: number }>(
      `INSERT INTO mail_messages(user_id, account_label, uid, message_id, in_reply_to, refs, thread_key,
         folder, direction, from_addr, from_name, to_addrs, cc_addrs, bcc_addrs, subject, preview, body_text, body_html,
         raw_size, ts, seen)
       VALUES($1,$2,NULL,$3,$4,$5,$6,$16,'out',$7,$8,$9,$10,$11,$12,$13,$14,$15,0,now(),true)
       RETURNING id`,
      [
        userId, acc.label, mid || null, opts.inReplyTo ?? null, opts.references ?? [], opts.inReplyTo ?? mid ?? null,
        s.user, s.fromName ?? null, toArr, ccArr, bccArr, opts.subject, previewOf(opts.body), opts.body, opts.html ?? null,
        sentFolder,
      ],
    );
    return { ok: true, messageId: mid, id: rows[0]?.id };
  } catch (e: any) {
    // Log the FULL nodemailer payload so we can spot creds / DNS / port
    // problems in the backend console instead of guessing from a generic
    // 400 in the browser.
    console.error('[mail:sendMail] FAIL', {
      account: opts.accountLabel,
      to: opts.to,
      smtpHost: s.host,
      smtpPort: s.port,
      smtpSecure: s.secure,
      err: e?.message ?? e,
      code: e?.code,
      response: e?.response,
      responseCode: e?.responseCode,
      command: e?.command,
    });
    return {
      ok: false,
      error: e?.code
        ? `${e.code} — ${e?.response ?? e?.message ?? e}`
        : String(e?.message ?? e),
    };
  }
}

// ---------------------------------------------------------------------------
// Folder discovery — enumerate IMAP folders/labels for an account.
// Maps the special-use flags (`\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\All`)
// to a stable kind so the UI can group them sanely. Anything else (user
// labels, sub-mailboxes) returns kind='custom'.
// ---------------------------------------------------------------------------
export type Folder = { name: string; label: string; kind: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'all' | 'custom'; subscribed: boolean };

function folderKindFor(spec: any): Folder['kind'] {
  const flags: string[] = spec?.specialUse ? [String(spec.specialUse)] : [];
  // ImapFlow may also expose specialUseSource / role
  const role = spec?.role ?? '';
  const all = `${flags.join(' ')} ${role}`.toLowerCase();
  if (all.includes('inbox')) return 'inbox';
  if (all.includes('sent')) return 'sent';
  if (all.includes('drafts')) return 'drafts';
  if (all.includes('trash')) return 'trash';
  if (all.includes('junk') || all.includes('spam')) return 'junk';
  if (all.includes('archive')) return 'archive';
  if (all.includes('all')) return 'all';
  const name = String(spec?.path ?? spec?.name ?? '').toLowerCase();
  if (name === 'inbox') return 'inbox';
  if (name.includes('sent') || name.includes('inviati')) return 'sent';
  if (name.includes('draft') || name.includes('bozze')) return 'drafts';
  if (name.includes('trash') || name.includes('cestino') || name.includes('deleted')) return 'trash';
  if (name.includes('spam') || name.includes('junk') || name.includes('posta indesiderata')) return 'junk';
  if (name.includes('archive') || name.includes('archivio')) return 'archive';
  return 'custom';
}

// Folders are persisted in `mail_folders`. Reads are pure SQL = instant.
// We trigger a background IMAP refresh when the stored rows are older than
// FOLDER_STALE_MS so the user sees up-to-date labels without ever waiting.
const FOLDER_STALE_MS = 30 * 60_000;                  // 30min freshness target
const refreshingFolders = new Set<string>();          // per user+account in-flight guard
const folderKey = (uid: number, label: string) => `${uid}:${label}`;

async function fetchFoldersLive(acc: Account): Promise<{ ok: boolean; folders: Folder[]; error?: string }> {
  const client = new ImapFlow({ host: acc.host, port: acc.port ?? 993, secure: true, auth: { user: acc.user, pass: acc.pass }, logger: false });
  try {
    await client.connect();
    const list: any[] = await client.list();
    const folders: Folder[] = list
      .filter((m) => {
        const f = m.flags;
        if (f && typeof f.has === 'function') return !f.has('\\Noselect');
        if (Array.isArray(f)) return !f.includes('\\Noselect');
        return true;
      })
      .map((m) => ({
        name: String(m.path ?? m.name ?? ''),
        label: String(m.name ?? m.path ?? ''),
        kind: folderKindFor(m),
        subscribed: !!m.subscribed,
      }))
      .filter((m) => m.name.length > 0);
    const order: Record<Folder['kind'], number> = { inbox: 0, sent: 1, drafts: 2, archive: 3, junk: 4, trash: 5, all: 6, custom: 7 };
    folders.sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
    return { ok: true, folders };
  } catch (e: any) {
    console.error('[mail:listFolders] failed', acc.label, e?.message ?? e);
    return { ok: false, folders: [], error: String(e?.message ?? e) };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function persistFolders(userId: number, accountLabel: string, folders: Folder[]): Promise<void> {
  // Atomic refresh: wipe old rows, insert new. mail_folders has PK
  // (user_id, account_label, name) so multi-row insert in a single tx avoids
  // partial states. Use a server-side transaction-equivalent via two calls.
  await query(`DELETE FROM mail_folders WHERE user_id=$1 AND account_label=$2`, [userId, accountLabel]).catch(() => {});
  if (!folders.length) return;
  // Build a single multi-row INSERT for speed.
  const values: any[] = [];
  const placeholders: string[] = [];
  let p = 0;
  for (const f of folders) {
    placeholders.push(`($${++p},$${++p},$${++p},$${++p},$${++p},$${++p})`);
    values.push(userId, accountLabel, f.name, f.label, f.kind, f.subscribed);
  }
  await query(
    `INSERT INTO mail_folders(user_id, account_label, name, label, kind, subscribed)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (user_id, account_label, name) DO UPDATE
       SET label=EXCLUDED.label, kind=EXCLUDED.kind, subscribed=EXCLUDED.subscribed, updated_at=now()`,
    values,
  ).catch((e) => console.warn('[mail:persistFolders] insert failed', e?.message ?? e));
}

async function readFoldersFromDb(userId: number, accountLabel: string): Promise<{ folders: Folder[]; ageMs: number } | null> {
  const rows = await query<{ name: string; label: string; kind: string; subscribed: boolean; updated_at: string }>(
    `SELECT name, label, kind, subscribed, updated_at
     FROM mail_folders
     WHERE user_id=$1 AND account_label=$2
     ORDER BY
       CASE kind
         WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2
         WHEN 'archive' THEN 3 WHEN 'junk' THEN 4 WHEN 'trash' THEN 5
         WHEN 'all' THEN 6 ELSE 7
       END, label`,
    [userId, accountLabel],
  ).catch(() => []);
  if (!rows.length) return null;
  const newest = Math.max(...rows.map((r) => new Date(r.updated_at).getTime()));
  return {
    folders: rows.map((r) => ({ name: r.name, label: r.label, kind: r.kind as Folder['kind'], subscribed: !!r.subscribed })),
    ageMs: Date.now() - newest,
  };
}

export async function listFolders(userId: number, accountLabel: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; folders: Folder[]; error?: string; cached?: boolean }> {
  const accs = await listAccounts(userId);
  if (!accs.length) return { ok: false, folders: [], error: 'nessun account configurato' };
  const acc = pickAccount(accs, accountLabel);
  const key = folderKey(userId, accountLabel);

  // DB read first — instant. Trigger a background refresh if stale or stub.
  const fromDb = !opts.force ? await readFoldersFromDb(userId, accountLabel) : null;
  if (fromDb) {
    if (fromDb.ageMs > FOLDER_STALE_MS && !refreshingFolders.has(key)) {
      refreshingFolders.add(key);
      fetchFoldersLive(acc).then((r) => {
        if (r.ok) return persistFolders(userId, accountLabel, r.folders);
      }).catch(() => {}).finally(() => refreshingFolders.delete(key));
    }
    return { ok: true, folders: fromDb.folders, cached: true };
  }

  // Cold path: first-ever fetch for this account → wait for IMAP, then store.
  refreshingFolders.add(key);
  try {
    const r = await fetchFoldersLive(acc);
    if (r.ok) await persistFolders(userId, accountLabel, r.folders);
    return r;
  } finally { refreshingFolders.delete(key); }
}


// ---------------------------------------------------------------------------
// Bonifica — feed a stored mail row through brain/ingestEmail so it lands as
// a vault note AND every from/to/cc address is linked to a `people/<slug>` neuron.
// Idempotent (writeNote upserts by path; upsertPerson dedup by email).
// Sets bonified_at so batch runs skip already-processed rows unless force=true.
// ---------------------------------------------------------------------------
function reconstructParsed(row: any): any {
  // Build a minimal ParsedMail shape from a mail_messages row, enough for
  // brain/ingestEmail to extract subject/date/from/to/cc + body.
  const toAddrObj = (addrs: string[]) => addrs?.length
    ? [{ value: addrs.map((a) => ({ address: a, name: a.split('@')[0] })), text: addrs.join(', ') }]
    : undefined;
  return {
    subject: row.subject ?? '(no subject)',
    date: row.ts ? new Date(row.ts) : new Date(),
    text: row.body_text ?? '',
    html: row.body_html ?? false,
    from: row.from_addr
      ? { value: [{ address: row.from_addr, name: row.from_name || row.from_addr }], text: row.from_addr }
      : undefined,
    to: toAddrObj(row.to_addrs ?? []),
    cc: toAddrObj(row.cc_addrs ?? []),
    attachments: [],
  };
}

export async function bonifyOne(userId: number, mailId: number, force = false): Promise<{ ok: boolean; subj?: string; skipped?: boolean; error?: string }> {
  const rows = await query<any>(
    `SELECT id, account_label, uid, subject, ts, body_text, body_html, from_addr, from_name,
            to_addrs, cc_addrs, direction, bonified_at
     FROM mail_messages WHERE user_id=$1 AND id=$2 AND direction='in'`,
    [userId, mailId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: 'message not found' };
  if (row.bonified_at && !force) return { ok: true, subj: row.subject, skipped: true };
  const t0 = Date.now();
  try {
    const { ingestEmail } = await import('../brain/email.js');
    const ev = await ingestEmail({ userId, accountLabel: row.account_label, uid: row.uid ?? 0, parsed: reconstructParsed(row) });
    await query(`UPDATE mail_messages SET bonified_at=now() WHERE id=$1`, [row.id]);
    // Log to agent_runs so it surfaces in the /logs page UI.
    try {
      await query(
        `INSERT INTO agent_runs(user_id, kind, status, duration_ms, prompt, result, meta)
         VALUES($1, 'mail_bonify', 'ok', $2, $3, $4, $5::jsonb)`,
        [
          userId,
          Date.now() - t0,
          `mail:${row.account_label}:${row.id}`,
          `${row.from_name ?? ''} <${row.from_addr ?? ''}> · ${ev.subj}`,
          JSON.stringify({
            mail_id: row.id, account: row.account_label, from: row.from_addr,
            subject: ev.subj, people_linked: ev.people?.length ?? 0,
          }),
        ],
      );
    } catch {}
    console.log(`[mail:bonify:u${userId}] ok · ${row.account_label} · ${row.from_addr ?? '?'} · "${ev.subj}"`);
    return { ok: true, subj: ev.subj };
  } catch (e: any) {
    // Log failures too so users can see why a message didn't make it in.
    try {
      await query(
        `INSERT INTO agent_runs(user_id, kind, status, duration_ms, prompt, result, error, meta)
         VALUES($1, 'mail_bonify', 'error', $2, $3, NULL, $4, $5::jsonb)`,
        [
          userId,
          Date.now() - t0,
          `mail:${row.account_label}:${row.id}`,
          String(e?.message ?? e).slice(0, 1000),
          JSON.stringify({ mail_id: row.id, account: row.account_label, from: row.from_addr, subject: row.subject }),
        ],
      );
    } catch {}
    console.warn(`[mail:bonify:u${userId}] FAIL · ${row.account_label} · ${row.from_addr ?? '?'} · ${String(e?.message ?? e)}`);
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function bonifyAll(userId: number, opts: { force?: boolean; account?: string; limit?: number } = {}): Promise<{ ok: boolean; processed: number; skipped: number; errors: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 5000));
  const where: string[] = [`user_id=$1`, `direction='in'`];
  const params: any[] = [userId];
  if (opts.account) { params.push(opts.account); where.push(`account_label=$${params.length}`); }
  if (!opts.force) where.push(`bonified_at IS NULL`);
  const rows = await query<{ id: number }>(
    `SELECT id FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ${limit}`,
    params,
  );
  let processed = 0, skipped = 0, errors = 0;
  for (const r of rows) {
    const res = await bonifyOne(userId, r.id, opts.force);
    if (res.skipped) skipped++;
    else if (res.ok) processed++;
    else errors++;
  }
  return { ok: true, processed, skipped, errors };
}

// ---------------------------------------------------------------------------
// Manual sync — fetch latest messages from a single account/folder.
//
// If the user has no rows yet for this account (first-ever open of the mail
// UI), do a FULL BACKFILL of the mailbox — capped at `limit` (default 1000)
// to keep memory + bandwidth bounded. Otherwise sync starts from the highest
// stored UID so we only pull new mail.
//
// Returns: { ok, fetched, skipped, scanned, error? }
//   fetched: newly persisted rows
//   skipped: messages already in DB (idempotent)
//   scanned: total fetched from IMAP (fetched + skipped + parse failures)
// ---------------------------------------------------------------------------
// Sync ALL selectable IMAP folders for the account at once. Aggregates
// per-folder stats. UI's "Sync" button calls this so labels/folders other
// than INBOX (Sent, Spam, custom labels) get populated too.
export async function syncAccountAllFolders(userId: number, accountLabel: string, opts: { limit?: number } = {}): Promise<{ ok: boolean; perFolder: Array<{ folder: string; fetched: number; skipped: number; scanned: number; error?: string }>; totals: { fetched: number; skipped: number; scanned: number } }> {
  const res = await listFolders(userId, accountLabel);
  if (!res.ok) return { ok: false, perFolder: [], totals: { fetched: 0, skipped: 0, scanned: 0 } };
  const perFolder: Array<{ folder: string; fetched: number; skipped: number; scanned: number; error?: string }> = [];
  const totals = { fetched: 0, skipped: 0, scanned: 0 };
  // Skip purely-system unread containers like \All / \Junk dupes if they
  // would only duplicate other folders. Keep all in v1; user can prune later.
  for (const f of res.folders) {
    // Trash folder = local soft-delete; don't pull server trash.
    if (f.kind === 'trash') continue;
    const r = await syncAccount(userId, accountLabel, { limit: opts.limit, folder: f.name });
    perFolder.push({ folder: f.name, fetched: r.fetched, skipped: r.skipped, scanned: r.scanned, error: r.error });
    totals.fetched += r.fetched; totals.skipped += r.skipped; totals.scanned += r.scanned;
  }
  return { ok: true, perFolder, totals };
}

export async function syncAccount(userId: number, accountLabel: string, opts: { limit?: number; folder?: string } = {}): Promise<{ ok: boolean; fetched: number; skipped: number; scanned: number; error?: string; diag?: any }> {
  const accs = await listAccounts(userId);
  if (!accs.length) return { ok: false, fetched: 0, skipped: 0, scanned: 0, error: 'nessun account configurato' };
  const acc = pickAccount(accs, accountLabel);
  const folder = opts.folder ?? acc.mailbox ?? 'INBOX';
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 5000));

  // We track BOTH ends of the stored window. A click on Sync runs:
  //   (1) forward pull: anything UID > max(stored)
  //   (2) backward backfill: anything UID < min(stored), up to `limit`
  // This way the user always converges toward full mailbox coverage rather
  // than getting stuck at the slice fetched by the cron's initial poll.
  const boundsRow = await query<{ min_uid: number | null; max_uid: number | null; cnt: number }>(
    `SELECT min(uid) AS min_uid, max(uid) AS max_uid, count(*)::int AS cnt
     FROM mail_messages
     WHERE user_id=$1 AND account_label=$2 AND folder=$3 AND direction='in' AND uid IS NOT NULL`,
    [userId, acc.label, folder],
  ).catch(() => [{ min_uid: null, max_uid: null, cnt: 0 }]);
  const highestStored = Number(boundsRow[0]?.max_uid ?? 0) || 0;
  const lowestStored = Number(boundsRow[0]?.min_uid ?? 0) || 0;
  const storedCount = Number(boundsRow[0]?.cnt ?? 0) || 0;

  const client = new ImapFlow({
    host: acc.host, port: acc.port ?? 993, secure: true,
    auth: { user: acc.user, pass: acc.pass }, logger: false,
  });
  let fetched = 0, skipped = 0, scanned = 0;
  let uidNext = 0, totalMsgs = 0;
  let ranges: string[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true, uidNext: true });
      uidNext = (status.uidNext ?? 1) as number;
      totalMsgs = (status.messages ?? 0) as number;
      if (totalMsgs === 0) return { ok: true, fetched: 0, skipped: 0, scanned: 0, diag: { uidNext, totalMsgs, highestStored, lowestStored, storedCount, ranges } };

      if (storedCount === 0) {
        // First-ever sync: backfill the latest `limit` slice of the mailbox
        const from = Math.max(1, uidNext - limit);
        ranges.push(`${from}:*`);
      } else {
        // Forward: newer than what we have
        if (highestStored + 1 < uidNext) ranges.push(`${highestStored + 1}:*`);
        // Backward: EVERYTHING older than what we have. IMAP only returns
        // existing UIDs in the range so the wide span is cheap. We bound
        // ingestion by counting + breaking after `limit` writes (below).
        if (lowestStored > 1) {
          ranges.push(`1:${lowestStored - 1}`);
        }
      }

      for (const range of ranges) {
        try {
          // Third param { uid: true } is REQUIRED — without it imapflow treats
          // the range as sequence numbers, not UIDs ("1692:*" on a 734-msg
          // mailbox silently matches nothing).
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            scanned++;
            try {
              const parsed = await simpleParser(msg.source as Buffer);
              const r = await persistInbound({
                userId, accountLabel: acc.label, uid: msg.uid, parsed, folder, rawSize: (msg.source as Buffer)?.length ?? 0,
              });
              if (r.inserted) fetched++; else skipped++;
            } catch (e) {
              console.error('[mail:sync] parse fail uid=' + msg.uid, e);
            }
          }
        } catch (rangeErr) {
          console.error('[mail:sync] range fail', range, rangeErr);
        }
      }
    } finally { lock.release(); }
    return { ok: true, fetched, skipped, scanned, diag: { uidNext, totalMsgs, highestStored, lowestStored, storedCount, ranges } };
  } catch (e: any) {
    return { ok: false, fetched, skipped, scanned, error: String(e?.message ?? e) };
  } finally {
    await client.logout().catch(() => {});
  }
}
