import type { Connector } from '../../types.js';
import { getSetting, setSetting } from '../../../db/index.js';
import { readNote, writeNote } from '../../../brain/vault.js';
import * as net from '../../../network/index.js';

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
