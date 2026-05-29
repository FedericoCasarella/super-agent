import nodemailer from 'nodemailer';
import type { Connector } from '../../types.js';
import { query, getSetting } from '../../../db/index.js';
import { bus } from '../../../bus.js';

type SmtpConfig = {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  fromName?: string;
  fromEmail?: string;
};

export type EmailDraft = {
  id: number;
  user_id: number;
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

async function getCfg(userId: number): Promise<SmtpConfig | null> {
  const rows = await query<{ config: any; enabled: boolean }>(
    `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='smtp'`, [userId]
  );
  const row = rows[0];
  if (!row?.enabled) return null;
  return row.config ?? {};
}

export async function createDraft(userId: number, draft: {
  to: string; cc?: string; bcc?: string; subject: string; body: string;
  inReplyTo?: string; references?: string;
}): Promise<EmailDraft> {
  const rows = await query<EmailDraft>(
    `INSERT INTO email_drafts(user_id, to_addr, cc_addr, bcc_addr, subject, body, in_reply_to, references_ids, status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
    [userId, draft.to, draft.cc ?? null, draft.bcc ?? null, draft.subject, draft.body, draft.inReplyTo ?? null, draft.references ?? null],
  );
  const d = rows[0];
  bus.emit('email_draft:created', { userId, draft: d });
  // Send Telegram approval keyboard
  try {
    const tg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
    if (tg?.chatId) {
      const { sendEmailDraftKeyboard } = await import('../../../telegram/bot.js');
      const sent = await sendEmailDraftKeyboard(userId, d);
      if (sent) {
        await query(
          `UPDATE email_drafts SET telegram_message_id=$1, telegram_chat_id=$2 WHERE id=$3`,
          [sent.message_id, sent.chat_id, d.id],
        );
        d.telegram_message_id = sent.message_id;
        d.telegram_chat_id = sent.chat_id;
      }
    }
  } catch (e: any) {
    console.error('[smtp] telegram approval send failed', e?.message ?? e);
  }
  return d;
}

export async function getDraft(userId: number, id: number): Promise<EmailDraft | null> {
  const rows = await query<EmailDraft>(`SELECT * FROM email_drafts WHERE id=$1 AND user_id=$2`, [id, userId]);
  return rows[0] ?? null;
}

export async function listDrafts(userId: number, status?: string): Promise<EmailDraft[]> {
  if (status) return query<EmailDraft>(`SELECT * FROM email_drafts WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 100`, [userId, status]);
  return query<EmailDraft>(`SELECT * FROM email_drafts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]);
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
  const cfg = await getCfg(userId);
  if (!cfg?.host || !cfg.user || !cfg.pass) throw new Error('SMTP not configured');
  const port = cfg.port ?? 587;
  const secure = cfg.secure ?? (port === 465);
  const transporter = nodemailer.createTransport({
    host: cfg.host, port, secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const fromEmail = cfg.fromEmail || cfg.user;
  const from = cfg.fromName ? `"${cfg.fromName}" <${fromEmail}>` : fromEmail;
  const headers: Record<string, string> = {};
  if (d.in_reply_to) headers['In-Reply-To'] = d.in_reply_to;
  if (d.references_ids) headers['References'] = d.references_ids;
  try {
    await transporter.sendMail({
      from, to: d.to_addr, cc: d.cc_addr ?? undefined, bcc: d.bcc_addr ?? undefined,
      subject: d.subject, text: d.body, headers,
    });
    await query(
      `UPDATE email_drafts SET status='sent', sent_at=now(), decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [id],
    );
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
    name: 'smtp',
    title: 'SMTP (email send)',
    description: 'Invio email con flusso human-in-the-loop: l\'agente crea bozze, tu approvi su Telegram, poi invia.',
    configSchema: [
      { key: 'host', label: 'SMTP host', type: 'text', required: true, placeholder: 'smtp.gmail.com / smtp.fastmail.com / ...' },
      { key: 'port', label: 'Port', type: 'number', placeholder: '587 (STARTTLS) o 465 (SSL)' },
      { key: 'secure', label: 'Use SSL (porta 465)', type: 'boolean' },
      { key: 'user', label: 'Username', type: 'text', required: true, placeholder: 'tu@dominio.com' },
      { key: 'pass', label: 'Password / app password', type: 'password', required: true },
      { key: 'fromName', label: 'Nome mittente (opzionale)', type: 'text', placeholder: 'Federico Casarella' },
      { key: 'fromEmail', label: 'Email mittente (default = username)', type: 'text' },
    ],
  },
  tools: [
    {
      name: 'propose_reply',
      description: 'Create an email draft and ask the user for approval via Telegram inline keyboard (✅ Invia / ❌ Scarta). USE THIS when the user receives an email and you want to reply on their behalf. Set `inReplyTo` to the original Message-ID for proper threading. Never send directly — always go through this flow.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address(es), comma-separated.' },
          cc: { type: 'string' },
          bcc: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'Plain text body. Sign with the user\'s name.' },
          inReplyTo: { type: 'string', description: 'Original Message-ID header value for threading.' },
          references: { type: 'string', description: 'References header (concat of previous Message-IDs).' },
        },
        required: ['to', 'subject', 'body'], additionalProperties: false,
      },
      handler: async (ctx, args) => {
        const d = await createDraft(ctx.userId, args);
        return { ok: true, draftId: d.id, status: d.status, awaitingApproval: true };
      },
    },
    {
      name: 'drafts_list',
      description: 'List pending email drafts awaiting user approval.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['pending', 'approved', 'denied', 'sent', 'error'] } },
        additionalProperties: false,
      },
      handler: async (ctx, { status }) => {
        const list = await listDrafts(ctx.userId, status);
        return list.map((d) => ({ id: d.id, to: d.to_addr, subject: d.subject, status: d.status, created_at: d.created_at }));
      },
    },
    {
      name: 'send_draft',
      description: 'Send a draft NOW. Only use if the user explicitly said "manda" / "invia ora" / "send it now" in plain text — bypassing the inline approval flow.',
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
