import type { Connector } from '../../types.js';
import { writeNote } from '../../../brain/vault.js';
import { bus } from '../../../bus.js';

// Polpo connector (additive, upstream-safe) — sess.2261.
// Mirrors the imap connector pattern: onTick polls Fathom, ingests new call
// summaries into the brain vault, emits connector:event so the proactive
// reflection loop can ask Mattia a contextual question about the new call.
// Auth + endpoints ground-truthed from ~/scripts/lib/fathom_api.py (no guessing).

const BASE = 'https://api.fathom.ai/external/v1';
const LIST_KEYS = ['items', 'meetings', 'data', 'results', 'recordings', 'calls'];

async function fathomGet(apiKey: string, path: string, params?: Record<string, any>) {
  const url = new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  if (res.status === 401 || res.status === 403) throw new Error(`fathom auth failed (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`fathom GET ${path} → HTTP ${res.status}`);
  return res.json();
}

function unwrapList(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const k of LIST_KEYS) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

// Canonical summary parser (dict-vs-string fallback chain, mirrors fathom_api.extract_summary_text).
function summaryText(data: any): string {
  if (typeof data === 'string') return data;
  if (data?.markdown_formatted) return String(data.markdown_formatted);
  if (data?.summary) return typeof data.summary === 'string' ? data.summary : JSON.stringify(data.summary, null, 2);
  if (data?.text) return String(data.text);
  return JSON.stringify(data, null, 2);
}

function recId(m: any): number | string | undefined {
  return m?.recording_id ?? m?.id ?? m?.recordingId;
}

const connector: Connector = {
  manifest: {
    name: 'fathom',
    title: 'Fathom Calls',
    description: 'Polls Fathom for new call recordings, ingests AI summaries into the brain (calls/), and signals each new call so the agent can ask a contextual question. Tools: list/summary/transcript/search.',
    schedule: '*/15 * * * *',
    configSchema: [
      {
        key: 'apiKey',
        label: 'Fathom API Key',
        type: 'password',
        required: true,
        placeholder: 'fathom external API key (X-Api-Key)',
      },
    ],
  },
  async onTick(ctx) {
    const apiKey: string = ctx.config?.apiKey;
    if (!apiKey) return;

    const state = { ...(ctx.state ?? {}) };
    const seen: Record<string, boolean> = { ...(state.seenIds ?? {}) };
    const firstRun = !state.seenIds; // baseline-only on first tick: don't flood brain/Telegram with old calls

    let list: any[] = [];
    try {
      list = unwrapList(await fathomGet(apiKey, '/meetings', { limit: 20 }));
    } catch (e) {
      ctx.log('list-failed', { err: String(e) });
      return;
    }

    let ingested = 0;
    for (const m of list) {
      const id = recId(m);
      if (id == null) continue;
      const key = String(id);
      if (seen[key]) continue;
      seen[key] = true;
      if (firstRun) continue; // mark current calls as baseline without ingesting

      try {
        const body = summaryText(await fathomGet(apiKey, `/recordings/${id}/summary`));
        const title = m.title ?? `Fathom call ${id}`;
        await writeNote(
          ctx.userId,
          `calls/fathom-${id}.md`,
          {
            kind: 'call',
            title,
            recording_id: id,
            start: m.start ?? m.started_at ?? null,
            invitees: m.invitees ?? null,
            share_url: m.share_url ?? null,
            source: 'fathom',
            tags: ['call', 'fathom'],
          },
          `# ${title}\n\n${body}\n`
        );
        bus.emit('connector:event', {
          userId: ctx.userId,
          connector: 'fathom',
          kind: 'new-call',
          payload: { recording_id: id, title, start: m.start ?? null, share_url: m.share_url ?? null },
        });
        ctx.log('ingested-call', { id, title });
        ingested++;
      } catch (e) {
        ctx.log('summary-failed', { id, err: String(e) });
        seen[key] = false; // unmark → retry next tick
      }
    }

    state.seenIds = seen;
    await ctx.saveState(state);
    if (ingested) ctx.log('tick-complete', { ingested });
  },
  tools: [
    {
      name: 'list_meetings',
      description: 'List recent Fathom call recordings (recording_id, title, start, invitees, share_url).',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number', default: 20 } },
        additionalProperties: false,
      },
      handler: async (ctx, { limit = 20 }) => unwrapList(await fathomGet(ctx.config.apiKey, '/meetings', { limit })),
    },
    {
      name: 'get_summary',
      description: 'Get the AI-generated summary of a call by recording_id.',
      inputSchema: {
        type: 'object',
        properties: { recording_id: { type: 'number' } },
        required: ['recording_id'],
        additionalProperties: false,
      },
      handler: async (ctx, { recording_id }) => summaryText(await fathomGet(ctx.config.apiKey, `/recordings/${recording_id}/summary`)),
    },
    {
      name: 'get_transcript',
      description: 'Get the full transcript (speaker + timestamp + text utterances) of a call by recording_id.',
      inputSchema: {
        type: 'object',
        properties: { recording_id: { type: 'number' } },
        required: ['recording_id'],
        additionalProperties: false,
      },
      handler: async (ctx, { recording_id }) => fathomGet(ctx.config.apiKey, `/recordings/${recording_id}/transcript`),
    },
    {
      name: 'search',
      description: 'Search calls by query string (matches title/participants).',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'number', default: 50 } },
        required: ['q'],
        additionalProperties: false,
      },
      handler: async (ctx, { q, limit = 50 }) => unwrapList(await fathomGet(ctx.config.apiKey, '/meetings/search', { q, limit })),
    },
  ],
};

export default connector;
