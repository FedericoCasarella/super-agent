import type { Connector } from '../../types.js';
import { writeNote } from '../../../brain/vault.js';
import { bus } from '../../../bus.js';

// Polpo connector (additive, upstream-safe) — sess.2261.
// GoHighLevel CRM. onTick polls opportunities, detects new/stage-changed deals,
// ingests into brain (crm/) and signals the proactive loop. Tools: contacts,
// opportunities, pipelines. API ground-truthed from ~/mcp-servers/ghl/index.js.

const DEFAULT_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_VERSION = '2021-07-28';

type GhlCfg = { pitToken: string; locationId: string; baseUrl?: string; apiVersion?: string };

function cfgOf(ctx: any): GhlCfg | null {
  const c = ctx.config ?? {};
  if (!c.pitToken || !c.locationId) return null;
  return { pitToken: c.pitToken, locationId: c.locationId, baseUrl: c.baseUrl, apiVersion: c.apiVersion };
}

async function ghlFetch(cfg: GhlCfg, path: string, opts: { method?: string; query?: Record<string, any>; body?: any } = {}) {
  const { method = 'GET', query = {}, body } = opts;
  const url = new URL(path, cfg.baseUrl || DEFAULT_BASE);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.pitToken}`,
      Version: cfg.apiVersion || DEFAULT_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new Error(`ghl auth failed (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`ghl ${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function asArray(data: any, ...keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return [];
}

const connector: Connector = {
  manifest: {
    name: 'ghl',
    title: 'GoHighLevel CRM',
    description: 'Polls GHL opportunities, ingests new/stage-changed deals into the brain (crm/) and signals the agent. Tools: search_contacts, search_opportunities, get_pipelines, get_contact.',
    schedule: '*/10 * * * *',
    configSchema: [
      { key: 'pitToken', label: 'Private Integration Token (PIT)', type: 'password', required: true },
      { key: 'locationId', label: 'Location ID', type: 'text', required: true },
      { key: 'baseUrl', label: 'Base URL (optional)', type: 'text', placeholder: DEFAULT_BASE },
      { key: 'apiVersion', label: 'API Version (optional)', type: 'text', placeholder: DEFAULT_VERSION },
    ],
  },
  async onTick(ctx) {
    const cfg = cfgOf(ctx);
    if (!cfg) return;

    const state = { ...(ctx.state ?? {}) };
    const known: Record<string, string> = { ...(state.oppStages ?? {}) };
    const firstRun = !state.oppStages; // populate vault on first tick, suppress events to avoid Telegram flood

    let opps: any[] = [];
    try {
      const data = await ghlFetch(cfg, '/opportunities/search', { query: { location_id: cfg.locationId, limit: 100 } });
      opps = asArray(data, 'opportunities', 'items', 'data');
    } catch (e) {
      ctx.log('opps-failed', { err: String(e) });
      return;
    }

    let changes = 0;
    for (const o of opps) {
      const id = o.id ?? o._id;
      if (!id) continue;
      const stage = String(o.pipelineStageId ?? o.stageId ?? o.status ?? '');
      const prev = known[String(id)];
      if (!firstRun && prev === stage) {
        known[String(id)] = stage;
        continue;
      }

      const name = o.name ?? o.title ?? `Opportunity ${id}`;
      const kind = prev == null ? 'new-opportunity' : 'opportunity-stage-change';
      try {
        await writeNote(
          ctx.userId,
          `crm/opp-${id}.md`,
          {
            kind: 'opportunity',
            title: name,
            opp_id: id,
            stage,
            status: o.status ?? null,
            value: o.monetaryValue ?? null,
            contact: o.contact?.name ?? o.contactId ?? null,
            source: 'ghl',
            tags: ['crm', 'ghl'],
          },
          `# ${name}\n\n- Stage: ${stage}\n- Status: ${o.status ?? ''}\n- Value: ${o.monetaryValue ?? ''}\n- Contact: ${o.contact?.name ?? o.contactId ?? ''}\n`
        );
        known[String(id)] = stage;
        if (!firstRun) {
          bus.emit('connector:event', {
            userId: ctx.userId,
            connector: 'ghl',
            kind,
            payload: { opp_id: id, name, stage, prev_stage: prev ?? null, value: o.monetaryValue ?? null },
          });
        }
        ctx.log(firstRun ? 'ingested-opportunity' : kind, { id, name, stage });
        changes++;
      } catch (e) {
        ctx.log('note-failed', { id, err: String(e) });
        // leave known[id] unset → retry next tick
      }
    }

    state.oppStages = known;
    await ctx.saveState(state);
    if (changes) ctx.log('tick-complete', { changes, firstRun });
    // onTick fix sess.2282 — firstRun back-fills vault (writeNote) while suppressing bus.emit (no Telegram flood).
    // Previous behavior: firstRun marked all stages as known without writing notes → vault stayed empty until a deal moved stage.
  },
  tools: [
    {
      name: 'search_contacts',
      description: 'Search GHL contacts by free-text query within the configured location.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', default: 20 } },
        additionalProperties: false,
      },
      handler: async (ctx, { query, limit = 20 }) => {
        const cfg = cfgOf(ctx);
        if (!cfg) throw new Error('ghl: pitToken/locationId missing');
        return ghlFetch(cfg, '/contacts/search', { method: 'POST', body: { locationId: cfg.locationId, query, pageLimit: limit } });
      },
    },
    {
      name: 'get_contact',
      description: 'Get a GHL contact by id (incl. fields).',
      inputSchema: {
        type: 'object',
        properties: { contactId: { type: 'string' } },
        required: ['contactId'],
        additionalProperties: false,
      },
      handler: async (ctx, { contactId }) => {
        const cfg = cfgOf(ctx);
        if (!cfg) throw new Error('ghl: pitToken/locationId missing');
        return ghlFetch(cfg, `/contacts/${encodeURIComponent(contactId)}`);
      },
    },
    {
      name: 'search_opportunities',
      description: 'Search GHL opportunities (deals) in the configured location. Optional free-text query.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', default: 50 } },
        additionalProperties: false,
      },
      handler: async (ctx, { query, limit = 50 }) => {
        const cfg = cfgOf(ctx);
        if (!cfg) throw new Error('ghl: pitToken/locationId missing');
        return ghlFetch(cfg, '/opportunities/search', { query: { location_id: cfg.locationId, q: query, limit } });
      },
    },
    {
      name: 'get_pipelines',
      description: 'List GHL pipelines and their stages for the configured location.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const cfg = cfgOf(ctx);
        if (!cfg) throw new Error('ghl: pitToken/locationId missing');
        return ghlFetch(cfg, '/opportunities/pipelines', { query: { locationId: cfg.locationId } });
      },
    },
  ],
};

export default connector;
