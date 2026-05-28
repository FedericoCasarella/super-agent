import { bus } from '../bus.js';
import { query, setSetting } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { buildTurnPrompt } from '../claude/prompts.js';
import { sendTelegram, startTyping } from '../telegram/bot.js';
import { getVaultRoot } from '../brain/vault.js';

export function startOrchestrator() {
  // Remove any stale listener (tsx-watch hot-reload, module re-eval) to avoid duplicate replies
  bus.removeAllListeners('telegram:incoming');
  bus.on('telegram:incoming', handleIncoming);
}

async function handleIncoming({ userId, text }: { userId: number; chatId: number; text: string }) {
  await logMessage(userId, 'in', 'telegram', text);
  await setSetting(userId, 'agent_next_reflection_at', null);
  const history = await query<{ direction: string; content: string }>(
    `SELECT direction, content FROM messages WHERE user_id=$1 AND channel='telegram' ORDER BY id DESC LIMIT 10`, [userId]
  );
  const prompt = await buildTurnPrompt(userId, text, history.reverse());
  const vault = await getVaultRoot(userId);
  const stopTyping = await startTyping(userId);
  let res;
  try {
    res = await runClaude(userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 180_000, kind: 'chat_turn', meta: { incoming: text.slice(0, 200) } });
  } finally {
    stopTyping();
  }
  const reply = res.ok ? res.text.trim() : `(error: ${res.stderr.slice(0, 200)})`;
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
