import { query } from '../db/index.js';
import { bus } from '../bus.js';
import { runClaude } from '../claude/runner.js';
import { getVaultRoot } from '../brain/vault.js';
import { MCP_SERVER_NAME } from '../mcp/config.js';
import { sendTelegram } from '../telegram/bot.js';
import { config } from '../config.js';

// =====================================================================
// Custom agent CRUD
// =====================================================================
export type CustomAgent = {
  id: number;
  user_id: number;
  name: string;
  role: string | null;
  description: string | null;
  system_prompt: string;
  skills: string[];
  model: string | null;
  icon: string | null;
  color: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};

export async function listAgents(userId: number, includeArchived = false): Promise<CustomAgent[]> {
  return await query<CustomAgent>(
    `SELECT id::int, user_id::int, name, role, description, system_prompt, skills, model, icon, color, archived, created_at, updated_at
     FROM custom_agents WHERE user_id=$1 ${includeArchived ? '' : 'AND archived=false'} ORDER BY name`,
    [userId],
  );
}
export async function getAgent(userId: number, id: number): Promise<CustomAgent | null> {
  const rows = await query<CustomAgent>(
    `SELECT id::int, user_id::int, name, role, description, system_prompt, skills, model, icon, color, archived, created_at, updated_at
     FROM custom_agents WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return rows[0] ?? null;
}
export async function createAgent(userId: number, input: Partial<CustomAgent>): Promise<CustomAgent> {
  const rows = await query<CustomAgent>(
    `INSERT INTO custom_agents(user_id, name, role, description, system_prompt, skills, model, icon, color)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
     RETURNING id::int, user_id::int, name, role, description, system_prompt, skills, model, icon, color, archived, created_at, updated_at`,
    [
      userId,
      String(input.name ?? '').trim(),
      input.role ?? null,
      input.description ?? null,
      input.system_prompt ?? '',
      JSON.stringify(input.skills ?? []),
      input.model ?? null,
      input.icon ?? null,
      input.color ?? null,
    ],
  );
  return rows[0];
}
export async function updateAgent(userId: number, id: number, patch: Partial<CustomAgent>): Promise<CustomAgent | null> {
  const fields: string[] = [];
  const params: any[] = [userId, id];
  const add = (col: string, val: any, cast = '') => { fields.push(`${col}=$${params.length + 1}${cast}`); params.push(val); };
  if (patch.name !== undefined) add('name', String(patch.name).trim());
  if (patch.role !== undefined) add('role', patch.role);
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.system_prompt !== undefined) add('system_prompt', patch.system_prompt);
  if (patch.skills !== undefined) add('skills', JSON.stringify(patch.skills), '::jsonb');
  if (patch.model !== undefined) add('model', patch.model);
  if (patch.icon !== undefined) add('icon', patch.icon);
  if (patch.color !== undefined) add('color', patch.color);
  if (patch.archived !== undefined) add('archived', patch.archived);
  if (!fields.length) return getAgent(userId, id);
  await query(
    `UPDATE custom_agents SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND id=$2`,
    params,
  );
  return getAgent(userId, id);
}
export async function deleteAgent(userId: number, id: number): Promise<void> {
  await query(`UPDATE custom_agents SET archived=true, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, id]);
}

// =====================================================================
// Team CRUD + membership
// =====================================================================
export type Team = {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
};
export type TeamMember = {
  id: number;
  team_id: number;
  agent_id: number;
  role: 'lead' | 'member';
  reports_to: number | null;
  position: number;
};
export type TeamWithMembers = Team & { members: (TeamMember & { agent?: CustomAgent | null })[] };

export async function listTeams(userId: number): Promise<(Team & { members_count: number })[]> {
  return await query<Team & { members_count: number }>(
    `SELECT t.id::int, t.user_id::int, t.name, t.description, t.archived, t.created_at, t.updated_at,
            COALESCE((SELECT count(*)::int FROM agent_team_members m WHERE m.team_id=t.id), 0) AS members_count
     FROM agent_teams t WHERE t.user_id=$1 AND t.archived=false ORDER BY t.name`,
    [userId],
  );
}
export async function getTeam(userId: number, id: number): Promise<TeamWithMembers | null> {
  const rows = await query<Team>(
    `SELECT id::int, user_id::int, name, description, archived, created_at, updated_at
     FROM agent_teams WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  if (!rows[0]) return null;
  const team = rows[0];
  const members = await query<TeamMember>(
    `SELECT id::int, team_id::int, agent_id::int, role, reports_to::int, position
     FROM agent_team_members WHERE team_id=$1 ORDER BY position, id`,
    [id],
  );
  // Load agents
  const agents = await listAgents(userId, true);
  const map = new Map(agents.map((a) => [a.id, a]));
  return { ...team, members: members.map((m) => ({ ...m, agent: map.get(m.agent_id) ?? null })) };
}
export async function createTeam(userId: number, input: { name: string; description?: string }): Promise<Team> {
  const rows = await query<Team>(
    `INSERT INTO agent_teams(user_id, name, description) VALUES($1,$2,$3)
     RETURNING id::int, user_id::int, name, description, archived, created_at, updated_at`,
    [userId, input.name.trim(), input.description ?? null],
  );
  return rows[0];
}
export async function updateTeam(userId: number, id: number, patch: Partial<Team>): Promise<Team | null> {
  const fields: string[] = [];
  const params: any[] = [userId, id];
  if (patch.name !== undefined) { fields.push(`name=$${params.length + 1}`); params.push(patch.name); }
  if (patch.description !== undefined) { fields.push(`description=$${params.length + 1}`); params.push(patch.description); }
  if (patch.archived !== undefined) { fields.push(`archived=$${params.length + 1}`); params.push(patch.archived); }
  if (!fields.length) return null;
  await query(`UPDATE agent_teams SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND id=$2`, params);
  const rows = await query<Team>(
    `SELECT id::int, user_id::int, name, description, archived, created_at, updated_at FROM agent_teams WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return rows[0] ?? null;
}
export async function deleteTeam(userId: number, id: number): Promise<void> {
  await query(`UPDATE agent_teams SET archived=true, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, id]);
}

// Replace full membership of a team in one call: ids = list of {agent_id, role, reports_to, position}.
export async function setTeamMembers(userId: number, teamId: number, members: { agent_id: number; role: 'lead' | 'member'; reports_to?: number | null; position?: number }[]): Promise<TeamWithMembers | null> {
  // Verify team owner
  const t = await getTeam(userId, teamId);
  if (!t) return null;
  await query(`DELETE FROM agent_team_members WHERE team_id=$1`, [teamId]);
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    await query(
      `INSERT INTO agent_team_members(team_id, agent_id, role, reports_to, position)
       VALUES($1,$2,$3,$4,$5)`,
      [teamId, m.agent_id, m.role, m.reports_to ?? null, m.position ?? i],
    );
  }
  return getTeam(userId, teamId);
}

// =====================================================================
// Team task execution
// =====================================================================
export type TeamTask = {
  id: number;
  user_id: number;
  team_id: number | null;
  agent_id: number | null;
  title: string;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  result: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};

export async function listTasks(userId: number, opts: { status?: string; limit?: number } = {}): Promise<TeamTask[]> {
  const params: any[] = [userId];
  let where = 'user_id=$1';
  if (opts.status) { params.push(opts.status); where += ` AND status=$${params.length}`; }
  params.push(Math.min(opts.limit ?? 50, 200));
  return await query<TeamTask>(
    `SELECT id::int, user_id::int, team_id::int, agent_id::int, title, prompt, status, result, error,
            cost_usd::float8, duration_ms, created_by, created_at, started_at, ended_at
     FROM team_tasks WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
}

export async function getTask(userId: number, id: number): Promise<TeamTask | null> {
  const rows = await query<TeamTask>(
    `SELECT id::int, user_id::int, team_id::int, agent_id::int, title, prompt, status, result, error,
            cost_usd::float8, duration_ms, created_by, created_at, started_at, ended_at
     FROM team_tasks WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function getTaskEvents(taskId: number): Promise<any[]> {
  return await query<any>(
    `SELECT id::int, task_id::int, ts, from_agent_id::int, to_agent_id::int, kind, content, meta
     FROM team_task_events WHERE task_id=$1 ORDER BY id`,
    [taskId],
  );
}

async function logEvent(taskId: number, kind: string, content: string | null, opts: { from?: number | null; to?: number | null; meta?: any } = {}) {
  const rows = await query<{ id: number }>(
    `INSERT INTO team_task_events(task_id, from_agent_id, to_agent_id, kind, content, meta)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id::int`,
    [taskId, opts.from ?? null, opts.to ?? null, kind, content, JSON.stringify(opts.meta ?? {})],
  );
  bus.emit('team_task:event', { taskId, eventId: rows[0]?.id, kind, ts: Date.now() });
}

export async function createTask(userId: number, input: { title: string; prompt: string; teamId?: number | null; agentId?: number | null; createdBy?: string }): Promise<TeamTask> {
  if (!input.teamId && !input.agentId) throw new Error('teamId or agentId required');
  const rows = await query<TeamTask>(
    `INSERT INTO team_tasks(user_id, team_id, agent_id, title, prompt, status, created_by)
     VALUES($1,$2,$3,$4,$5,'pending',$6)
     RETURNING id::int, user_id::int, team_id::int, agent_id::int, title, prompt, status, result, error,
               cost_usd::float8, duration_ms, created_by, created_at, started_at, ended_at`,
    [userId, input.teamId ?? null, input.agentId ?? null, input.title, input.prompt, input.createdBy ?? 'user'],
  );
  const task = rows[0];
  void runTask(userId, task.id).catch((e) => console.error('[team_task] run error', e));
  return task;
}

// Build a system prompt for an agent acting inside a team: includes its persona,
// allowed skills, the team roster (so it knows who to delegate to), and delegation rules.
function buildAgentSystemPrompt(agent: CustomAgent, team: TeamWithMembers | null, isLead: boolean): string {
  const lines: string[] = [];
  lines.push(`# ${agent.name}${agent.role ? ` — ${agent.role}` : ''}`);
  if (agent.description) lines.push(agent.description);
  lines.push('');
  lines.push(agent.system_prompt);
  if (team) {
    lines.push('');
    lines.push(`## Team: ${team.name}`);
    if (team.description) lines.push(team.description);
    lines.push('');
    lines.push('### Roster (chi puoi coinvolgere):');
    for (const m of team.members) {
      if (!m.agent || m.agent.id === agent.id) continue;
      const reports = m.reports_to ? team.members.find((x) => x.agent_id === m.reports_to)?.agent?.name : null;
      lines.push(`- **${m.agent.name}**${m.agent.role ? ` (${m.agent.role})` : ''} — id ${m.agent_id}${reports ? ` · reports to ${reports}` : ''}`);
      if (m.agent.description) lines.push(`  ${m.agent.description}`);
    }
    lines.push('');
    if (isLead) {
      lines.push('## RUOLO: Sei il LEAD del team. Devi:');
      lines.push('1. Scomporre il task in sotto-task chiari.');
      lines.push(`2. Delegare ai membri appropriati via \`mcp__${MCP_SERVER_NAME}__team_delegate\` (passa \`agent_id\` + prompt self-contained).`);
      lines.push('3. Raccogliere i risultati, fare review se necessario (ri-delegare con feedback), e produrre il deliverable finale.');
      lines.push('4. Output finale: risultato finale, niente preamboli.');
    } else {
      lines.push('## RUOLO: Sei un membro del team. Esegui il sotto-task assegnato dal lead.');
      lines.push(`- Se hai bisogno di delegare a un altro membro a cui sei superiore (reports_to inverso), usa \`mcp__${MCP_SERVER_NAME}__team_delegate\`.`);
      lines.push('- Output: risultato del tuo sotto-task, conciso, senza preamboli.');
    }
  }
  return lines.join('\n');
}

// runAgent: invoke Claude headless for one agent with its persona + skill allowlist.
// Returns text result + cost. Skill set translates to --allowed-tools.
async function runAgent(userId: number, taskId: number, agent: CustomAgent, team: TeamWithMembers | null, isLead: boolean, prompt: string, callerId: number | null = null): Promise<{ text: string; ok: boolean; cost?: number; error?: string }> {
  await logEvent(taskId, callerId ? 'delegate' : 'start', prompt.slice(0, 800), { from: callerId, to: agent.id });
  const sys = buildAgentSystemPrompt(agent, team, isLead);
  // Skill allowlist: always include MCP root (so team_delegate works) + agent.skills entries.
  const allowed = Array.from(new Set<string>([`mcp__${MCP_SERVER_NAME}`, ...agent.skills]));
  const vault = await getVaultRoot(userId);
  const ctx = activeTasks.get(taskId);
  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(),
    timeoutMs: 600_000,
    kind: `team_agent:${agent.name}`,
    model: agent.model ?? undefined,
    systemPrompt: sys,
    allowedTools: allowed,
    signal: ctx?.abort.signal,
    meta: { task_id: taskId, agent_id: agent.id, is_lead: isLead },
  });
  if (!res.ok) {
    await logEvent(taskId, 'error', res.stderr?.slice(0, 800) ?? 'failed', { from: agent.id, to: callerId, meta: { cost: res.costUsd } });
    return { text: '', ok: false, error: res.stderr?.slice(0, 800) ?? 'failed' };
  }
  await logEvent(taskId, callerId ? 'report' : 'finish', res.text.slice(0, 4000), { from: agent.id, to: callerId, meta: { cost: res.costUsd, duration_ms: res.durationMs } });
  return { text: res.text, ok: true, cost: res.costUsd };
}

// runTask: orchestrates lead → delegates. Tracked here so nested delegate calls
// (from the MCP tool) can resolve the active context.
type ActiveCtx = { userId: number; taskId: number; team: TeamWithMembers | null; callerStack: number[]; abort: AbortController };
const activeTasks = new Map<number, ActiveCtx>();

export function getActiveTaskCtx(taskId: number): ActiveCtx | undefined {
  return activeTasks.get(taskId);
}

export async function delegateToAgent(taskId: number, callerAgentId: number, targetAgentId: number, prompt: string): Promise<{ ok: boolean; result?: string; error?: string }> {
  const ctx = activeTasks.get(taskId);
  if (!ctx) return { ok: false, error: 'task not active' };
  const target = await getAgent(ctx.userId, targetAgentId);
  if (!target) return { ok: false, error: `agent ${targetAgentId} not found` };
  // Cycle guard
  if (ctx.callerStack.includes(targetAgentId)) return { ok: false, error: 'cycle: agent already in delegation stack' };
  ctx.callerStack.push(targetAgentId);
  try {
    const res = await runAgent(ctx.userId, taskId, target, ctx.team, false, prompt, callerAgentId);
    return { ok: res.ok, result: res.text, error: res.error };
  } finally {
    ctx.callerStack.pop();
  }
}

async function runTask(userId: number, taskId: number) {
  const task = await getTask(userId, taskId);
  if (!task) return;
  await query(`UPDATE team_tasks SET status='running', started_at=now() WHERE id=$1`, [taskId]);
  bus.emit('team_task:event', { taskId, kind: 'status', status: 'running' });
  await logEvent(taskId, 'start', task.prompt.slice(0, 800));

  const started = Date.now();
  try {
    let leadAgent: CustomAgent | null = null;
    let team: TeamWithMembers | null = null;
    if (task.team_id) {
      team = await getTeam(userId, task.team_id);
      if (!team) throw new Error('team not found');
      const leadMember = team.members.find((m) => m.role === 'lead') ?? team.members[0];
      if (!leadMember?.agent) throw new Error('team has no lead');
      leadAgent = leadMember.agent;
    } else if (task.agent_id) {
      leadAgent = await getAgent(userId, task.agent_id);
      if (!leadAgent) throw new Error('agent not found');
    } else {
      throw new Error('task missing team_id and agent_id');
    }

    activeTasks.set(taskId, { userId, taskId, team, callerStack: [leadAgent.id], abort: new AbortController() });
    const res = await runAgent(userId, taskId, leadAgent, team, true, task.prompt, null);
    activeTasks.delete(taskId);

    if (!res.ok) {
      await query(
        `UPDATE team_tasks SET status='error', error=$2, duration_ms=$3, ended_at=now() WHERE id=$1`,
        [taskId, res.error ?? 'failed', Date.now() - started],
      );
      bus.emit('team_task:event', { taskId, kind: 'status', status: 'error' });
      try {
        const base = (config.frontendOrigin ?? '').replace(/\/+$/, '') || 'http://localhost:5173';
        await sendTelegram(userId, `❌ **Task #${taskId}** — "${task.title}"\nFallito: ${(res.error ?? 'errore').slice(0, 200)}\n\n${base}/team-tasks/${taskId}`, `team_task:${taskId}`);
      } catch {}
      return;
    }
    const elapsed = Date.now() - started;
    await query(
      `UPDATE team_tasks SET status='done', result=$2, cost_usd=$3, duration_ms=$4, ended_at=now() WHERE id=$1`,
      [taskId, res.text, res.cost ?? null, elapsed],
    );
    bus.emit('team_task:event', { taskId, kind: 'status', status: 'done' });
    try {
      const base = (config.frontendOrigin ?? '').replace(/\/+$/, '') || 'http://localhost:5173';
      const dur = Math.round(elapsed / 1000);
      const head = `✅ **Task #${taskId} completato** — "${task.title}"\n⏱ ${dur}s${res.cost ? ` · $${res.cost.toFixed(4)}` : ''}`;
      const body = res.text.length > 2500 ? res.text.slice(0, 2500) + '\n…' : res.text;
      await sendTelegram(userId, `${head}\n\n${body}\n\n${base}/team-tasks/${taskId}`, `team_task:${taskId}`);
    } catch (e) { console.error('[team_task] telegram notify failed', e); }
  } catch (e: any) {
    activeTasks.delete(taskId);
    await query(
      `UPDATE team_tasks SET status='error', error=$2, duration_ms=$3, ended_at=now() WHERE id=$1`,
      [taskId, String(e?.message ?? e).slice(0, 800), Date.now() - started],
    );
    bus.emit('team_task:event', { taskId, kind: 'status', status: 'error' });
  }
}

export async function cancelTask(userId: number, id: number): Promise<void> {
  // Abort live Claude processes immediately
  const ctx = activeTasks.get(id);
  if (ctx) {
    try { ctx.abort.abort(); } catch {}
    await logEvent(id, 'error', 'task aborted by user', {}).catch(() => {});
  }
  await query(
    `UPDATE team_tasks SET status='cancelled', ended_at=now() WHERE user_id=$1 AND id=$2 AND status IN ('pending','running')`,
    [userId, id],
  );
  bus.emit('team_task:event', { taskId: id, kind: 'status', status: 'cancelled' });
}
