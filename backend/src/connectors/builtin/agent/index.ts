import type { Connector } from '../../types.js';
import { getSetting, setSetting, query } from '../../../db/index.js';
import { readNote, writeNote } from '../../../brain/vault.js';
import { bus } from '../../../bus.js';
import { getPrimaryVault } from '../../../brain/vaults.js';
import * as net from '../../../network/index.js';
import * as subAgents from '../../../sub_agents/index.js';
import * as roadmapV2 from '../../../roadmap/index.js';

const ROADMAP_PATH = 'meta/business-roadmap.md';

const EMPTY_ROADMAP = `# Business Roadmap

> Auto-managed by the agent. Each item has a status: \`pending\`, \`ready\`, \`in_progress\`, \`done\`, \`blocked\`.

## Discovery (info to gather from user)

- [ ] Pending: define current MRR / revenue baseline
- [ ] Pending: identify single biggest bottleneck right now
- [ ] Pending: capture top 3 offers and their conversion rates
- [ ] Pending: clarify ideal customer (avatar, pain, willingness-to-pay)
- [ ] Pending: list current acquisition channels with weekly volume
- [ ] Pending: time audit — where does the user actually spend hours

## Strategy (auto-filled once discovery is complete)

_empty_

## Execution (90-day plays)

_empty_

## Review log

- ${new Date().toISOString().slice(0,10)}: roadmap initialized
`;

const connector: Connector = {
  manifest: {
    name: 'agent',
    title: 'Agent self-control',
    description: 'Internal tools: quiet mode, sleep scheduling, roadmap management.',
    configSchema: [],
  },
  tools: [
    {
      name: 'flows_list',
      description: 'List automation flows: name, enabled state, trigger count, step count. Use when user asks "che flow ho", "lista flow", "i miei flussi", "what automations are active".',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const m = await import('../../../flows/index.js');
        const flows = await m.listFlows(ctx.userId);
        const out = [];
        for (const f of flows) {
          const full = await m.getFlow(ctx.userId, f.id);
          out.push({ id: f.id, name: f.name, enabled: f.enabled, description: f.description, triggers: full?.triggers.length ?? 0, steps: full?.steps.length ?? 0 });
        }
        return { flows: out };
      },
    },
    {
      name: 'flows_get',
      description: 'Get full flow detail (triggers + steps with configs) by id. Use before flows_update to know current state.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false },
      handler: async (ctx, { id }) => {
        const m = await import('../../../flows/index.js');
        const f = await m.getFlow(ctx.userId, id);
        if (!f) throw new Error('flow not found');
        return f;
      },
    },
    {
      name: 'flows_create',
      description: 'Create a new flow. Optionally seed triggers + steps in one call. Supported trigger types: whatsapp.received, email.received, voice.received, telegram.received, schedule.datetime, schedule.cron, agent.finished, brain.node_added, task.triggered, perk.fired, team.fired. Supported step types: agent.run, telegram.notify, team.run, email.send, whatsapp.send, brain.write_note, delay, webhook, condition.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          triggers: { type: 'array', items: { type: 'object' } },
          steps: { type: 'array', items: { type: 'object' } },
        },
        required: ['name'], additionalProperties: false,
      },
      handler: async (ctx, { name, description, enabled, triggers, steps }) => {
        const m = await import('../../../flows/index.js');
        const f = await m.createFlow(ctx.userId, { name, description, enabled });
        if (Array.isArray(triggers) && triggers.length) await m.setTriggers(ctx.userId, f.id, triggers);
        if (Array.isArray(steps) && steps.length) await m.setSteps(ctx.userId, f.id, steps);
        return await m.getFlow(ctx.userId, f.id);
      },
    },
    {
      name: 'flows_update',
      description: 'Update flow metadata (name, description, enabled). For triggers/steps use flows_set_triggers / flows_set_steps.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, name: { type: 'string' }, description: { type: 'string' }, enabled: { type: 'boolean' } },
        required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id, ...patch }) => {
        const m = await import('../../../flows/index.js');
        const r = await m.updateFlow(ctx.userId, id, patch);
        if (!r) throw new Error('flow not found');
        return r;
      },
    },
    {
      name: 'flows_set_triggers',
      description: 'Replace full trigger list of a flow. Each trigger: {type, config}.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, triggers: { type: 'array', items: { type: 'object' } } },
        required: ['id', 'triggers'], additionalProperties: false,
      },
      handler: async (ctx, { id, triggers }) => {
        const m = await import('../../../flows/index.js');
        await m.setTriggers(ctx.userId, id, triggers);
        return await m.getFlow(ctx.userId, id);
      },
    },
    {
      name: 'flows_set_steps',
      description: 'Replace full step list of a flow. Each step: {type, name?, config}. Step order = array order.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, steps: { type: 'array', items: { type: 'object' } } },
        required: ['id', 'steps'], additionalProperties: false,
      },
      handler: async (ctx, { id, steps }) => {
        const m = await import('../../../flows/index.js');
        await m.setSteps(ctx.userId, id, steps);
        return await m.getFlow(ctx.userId, id);
      },
    },
    {
      name: 'flows_delete',
      description: 'Archive (soft-delete) a flow by id. Run history preserved.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false },
      handler: async (ctx, { id }) => {
        const m = await import('../../../flows/index.js');
        await m.deleteFlow(ctx.userId, id);
        return { ok: true };
      },
    },
    {
      name: 'flows_run_now',
      description: 'Manually trigger a flow run, optionally with custom payload (available as {{trigger.*}} in step configs).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' }, payload: { type: 'object' } },
        required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id, payload }) => {
        const m = await import('../../../flows/index.js');
        const runId = await m.runFlow(ctx.userId, id, 'manual', payload ?? {});
        return { ok: true, run_id: runId };
      },
    },
    {
      name: 'teams_list',
      description: 'List user-defined custom agents and teams. Use when planning a task to decide if an existing agent/team fits or a new one is needed.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const t = await import('../../../teams/index.js');
        const [agents, teams] = await Promise.all([t.listAgents(ctx.userId), t.listTeams(ctx.userId)]);
        return {
          agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, description: a.description, skills: a.skills })),
          teams: teams.map((tm) => ({ id: tm.id, name: tm.name, description: tm.description })),
        };
      },
    },
    {
      name: 'team_create_task',
      description: 'Create and START a task for a team or a single custom agent. Prefer existing teams/agents over creating new ones. If indecisive on which agent/team to pick, ASK the user first (do NOT call this tool blindly). Returns task_id. The task runs async; monitor via team_task_get.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          prompt: { type: 'string', description: 'Self-contained brief: goal, context, deliverable spec, constraints. Lead agent receives this.' },
          team_id: { type: 'number', description: 'Either team_id OR agent_id (not both).' },
          agent_id: { type: 'number' },
        },
        required: ['title', 'prompt'], additionalProperties: false,
      },
      handler: async (ctx, { title, prompt, team_id, agent_id }) => {
        if (!team_id && !agent_id) throw new Error('team_id or agent_id required');
        const t = await import('../../../teams/index.js');
        const task = await t.createTask(ctx.userId, { title, prompt, teamId: team_id ?? null, agentId: agent_id ?? null, createdBy: 'agent' });
        return { task_id: task.id, status: task.status };
      },
    },
    {
      name: 'team_task_get',
      description: 'Read status + result + recent events for a team task.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'number' } }, required: ['task_id'], additionalProperties: false },
      handler: async (ctx, { task_id }) => {
        const t = await import('../../../teams/index.js');
        const task = await t.getTask(ctx.userId, task_id);
        if (!task) throw new Error('task not found');
        const events = await t.getTaskEvents(task_id);
        return { task, events: events.slice(-30) };
      },
    },
    {
      name: 'team_delegate',
      description: 'INTERNAL — called by agents running INSIDE a team task to delegate a sub-task to another team member. Requires active task context (auto-resolved from the calling agent run). Returns the delegated agent\'s response synchronously.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'number' },
          from_agent_id: { type: 'number' },
          to_agent_id: { type: 'number' },
          prompt: { type: 'string' },
        },
        required: ['task_id', 'from_agent_id', 'to_agent_id', 'prompt'], additionalProperties: false,
      },
      handler: async (_ctx, { task_id, from_agent_id, to_agent_id, prompt }) => {
        const t = await import('../../../teams/index.js');
        return await t.delegateToAgent(task_id, from_agent_id, to_agent_id, prompt);
      },
    },
    {
      name: 'brain_search',
      description: 'MANDATORY first step on EVERY user turn. Fast full-text + tag search over the second-brain index. Returns top-N matching notes with path, title, tags, summary. Emits brain:access events for the MRI animation. Call this BEFORE composing your reply, for ANY topic (person, project, fact, decision, history). If user mentions a name → also call people_search. NEVER answer from memory if the brain might know.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Free-text query. Use 1-5 keywords or a person/entity name.' },
          limit: { type: 'number', description: 'Max results (default 8, max 20).' },
        },
        required: ['q'], additionalProperties: false,
      },
      handler: async (ctx, { q, limit }) => {
        const lim = Math.max(1, Math.min(20, Number(limit ?? 8)));
        const term = String(q ?? '').trim();
        if (!term) return { results: [], note: 'empty query' };
        const like = `%${term.toLowerCase()}%`;
        const rows = await query<any>(
          `SELECT path, kind, title, tags, summary, visibility, updated_at
           FROM brain_index
           WHERE user_id=$1 AND (
             lower(coalesce(title,'')) LIKE $2
             OR lower(coalesce(summary,'')) LIKE $2
             OR lower(path) LIKE $2
             OR EXISTS(SELECT 1 FROM unnest(coalesce(tags, ARRAY[]::text[])) t WHERE lower(t) LIKE $2)
           )
           ORDER BY
             CASE WHEN lower(coalesce(title,'')) LIKE $2 THEN 0 ELSE 1 END,
             updated_at DESC
           LIMIT $3`,
          [ctx.userId, like, lim],
        );
        // Emit brain:access for MRI animation — use real primary vault name
        const primary = await getPrimaryVault(ctx.userId).catch(() => null);
        const vaultName = primary?.name ?? 'default';
        for (const r of rows) {
          bus.emit('brain:access', {
            userId: ctx.userId,
            vaultName,
            rel: r.path,
            tool: 'brain_search',
            ts: Date.now(),
          });
        }
        return {
          count: rows.length,
          results: rows.map((r) => ({
            path: r.path, title: r.title, kind: r.kind, tags: r.tags,
            summary: (r.summary ?? '').slice(0, 200), visibility: r.visibility,
            updated_at: r.updated_at,
          })),
          hint: rows.length === 0 ? 'No match — try broader keywords or call Glob/Grep directly.' : `Read full content via Read tool on top results.`,
        };
      },
    },
    {
      name: 'set_push_threshold',
      description: 'Calibrate how often the agent pushes the user with questions/commitments. Threshold 0-10. Lower = more aggressive (default 6). Use when user says "smettila di farmi domande", "sii meno insistente", "puoi spingermi di più", or similar.',
      inputSchema: {
        type: 'object',
        properties: { threshold: { type: 'number', minimum: 0, maximum: 10, description: '0=never push, 10=always push, default=6' } },
        required: ['threshold'], additionalProperties: false,
      },
      handler: async (ctx, { threshold }) => {
        const v = Math.max(0, Math.min(10, Number(threshold)));
        const existing = (await getSetting<any>(ctx.userId, 'profile')) ?? {};
        await setSetting(ctx.userId, 'profile', { ...existing, push_threshold: v });
        return { ok: true, push_threshold: v };
      },
    },
    {
      name: 'set_quiet',
      description: 'Stop proactive pings until a given timestamp.',
      inputSchema: {
        type: 'object',
        properties: { until: { type: 'string' }, reason: { type: 'string' } },
        required: ['until'], additionalProperties: false,
      },
      handler: async (ctx, { until, reason }) => {
        await setSetting(ctx.userId, 'agent_quiet_until', { until, reason: reason ?? null, setAt: new Date().toISOString() });
        return { ok: true, quiet_until: until };
      },
    },
    {
      name: 'clear_quiet',
      description: 'Resume proactive pings immediately.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => { await setSetting(ctx.userId, 'agent_quiet_until', null); return { ok: true }; },
    },
    {
      name: 'get_quiet_state',
      description: 'Read current quiet mode state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const s = await getSetting<any>(ctx.userId, 'agent_quiet_until');
        if (!s?.until) return { quiet: false };
        return { quiet: new Date(s.until) > new Date(), until: s.until, reason: s.reason };
      },
    },
    {
      name: 'sleep_until',
      description: 'Put the reflection loop to sleep until a given timestamp.',
      inputSchema: {
        type: 'object',
        properties: { until: { type: 'string' }, reason: { type: 'string' } },
        required: ['until'], additionalProperties: false,
      },
      handler: async (ctx, { until, reason }) => {
        await setSetting(ctx.userId, 'agent_next_reflection_at', { until, reason: reason ?? null, setAt: new Date().toISOString() });
        return { ok: true, next_at: until };
      },
    },
    {
      name: 'wake_now',
      description: 'Cancel any pending sleep.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => { await setSetting(ctx.userId, 'agent_next_reflection_at', null); return { ok: true }; },
    },
    {
      name: 'roadmap_get',
      description: 'Read the current business roadmap. Creates empty scaffold if missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        let note = await readNote(ctx.userId, ROADMAP_PATH);
        if (!note) {
          await writeNote(ctx.userId, ROADMAP_PATH, { kind: 'roadmap', title: 'Business Roadmap', tags: ['roadmap', 'meta'] }, EMPTY_ROADMAP);
          note = await readNote(ctx.userId, ROADMAP_PATH);
        }
        return { path: ROADMAP_PATH, content: note?.content ?? '' };
      },
    },
    {
      name: 'roadmap_update',
      description: 'Overwrite the entire roadmap with new markdown.',
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'], additionalProperties: false,
      },
      handler: async (ctx, { content }) => {
        await writeNote(ctx.userId, ROADMAP_PATH, { kind: 'roadmap', title: 'Business Roadmap', tags: ['roadmap', 'meta'], updated: new Date().toISOString() }, content);
        return { ok: true, path: ROADMAP_PATH };
      },
    },
    {
      name: 'vaults_list',
      description: 'List the user\'s connected brains (vaults). Each has name, path, and whether it is primary.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const m = await import('../../../brain/vaults.js');
        return m.listVaults(ctx.userId);
      },
    },
    {
      name: 'vaults_create',
      description: 'Create / connect a new brain (vault). `name` is a short slug. `path` is an absolute folder path. `seed` (default true) creates standard subfolders. `makePrimary` (default false) sets it as the active brain.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          seed: { type: 'boolean', default: true },
          makePrimary: { type: 'boolean', default: false },
        },
        required: ['name', 'path'], additionalProperties: false,
      },
      handler: async (ctx, { name, path, seed, makePrimary }) => {
        const m = await import('../../../brain/vaults.js');
        return m.createVault(ctx.userId, name, path, { seed: seed !== false, makePrimary: !!makePrimary });
      },
    },
    {
      name: 'vaults_set_primary',
      description: 'Make a vault the primary brain (becomes cwd for chat turns).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'number' } },
        required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id }) => {
        const m = await import('../../../brain/vaults.js');
        await m.setPrimaryVault(ctx.userId, id);
        return { ok: true };
      },
    },
    {
      name: 'network_peers',
      description: 'List my brain-network peers (connected users). Shows connection status and direction.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => net.listPeers(ctx.userId),
    },
    {
      name: 'network_request_connection',
      description: 'Request a brain-network connection with another user by email. They must accept before queries can flow.',
      inputSchema: {
        type: 'object',
        properties: { email: { type: 'string' } },
        required: ['email'], additionalProperties: false,
      },
      handler: async (ctx, { email }) => net.requestConnection(ctx.userId, email),
    },
    {
      name: 'network_respond_connection',
      description: 'Accept or block an incoming connection request.',
      inputSchema: {
        type: 'object',
        properties: { connection_id: { type: 'number' }, accept: { type: 'boolean' } },
        required: ['connection_id', 'accept'], additionalProperties: false,
      },
      handler: async (ctx, { connection_id, accept }) => net.respondConnection(ctx.userId, connection_id, !!accept),
    },
    {
      name: 'network_query_peer',
      description: 'Ask a connected peer\'s brain a question. `target` can be an email OR a name/surname (e.g. "Mattia", "Mattia Calastri") — matched fuzzy among your accepted peers. Triggers human-in-the-loop review.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Peer email or name/surname.' },
          query: { type: 'string', description: 'Natural-language question to ask the peer\'s brain.' },
        },
        required: ['target', 'query'], additionalProperties: false,
      },
      handler: async (ctx, { target, query: q }) => net.createShareRequest(ctx.userId, target, q),
    },
    {
      name: 'network_resolve_peer',
      description: 'Resolve a name or email to a peer record. Use when uncertain which peer the user means.',
      inputSchema: {
        type: 'object',
        properties: { identifier: { type: 'string' } },
        required: ['identifier'], additionalProperties: false,
      },
      handler: async (ctx, { identifier }) => net.resolvePeer(ctx.userId, identifier),
    },
    {
      name: 'network_pending_incoming',
      description: 'List share requests waiting for my approval (other users asking my brain).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => net.listIncomingShareRequests(ctx.userId),
    },
    {
      name: 'network_pending_outgoing',
      description: 'List share requests I sent and their status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => net.listOutgoingShareRequests(ctx.userId),
    },
    {
      name: 'network_approve_share',
      description: 'Approve a brain-share request, picking which candidate notes to actually share.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'number' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Subset of candidate paths to share. Empty = share nothing (use deny instead).' },
        },
        required: ['request_id', 'paths'], additionalProperties: false,
      },
      handler: async (ctx, { request_id, paths }) => net.approveShareRequest(ctx.userId, request_id, paths),
    },
    {
      name: 'network_deny_share',
      description: 'Deny a brain-share request with optional reason.',
      inputSchema: {
        type: 'object',
        properties: { request_id: { type: 'number' }, reason: { type: 'string' } },
        required: ['request_id'], additionalProperties: false,
      },
      handler: async (ctx, { request_id, reason }) => net.denyShareRequest(ctx.userId, request_id, reason),
    },
    {
      name: 'change_user_password',
      description: 'Cambia password account web super-agent dell\'utente. USA SOLO SU RICHIESTA ESPLICITA dell\'utente nel messaggio corrente (es. "cambia password a X", "imposta password nuova: X"). MAI in autonomia. MAI inferire. Password min 8 chars. Conferma in chat dopo successo senza ripetere la password.',
      inputSchema: {
        type: 'object',
        properties: { newPassword: { type: 'string', minLength: 8, description: 'Nuova password in chiaro (min 8 char). Non logga.' } },
        required: ['newPassword'], additionalProperties: false,
      },
      handler: async (ctx, { newPassword }) => {
        const { setUserPassword } = await import('../../../auth/index.js');
        try {
          await setUserPassword(ctx.userId, newPassword);
          console.log(`[agent:u${ctx.userId}] password changed via telegram`);
          return { ok: true };
        } catch (e: any) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
    },
    {
      name: 'telegram_react',
      description: 'React with an emoji to the last incoming Telegram message (or a specific message_id). Use SPARINGLY — only when reaction is more appropriate than a text reply: acknowledgment of a small update ("ok 👍"), agreement (❤️/🔥), celebration (🎉), comprehension (🤔). Do NOT react to every message. If reacting, you can SKIP the text reply (return empty string).',
      inputSchema: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'One emoji. Allowed: 👍 ❤ 🔥 🎉 👌 🙏 🤔 👏 😁 🤯 😱 😢 🤩 💯 ⚡ 🏆 ✍ 🫡 👀 😇 🤝 🆒' },
          messageId: { type: 'number', description: 'Optional explicit Telegram message_id. Defaults to last incoming.' },
        },
        required: ['emoji'], additionalProperties: false,
      },
      handler: async (ctx, { emoji, messageId }) => {
        const last = await getSetting<{ chatId: number; messageId: number }>(ctx.userId, 'telegram_last_incoming');
        if (!last?.chatId) return { ok: false, error: 'no telegram chat known' };
        const mid = messageId ?? last.messageId;
        if (!mid) return { ok: false, error: 'no message_id' };
        const { sendReaction } = await import('../../../telegram/bot.js');
        const ok = await sendReaction(ctx.userId, last.chatId, mid, emoji);
        return { ok, emoji, messageId: mid };
      },
    },
    {
      name: 'propose_agents',
      description: 'Propose to spawn one or more sub-agents in parallel. Sends a yes/no Telegram prompt to the user. Each agent gets a complete self-contained prompt (no shared memory). USE THIS instead of doing big async work yourself when: (a) the work is parallelizable, (b) you can let the user offload it, (c) tasks > 30s. After approval, sub-agents run in background; user sees them in /agents portal + Telegram /agents command.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One-line headline for the batch (e.g. "Landing + Pricing in parallelo")' },
          reason: { type: 'string', description: 'Why you want to spawn these (1-2 lines, user-facing)' },
          proposals: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short label (3-6 words)' },
                brief: { type: 'string', description: 'One-line user-facing summary' },
                prompt: { type: 'string', description: 'Full self-contained prompt for the sub-agent. Include all context (no shared memory). Be specific about deliverable + file path.' },
              },
              required: ['title', 'brief', 'prompt'], additionalProperties: false,
            },
          },
        },
        required: ['title', 'proposals'], additionalProperties: false,
      },
      handler: async (ctx, { title, reason, proposals }) => {
        const p = await subAgents.createProposal(ctx.userId, title, reason ?? null, proposals);
        return { ok: true, proposalId: p.id, status: p.status, awaitingApproval: true };
      },
    },
    {
      name: 'agents_list',
      description: 'List current sub-agents (running, done, error). Use to report state when user asks "what are you working on" or before proposing new ones.',
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: ['pending', 'running', 'done', 'error', 'cancelled'] } },
        additionalProperties: false,
      },
      handler: async (ctx, { status }) => {
        const list = await subAgents.listSubAgents(ctx.userId, { status, limit: 50 });
        return list.map((s) => ({ id: s.id, title: s.title, brief: s.brief, status: s.status, started_at: s.started_at, ended_at: s.ended_at }));
      },
    },
    {
      name: 'roadmap_set_status',
      description: 'Toggle a single roadmap item by matching a substring of its line.',
      inputSchema: {
        type: 'object',
        properties: {
          match: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'] },
          note: { type: 'string' },
        },
        required: ['match', 'status'], additionalProperties: false,
      },
      handler: async (ctx, { match, status, note }) => {
        const cur = await readNote(ctx.userId, ROADMAP_PATH);
        if (!cur) return { ok: false, error: 'roadmap missing' };
        const marker = { pending: '[ ]', in_progress: '[~]', done: '[x]', blocked: '[!]' }[status as string]!;
        const lines = cur.content.split('\n');
        let touched = 0;
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (!/^\s*-\s\[.\]/.test(l)) continue;
          if (!l.toLowerCase().includes(String(match).toLowerCase())) continue;
          lines[i] = l.replace(/\[.\]/, marker) + (note ? ` _(${note})_` : '');
          touched++;
        }
        if (!touched) return { ok: false, error: 'no matching item' };
        const review = `\n- ${new Date().toISOString().slice(0,10)}: ${touched} item(s) → ${status}${note ? ` (${note})` : ''}`;
        const updated = lines.join('\n').replace(/(## Review log[\s\S]*?)$/, `$1${review}`);
        await writeNote(ctx.userId, ROADMAP_PATH, { kind: 'roadmap', title: 'Business Roadmap', tags: ['roadmap', 'meta'], updated: new Date().toISOString() }, updated);
        return { ok: true, touched };
      },
    },
    // =====================================================================
    // Roadmap v2 — JSON-backed structured roadmap powering the UI.
    // Mirror of the legacy MD roadmap above; the UI reads/writes via these.
    // Agent should keep both in sync (or migrate fully to v2 over time).
    // =====================================================================
    {
      name: 'roadmap_v2_get',
      description: 'Read full structured Roadmap (v2): shortTerm/midTerm/longTerm todos + strategy + KPIs + log. JSON powering the Roadmap UI.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => roadmapV2.getRoadmap(ctx.userId),
    },
    {
      name: 'roadmap_v2_stats',
      description: 'Get per-horizon counts (total/done/wip/pending/blocked/parked), 30-day burn-down, and KPI snapshots.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => roadmapV2.stats(ctx.userId),
    },
    {
      name: 'roadmap_v2_add_todo',
      description: 'Add a todo to a horizon. horizon ∈ {shortTerm (~4 wk), midTerm (~3 mo), longTerm (~12 mo)}. status defaults to pending.',
      inputSchema: {
        type: 'object',
        properties: {
          horizon: { type: 'string', enum: ['shortTerm', 'midTerm', 'longTerm'] },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'parked'] },
          priority: { type: 'string', enum: ['low', 'med', 'high'] },
          due: { type: ['string', 'null'], description: 'ISO date (YYYY-MM-DD) or null' },
        },
        required: ['horizon', 'title'], additionalProperties: false,
      },
      handler: async (ctx, { horizon, ...input }) => roadmapV2.addTodo(ctx.userId, horizon, input),
    },
    {
      name: 'roadmap_v2_update_todo',
      description: 'Update a v2 todo by id. Pass only fields to change. Setting status=done auto-stamps completed_at.',
      inputSchema: {
        type: 'object',
        properties: {
          horizon: { type: 'string', enum: ['shortTerm', 'midTerm', 'longTerm'] },
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked', 'parked'] },
          priority: { type: 'string', enum: ['low', 'med', 'high'] },
          due: { type: ['string', 'null'] },
        },
        required: ['horizon', 'id'], additionalProperties: false,
      },
      handler: async (ctx, { horizon, id, ...patch }) => roadmapV2.updateTodo(ctx.userId, horizon, id, patch),
    },
    {
      name: 'roadmap_v2_delete_todo',
      description: 'Delete a v2 todo by id from a horizon.',
      inputSchema: {
        type: 'object',
        properties: {
          horizon: { type: 'string', enum: ['shortTerm', 'midTerm', 'longTerm'] },
          id: { type: 'string' },
        },
        required: ['horizon', 'id'], additionalProperties: false,
      },
      handler: async (ctx, { horizon, id }) => roadmapV2.deleteTodo(ctx.userId, horizon, id),
    },
    {
      name: 'roadmap_v2_move_todo',
      description: 'Move a v2 todo from one horizon to another (e.g. shortTerm → midTerm when scope grows).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          from: { type: 'string', enum: ['shortTerm', 'midTerm', 'longTerm'] },
          to: { type: 'string', enum: ['shortTerm', 'midTerm', 'longTerm'] },
        },
        required: ['id', 'from', 'to'], additionalProperties: false,
      },
      handler: async (ctx, { id, from, to }) => roadmapV2.moveTodo(ctx.userId, from, id, to),
    },
    {
      name: 'roadmap_v2_set_strategy',
      description: 'Set strategic vision/mission/pillars/bets. Partial update — pass only fields to change.',
      inputSchema: {
        type: 'object',
        properties: {
          vision: { type: 'string' },
          mission: { type: 'string' },
          pillars: { type: 'array', items: { type: 'string' } },
          bets: {
            type: 'array',
            items: {
              type: 'object',
              properties: { title: { type: 'string' }, rationale: { type: 'string' } },
              required: ['title'], additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      handler: async (ctx, input) => roadmapV2.setStrategy(ctx.userId, input),
    },
    {
      name: 'roadmap_v2_upsert_kpi',
      description: 'Create or update a KPI. Omit id for new; pass id to update. current updates push to history (last 50 points kept).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          current: { type: 'number' },
          target: { type: 'number' },
          unit: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: async (ctx, input) => roadmapV2.upsertKpi(ctx.userId, input),
    },
    {
      name: 'roadmap_v2_delete_kpi',
      description: 'Delete a KPI by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'], additionalProperties: false,
      },
      handler: async (ctx, { id }) => roadmapV2.deleteKpi(ctx.userId, id),
    },
  ],
};

export default connector;
