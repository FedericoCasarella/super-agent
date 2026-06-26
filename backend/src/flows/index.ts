import { query } from '../db/index.js';
import { bus } from '../bus.js';
import { runClaude } from '../claude/runner.js';
import { getVaultRoot, writeNote } from '../brain/vault.js';
import { sendTelegram } from '../telegram/bot.js';

// =====================================================================
// FLOWS — trigger-action automation engine
// =====================================================================

export type FlowTrigger = {
  id: number; flow_id: number; type: string; config: any; position: number;
};
export type FlowStep = {
  id: number; flow_id: number; position: number; type: string; name: string | null; config: any;
};
export type Flow = {
  id: number; user_id: number; name: string; description: string | null;
  enabled: boolean; archived: boolean; created_at: string; updated_at: string;
};
export type FlowFull = Flow & { triggers: FlowTrigger[]; steps: FlowStep[] };

// ---------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------
export async function listFlows(userId: number): Promise<Flow[]> {
  return await query<Flow>(
    `SELECT id::int, user_id::int, name, description, enabled, archived, created_at, updated_at
     FROM flows WHERE user_id=$1 AND archived=false ORDER BY name`,
    [userId],
  );
}
export async function getFlow(userId: number, id: number): Promise<FlowFull | null> {
  const rows = await query<Flow>(
    `SELECT id::int, user_id::int, name, description, enabled, archived, created_at, updated_at
     FROM flows WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  if (!rows[0]) return null;
  const flow = rows[0];
  const triggers = await query<FlowTrigger>(
    `SELECT id::int, flow_id::int, type, config, position FROM flow_triggers WHERE flow_id=$1 ORDER BY position, id`,
    [id],
  );
  const steps = await query<FlowStep>(
    `SELECT id::int, flow_id::int, position, type, name, config FROM flow_steps WHERE flow_id=$1 ORDER BY position, id`,
    [id],
  );
  return { ...flow, triggers, steps };
}
export async function createFlow(userId: number, input: { name: string; description?: string; enabled?: boolean }): Promise<Flow> {
  const rows = await query<Flow>(
    `INSERT INTO flows(user_id, name, description, enabled) VALUES($1,$2,$3,COALESCE($4,true))
     RETURNING id::int, user_id::int, name, description, enabled, archived, created_at, updated_at`,
    [userId, input.name.trim(), input.description ?? null, input.enabled ?? true],
  );
  return rows[0];
}
export async function updateFlow(userId: number, id: number, patch: Partial<Flow>): Promise<Flow | null> {
  const fields: string[] = [];
  const params: any[] = [userId, id];
  if (patch.name !== undefined) { fields.push(`name=$${params.length + 1}`); params.push(patch.name); }
  if (patch.description !== undefined) { fields.push(`description=$${params.length + 1}`); params.push(patch.description); }
  if (patch.enabled !== undefined) { fields.push(`enabled=$${params.length + 1}`); params.push(patch.enabled); }
  if (patch.archived !== undefined) { fields.push(`archived=$${params.length + 1}`); params.push(patch.archived); }
  if (!fields.length) return null;
  await query(`UPDATE flows SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND id=$2`, params);
  const r = await query<Flow>(
    `SELECT id::int, user_id::int, name, description, enabled, archived, created_at, updated_at FROM flows WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return r[0] ?? null;
}
export async function deleteFlow(userId: number, id: number): Promise<void> {
  await query(`UPDATE flows SET archived=true, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, id]);
}

// Triggers
export async function setTriggers(userId: number, flowId: number, triggers: { type: string; config?: any; position?: number }[]): Promise<void> {
  const owner = await query<{ id: number }>(`SELECT id FROM flows WHERE user_id=$1 AND id=$2`, [userId, flowId]);
  if (!owner[0]) throw new Error('flow not found');
  await query(`DELETE FROM flow_triggers WHERE flow_id=$1`, [flowId]);
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i];
    await query(
      `INSERT INTO flow_triggers(flow_id, type, config, position) VALUES($1,$2,$3::jsonb,$4)`,
      [flowId, t.type, JSON.stringify(t.config ?? {}), t.position ?? i],
    );
  }
}

// Steps
export async function setSteps(userId: number, flowId: number, steps: { type: string; name?: string | null; config?: any; position?: number }[]): Promise<void> {
  const owner = await query<{ id: number }>(`SELECT id FROM flows WHERE user_id=$1 AND id=$2`, [userId, flowId]);
  if (!owner[0]) throw new Error('flow not found');
  await query(`DELETE FROM flow_steps WHERE flow_id=$1`, [flowId]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await query(
      `INSERT INTO flow_steps(flow_id, position, type, name, config) VALUES($1,$2,$3,$4,$5::jsonb)`,
      [flowId, s.position ?? i, s.type, s.name ?? null, JSON.stringify(s.config ?? {})],
    );
  }
}

// ---------------------------------------------------------------------
// Runs + events
// ---------------------------------------------------------------------
export async function listRuns(userId: number, flowId: number, limit = 50): Promise<any[]> {
  return await query<any>(
    `SELECT id::int, flow_id::int, status, trigger_type, result, error, duration_ms,
            created_at, started_at, ended_at
     FROM flow_runs WHERE user_id=$1 AND flow_id=$2 ORDER BY id DESC LIMIT $3`,
    [userId, flowId, limit],
  );
}
export async function getRun(userId: number, runId: number): Promise<any | null> {
  const rows = await query<any>(
    `SELECT id::int, flow_id::int, status, trigger_type, trigger_payload, result, error,
            duration_ms, created_at, started_at, ended_at
     FROM flow_runs WHERE user_id=$1 AND id=$2`,
    [userId, runId],
  );
  if (!rows[0]) return null;
  const events = await query<any>(
    `SELECT id::int, run_id::int, step_id::int, ts, kind, content, meta
     FROM flow_run_events WHERE run_id=$1 ORDER BY id`,
    [runId],
  );
  return { ...rows[0], events };
}
async function logEvent(runId: number, kind: string, content: string | null, opts: { stepId?: number | null; meta?: any } = {}) {
  const rows = await query<{ id: number }>(
    `INSERT INTO flow_run_events(run_id, step_id, kind, content, meta) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id::int`,
    [runId, opts.stepId ?? null, kind, content, JSON.stringify(opts.meta ?? {})],
  );
  bus.emit('flow:event', { runId, kind, eventId: rows[0]?.id, ts: Date.now() });
}

// ---------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------
// Substitute {{path.to.field}} in strings using the run context (trigger payload + step outputs).
function substitute(value: any, ctx: any): any {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const parts = path.trim().split('.');
      let cur: any = ctx;
      for (const p of parts) cur = cur?.[p];
      return cur == null ? '' : String(cur);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, ctx));
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, ctx);
    return out;
  }
  return value;
}

async function runStep(userId: number, runId: number, step: FlowStep, ctx: any): Promise<{ ok: boolean; output?: any; error?: string }> {
  const config = substitute(step.config ?? {}, ctx);
  switch (step.type) {
    case 'delay': {
      const ms = Math.max(0, Math.min(60_000, Number(config.ms ?? 1000)));
      await new Promise((r) => setTimeout(r, ms));
      return { ok: true, output: { waited_ms: ms } };
    }
    case 'telegram.notify': {
      const text = String(config.text ?? '').trim();
      if (!text) return { ok: false, error: 'empty text' };
      await sendTelegram(userId, text, `flow:${ctx.flow.id}`);
      return { ok: true, output: { sent: true } };
    }
    case 'agent.run': {
      const prompt = String(config.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'empty prompt' };
      const vault = await getVaultRoot(userId);
      const res = await runClaude(userId, prompt, {
        cwd: vault ?? process.cwd(),
        timeoutMs: Number(config.timeoutMs ?? 300_000),
        kind: `flow:${ctx.flow.id}:step:${step.id}`,
        model: config.model ?? undefined,
        meta: { flow_id: ctx.flow.id, run_id: runId, step_id: step.id },
      });
      return { ok: res.ok, output: { text: res.text, cost: res.costUsd }, error: res.ok ? undefined : res.stderr?.slice(0, 300) };
    }
    case 'team.run': {
      const teams = await import('../teams/index.js');
      const teamId = Number(config.team_id ?? 0);
      const agentId = Number(config.agent_id ?? 0);
      const title = String(config.title ?? `Flow ${ctx.flow.id} step ${step.id}`);
      const prompt = String(config.prompt ?? '').trim();
      if (!prompt) return { ok: false, error: 'empty prompt' };
      if (!teamId && !agentId) return { ok: false, error: 'team_id or agent_id required' };
      const task = await teams.createTask(userId, { title, prompt, teamId: teamId || null, agentId: agentId || null, createdBy: 'flow' });
      return { ok: true, output: { task_id: task.id } };
    }
    case 'email.send': {
      const im = await import('../connectors/builtin/imap/index.js');
      const account = String(config.account ?? '');
      const to = String(config.to ?? '');
      const subject = String(config.subject ?? '');
      const body = String(config.body ?? '');
      if (!account || !to) return { ok: false, error: 'account + to required' };
      const draft = await im.createDraft(userId, account, { to, subject, body });
      const sent = await im.sendDraft(userId, draft.id);
      return { ok: true, output: { sent: sent.status === 'sent', draft_id: draft.id } };
    }
    case 'whatsapp.send': {
      const wa = await import('../connectors/builtin/whatsapp/index.js');
      const jid = String(config.chat_jid ?? '');
      const text = String(config.text ?? '');
      if (!jid || !text) return { ok: false, error: 'chat_jid + text required' };
      const r = await wa.sendWaMessage(userId, jid, text, `flow:${ctx.flow.id}`);
      return { ok: r.ok, output: { sent: r.ok }, error: r.error };
    }
    case 'instagram.send': {
      const ig = await import('../connectors/builtin/instagram/index.js');
      const tid = String(config.thread_id ?? '');
      const text = String(config.text ?? '');
      if (!tid || !text) return { ok: false, error: 'thread_id + text required' };
      const r = await ig.sendIgMessage(userId, tid, text, `flow:${ctx.flow.id}`, 'ai');
      return { ok: r.ok, output: { sent: r.ok }, error: r.error };
    }
    case 'brain.write_note': {
      const path = String(config.path ?? '');
      const body = String(config.body ?? '');
      if (!path) return { ok: false, error: 'path required' };
      const fm = config.frontmatter ?? { kind: 'flow', flow_id: ctx.flow.id };
      const full = await writeNote(userId, path, fm, body);
      return { ok: true, output: { path: full } };
    }
    case 'webhook': {
      const url = String(config.url ?? '');
      const method = String(config.method ?? 'POST');
      if (!url) return { ok: false, error: 'url required' };
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(config.body ?? ctx),
      });
      return { ok: r.ok, output: { status: r.status } };
    }
    case 'condition': {
      // config.expr like "{{trigger.text}} contains 'urgent'"; very simple subset
      const expr = String(config.expr ?? '');
      const truthy = !!expr.trim() && !/false|0|null|undefined/i.test(expr);
      return { ok: true, output: { branch: truthy } };
    }
    default:
      return { ok: false, error: `unknown step type: ${step.type}` };
  }
}

export async function runFlow(userId: number, flowId: number, triggerType: string, payload: any): Promise<number | null> {
  const full = await getFlow(userId, flowId);
  if (!full || !full.enabled || full.archived) return null;
  const ins = await query<{ id: number }>(
    `INSERT INTO flow_runs(flow_id, user_id, status, trigger_type, trigger_payload)
     VALUES($1,$2,'running',$3,$4::jsonb)
     RETURNING id::int`,
    [flowId, userId, triggerType, JSON.stringify(payload ?? {})],
  );
  const runId = ins[0]?.id;
  if (!runId) return null;
  bus.emit('flow:event', { runId, kind: 'start', ts: Date.now() });
  const started = Date.now();
  await query(`UPDATE flow_runs SET started_at=now() WHERE id=$1`, [runId]);
  await logEvent(runId, 'start', `triggered by ${triggerType}`, { meta: { payload } });
  const ctx: any = { trigger: payload ?? {}, flow: full, outputs: {} };
  let lastOutput: any = null;
  try {
    for (const step of full.steps) {
      await logEvent(runId, 'step.start', step.name ?? step.type, { stepId: step.id });
      const res = await runStep(userId, runId, step, ctx);
      ctx.outputs[String(step.id)] = res.output;
      lastOutput = res.output;
      if (res.ok) {
        await logEvent(runId, 'step.done', JSON.stringify(res.output).slice(0, 1000), { stepId: step.id, meta: { output: res.output } });
      } else {
        await logEvent(runId, 'step.error', res.error ?? 'failed', { stepId: step.id });
        await query(
          `UPDATE flow_runs SET status='error', error=$2, duration_ms=$3, ended_at=now() WHERE id=$1`,
          [runId, (res.error ?? 'failed').slice(0, 800), Date.now() - started],
        );
        bus.emit('flow:event', { runId, kind: 'status', status: 'error' });
        return runId;
      }
    }
    await query(
      `UPDATE flow_runs SET status='done', result=$2, duration_ms=$3, ended_at=now() WHERE id=$1`,
      [runId, JSON.stringify(lastOutput).slice(0, 4000), Date.now() - started],
    );
    await logEvent(runId, 'finish', 'ok');
    bus.emit('flow:event', { runId, kind: 'status', status: 'done' });
    return runId;
  } catch (e: any) {
    await query(
      `UPDATE flow_runs SET status='error', error=$2, duration_ms=$3, ended_at=now() WHERE id=$1`,
      [runId, String(e?.message ?? e).slice(0, 800), Date.now() - started],
    );
    await logEvent(runId, 'error', String(e?.message ?? e));
    bus.emit('flow:event', { runId, kind: 'status', status: 'error' });
    return runId;
  }
}

// ---------------------------------------------------------------------
// Trigger dispatch — listen to bus events, find matching flows, fire
// ---------------------------------------------------------------------
type TriggerMatch = (cfg: any, payload: any) => boolean;
const TRIGGER_MATCHERS: Record<string, TriggerMatch> = {
  'whatsapp.received': (cfg, p) => !cfg.chat_jid || cfg.chat_jid === p.msg?.chat_jid,
  'email.received':   (cfg, p) => !cfg.account || cfg.account === p.account,
  'voice.received':   () => true,
  'telegram.received':(cfg, p) => !cfg.contains || String(p.text ?? '').toLowerCase().includes(String(cfg.contains).toLowerCase()),
  'agent.finished':   (cfg, p) => !cfg.agent_name || cfg.agent_name === p.agentName,
  'brain.node_added': (cfg, p) => !cfg.kind || cfg.kind === p.kind,
  'task.triggered':   (cfg, p) => !cfg.task_id || Number(cfg.task_id) === Number(p.taskId),
  'perk.fired':       (cfg, p) => !cfg.perk_name || cfg.perk_name === p.name,
  'team.fired':       (cfg, p) => !cfg.team_id || Number(cfg.team_id) === Number(p.teamId),
};

// True iff at least one enabled, non-archived flow has a trigger of this type
// for this user. Orchestrator uses it to skip its default reply when the user
// has explicitly wired a flow to handle the channel — otherwise both fire and
// the user gets two answers.
export async function hasFlowForTrigger(userId: number, triggerType: string): Promise<boolean> {
  // Only count flows that ACTUALLY have steps wired up. An empty flow with
  // just a trigger and zero steps would silently swallow the message — the
  // orchestrator skipped its default reply and the flow had nothing to run.
  // Result: user sent message, got nothing back.
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM flow_triggers t
     JOIN flows f ON f.id=t.flow_id
     WHERE t.type=$1 AND f.user_id=$2 AND f.enabled=true AND f.archived=false
       AND EXISTS(SELECT 1 FROM flow_steps s WHERE s.flow_id=f.id)`,
    [triggerType, userId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function dispatchTrigger(triggerType: string, userId: number, payload: any) {
  const rows = await query<{ flow_id: number; user_id: number; cfg: any }>(
    `SELECT t.flow_id::int, f.user_id::int, t.config AS cfg
     FROM flow_triggers t JOIN flows f ON f.id=t.flow_id
     WHERE t.type=$1 AND f.user_id=$2 AND f.enabled=true AND f.archived=false`,
    [triggerType, userId],
  );
  const matcher = TRIGGER_MATCHERS[triggerType] ?? (() => true);
  for (const r of rows) {
    if (!matcher(r.cfg, payload)) continue;
    void runFlow(userId, r.flow_id, triggerType, payload).catch((e) => console.error('[flows] runFlow', e));
  }
}

let busAttached = false;
export function attachFlowDispatchers() {
  if (busAttached) return;
  busAttached = true;
  // WhatsApp incoming. Il payload bus ha i campi NIDIFICATI sotto `msg`, ma i
  // template dei flow usano {{trigger.text}}/{{trigger.sender}}/{{trigger.chatName}}
  // → aggiungo alias FLAT così i flow ricevono i dati (prima erano sempre vuoti
  // → l'agente rispondeva "silenzio" a ogni messaggio). Salto i messaggi MIEI
  // (from_me) e quelli senza testo: niente triage a vuoto.
  bus.on('wa:message', (m: any) => {
    if (!m?.userId) return;
    const msg = m.msg ?? {};
    if (msg.from_me) return;                       // non triagare i miei stessi messaggi
    if (!String(msg.text ?? '').trim()) return;    // niente testo → niente da valutare
    dispatchTrigger('whatsapp.received', m.userId, {
      ...m,
      text: msg.text ?? '',
      sender: msg.sender_name ?? msg.sender_phone ?? msg.sender_jid ?? '',
      senderPhone: msg.sender_phone ?? '',
      chatName: msg.is_group ? (msg.group_jid ?? msg.chat_jid ?? '') : (msg.sender_name ?? msg.chat_jid ?? ''),
      isGroup: !!msg.is_group,
      personSlug: msg.person_slug ?? null,
    });
  });
  // Instagram DM incoming
  bus.on('ig:message', (m: any) => { if (m?.userId) dispatchTrigger('instagram.received', m.userId, m); });
  // Telegram incoming
  bus.on('telegram:incoming', (m: any) => { if (m?.userId) dispatchTrigger('telegram.received', m.userId, m); });
  // Voice transcribed (telegram bot emits as telegram:incoming with transcript text; we also rebroadcast)
  // Email — placeholder, no current event
  // Agent finished (subagent done)
  bus.on('subagent:event', (m: any) => {
    if (m?.userId && m?.kind === 'done') dispatchTrigger('agent.finished', m.userId, { agentName: m.title, ...m });
  });
  // Perk fired (internal_agents): we add an emit on registry; for now hook via team_task done as a proxy
  bus.on('team_task:event', (m: any) => {
    if (m?.userId && m?.kind === 'status' && m?.status === 'done') dispatchTrigger('team.fired', m.userId, m);
  });
  // Brain node added — emitted by writeNote (brain:access kind='write') — re-route as brain.node_added
  bus.on('brain:access', (m: any) => {
    if (m?.userId && m?.tool === 'write') dispatchTrigger('brain.node_added', m.userId, { path: m.rel, kind: 'note' });
  });
  console.log('[flows] dispatchers attached');
}

// Schedule trigger ticker — every 60s scan upcoming schedule.datetime + schedule.cron triggers
import cron from 'node-cron';
let schedulerArmed = false;
export function startFlowScheduler() {
  if (schedulerArmed) return;
  schedulerArmed = true;
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      // schedule.datetime: one-shot at config.at
      const dt = await query<{ flow_id: number; user_id: number; cfg: any; tid: number }>(
        `SELECT t.flow_id::int, f.user_id::int, t.config AS cfg, t.id::int AS tid
         FROM flow_triggers t JOIN flows f ON f.id=t.flow_id
         WHERE t.type='schedule.datetime' AND f.enabled=true AND f.archived=false`,
      );
      for (const r of dt) {
        const at = r.cfg?.at ? new Date(r.cfg.at) : null;
        if (!at) continue;
        if (Math.abs(at.getTime() - now.getTime()) > 60_000) continue;
        const last = r.cfg?._lastFired ? new Date(r.cfg._lastFired) : null;
        if (last && now.getTime() - last.getTime() < 5 * 60_000) continue;
        await query(
          `UPDATE flow_triggers SET config = jsonb_set(config, '{_lastFired}', to_jsonb($2::text)) WHERE id=$1`,
          [r.tid, now.toISOString()],
        );
        await runFlow(r.user_id, r.flow_id, 'schedule.datetime', { at: r.cfg.at });
      }
      // schedule.cron: parse cron expression (minute resolution)
      const cr = await query<{ flow_id: number; user_id: number; cfg: any }>(
        `SELECT t.flow_id::int, f.user_id::int, t.config AS cfg
         FROM flow_triggers t JOIN flows f ON f.id=t.flow_id
         WHERE t.type='schedule.cron' AND f.enabled=true AND f.archived=false`,
      );
      for (const r of cr) {
        if (!r.cfg?.cron) continue;
        if (!cron.validate(r.cfg.cron)) continue;
        // Quick-and-dirty: match if cron expression equates to current minute via cron-parser.
        try {
          const cp = await import('cron-parser');
          const interval: any = (cp as any).default ? (cp as any).default.parseExpression(r.cfg.cron) : (cp as any).parseExpression(r.cfg.cron);
          const prev: Date = interval.prev().toDate();
          if (Math.abs(prev.getTime() - now.getTime()) < 65_000) {
            await runFlow(r.user_id, r.flow_id, 'schedule.cron', { cron: r.cfg.cron });
          }
        } catch {}
      }
    } catch (e) { console.error('[flows] scheduler tick', e); }
  });
  console.log('[flows] scheduler armed (1-min tick, datetime + cron)');
}
