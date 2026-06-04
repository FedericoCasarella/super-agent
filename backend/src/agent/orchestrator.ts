import { bus } from '../bus.js';
import { query, setSetting } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { buildTurnPrompt } from '../claude/prompts.js';
import { sendTelegram, startTyping } from '../telegram/bot.js';
import { getVaultRoot } from '../brain/vault.js';
import { isQuotaLocked, QUOTA_LOCK_ERROR } from '../quota.js';

export function startOrchestrator() {
  // Remove any stale listener (tsx-watch hot-reload, module re-eval) to avoid duplicate replies
  bus.removeAllListeners('telegram:incoming');
  bus.on('telegram:incoming', handleIncoming);
}

async function handleIncoming({ userId, text }: { userId: number; chatId: number; text: string }) {
  await logMessage(userId, 'in', 'telegram', text);
  await setSetting(userId, 'agent_next_reflection_at', null);
  // Quota lock: if Claude session usage is >= 95%, refuse to call the API
  // (which would burn the last few % on a partial reply) and surface the
  // freeze message to the user instead.
  if (isQuotaLocked()) {
    const msg = '🚫 ' + QUOTA_LOCK_ERROR.error;
    try { await sendTelegram(userId, msg, 'quota_locked'); } catch (e) { console.error('[orchestrator:quota_locked]', e); }
    await logMessage(userId, 'out', 'telegram', msg);
    return;
  }
  // Pull last 30 so repetition detector can see 4-5 asks across a few turns.
  const history = await query<{ direction: string; content: string }>(
    `SELECT direction, content FROM messages WHERE user_id=$1 AND channel='telegram' ORDER BY id DESC LIMIT 30`, [userId]
  );
  const prompt = await buildTurnPrompt(userId, text, history.reverse());
  const vault = await getVaultRoot(userId);
  const stopTyping = await startTyping(userId);
  let res;
  try {
    res = await runClaude(userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 600_000, kind: 'chat_turn', meta: { incoming: text.slice(0, 200) } });
  } finally {
    stopTyping();
  }
  let reply: string;
  if (res.ok) {
    reply = res.text.trim();
  } else if (res.diagnosis) {
    reply = `${res.diagnosis.title}\n\n${res.diagnosis.hint}`;
  } else if (res.exitCode === 143) {
    reply = '⏱️ Timeout: ho impiegato troppo. Riprova o spezza la richiesta.';
  } else {
    reply = `⚠️ Errore: ${res.stderr.slice(0, 250)}`;
  }
  if (!reply || reply === 'SKIP') return;
  try {
    await sendTelegram(userId, reply);
    await logMessage(userId, 'out', 'telegram', reply);
  } catch (e) {
    console.error('[orchestrator] sendTelegram', e);
    await logMessage(userId, 'system', 'telegram', `send failed: ${e}`);
  }
}

async function logMessage(userId: number, direction: 'in'|'out'|'system', channel: string, content: string) {
  await query(
    `INSERT INTO messages(user_id, direction, channel, content) VALUES($1,$2,$3,$4)`,
    [userId, direction, channel, content]
  );
  bus.emit('message:logged', { userId, direction, channel, content, ts: new Date().toISOString() });
}
