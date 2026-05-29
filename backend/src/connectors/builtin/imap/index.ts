import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Connector } from '../../types.js';
import { ingestEmail, emailBodyText } from '../../../brain/email.js';
import { bus } from '../../../bus.js';

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
};

const connector: Connector = {
  manifest: {
    name: 'imap',
    title: 'IMAP Email Reader (multi-account)',
    description: 'Polls one or more IMAP mailboxes. Cleans HTML, links senders to People, stores notes in inbox/email/<account>/.',
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
  ],
};

export default connector;
