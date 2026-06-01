import { query } from '../db/index.js';
import { bus } from '../bus.js';
import { runClaude } from '../claude/runner.js';
import { sendTelegram } from '../telegram/bot.js';
import { getSetting } from '../db/index.js';

export type ProposedAgent = { title: string; brief: string; prompt: string };

export type AgentProposal = {
  id: number;
  user_id: number;
  title: string;
  reason: string | null;
  proposals: ProposedAgent[];
  status: 'pending' | 'approved' | 'denied' | 'expired';
  telegram_message_id: number | null;
  telegram_chat_id: number | null;
  decided_at: string | null;
  created_at: string;
};

export type SubAgent = {
  id: number;
  user_id: number;
  proposal_id: number | null;
  title: string;
  brief: string | null;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  result: string | null;
  error: string | null;
  run_id: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  num_turns: number | null;
  actions: Array<{ name: string; brief: string; ts: number }>;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

function emit(userId: number, type: string, payload: any) {
  bus.emit('subagent:event', { userId, type, payload });
}

export async function createProposal(
  userId: number,
  title: string,
  reason: string | null,
  proposals: ProposedAgent[],
): Promise<AgentProposal> {
  if (!proposals.length) throw new Error('proposals empty');
  const rows = await query<AgentProposal>(
    `INSERT INTO agent_proposals(user_id, title, reason, proposals, status)
     VALUES($1, $2, $3, $4::jsonb, 'pending') RETURNING *`,
    [userId, title, reason, JSON.stringify(proposals)],
  );
  const p = rows[0];
  emit(userId, 'proposal:created', p);
  // Try send Telegram with inline keyboard
  try {
    const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
    if (cfg?.chatId) {
      const { sendProposalKeyboard } = await import('../telegram/bot.js');
      const msg = await sendProposalKeyboard(userId, p);
      if (msg) {
        await query(
          `UPDATE agent_proposals SET telegram_message_id=$1, telegram_chat_id=$2 WHERE id=$3`,
          [msg.message_id, msg.chat_id, p.id],
        );
        p.telegram_message_id = msg.message_id;
        p.telegram_chat_id = msg.chat_id;
      }
    }
  } catch (e: any) {
    console.error('[sub_agents] telegram proposal failed', e?.message ?? e);
  }
  return p;
}

export async function getProposal(userId: number, id: number): Promise<AgentProposal | null> {
  const rows = await query<AgentProposal>(
    `SELECT * FROM agent_proposals WHERE id=$1 AND user_id=$2`, [id, userId],
  );
  return rows[0] ?? null;
}

export async function approveProposal(userId: number, id: number): Promise<SubAgent[]> {
  const p = await getProposal(userId, id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') throw new Error(`proposal already ${p.status}`);
  await query(
    `UPDATE agent_proposals SET status='approved', decided_at=now() WHERE id=$1`, [id],
  );
  const spawned: SubAgent[] = [];
  for (const sp of p.proposals) {
    const rows = await query<SubAgent>(
      `INSERT INTO sub_agents(user_id, proposal_id, title, brief, prompt, status)
       VALUES($1, $2, $3, $4, $5, 'pending') RETURNING *`,
      [userId, id, sp.title, sp.brief, sp.prompt],
    );
    spawned.push(rows[0]);
    emit(userId, 'subagent:created', rows[0]);
    // Fire-and-forget run
    void runSubAgent(rows[0].id).catch((e) => console.error('[sub_agents] run error', e));
  }
  emit(userId, 'proposal:approved', { id, spawned: spawned.map((s) => s.id) });
  return spawned;
}

export async function denyProposal(userId: number, id: number): Promise<void> {
  const p = await getProposal(userId, id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') return;
  await query(
    `UPDATE agent_proposals SET status='denied', decided_at=now() WHERE id=$1`, [id],
  );
  emit(userId, 'proposal:denied', { id });
}

export async function spawnSubAgent(userId: number, opts: { title: string; brief?: string; prompt: string; dedupe?: boolean }): Promise<SubAgent> {
  // Idempotency: if a sub-agent with same title is already pending/running for this user, return it.
  // Prevents recursive self-spawning when sub-agent calls an MCP tool that itself spawns a sub-agent.
  if (opts.dedupe !== false) {
    const existing = await query<SubAgent>(
      `SELECT * FROM sub_agents WHERE user_id=$1 AND title=$2 AND status IN ('pending','running') ORDER BY id DESC LIMIT 1`,
      [userId, opts.title],
    );
    if (existing[0]) return existing[0];
  }
  const rows = await query<SubAgent>(
    `INSERT INTO sub_agents(user_id, proposal_id, title, brief, prompt, status)
     VALUES($1, NULL, $2, $3, $4, 'pending') RETURNING *`,
    [userId, opts.title, opts.brief ?? null, opts.prompt],
  );
  const sa = rows[0];
  emit(userId, 'subagent:created', sa);
  void runSubAgent(sa.id).catch((e) => console.error('[sub_agents] run error', e));
  return sa;
}

async function runSubAgent(id: number): Promise<void> {
  const rows = await query<SubAgent>(`SELECT * FROM sub_agents WHERE id=$1`, [id]);
  const sa = rows[0];
  if (!sa) return;
  await query(
    `UPDATE sub_agents SET status='running', started_at=now(), updated_at=now() WHERE id=$1`, [id],
  );
  emit(sa.user_id, 'subagent:running', { id });
  try {
    const result = await runClaude(sa.user_id, sa.prompt, {
      kind: `subagent:${sa.title.slice(0, 32)}`,
      timeoutMs: 1_800_000,
      meta: { sub_agent_id: id, title: sa.title },
    });
    const actions = JSON.stringify(result.toolCalls ?? []);
    if (!result.ok) {
      await query(
        `UPDATE sub_agents SET status='error', error=$2, run_id=$3, cost_usd=$4, input_tokens=$5, output_tokens=$6, num_turns=$7, actions=$8::jsonb, ended_at=now(), updated_at=now() WHERE id=$1`,
        [id, (result.stderr || 'failed').slice(0, 2000), result.runId ?? null, result.costUsd ?? null, result.inputTokens ?? null, result.outputTokens ?? null, result.numTurns ?? null, actions],
      );
      emit(sa.user_id, 'subagent:done', { id, status: 'error' });
      await notifyDone(sa.user_id, sa, 'error', result.stderr ?? 'failed').catch(() => {});
      return;
    }
    await query(
      `UPDATE sub_agents SET status='done', result=$2, run_id=$3, cost_usd=$4, input_tokens=$5, output_tokens=$6, num_turns=$7, actions=$8::jsonb, ended_at=now(), updated_at=now() WHERE id=$1`,
      [id, result.text.slice(0, 16_000), result.runId ?? null, result.costUsd ?? null, result.inputTokens ?? null, result.outputTokens ?? null, result.numTurns ?? null, actions],
    );
    emit(sa.user_id, 'subagent:done', { id, status: 'done' });
    await notifyDone(sa.user_id, sa, 'done', result.text).catch(() => {});
  } catch (e: any) {
    await query(
      `UPDATE sub_agents SET status='error', error=$2, ended_at=now(), updated_at=now() WHERE id=$1`,
      [id, String(e?.message ?? e).slice(0, 2000)],
    );
    emit(sa.user_id, 'subagent:done', { id, status: 'error' });
  }
}

async function notifyDone(userId: number, sa: SubAgent, status: 'done' | 'error', text: string) {
  const emoji = status === 'done' ? '✅' : '⚠️';
  const head = `${emoji} Sub-agent **${sa.title}** ${status === 'done' ? 'completato' : 'fallito'}.`;
  const body = text.slice(0, 800);
  await sendTelegram(userId, `${head}\n\n${body}`);
}

export async function listSubAgents(userId: number, opts: { status?: string; limit?: number } = {}): Promise<SubAgent[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.status) {
    return await query<SubAgent>(
      `SELECT * FROM sub_agents WHERE user_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT $3`,
      [userId, opts.status, limit],
    );
  }
  return await query<SubAgent>(
    `SELECT * FROM sub_agents WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

export async function listActive(userId: number): Promise<SubAgent[]> {
  return await query<SubAgent>(
    `SELECT * FROM sub_agents WHERE user_id=$1 AND status IN ('pending','running') ORDER BY created_at ASC`,
    [userId],
  );
}

export async function getSubAgent(userId: number, id: number): Promise<SubAgent | null> {
  const rows = await query<SubAgent>(
    `SELECT * FROM sub_agents WHERE id=$1 AND user_id=$2`, [id, userId],
  );
  return rows[0] ?? null;
}

export async function cancelSubAgent(userId: number, id: number): Promise<void> {
  await query(
    `UPDATE sub_agents SET status='cancelled', ended_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('pending','running')`,
    [id, userId],
  );
  emit(userId, 'subagent:done', { id, status: 'cancelled' });
}
