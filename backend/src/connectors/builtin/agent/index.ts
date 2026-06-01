import type { Connector } from '../../types.js';
import { getSetting, setSetting, query } from '../../../db/index.js';
import { readNote, writeNote } from '../../../brain/vault.js';
import { bus } from '../../../bus.js';
import { getPrimaryVault } from '../../../brain/vaults.js';
import * as net from '../../../network/index.js';
import * as subAgents from '../../../sub_agents/index.js';

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
  ],
};

export default connector;
