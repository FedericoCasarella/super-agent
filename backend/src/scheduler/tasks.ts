import cron, { ScheduledTask } from 'node-cron';
import { query } from '../db/index.js';
import { sendTelegram } from '../telegram/bot.js';
import { runClaude } from '../claude/runner.js';
import { buildScheduledTaskContext } from '../claude/prompts.js';
import { getVaultRoot } from '../brain/vault.js';
import { invokeTool } from '../connectors/tools.js';

export type ScheduledTaskRow = {
  id: number;
  user_id: number;
  name: string;
  cron: string;
  action_type: 'notify' | 'prompt' | 'tool';
  action_payload: any;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_result: string | null;
};

const live = new Map<number, ScheduledTask>();

export async function listTasks(userId: number): Promise<ScheduledTaskRow[]> {
  return query<ScheduledTaskRow>(
    `SELECT id::int, user_id::int, name, cron, action_type, action_payload, enabled,
            last_run_at, last_status, last_result
     FROM scheduled_tasks WHERE user_id=$1 ORDER BY id DESC`, [userId]
  );
}

export async function refreshTasks() {
  for (const [, t] of live) { try { t.stop(); } catch {} }
  live.clear();
  const rows = await query<ScheduledTaskRow>(
    `SELECT id::int, user_id::int, name, cron, action_type, action_payload, enabled,
            last_run_at, last_status, last_result FROM scheduled_tasks WHERE user_id IS NOT NULL`
  );
  for (const r of rows) {
    if (!r.enabled) continue;
    if (!cron.validate(r.cron)) {
      console.error(`[tasks] invalid cron #${r.id}: ${r.cron}`);
      continue;
    }
    const task = cron.schedule(r.cron, () => runTaskById(r.user_id, r.id).catch((e) => console.error('[tasks]', e)));
    live.set(r.id, task);
  }
  console.log(`[tasks] ${live.size} active schedules`);
}

export async function runTaskById(userId: number, id: number) {
  const rows = await query<ScheduledTaskRow>(
    `SELECT id::int, user_id::int, name, cron, action_type, action_payload, enabled, last_run_at, last_status, last_result
     FROM scheduled_tasks WHERE id=$1 AND user_id=$2`, [id, userId]
  );
  const t = rows[0];
  if (!t) return;
  let status = 'ok';
  let result = '';
  try {
    if (t.action_type === 'notify') {
      const text = String(t.action_payload?.text ?? '').trim();
      if (!text) throw new Error('notify: empty text');
      await sendTelegram(userId, text);
      result = `sent: ${text.slice(0, 120)}`;
    } else if (t.action_type === 'prompt') {
      const sys = await buildScheduledTaskContext(userId);
      const userPrompt = String(t.action_payload?.prompt ?? '').trim();
      if (!userPrompt) throw new Error('prompt: empty');
      const fullPrompt = `${sys}\n\n=== SCHEDULED TASK: ${t.name} ===\n\nINSTRUCTIONS (follow exactly, ignore advisor/conductor framing):\n${userPrompt}\n\nOUTPUT RULES:\n- Output ONLY what the task asks for. No "OK dove eravamo", no roadmap recap, no closing question unless the task itself asks for it.\n- If something should be sent to Telegram: output it directly (split with <<MSG>> for multiple messages).\n- If nothing should be sent: output the literal token \`SKIP\` and nothing else.`;
      const vault = await getVaultRoot(userId);
      const res = await runClaude(userId, fullPrompt, { cwd: vault ?? process.cwd(), timeoutMs: 180_000, kind: 'scheduled', meta: { taskId: t.id, name: t.name } });
      const out = (res.text || '').trim();
      if (out && !/^SKIP$/i.test(out) && !/(^|\n)\s*SKIP\s*($|\n)/i.test(out)) {
        await sendTelegram(userId, out);
        result = `claude → telegram: ${out.slice(0, 120)}`;
      } else {
        result = 'SKIP';
      }
    } else if (t.action_type === 'tool') {
      const tool = String(t.action_payload?.tool ?? '');
      const args = t.action_payload?.args ?? {};
      const out = await invokeTool(userId, tool, args);
      result = `tool ${tool} → ${JSON.stringify(out).slice(0, 200)}`;
      if (t.action_payload?.notify) {
        await sendTelegram(userId, `📋 ${t.name}: ${result.slice(0, 300)}`);
      }
    }
  } catch (e: any) {
    status = 'error';
    result = String(e?.message ?? e).slice(0, 400);
    console.error(`[tasks] #${id} failed`, e);
  }
  await query(
    `UPDATE scheduled_tasks SET last_run_at=now(), last_status=$3, last_result=$4, updated_at=now() WHERE id=$1 AND user_id=$2`,
    [id, userId, status, result]
  );
}
