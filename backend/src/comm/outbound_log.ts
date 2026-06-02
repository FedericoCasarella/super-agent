import { query } from '../db/index.js';
import { bus } from '../bus.js';

// Centralised audit log for every outbound communication sent on behalf of the user.
// Called by senders (whatsapp.sendWaMessage, imap.sendDraft, telegram.sendTelegram).
// Append-only — no updates, no deletes. Body capped to 16KB to keep rows sane.

export type OutboundChannel = 'whatsapp' | 'email' | 'telegram';
export type OutboundStatus = 'sent' | 'error';

export type OutboundLogInput = {
  userId: number;
  channel: OutboundChannel;
  status: OutboundStatus;
  recipient?: string | null;
  recipient_name?: string | null;
  subject?: string | null;
  body?: string | null;
  origin?: string | null;
  error?: string | null;
  meta?: Record<string, any>;
};

export async function logOutbound(input: OutboundLogInput): Promise<{ id: number } | null> {
  try {
    const body = (input.body ?? '').slice(0, 16_000);
    const rows = await query<{ id: number }>(
      `INSERT INTO outbound_log(user_id, channel, status, recipient, recipient_name, subject, body, origin, error, meta)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       RETURNING id::int`,
      [
        input.userId,
        input.channel,
        input.status,
        input.recipient ?? null,
        input.recipient_name ?? null,
        input.subject ?? null,
        body,
        input.origin ?? null,
        input.error ?? null,
        JSON.stringify(input.meta ?? {}),
      ],
    );
    const id = rows[0]?.id ?? null;
    if (id) bus.emit('outbound:logged', { userId: input.userId, id, channel: input.channel, status: input.status, ts: new Date().toISOString() });
    return id != null ? { id } : null;
  } catch (e) {
    // Never throw from the logger — outbound send must not fail because of log errors.
    console.error('[outbound_log] insert failed', e);
    return null;
  }
}
