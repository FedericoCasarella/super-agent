import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import type { Connector } from '../../types.js';
import { ingestEmail, emailBodyText } from '../../../brain/email.js';
import { bus } from '../../../bus.js';
import { query, getSetting } from '../../../db/index.js';

async function openClient(acc: Account) {
  const client = new ImapFlow({
    host: acc.host, port: Number(acc.port ?? 993), secure: true,
    auth: { user: acc.user, pass: acc.pass }, logger: false,
  });
  // An unhandled 'error' event on the IMAP socket (e.g. ETIMEOUT after the socket is
  // already open) is re-thrown by Node and crashes the entire backend process. Always
  // register a handler; callers reconnect on the next tick. (sess.2939 — backend down RCA)
  client.on('error', (err) => console.error('[imap] socket error (openClient):', (err as any)?.message ?? err));
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
  const host = acc.smtpHost || acc.host.replace(/^imap\./i, 'smtp.');
  const port = acc.smtpPort ?? 587;
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

export async function createDraft(userId: number, accountLabel: string, draft: {
  to: string; cc?: string; bcc?: string; subject: string; body: string; inReplyTo?: string; references?: string;
}): Promise<EmailDraft> {
  const accs = await getAccountsForUser(userId);
  if (!accs.find((a) => a.label === accountLabel)) throw new Error(`account ${accountLabel} not found`);
  const rows = await query<EmailDraft>(
    `INSERT INTO email_drafts(user_id, account_label, to_addr, cc_addr, bcc_addr, subject, body, in_reply_to, references_ids, status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING *`,
    [userId, accountLabel, draft.to, draft.cc ?? null, draft.bcc ?? null, draft.subject, draft.body, draft.inReplyTo ?? null, draft.references ?? null],
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
  try {
    await t.sendMail({ from, to: d.to_addr, cc: d.cc_addr ?? undefined, bcc: d.bcc_addr ?? undefined, subject: d.subject, text: d.body, headers });
    await query(`UPDATE email_drafts SET status='sent', sent_at=now(), decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [id]);
    bus.emit('email_draft:sent', { userId, id });
    return { ...d, status: 'sent', sent_at: new Date().toISOString() };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 800);
    await query(`UPDATE email_drafts SET status='error', error=$2, decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [id, msg]);
    bus.emit('email_draft:error', { userId, id, error: msg });
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
      // Guard against unhandled 'error' events (socket timeout mid-fetch) crashing the
      // process — the try/catch below only covers awaited calls, not async socket events.
      client.on('error', (err) => console.error(`[imap] socket error (${acc.label}):`, (err as any)?.message ?? err));
      let maxUid = lastUid;
      try {
        await client.connect();
        const lock = await client.getMailboxLock(acc.mailbox || 'INBOX');
        try {
          let range: string;
          if (lastUid > 0) {
            range = `${lastUid + 1}:*`;
          } else {
            const status = await client.status(acc.mailbox || 'INBOX', { messages: true, uidNext: true });
            const uidNext = (status.uidNext ?? 1) as number;
            const backlog = Math.max(0, acc.initialBacklog ?? 0);
            const from = backlog > 0 ? Math.max(1, uidNext - backlog) : uidNext;
            range = `${from}:*`;
            maxUid = from - 1;
          }
          for await (const msg of client.fetch(range, { uid: true, source: true })) {
            if (msg.uid <= maxUid) continue;
            try {
              const parsed = await simpleParser(msg.source as Buffer);
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
      } catch (e) {
        ctx.log('account-error', { account: acc.label, err: String(e) });
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
            return {
              uid,
              subject: parsed.subject ?? '',
              from: parsed.from?.text ?? '',
              to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join('; ') : parsed.to.text) : '',
              date: (parsed.date ?? new Date()).toISOString(),
              body: emailBodyText(parsed),
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
            for await (const msg of client.fetch(slice, { uid: true, source: true }, { uid: true })) {
              const parsed = await simpleParser(msg.source as Buffer);
              const body = emailBodyText(parsed);
              out.push({
                uid: msg.uid,
                subject: parsed.subject ?? '',
                from: parsed.from?.text ?? '',
                date: (parsed.date ?? new Date()).toISOString(),
                snippet: body.slice(0, 400),
              });
            }
            return out.reverse();
          } finally { lock.release(); }
        } finally { await client.logout().catch(() => {}); }
      },
    },
    {
      name: 'propose_reply',
      description: 'Crea una bozza di risposta email e chiede approvazione all\'utente via Telegram (✅ Invia / ❌ Scarta). USA SEMPRE questo invece di rispondere direttamente. `account` = label dell\'account email da cui inviare (deve avere SMTP configurato). Setta `inReplyTo` al Message-ID dell\'email originale per il threading. Firma con il nome dell\'utente.',
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
      description: 'Lista bozze email (pending = in attesa di approvazione utente).',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['pending', 'approved', 'denied', 'sent', 'error'] } },
        additionalProperties: false,
      },
      handler: async (ctx, { status }) => {
        const list = await listDrafts(ctx.userId, status);
        return list.map((d) => ({ id: d.id, account: d.account_label, to: d.to_addr, subject: d.subject, status: d.status, created_at: d.created_at }));
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
