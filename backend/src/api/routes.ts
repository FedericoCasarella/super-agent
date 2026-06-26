import { Router } from 'express';
import crypto from 'node:crypto';
import { config, AVAILABLE_MODELS, MODEL_IDS } from '../config.js';
import { query, getSetting, setSetting } from '../db/index.js';
import { quotaGuard } from '../quota.js';
import { setVaultRoot, getVaultRoot, searchNotes, readNote } from '../brain/vault.js';
import { buildGraph, invalidateGraphCache } from '../brain/graph.js';
import { listConnectors, ensureUserConnectorRows } from '../connectors/registry.js';
import { restartTelegramForUser } from '../telegram/bot.js';
import { bus } from '../bus.js';
import { runTick } from '../scheduler/index.js';
import { listTools, invokeTool } from '../connectors/tools.js';
import { requireUser } from '../auth/index.js';

export const router = Router();

// ===== MCP bridge endpoints — auth via service header `x-super-agent-user`.
// These MUST be mounted BEFORE requireUser middleware so the local MCP bridge
// (which has no cookie) can still list/invoke tools.
router.get('/tools', (_req, res) => {
  res.json(listTools().map((t) => ({
    name: t.fullName, connector: t.connector, description: t.description, inputSchema: t.inputSchema,
  })));
});
router.post('/tools/:name', async (req, res) => {
  const headerUid = Number(req.header('x-super-agent-user') || '');
  // Prefer header (bridge call) — fall back to cookie session if present
  let userId = Number.isFinite(headerUid) && headerUid > 0 ? headerUid : NaN;
  if (!userId) {
    // Try cookie auth manually
    const { verifyToken } = await import('../auth/index.js');
    const { config } = await import('../config.js');
    const tok = (req as any).cookies?.[config.cookieName];
    const d = tok ? verifyToken(tok) : null;
    if (d) userId = d.uid;
  }
  if (!userId) return res.status(401).json({ ok: false, error: 'missing user id (header or cookie)' });
  try {
    const out = await invokeTool(userId, req.params.name, req.body ?? {});
    res.json({ ok: true, result: out });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// All routes below require auth
// Liveness probe — no auth, used by the frontend to detect "backend down"
// and show a blocking overlay until it comes back.
router.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// File gateway — serves a local file so links sent via Telegram open the real
// file in the browser. Mounted BEFORE requireUser: Telegram clicks arrive
// without a session cookie, so auth is an HMAC signature over the resolved
// path (only the backend can mint valid links). Cookie session also accepted
// as fallback for in-app use. `download=1` forces attachment disposition.
export function signFilePath(absPath: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(absPath).digest('hex').slice(0, 32);
}
router.get('/files', async (req, res) => {
  try {
    const raw = String(req.query.path ?? '');
    if (!raw) return res.status(400).json({ error: 'path required' });
    const path = await import('node:path');
    const fs = await import('node:fs');
    const os = await import('node:os');
    // Resolve ~ and relative → absolute
    let p = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
    p = path.resolve(p);
    // Auth: valid signature OR logged-in session cookie.
    const sig = String(req.query.sig ?? '');
    let authed = sig && sig === signFilePath(p);
    if (!authed) {
      const { verifyToken } = await import('../auth/index.js');
      const tok = (req as any).cookies?.[config.cookieName];
      authed = !!(tok && verifyToken(tok));
    }
    if (!authed) return res.status(401).json({ error: 'unauthorized' });
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return res.status(404).json({ error: `file non trovato: ${p}` });
    const download = String(req.query.download ?? '') === '1';
    if (download) return res.download(p);
    res.sendFile(p);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// ── Spotify OAuth callback (PUBBLICA) ───────────────────────────────────────
// Spotify reindirizza il browser qui senza il nostro cookie di sessione, quindi
// la rotta è prima del gate auth e si fida dello `state` firmato (JWT con uid).
function spotifyRedirectUri(): string {
  return `http://127.0.0.1:${config.port}/api/connectors/spotify/callback`;
}
router.get('/connectors/spotify/callback', async (req, res) => {
  const send = (msg: string, ok: boolean) =>
    res.redirect(`${config.frontendOrigin.replace(/\/+$/, '')}/connectors?spotify=${ok ? 'connected' : 'error'}&msg=${encodeURIComponent(msg)}`);
  try {
    const code = String(req.query.code ?? '');
    const stateTok = String(req.query.state ?? '');
    if (req.query.error) return send(String(req.query.error), false);
    if (!code || !stateTok) return send('parametri mancanti', false);
    const jwt = (await import('jsonwebtoken')).default;
    let uid: number;
    try { uid = (jwt.verify(stateTok, config.jwtSecret) as any).uid; } catch { return send('state non valido o scaduto', false); }
    const rows = await query<{ config: any; state: any }>(`SELECT config, state FROM connectors WHERE user_id=$1 AND name='spotify'`, [uid]);
    const cfg = rows[0]?.config ?? {};
    if (!cfg.clientId || !cfg.clientSecret) return send('Client ID/Secret mancanti', false);
    const tokRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64') },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: spotifyRedirectUri() }),
    });
    const j: any = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !j.refresh_token) return send(j.error_description || j.error || 'scambio token fallito', false);
    const nextState = {
      ...(rows[0]?.state ?? {}),
      refreshToken: j.refresh_token,
      accessToken: j.access_token,
      expiresAt: Date.now() + ((j.expires_in ?? 3600) as number) * 1000,
      connectedAt: new Date().toISOString(),
    };
    await query(`UPDATE connectors SET state=$1::jsonb, enabled=true, updated_at=now() WHERE user_id=$2 AND name='spotify'`, [JSON.stringify(nextState), uid]);
    return send('Spotify collegato', true);
  } catch (e: any) {
    return send(String(e?.message ?? e), false);
  }
});

router.use(requireUser);

// Avvio OAuth Spotify (autenticato): restituisce l'URL di autorizzazione che il
// frontend apre. Lo `state` è un JWT con l'uid (10 min) verificato nel callback.
router.get('/connectors/spotify/auth', async (req, res) => {
  try {
    const uid = req.user!.id;
    const rows = await query<{ config: any }>(`SELECT config FROM connectors WHERE user_id=$1 AND name='spotify'`, [uid]);
    const cfg = rows[0]?.config ?? {};
    if (!cfg.clientId) return res.status(400).json({ error: 'Inserisci e salva prima Client ID e Client Secret.' });
    const jwt = (await import('jsonwebtoken')).default;
    const { SPOTIFY_SCOPES } = await import('../connectors/builtin/spotify/index.js');
    const state = jwt.sign({ uid, p: 'spotify' }, config.jwtSecret, { expiresIn: '10m' });
    const url = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      scope: SPOTIFY_SCOPES.join(' '),
      redirect_uri: spotifyRedirectUri(),
      state,
    }).toString();
    res.json({ url, redirectUri: spotifyRedirectUri() });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/status', async (req, res) => {
  const userId = req.user!.id;
  const vault = await getVaultRoot(userId);
  const telegram = await getSetting<any>(userId, 'telegram');
  const profile = await getSetting<any>(userId, 'profile');
  const business = await getSetting<any>(userId, 'business');
  res.json({
    onboarded: !!(vault && telegram?.token && telegram?.chatId && profile && business),
    vault,
    telegram: telegram ? { hasToken: !!telegram.token, chatId: telegram.chatId ?? null } : null,
    profile, business,
  });
});

router.post('/onboarding/profile', async (req, res) => {
  await setSetting(req.user!.id, 'profile', req.body);
  res.json({ ok: true });
});
router.post('/onboarding/business', async (req, res) => {
  await setSetting(req.user!.id, 'business', req.body);
  res.json({ ok: true });
});
router.post('/onboarding/vault', async (req, res) => {
  const { vaultPath } = req.body ?? {};
  if (!vaultPath) return res.status(400).json({ error: 'vaultPath required' });
  await setVaultRoot(req.user!.id, vaultPath);
  res.json({ ok: true });
});
router.post('/onboarding/telegram', async (req, res) => {
  const { token } = req.body ?? {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const cur = await getSetting<any>(req.user!.id, 'telegram') ?? {};
  await setSetting(req.user!.id, 'telegram', { ...cur, token });
  await restartTelegramForUser(req.user!.id);
  res.json({ ok: true, message: 'Bot started. Open Telegram and send /start to link this chat.' });
});

router.get('/messages', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const rows = await query(
    `SELECT id::int, ts, direction, channel, content FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT $2`,
    [req.user!.id, limit]
  );
  res.json(rows.reverse());
});

// Live page KPIs — agents-now, agents-24h, people-touched-24h, upcoming
// scheduled contacts (channel + modality). Single round-trip; client renders.
router.get('/live/kpis', async (req, res) => {
  try {
    const u = req.user!.id;
    // Active agents NOW: running sub_agents + running team_tasks
    const nowAgg = await query<{ sub_now: number; team_now: number; internal_now: number }>(
      `SELECT
         (SELECT count(*)::int FROM sub_agents WHERE user_id=$1 AND status='running') AS sub_now,
         (SELECT count(*)::int FROM team_tasks WHERE user_id=$1 AND status='running') AS team_now,
         (SELECT count(*)::int FROM internal_agents WHERE user_id=$1 AND status='running') AS internal_now`,
      [u],
    ).catch(() => [{ sub_now: 0, team_now: 0, internal_now: 0 }]);

    // Agents activated in last 24h
    const last24Agg = await query<{ sub_24h: number; team_24h: number; internal_24h: number }>(
      `SELECT
         (SELECT count(*)::int FROM sub_agents WHERE user_id=$1 AND created_at > now() - INTERVAL '24 hours') AS sub_24h,
         (SELECT count(*)::int FROM team_tasks WHERE user_id=$1 AND created_at > now() - INTERVAL '24 hours') AS team_24h,
         (SELECT count(*)::int FROM internal_agents WHERE user_id=$1 AND created_at > now() - INTERVAL '24 hours') AS internal_24h`,
      [u],
    ).catch(() => [{ sub_24h: 0, team_24h: 0, internal_24h: 0 }]);

    // People involved in agentic work last 24h — distinct recipients from
    // outbound_log filtered to agent / sub-agent / perk origins.
    const peopleAgg = await query<{ c: number }>(
      `SELECT count(DISTINCT recipient)::int AS c
       FROM outbound_log
       WHERE user_id=$1
         AND status='sent'
         AND ts > now() - INTERVAL '24 hours'
         AND recipient IS NOT NULL
         AND (origin = 'agent' OR origin LIKE 'subagent:%' OR origin LIKE 'perk:%' OR origin LIKE 'team:%')`,
      [u],
    ).catch(() => [{ c: 0 }]);

    // Upcoming scheduled contacts — compute next_run_at from cron expression
    // since scheduled_tasks doesn't materialize it.
    const upcoming = await query<{ id: number; name: string; cron: string; action_type: string; action_payload: any }>(
      `SELECT id, name, cron, action_type, action_payload
       FROM scheduled_tasks
       WHERE user_id=$1 AND enabled=true
       LIMIT 50`,
      [u],
    ).catch(() => []);
    function inferChannel(t: any): string {
      const blob = (`${t.name ?? ''} ${JSON.stringify(t.action_payload ?? {})}`).toLowerCase();
      if (/whatsapp|wa\b/.test(blob)) return 'whatsapp';
      if (/instagram|\big\b/.test(blob)) return 'instagram';
      if (/telegram|\btg\b/.test(blob)) return 'telegram';
      if (/gmail|email|mail|imap|smtp/.test(blob)) return 'email';
      return 'agent';
    }
    function inferModality(t: any): string {
      const blob = (`${t.name ?? ''} ${JSON.stringify(t.action_payload ?? {})}`).toLowerCase();
      if (/community|broadcast|gruppo|group|many/.test(blob)) return '1:many';
      if (/thread|conversazione|conversation/.test(blob)) return 'thread';
      return '1:1';
    }
    const { CronExpressionParser } = await import('cron-parser');
    const upcomingMapped = upcoming
      .map((t) => {
        let next: string | null = null;
        try { next = CronExpressionParser.parse(t.cron, { tz: 'Europe/Rome' }).next().toISOString(); } catch {}
        return {
          id: t.id, name: t.name, cron: t.cron, next_run_at: next,
          channel: inferChannel(t), modality: inferModality(t),
        };
      })
      .filter((t) => !!t.next_run_at)
      .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))
      .slice(0, 12);

    res.json({
      agentsNow: (nowAgg[0]?.sub_now ?? 0) + (nowAgg[0]?.team_now ?? 0) + (nowAgg[0]?.internal_now ?? 0),
      agents24h: (last24Agg[0]?.sub_24h ?? 0) + (last24Agg[0]?.team_24h ?? 0) + (last24Agg[0]?.internal_24h ?? 0),
      peopleTouched24h: peopleAgg[0]?.c ?? 0,
      upcoming: upcomingMapped,
      breakdown: {
        now: nowAgg[0] ?? {},
        last24h: last24Agg[0] ?? {},
      },
    });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Message counts for KPI cards — backend computes from full table so values
// don't cap at /messages?limit=100 (which was producing the "Msg 24h = 100"
// constant on the live dashboard).
router.get('/messages/counts', async (req, res) => {
  try {
    const r = await query<{ h24: number; d7: number; d30: number; total: number }>(
      `SELECT
         count(*) FILTER (WHERE ts > now() - INTERVAL '24 hours')::int AS h24,
         count(*) FILTER (WHERE ts > now() - INTERVAL '7 days')::int  AS d7,
         count(*) FILTER (WHERE ts > now() - INTERVAL '30 days')::int AS d30,
         count(*)::int AS total
       FROM messages WHERE user_id=$1`,
      [req.user!.id],
    );
    res.json(r[0] ?? { h24: 0, d7: 0, d30: 0, total: 0 });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// One-off test for the TTS connector: synthesizes a sample line via the
// configured provider (ElevenLabs) and sends it as a Telegram voice note.
// Surfaces the real failure reason so the user can debug API key / voice id.
// List voices available on the ElevenLabs account tied to the saved apiKey.
// Lets the UI / user know which voices actually work (owned vs library) without
// digging through the dashboard. Free tier sees only premade — UI surfaces a
// "Add a voice" hint when no owned voices exist.
router.get('/connectors/tts/voices', async (req, res) => {
  try {
    const userId = req.user!.id;
    const { getTtsConfig } = await import('../connectors/builtin/tts/index.js');
    const cfg = await getTtsConfig(userId);
    if (!cfg.apiKey) return res.json({ ok: false, error: 'apiKey vuota' });
    const apiKey = String(cfg.apiKey).replace(/\s/g, '');
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
    if (!r.ok) return res.json({ ok: false, error: `elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}` });
    const data: any = await r.json();
    const voices = (data?.voices ?? []).map((v: any) => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels ?? {} }));
    const owned = voices.filter((v: any) => v.category !== 'premade');
    res.json({ ok: true, voices, owned_count: owned.length, total: voices.length });
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.post('/connectors/tts/test', async (req, res) => {
  try {
    const userId = req.user!.id;
    const text = String(req.body?.text ?? 'Ciao Federico, questa è una prova per dimostrarti che funziona.');
    const { synthesizeDetailed } = await import('../connectors/builtin/tts/index.js');
    const { sendTelegramVoice } = await import('../telegram/bot.js');
    const audio = await synthesizeDetailed(userId, text);
    if (!audio.ok) return res.json({ ok: false, error: audio.error });
    const r = await sendTelegramVoice(userId, text, 'test');
    res.json({ ok: r.ok, fallback: r.fallback ?? null, error: r.error ?? null, bytes: audio.buf.length, ext: audio.ext });
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.get('/connectors', async (req, res) => {
  await ensureUserConnectorRows(req.user!.id);
  const rows = await query<{ name: string; enabled: boolean; config: any; state: any }>(
    'SELECT name, enabled, config, state FROM connectors WHERE user_id=$1', [req.user!.id]
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  const out = listConnectors().map((c) => ({
    manifest: c.manifest,
    enabled: byName.get(c.manifest.name)?.enabled ?? false,
    config: byName.get(c.manifest.name)?.config ?? {},
    state: byName.get(c.manifest.name)?.state ?? {},
  }));
  res.json(out);
});

router.put('/connectors/:name', async (req, res) => {
  const { enabled, config } = req.body ?? {};
  await ensureUserConnectorRows(req.user!.id);
  const cfgJson = config !== undefined ? JSON.stringify(config) : null;
  await query(
    `UPDATE connectors SET enabled=COALESCE($3,enabled), config=COALESCE($4::jsonb,config), updated_at=now() WHERE user_id=$1 AND name=$2`,
    [req.user!.id, req.params.name, enabled ?? null, cfgJson]
  );
  bus.emit('connectors:changed');
  // Fire connector's onConfigSaved hook so side-effects (e.g. registering
  // external resources) run immediately.
  try {
    const { getConnector } = await import('../connectors/registry.js');
    const conn = getConnector(req.params.name);
    if (conn?.onConfigSaved) {
      const rows = await query<{ config: any; state: any }>(
        `SELECT config, state FROM connectors WHERE user_id=$1 AND name=$2`,
        [req.user!.id, req.params.name],
      );
      const r = rows[0] ?? { config: {}, state: {} };
      await conn.onConfigSaved({
        userId: req.user!.id,
        config: r.config ?? {},
        state: r.state ?? {},
        saveState: async () => {},
        log: (msg, meta) => console.log(`[${req.params.name}:u${req.user!.id}] ${msg}`, meta ?? ''),
      });
    }
  } catch (e) { console.error(`[connectors:${req.params.name}] onConfigSaved`, e); }
  res.json({ ok: true });
});

router.post('/connectors/:name/run', async (req, res) => {
  await runTick(req.user!.id, req.params.name);
  res.json({ ok: true });
});

router.post('/connectors/imap/test', async (req, res) => {
  const { ImapFlow } = await import('imapflow');
  const { host, port, user, pass, mailbox } = req.body ?? {};
  if (!host || !user || !pass) return res.json({ ok: false, error: 'host, user, pass required' });
  const client = new ImapFlow({ host, port: Number(port ?? 993), secure: true, auth: { user, pass }, logger: false });
  try {
    await client.connect();
    const box = mailbox || 'INBOX';
    const status = await client.status(box, { messages: true, uidNext: true });
    await client.logout().catch(() => {});
    res.json({ ok: true, mailbox: box, messages: status.messages ?? 0, uidNext: status.uidNext ?? null });
  } catch (e: any) {
    try { await client.logout(); } catch {}
    res.json({ ok: false, error: String(e?.message ?? e) });
  }
});

// Apply the visibility/origin filters consistently across graph + meta.
function filterGraphNodes(nodes: any[], filter: string, origin: string): any[] {
  let out = nodes;
  if (filter !== 'all') out = out.filter((n) => n.visibility === filter);
  if (origin === 'native') out = out.filter((n) => !n.origin_user_id);
  else if (origin !== 'all') out = out.filter((n) => n.origin_email === origin);
  return out;
}

router.get('/brain/graph', async (req, res) => {
  const filter = String(req.query.visibility ?? 'all');
  const origin = req.query.origin ? String(req.query.origin) : 'all';
  const vaultFilter = req.query.vault ? String(req.query.vault) : 'all';
  const g = await buildGraph(req.user!.id, { vaultFilter });
  const nodes = filterGraphNodes(g.nodes, filter, origin);
  const ids = new Set(nodes.map((n) => n.id));
  const clusterById = new Map(nodes.map((n) => [n.id, n.cluster]));
  // Payload shrink: the 3D view connects clusters ONLY through the center
  // (leaf→hub→brain) and drops cross-cluster wikilinks. Sending them is dead
  // weight (was ~26MB / 158k links). Keep only same-cluster links — the ones
  // the client actually renders. Cross-cluster relations still live in the
  // node clustering; nothing visible is lost.
  // Keep only same-cluster links (cross-cluster ones are dropped by the 3D
  // view anyway), AND cap how many we keep per node. Big clusters (super-agent,
  // inbox) have tens of thousands of internal links — feeding them all to the
  // d3 force sim + LineSegments is what froze the client for minutes. A handful
  // per node preserves intra-cluster cohesion at a fraction of the cost.
  const MAX_LINKS_PER_NODE = 24;
  const perNode = new Map<string, number>();
  const links: any[] = [];
  for (const l of g.links) {
    if (!ids.has(l.source) || !ids.has(l.target)) continue;
    if (clusterById.get(l.source) !== clusterById.get(l.target)) continue;
    const sc = perNode.get(l.source) ?? 0;
    const tc = perNode.get(l.target) ?? 0;
    if (sc >= MAX_LINKS_PER_NODE || tc >= MAX_LINKS_PER_NODE) continue;
    perNode.set(l.source, sc + 1);
    perNode.set(l.target, tc + 1);
    links.push(l);
  }
  const origins = Array.from(new Set(g.nodes.map((n) => n.origin_email).filter(Boolean))) as string[];
  res.json({ nodes, links, origins, vaults: g.vaults });
});

// Phase-1 structure endpoint: cluster macro-sets + counts, NO node/link bodies.
// Lets the client paint the brain + cluster hubs instantly while the full node
// list streams in. Served from the same cached graph build → ~instant.
router.get('/brain/graph/meta', async (req, res) => {
  const filter = String(req.query.visibility ?? 'all');
  const origin = req.query.origin ? String(req.query.origin) : 'all';
  const vaultFilter = req.query.vault ? String(req.query.vault) : 'all';
  const g = await buildGraph(req.user!.id, { vaultFilter });
  const nodes = filterGraphNodes(g.nodes, filter, origin);
  const counts = new Map<string, number>();
  for (const n of nodes) counts.set(n.cluster, (counts.get(n.cluster) ?? 0) + 1);
  const clusters = Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
  const origins = Array.from(new Set(g.nodes.map((n) => n.origin_email).filter(Boolean))) as string[];
  res.json({ clusters, total: nodes.length, origins, vaults: g.vaults });
});

// Internal agents
router.get('/internal-agents', async (req, res) => {
  const { listUserAgents } = await import('../agents/internal/registry.js');
  res.json(await listUserAgents(req.user!.id));
});
router.put('/internal-agents/:name', async (req, res) => {
  const { updateAgentSchedule } = await import('../agents/internal/registry.js');
  await updateAgentSchedule(req.user!.id, req.params.name, req.body ?? {});
  res.json({ ok: true });
});
router.post('/internal-agents/:name/run', async (req, res) => {
  const { runInternalAgent } = await import('../agents/internal/registry.js');
  const out = await runInternalAgent(req.user!.id, req.params.name);
  res.json(out);
});

router.get('/brain/search', async (req, res) => {
  const q = String(req.query.q ?? '');
  if (!q) return res.json([]);
  const out = await searchNotes(req.user!.id, q, 30);
  res.json(out.map((n) => ({ path: n.path, title: n.title, tags: n.tags, snippet: n.content.slice(0, 220) })));
});

router.get('/brain/note', async (req, res) => {
  const raw = String(req.query.path ?? '');
  const userId = req.user!.id;
  // Support id format `<vaultName>::<relPath>`
  if (raw.includes('::')) {
    const [vaultName, rel] = raw.split('::', 2);
    const { listVaults } = await import('../brain/vaults.js');
    const vs = await listVaults(userId);
    const v = vs.find((x) => x.name === vaultName);
    if (!v) return res.status(404).json({ error: 'vault not found' });
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const matter = (await import('gray-matter')).default;
      const fullPath = path.join(v.path, rel);
      const txt = await fs.readFile(fullPath, 'utf8');
      const parsed = matter(txt);
      return res.json({
        path: raw,
        title: parsed.data.title,
        tags: parsed.data.tags ?? [],
        data: parsed.data,
        content: parsed.content,
      });
    } catch { return res.status(404).json({ error: 'not found' }); }
  }
  const note = await readNote(userId, raw);
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json(note);
});

// Save edited note content. Supports `<vault>::<rel>` ids. Keeps existing
// frontmatter (data passed back from FE) so `gray-matter` re-serializes.
router.put('/brain/note', async (req, res) => {
  try {
    const userId = req.user!.id;
    const raw = String(req.body?.path ?? '');
    const content = String(req.body?.content ?? '');
    const frontmatter = req.body?.data && typeof req.body.data === 'object' ? req.body.data : {};
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const matter = (await import('gray-matter')).default;
    let vaultRoot: string | null = null;
    let rel = raw;
    if (raw.includes('::')) {
      const { listVaults } = await import('../brain/vaults.js');
      const vs = await listVaults(userId);
      const [vaultName, r] = raw.split('::', 2);
      const v = vs.find((x) => x.name === vaultName);
      if (!v) return res.status(404).json({ error: 'vault not found' });
      vaultRoot = v.path; rel = r;
    } else {
      const { getVaultRoot } = await import('../brain/vault.js');
      vaultRoot = await getVaultRoot(userId);
    }
    if (!vaultRoot) return res.status(400).json({ error: 'no vault configured' });
    const full = path.join(vaultRoot, rel);
    const md = matter.stringify(content, frontmatter);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, md, 'utf8');
    invalidateGraphCache(userId);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Delete note from disk. Supports `<vault>::<rel>` ids.
router.delete('/brain/note', async (req, res) => {
  try {
    const userId = req.user!.id;
    const raw = String(req.query.path ?? '');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    let vaultRoot: string | null = null;
    let rel = raw;
    if (raw.includes('::')) {
      const { listVaults } = await import('../brain/vaults.js');
      const vs = await listVaults(userId);
      const [vaultName, r] = raw.split('::', 2);
      const v = vs.find((x) => x.name === vaultName);
      if (!v) return res.status(404).json({ error: 'vault not found' });
      vaultRoot = v.path; rel = r;
    } else {
      const { getVaultRoot } = await import('../brain/vault.js');
      vaultRoot = await getVaultRoot(userId);
    }
    if (!vaultRoot) return res.status(400).json({ error: 'no vault configured' });
    const full = path.join(vaultRoot, rel);
    await fs.unlink(full);
    // Also drop the row from brain_index if present.
    try { await query(`DELETE FROM brain_index WHERE user_id=$1 AND path=$2`, [userId, rel]); } catch {}
    invalidateGraphCache(userId);
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Reveal a vault path in the OS file manager (Finder on macOS, Explorer on
// Windows, xdg-open on Linux). Accepts `<vault>::<rel>` or bare rel. If the
// resolved path is a file, opens its PARENT folder with the file highlighted
// when the platform supports it.
router.post('/brain/reveal', async (req, res) => {
  try {
    const userId = req.user!.id;
    const raw = String(req.body?.path ?? req.query?.path ?? '');
    if (!raw) return res.status(400).json({ error: 'path missing' });
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const { spawn } = await import('node:child_process');
    let vaultRoot: string | null = null;
    let rel = raw;
    if (raw.includes('::')) {
      const { listVaults } = await import('../brain/vaults.js');
      const vs = await listVaults(userId);
      const [vaultName, r] = raw.split('::', 2);
      const v = vs.find((x) => x.name === vaultName);
      if (!v) return res.status(404).json({ error: 'vault not found' });
      vaultRoot = v.path; rel = r;
    } else {
      const { getVaultRoot } = await import('../brain/vault.js');
      vaultRoot = await getVaultRoot(userId);
    }
    if (!vaultRoot) return res.status(400).json({ error: 'no vault configured' });
    // Resolve + sandbox: must stay under vaultRoot
    const full = path.resolve(vaultRoot, rel);
    const rootResolved = path.resolve(vaultRoot);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
      return res.status(400).json({ error: 'path escapes vault' });
    }
    let stat;
    try { stat = await fs.stat(full); } catch { return res.status(404).json({ error: 'not found' }); }
    if (process.platform === 'darwin') {
      // -R reveals the item in its parent folder (file or dir); for the vault
      // root itself we just `open` it directly.
      const args = stat.isFile() ? ['-R', full] : [full];
      spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      const args = stat.isFile() ? ['/select,', full] : [full];
      spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref();
    } else {
      const target = stat.isFile() ? path.dirname(full) : full;
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
    res.json({ ok: true, path: full });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Brain snapshots: nightly backups + manual trigger.
router.get('/brain/snapshots', async (req, res) => {
  try {
    const { listSnapshots } = await import('../brain/snapshots.js');
    const limit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const vault = req.query.vault ? String(req.query.vault) : undefined;
    res.json(await listSnapshots(req.user!.id, { vault, limit, offset }));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/brain/snapshots/run', async (req, res) => {
  try {
    const { createSnapshots } = await import('../brain/snapshots.js');
    res.json({ ok: true, snapshots: await createSnapshots(req.user!.id, 'manual') });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// ---------------------------------------------------------------------------
// GOALS — obiettivi con piano approvabile, KPI per-goal e steward settimanale.
// ---------------------------------------------------------------------------
router.get('/goals', async (req, res) => {
  try {
    const { listGoals } = await import('../goals/index.js');
    res.json({ rows: await listGoals(req.user!.id, req.query.archived === '1') });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/goals', async (req, res) => {
  try {
    const { createGoal } = await import('../goals/index.js');
    const { title, objective, deadline } = req.body ?? {};
    if (!title || !objective) return res.status(400).json({ error: 'title e objective richiesti' });
    res.json(await createGoal(req.user!.id, { title, objective, deadline }));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/goals/:id', async (req, res) => {
  try {
    const { updateGoal } = await import('../goals/index.js');
    res.json(await updateGoal(req.user!.id, Number(req.params.id), req.body ?? {}));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/goals/:id/plan/generate', quotaGuard, async (req, res) => {
  try {
    const { generatePlan } = await import('../goals/index.js');
    const r = await generatePlan(req.user!.id, Number(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/goals/:id/plan/approve', async (req, res) => {
  try {
    const { approvePlan } = await import('../goals/index.js');
    const r = await approvePlan(req.user!.id, Number(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/goals/:id/plan/reject', async (req, res) => {
  try {
    const { rejectPlan } = await import('../goals/index.js');
    res.json(await rejectPlan(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/goals/:id/kpis', async (req, res) => {
  try {
    const { upsertGoalKpi } = await import('../goals/index.js');
    res.json(await upsertGoalKpi(req.user!.id, Number(req.params.id), req.body ?? {}));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/goals/:id/kpis/:kpiId', async (req, res) => {
  try {
    const { deleteGoalKpi } = await import('../goals/index.js');
    res.json(await deleteGoalKpi(req.user!.id, Number(req.params.id), String(req.params.kpiId)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
// Esecuzione di un goal: proposte (in attesa di ✅ Telegram / approvate /
// rifiutate) + sub-agent spawnati con stato, costo e risultato.
router.get('/goals/:id/execution', async (req, res) => {
  try {
    const userId = req.user!.id;
    const goalId = Number(req.params.id);
    const proposals = await query<any>(
      `SELECT id::int, title, reason, proposals, status, created_at, decided_at
       FROM agent_proposals WHERE user_id=$1 AND goal_id=$2 ORDER BY created_at DESC LIMIT 50`,
      [userId, goalId],
    );
    const agents = await query<any>(
      `SELECT id::int, title, brief, status, cost_usd, created_at, started_at, ended_at, goal_id, milestone_id,
              left(coalesce(result, ''), 1500) AS result, error, actions
       FROM sub_agents WHERE user_id=$1 AND goal_id=$2 ORDER BY created_at DESC LIMIT 100`,
      [userId, goalId],
    );
    // milestone_id sulle proposte pending serve a raggrupparle nel pannello.
    const propsWithMs = await query<any>(
      `SELECT id::int, milestone_id FROM agent_proposals WHERE user_id=$1 AND goal_id=$2`,
      [userId, goalId],
    );
    const msById = new Map(propsWithMs.map((p: any) => [p.id, p.milestone_id]));
    for (const p of proposals) (p as any).milestone_id = msById.get(p.id) ?? null;
    // Risorse per agente: file .md/.txt/… toccati (Read/Write/Edit dalle azioni),
    // dedup per path, SOLO quelli realmente esistenti su disco (gli agenti
    // registrano anche tentativi di lettura falliti → niente nodi fantasma).
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    for (const a of agents) {
      const acts: any[] = Array.isArray(a.actions) ? a.actions : [];
      const map = new Map<string, boolean>();
      for (const act of acts) {
        if (act?.name !== 'Read' && act?.name !== 'Write' && act?.name !== 'Edit') continue;
        const p = String(act.brief ?? '').trim();
        if (!p || !/\.(md|txt|pdf|csv|json|docx?)$/i.test(p)) continue;
        map.set(p, (map.get(p) ?? false) || act.name !== 'Read');
      }
      const resources: { path: string; written: boolean }[] = [];
      for (const [p, written] of map) {
        const ok = await fs.access(path.resolve(p)).then(() => true).catch(() => false);
        if (ok) resources.push({ path: p, written });
      }
      a.resources = resources;
      delete a.actions;
    }
    res.json({ proposals, agents });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Anteprima di un file-risorsa toccato da un agente (path assoluto). Per
// sicurezza il path deve risiedere dentro uno dei vault dell'utente.
router.get('/goals/:id/resource', async (req, res) => {
  try {
    const userId = req.user!.id;
    const raw = String(req.query.path ?? '');
    if (!raw) return res.status(400).json({ error: 'path richiesto' });
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const abs = path.resolve(raw);
    const { listVaults } = await import('../brain/vaults.js');
    const vaults = await listVaults(userId);
    // Gli agenti scrivono nell'intero albero `memory/` (es. people/ è sibling
    // di MyCEO/), non solo dentro i vault registrati. Boundary = parent del
    // vault root → copre le directory fratelle dello stesso brain.
    const roots = new Set<string>();
    for (const v of vaults) { const r = path.resolve(v.path); roots.add(r); roots.add(path.dirname(r)); }
    const inside = [...roots].some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!inside) return res.status(403).json({ error: 'fuori dai vault' });
    const txt = await fs.readFile(abs, 'utf8').catch(() => null);
    if (txt == null) return res.status(404).json({ error: 'non trovato' });
    let content = txt, title: string | undefined;
    if (/\.md$/i.test(abs)) {
      try { const matter = (await import('gray-matter')).default; const p = matter(txt); content = p.content; title = p.data?.title; } catch { /* keep raw */ }
    }
    res.json({ path: abs, name: path.basename(abs), title, content: content.slice(0, 60_000) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Diario dei round di goal_pursuit (append giornaliero in brain). Tasto "Recap"
// nella pagina obiettivo.
router.get('/goals/:id/pursuit-log', async (req, res) => {
  try {
    const userId = req.user!.id;
    const goalId = Number(req.params.id);
    const { getGoal } = await import('../goals/index.js');
    const g = await getGoal(userId, goalId);
    if (!g) return res.status(404).json({ error: 'goal non trovato' });
    const slug = g.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'goal';
    const note = await readNote(userId, `goals/${slug}/pursuit-log.md`);
    if (!note) return res.json({ content: null });
    res.json({ content: note.content, title: note.title });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Milestone CRUD dalla UI.
router.post('/goals/:id/milestones', async (req, res) => {
  try {
    const { addMilestone } = await import('../goals/index.js');
    const { title, due, area, order } = req.body ?? {};
    if (!title) return res.status(400).json({ error: 'title richiesto' });
    res.json(await addMilestone(req.user!.id, Number(req.params.id), { title, due, area, order }));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/goals/:id/milestones/:mid', async (req, res) => {
  try {
    const goals = await import('../goals/index.js');
    const b = req.body ?? {};
    // status separato (updateMilestone) dagli altri campi (editMilestone).
    if (b.title !== undefined || b.due !== undefined || b.area !== undefined || b.order !== undefined) {
      await goals.editMilestone(req.user!.id, Number(req.params.id), String(req.params.mid), { title: b.title, due: b.due, area: b.area, order: b.order });
    }
    const g = b.status
      ? await goals.updateMilestone(req.user!.id, Number(req.params.id), String(req.params.mid), b.status)
      : await goals.getGoal(req.user!.id, Number(req.params.id));
    res.json(g);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/goals/:id/milestones/:mid', async (req, res) => {
  try {
    const { removeMilestone } = await import('../goals/index.js');
    res.json(await removeMilestone(req.user!.id, Number(req.params.id), String(req.params.mid)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
// Deploy un agente su una milestone dalla UI → crea proposta (goal+milestone)
// con keyboard ✅/❌ su Telegram. `instruction` = cosa deve fare in parole semplici.
router.post('/goals/:id/milestones/:mid/deploy', async (req, res) => {
  try {
    const userId = req.user!.id;
    const goalId = Number(req.params.id);
    const mid = String(req.params.mid);
    const instruction = String(req.body?.instruction ?? '').trim();
    if (!instruction) return res.status(400).json({ error: 'instruction richiesta' });
    const { getGoal } = await import('../goals/index.js');
    const g = await getGoal(userId, goalId);
    const ms = g?.plan?.milestones?.find((m: any) => m.id === mid);
    if (!g || !ms) return res.status(404).json({ error: 'milestone non trovata' });
    const { createProposal } = await import('../sub_agents/index.js');
    const prompt = [
      `Stai lavorando all'obiettivo "${g.title}" (${g.objective}).`,
      `Milestone assegnata: "${ms.title}"${ms.due ? ` (entro ${ms.due})` : ''}.`,
      `Compito: ${instruction}`,
      `Esegui concretamente con i tool disponibili (mail, WhatsApp, brain, Flowspace).`,
      `Al termine: riporta l'esito a Federico in modo conciso e SCRIVI una nota nel brain (markdown) con cosa è stato fatto e i prossimi passi, taggata con l'obiettivo.`,
    ].join('\n');
    const p = await createProposal(
      userId,
      `${ms.title} — agente`,
      `Milestone: ${ms.title}`,
      [{ title: `Agente: ${ms.title.slice(0, 40)}`, brief: instruction.slice(0, 120), prompt }],
      { goalId, milestoneId: mid },
    );
    res.json({ ok: true, proposalId: p.id });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/goals/:id', async (req, res) => {
  try {
    const { deleteGoal } = await import('../goals/index.js');
    res.json(await deleteGoal(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Brain Consolidator proposals — list / apply / reject. Apply runs through
// brain/proposals.ts which snapshots the vault first.
router.get('/brain/proposals', async (req, res) => {
  try {
    const { listProposals } = await import('../brain/proposals.js');
    res.json({ rows: await listProposals(req.user!.id, String(req.query.status ?? 'pending')) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/brain/proposals/:id/apply', async (req, res) => {
  try {
    const { applyProposal } = await import('../brain/proposals.js');
    const r = await applyProposal(req.user!.id, Number(req.params.id));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/brain/proposals/:id/reject', async (req, res) => {
  try {
    const { rejectProposal } = await import('../brain/proposals.js');
    res.json(await rejectProposal(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/brain/snapshots/:id/restore', async (req, res) => {
  try {
    const { restoreSnapshot } = await import('../brain/snapshots.js');
    res.json(await restoreSnapshot(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/brain/snapshots/:id', async (req, res) => {
  try {
    const { deleteSnapshot } = await import('../brain/snapshots.js');
    res.json(await deleteSnapshot(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/brain/snapshots/dir', async (req, res) => {
  try {
    const { getSnapshotRoot } = await import('../brain/snapshots.js');
    res.json({ dir: await getSnapshotRoot(req.user!.id) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/brain/snapshots/dir', async (req, res) => {
  try {
    const { setSnapshotRoot, getSnapshotRoot } = await import('../brain/snapshots.js');
    await setSnapshotRoot(req.user!.id, String(req.body?.dir ?? ''));
    res.json({ ok: true, dir: await getSnapshotRoot(req.user!.id) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/brain/stats', async (req, res) => {
  const userId = req.user!.id;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { listVaults } = await import('../brain/vaults.js');
  const vaults = await listVaults(userId);

  async function dirSize(root: string): Promise<{ bytes: number; files: number }> {
    let bytes = 0, files = 0;
    async function walk(p: string) {
      let entries: any[] = [];
      try { entries = await fs.readdir(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) { await walk(full); continue; }
        try {
          const st = await fs.stat(full);
          bytes += st.size;
          files += 1;
        } catch {}
      }
    }
    await walk(root);
    return { bytes, files };
  }

  const vaultStats = await Promise.all(vaults.map(async (v: any) => {
    const sz = await dirSize(v.path);
    return { name: v.name, path: v.path, is_primary: v.is_primary, bytes: sz.bytes, files: sz.files };
  }));

  const byKind = await query<{ kind: string; n: number }>(
    `SELECT kind, count(*)::int AS n FROM brain_index WHERE user_id=$1 GROUP BY kind ORDER BY n DESC`, [userId]
  );
  const byVis = await query<{ visibility: string | null; n: number }>(
    `SELECT visibility, count(*)::int AS n FROM brain_index WHERE user_id=$1 GROUP BY visibility`, [userId]
  );
  const byOrigin = await query<{ origin_email: string | null; n: number }>(
    `SELECT u.email AS origin_email, count(*)::int AS n
     FROM brain_index bi LEFT JOIN users u ON u.id = bi.origin_user_id
     WHERE bi.user_id=$1 AND bi.origin_user_id IS NOT NULL
     GROUP BY u.email`, [userId]
  );
  const totalNotes = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brain_index WHERE user_id=$1`, [userId]
  );
  const lastUpdate = await query<{ ts: string | null }>(
    `SELECT max(updated_at) AS ts FROM brain_index WHERE user_id=$1`, [userId]
  );
  const last7 = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brain_index WHERE user_id=$1 AND updated_at > now() - interval '7 days'`, [userId]
  );

  const totalBytes = vaultStats.reduce((a, v) => a + v.bytes, 0);
  const totalFiles = vaultStats.reduce((a, v) => a + v.files, 0);

  res.json({
    totals: {
      notes: totalNotes[0]?.n ?? 0,
      files: totalFiles,
      bytes: totalBytes,
      vaults: vaults.length,
      updatedLast7Days: last7[0]?.n ?? 0,
      lastUpdate: lastUpdate[0]?.ts ?? null,
    },
    vaults: vaultStats,
    byKind,
    byVisibility: byVis,
    byOrigin: byOrigin.filter((o) => o.origin_email),
  });
});

// Full vault tree (every .md path relative to vault root). Used by the
// Brain file-explorer sidebar. Walks the filesystem so it doesn't depend on
// brain_index staleness. Skips dot-folders + node_modules + .git.
router.get('/brain/tree', async (req, res) => {
  try {
    // Reuse buildGraph which already walks every configured vault correctly.
    // The 3D graph reads from it, so if the graph has nodes, so will the tree.
    // Node id format: `<vaultName>::<relPath>` — split to get the rel path.
    const g = await buildGraph(req.user!.id, {});
    // Keep the `<vault>::<rel>` id format. /brain/note knows how to resolve it
    // against multi-vault. Stripping the vault prefix made clicks 404 because
    // readNote() only looks in the primary vault root.
    const files = Array.from(
      new Set(
        (g.nodes as any[])
          .map((n) => String(n.id ?? ''))
          .filter((id) => id.endsWith('.md')),
      ),
    ).sort();
    console.log(`[brain/tree] u${req.user!.id} from buildGraph: ${files.length} files`);
    res.json({ root: null, files });
  } catch (e: any) {
    console.error('[brain/tree] error', e);
    res.status(400).json({ error: String(e?.message ?? e) });
  }
});

router.get('/brain/index', async (req, res) => {
  const filter = String(req.query.visibility ?? 'all');
  const where = filter === 'all' ? '' : ' AND visibility=$2';
  const params: any[] = [req.user!.id];
  if (filter !== 'all') params.push(filter);
  const rows = await query(
    `SELECT path, kind, title, tags, summary, visibility, updated_at FROM brain_index WHERE user_id=$1${where} ORDER BY updated_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// Logs
router.get('/logs', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const kinds = String(req.query.kind ?? '').split(',').filter(Boolean);
  const statuses = String(req.query.status ?? '').split(',').filter(Boolean);
  const q = String(req.query.q ?? '').trim();
  const where: string[] = ['user_id=$1'];
  const params: any[] = [req.user!.id];
  if (kinds.length) { params.push(kinds); where.push(`kind = ANY($${params.length}::text[])`); }
  if (statuses.length) { params.push(statuses); where.push(`status = ANY($${params.length}::text[])`); }
  if (q) { params.push(`%${q}%`); where.push(`(result ILIKE $${params.length} OR prompt ILIKE $${params.length} OR error ILIKE $${params.length})`); }
  const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM agent_runs WHERE ${where.join(' AND ')}`, params);
  params.push(limit, offset);
  const rows = await query(
    `SELECT id::int, ts, kind, status, model, duration_ms, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, cost_usd::float8, num_turns,
            LEFT(result, 240) AS preview, meta, error
     FROM agent_runs WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ rows, total: totalRows[0]?.c ?? 0 });
});

router.get('/logs/:id', async (req, res) => {
  const rows = await query(
    `SELECT id::int, ts, kind, status, model, duration_ms, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, cost_usd::float8, num_turns,
            prompt, result, meta, error FROM agent_runs WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user!.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// Outbound communications audit log
router.get('/outbound', async (req, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const channels = String(req.query.channel ?? '').split(',').filter(Boolean);
  const statuses = String(req.query.status ?? '').split(',').filter(Boolean);
  const q = req.query.q ? String(req.query.q).trim() : null;
  const where: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  const validCh = channels.filter((c) => ['whatsapp','email','telegram','instagram'].includes(c));
  const validSt = statuses.filter((s) => ['sent','error'].includes(s));
  if (validCh.length) { params.push(validCh); where.push(`channel = ANY($${params.length}::text[])`); }
  if (validSt.length) { params.push(validSt); where.push(`status = ANY($${params.length}::text[])`); }
  if (q) { params.push(`%${q.toLowerCase()}%`); where.push(`(lower(coalesce(recipient,'')) LIKE $${params.length} OR lower(coalesce(recipient_name,'')) LIKE $${params.length} OR lower(coalesce(subject,'')) LIKE $${params.length} OR lower(coalesce(body,'')) LIKE $${params.length})`); }
  const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM outbound_log WHERE ${where.join(' AND ')}`, params);
  params.push(limit); params.push(offset);
  const rows = await query<any>(
    `SELECT id::int, ts, channel, status, recipient, recipient_name, subject,
            LEFT(coalesce(body,''), 320) AS body_preview, origin, error, meta
     FROM outbound_log WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const totals = await query<any>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='error')::int AS errors,
            count(*) FILTER (WHERE channel='whatsapp')::int AS whatsapp,
            count(*) FILTER (WHERE channel='email')::int AS email,
            count(*) FILTER (WHERE channel='telegram')::int AS telegram,
            count(*) FILTER (WHERE channel='instagram')::int AS instagram
     FROM outbound_log WHERE user_id=$1`,
    [userId],
  );
  res.json({ rows, total: totalRows[0]?.c ?? 0, totals: totals[0] ?? { total: 0 } });
});
router.get('/outbound/:id', async (req, res) => {
  const rows = await query(
    `SELECT id::int, ts, channel, status, recipient, recipient_name, subject, body, origin, error, meta
     FROM outbound_log WHERE id=$1 AND user_id=$2`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

router.get('/logs/stats/summary', async (req, res) => {
  const userId = req.user!.id;
  const rows = await query<any>(
    `SELECT date_trunc('day', ts) AS day, kind, count(*)::int AS runs,
            coalesce(sum(cost_usd), 0)::float8 AS cost,
            coalesce(sum(input_tokens), 0)::int AS in_tok,
            coalesce(sum(output_tokens), 0)::int AS out_tok,
            coalesce(avg(duration_ms), 0)::int AS avg_ms
     FROM agent_runs WHERE user_id=$1 AND ts > now() - interval '14 days'
     GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [userId]
  );
  const today = await query<any>(
    `SELECT coalesce(sum(cost_usd),0)::float8 AS cost, count(*)::int AS runs FROM agent_runs WHERE user_id=$1 AND ts > date_trunc('day', now())`, [userId]
  );
  const total = await query<any>(
    `SELECT coalesce(sum(cost_usd),0)::float8 AS cost, count(*)::int AS runs FROM agent_runs WHERE user_id=$1`, [userId]
  );
  res.json({ byDay: rows, today: today[0], allTime: total[0] });
});

// Agent state
router.get('/agent/state', async (req, res) => {
  const userId = req.user!.id;
  const quiet = await getSetting<any>(userId, 'agent_quiet_until');
  const sleep = await getSetting<any>(userId, 'agent_next_reflection_at');
  const now = Date.now();
  res.json({
    quiet: quiet?.until && new Date(quiet.until).getTime() > now ? quiet : null,
    sleep: sleep?.until && new Date(sleep.until).getTime() > now ? sleep : null,
  });
});

router.post('/agent/wake', async (req, res) => {
  await setSetting(req.user!.id, 'agent_next_reflection_at', null);
  await setSetting(req.user!.id, 'agent_quiet_until', null);
  res.json({ ok: true });
});

// Tasks
router.get('/tasks', async (req, res) => {
  const { listTasks } = await import('../scheduler/tasks.js');
  res.json(await listTasks(req.user!.id));
});
router.post('/tasks', async (req, res) => {
  const { name, cron: expr, action_type, action_payload, enabled = true } = req.body ?? {};
  if (!name || !expr || !action_type) return res.status(400).json({ error: 'name, cron, action_type required' });
  const cron = (await import('node-cron')).default;
  if (!cron.validate(expr)) return res.status(400).json({ error: `invalid cron: ${expr}` });
  const rows = await query<{ id: number }>(
    `INSERT INTO scheduled_tasks(user_id,name,cron,action_type,action_payload,enabled) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
    [req.user!.id, name, expr, action_type, JSON.stringify(action_payload ?? {}), enabled]
  );
  const { refreshTasks } = await import('../scheduler/tasks.js');
  await refreshTasks();
  res.json({ ok: true, id: rows[0]?.id });
});
router.put('/tasks/:id', async (req, res) => {
  const cron = (await import('node-cron')).default;
  const p = req.body ?? {};
  if (p.cron && !cron.validate(p.cron)) return res.status(400).json({ error: `invalid cron: ${p.cron}` });
  const fields: string[] = [];
  const vals: any[] = [];
  let i = 2;
  for (const k of ['name', 'cron', 'action_type', 'action_payload', 'enabled']) {
    if (p[k] !== undefined) { fields.push(`${k}=$${++i}`); vals.push(p[k]); }
  }
  if (fields.length) {
    await query(`UPDATE scheduled_tasks SET ${fields.join(',')}, updated_at=now() WHERE id=$1 AND user_id=$2`, [req.params.id, req.user!.id, ...vals]);
  }
  const { refreshTasks } = await import('../scheduler/tasks.js');
  await refreshTasks();
  res.json({ ok: true });
});
router.delete('/tasks/:id', async (req, res) => {
  await query('DELETE FROM scheduled_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.id]);
  const { refreshTasks } = await import('../scheduler/tasks.js');
  await refreshTasks();
  res.json({ ok: true });
});
router.post('/tasks/:id/run', async (req, res) => {
  const { runTaskById } = await import('../scheduler/tasks.js');
  await runTaskById(req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});

// Network (P2P brain sharing) — discovery: all users with public-ish blurb
router.get('/network/discover', async (req, res) => {
  const me = req.user!.id;
  const users = await query<any>(
    `SELECT u.id::int, u.email, u.name,
            (SELECT value FROM settings WHERE user_id=u.id AND key='profile')   AS profile,
            (SELECT value FROM settings WHERE user_id=u.id AND key='business')  AS business
       FROM users u WHERE u.id <> $1 ORDER BY u.created_at DESC`,
    [me]
  );
  const conns = await query<any>(
    `SELECT a_user_id::int, b_user_id::int, status, initiator_user_id::int
       FROM user_connections WHERE a_user_id=$1 OR b_user_id=$1`, [me]
  );
  const byPeer = new Map<number, any>();
  for (const c of conns) {
    const peer = c.a_user_id === me ? c.b_user_id : c.a_user_id;
    byPeer.set(peer, c);
  }
  res.json(users.map((u: any) => {
    const c = byPeer.get(u.id);
    return {
      id: u.id, email: u.email, name: u.name,
      role: u.profile?.role ?? null,
      company: u.business?.company ?? null,
      what: u.business?.what ?? null,
      connection_status: c?.status ?? 'none',
      connection_initiator: c?.initiator_user_id ?? null,
    };
  }));
});

router.get('/network/peers', async (req, res) => {
  const m = await import('../network/index.js');
  res.json(await m.listPeers(req.user!.id));
});
router.post('/network/connect', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.requestConnection(req.user!.id, String(req.body?.email ?? ''))); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/network/connection/:id/respond', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.respondConnection(req.user!.id, Number(req.params.id), !!req.body?.accept)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/network/share/incoming', async (req, res) => {
  const m = await import('../network/index.js');
  res.json(await m.listIncomingShareRequests(req.user!.id));
});
router.get('/network/share/outgoing', async (req, res) => {
  const m = await import('../network/index.js');
  res.json(await m.listOutgoingShareRequests(req.user!.id));
});
router.post('/network/share', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.createShareRequest(req.user!.id, String(req.body?.email ?? ''), String(req.body?.query ?? ''))); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/network/share/:id/review', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.triggerReview(Number(req.params.id), req.user!.id)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/network/share/:id/approve', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.approveShareRequest(req.user!.id, Number(req.params.id), req.body?.paths ?? [])); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/network/share/:id/deny', async (req, res) => {
  const m = await import('../network/index.js');
  try { res.json(await m.denyShareRequest(req.user!.id, Number(req.params.id), req.body?.reason)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Vaults (multi-brain)
router.get('/vaults', async (req, res) => {
  const m = await import('../brain/vaults.js');
  res.json(await m.listVaults(req.user!.id));
});
router.post('/vaults', async (req, res) => {
  const m = await import('../brain/vaults.js');
  const { name, path: p, seed = true, makePrimary = false } = req.body ?? {};
  if (!name || !p) return res.status(400).json({ error: 'name and path required' });
  try { res.json(await m.createVault(req.user!.id, String(name), String(p), { seed: !!seed, makePrimary: !!makePrimary })); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/vaults/:id/primary', async (req, res) => {
  const m = await import('../brain/vaults.js');
  try { await m.setPrimaryVault(req.user!.id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/vaults/:id', async (req, res) => {
  const m = await import('../brain/vaults.js');
  try { await m.deleteVault(req.user!.id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// People — server-side paginated/searchable
router.get('/people', async (req, res) => {
  const userId = req.user!.id;
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const sortMap: Record<string, string> = { name: 'name', slug: 'slug', updated: 'updated_at' };
  const sortCol = sortMap[String(req.query.sort ?? 'updated')] ?? 'updated_at';
  const dir = String(req.query.dir ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const where: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  if (q) {
    const idx = params.length;
    params.push(`%${q}%`);
    where.push(`(name ILIKE $${idx + 1} OR slug ILIKE $${idx + 1}
      OR EXISTS(SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $${idx + 1})
      OR EXISTS(SELECT 1 FROM unnest(emails) e WHERE e ILIKE $${idx + 1})
      OR EXISTS(SELECT 1 FROM unnest(phones) p WHERE p ILIKE $${idx + 1}))`);
  }
  const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM people WHERE ${where.join(' AND ')}`, params);
  params.push(limit, offset);
  const rows = await query<any>(
    `SELECT id::int, slug, name, aliases, emails, phones, note_path, meta, updated_at,
            EXISTS(SELECT 1 FROM brain_index bi WHERE bi.user_id=people.user_id AND bi.path = 'people/' || people.slug || '.psy-profile.md') AS has_psy
     FROM people WHERE ${where.join(' AND ')}
     ORDER BY ${sortCol} ${dir} NULLS LAST, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ rows, total: totalRows[0]?.c ?? 0, limit, offset });
});

router.get('/people/:slug/psy-profile', async (req, res) => {
  const userId = req.user!.id;
  const slug = String(req.params.slug);
  const rel = `people/${slug}.psy-profile.md`;
  const note = await readNote(userId, rel);
  if (!note) return res.status(404).json({ error: 'profile not generated yet' });
  res.json(note);
});
router.get('/people/:slug/graph', async (req, res) => {
  const userId = req.user!.id;
  const slug = String(req.params.slug);
  const hops = Math.min(Math.max(Number(req.query.hops ?? 2), 1), 4);
  const { buildGraph } = await import('../brain/graph.js');
  const g = await buildGraph(userId, {});
  // Find central node for the person — usually `<vault>::people/<slug>.md`
  const center = g.nodes.find((n: any) => n.id?.endsWith(`::people/${slug}.md`) || n.id === `people/${slug}.md`);
  if (!center) return res.json({ nodes: [], links: [], center: null });
  // BFS up to `hops`
  const adj = new Map<string, Set<string>>();
  for (const l of g.links as any[]) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (!adj.has(s)) adj.set(s, new Set());
    if (!adj.has(t)) adj.set(t, new Set());
    adj.get(s)!.add(t); adj.get(t)!.add(s);
  }
  const keep = new Set<string>([center.id]);
  let frontier = new Set<string>([center.id]);
  for (let h = 0; h < hops; h++) {
    const next = new Set<string>();
    for (const id of frontier) for (const nb of adj.get(id) ?? []) {
      if (!keep.has(nb)) { keep.add(nb); next.add(nb); }
    }
    frontier = next;
    if (!frontier.size) break;
  }
  // Assign BFS level per kept node + emit tree edges (parent→child) only,
  // so the graph is acyclic and dagMode renders cleanly.
  const level = new Map<string, number>();
  level.set(center.id, 0);
  const parent = new Map<string, string>();
  const queue: string[] = [center.id];
  while (queue.length) {
    const id = queue.shift()!;
    const lvl = level.get(id)!;
    for (const nb of adj.get(id) ?? []) {
      if (!keep.has(nb) || level.has(nb)) continue;
      level.set(nb, lvl + 1);
      parent.set(nb, id);
      queue.push(nb);
    }
  }
  const nodes = (g.nodes as any[])
    .filter((n) => keep.has(n.id))
    .map((n) => ({ ...n, level: level.get(n.id) ?? 0 }));
  const links: any[] = [];
  for (const [child, par] of parent) links.push({ source: par, target: child });
  res.json({ nodes, links, center: center.id });
});

router.delete('/people/:slug', async (req, res) => {
  try {
    const m = await import('../connectors/builtin/people/index.js');
    const keepNote = req.query.keep_note === '1' || req.query.keep_note === 'true';
    const keepRefs = req.query.keep_refs === '1' || req.query.keep_refs === 'true';
    res.json(await m.deletePerson(req.user!.id, req.params.slug, { keep_note: keepNote, keep_refs: keepRefs }));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.post('/people/merge', async (req, res) => {
  try {
    const m = await import('../connectors/builtin/people/index.js');
    const canonical_slug = String(req.body?.canonical_slug ?? '');
    const dup_slugs = Array.isArray(req.body?.dup_slugs) ? req.body.dup_slugs.map(String) : [];
    res.json(await m.mergePeople(req.user!.id, canonical_slug, dup_slugs));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.post('/people/resync', async (req, res) => {
  try {
    const m = await import('../connectors/builtin/people/index.js');
    const prune = req.body?.prune === true || req.query.prune === '1';
    res.json(await m.resyncPeopleFromVault(req.user!.id, { prune }));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.post('/people/dedupe-agent', async (req, res) => {
  const { spawnSubAgent } = await import('../sub_agents/index.js');
  const userId = req.user!.id;
  const prompt = `=== BONIFICA DUPLICATI PEOPLE ===

Compito: trova e unifica i duplicati nella tabella People del DB e nelle note del second brain.

TOOL ATOMICI (USA QUESTI, non re-implementare a mano):
- \`mcp__super_agent__people_list\` — paginato, restituisce name/slug/aliases/emails/phones/note_path.
- \`mcp__super_agent__people_merge\` — input: \`{canonical_slug, dup_slugs: [...]}\`. UNICA call necessaria per fondere un gruppo. Esegue TUTTO: union arrays, append note bodies sotto "## merged from <slug>", repoint wa_contacts.linked_person_slug, DELETE righe DB dup, DELETE file .md dup, riscrive [[dup-slug]] refs nel vault → [[people/canonical|name]].
- \`mcp__super_agent__people_delete\` — input: \`{slug}\`. Per record spuri da rimuovere senza merge.

PROCEDURA:
1. Chiama \`people_list({limit: 200})\` (e pagina se total > 200).
2. Identifica gruppi di duplicati (per ogni gruppo, ≥ 2 record):
   - Stesso normalized name (lowercase, trim, no accenti)
   - Email in comune (case-insensitive)
   - Telefono in comune (solo digits)
   - Slug simili (Levenshtein ≤ 3)
3. Per ogni gruppo: scegli canonical con questa PRIORITÀ STRICT (in ordine, prima che vince):
   a. Record con ≥1 email O ≥1 phone → vince sempre su record senza contatti.
   b. Se pari su (a): record con più aliases.
   c. Se pari su (a)+(b): record con slug più corto / più "pulito" (es. \`mattia-calastri\` > \`mattia-calastri-autonomous-ai-business-governance\`).
   d. Se ancora pari: il primo per updated_at DESC.
   ESEMPIO: tra \`mattia-calastri\` (emails+phones) e \`mattia-calastri-autonomous-ai-business-governance\` (vuoto), canonical = \`mattia-calastri\`. SEMPRE.
   Chiama UNA volta \`people_merge({canonical_slug, dup_slugs})\` con tutti i dup. NON usare upsert.
4. Se sicuro che un record è 100% spurio (no merge utile, dati orfani), chiama \`people_delete({slug})\`.

REGOLE:
- NESSUNA conferma utente: agire deterministico.
- Se gruppo ambiguo (omonimi senza email/phone overlap) → skip, log "ambiguous".
- Mai inviare msg Telegram.
- VIETATO chiamare \`people_dedupe_run\`: TU SEI già il dedupe runner.
- Output finale: 1 paragrafo riepilogo (gruppi, merged, deleted, skipped).`;

  const sa = await spawnSubAgent(userId, {
    title: 'Bonifica duplicati People',
    brief: 'Trova duplicati in People (name/email/phone) e unifica record + note brain.',
    prompt,
  });
  res.json({ ok: true, subAgentId: sa.id });
});

// Sub-agents
router.get('/sub-agents', async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  const statuses = String(req.query.status ?? '').split(',').filter(Boolean);
  const q = String(req.query.q ?? '').trim();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 100), 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const sort = req.query.sort ? String(req.query.sort) : undefined;
  const dir = req.query.dir === 'asc' ? 'asc' as const : req.query.dir === 'desc' ? 'desc' as const : undefined;
  if (req.query.paginated === '1') {
    res.json(await sa.listSubAgents(req.user!.id, { statuses, q, limit, offset, sort, dir, withTotal: true }));
  } else {
    res.json(await sa.listSubAgents(req.user!.id, { statuses, q, limit, offset, sort, dir }));
  }
});
router.get('/sub-agents/stats', async (req, res) => {
  const userId = req.user!.id;
  const totals = await query<any>(
    `SELECT count(*)::int AS n,
            coalesce(sum(cost_usd),0)::float8 AS cost,
            coalesce(sum(input_tokens),0)::int AS in_tok,
            coalesce(sum(output_tokens),0)::int AS out_tok,
            coalesce(sum(num_turns),0)::int AS turns
     FROM sub_agents WHERE user_id=$1`, [userId]
  );
  const byStatus = await query<any>(
    `SELECT status, count(*)::int AS n FROM sub_agents WHERE user_id=$1 GROUP BY status`, [userId]
  );
  const byDay = await query<any>(
    `SELECT date_trunc('day', created_at) AS day, count(*)::int AS n,
            coalesce(sum(cost_usd),0)::float8 AS cost
     FROM sub_agents WHERE user_id=$1 AND created_at > now() - interval '14 days'
     GROUP BY 1 ORDER BY 1 DESC`, [userId]
  );
  const topTools = await query<any>(
    `SELECT tool->>'name' AS name, count(*)::int AS n
     FROM sub_agents, jsonb_array_elements(actions) AS tool
     WHERE user_id=$1
     GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [userId]
  );
  res.json({ totals: totals[0], byStatus, byDay, topTools });
});
router.get('/sub-agents/active', async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  res.json(await sa.listActive(req.user!.id));
});
router.get('/sub-agents/:id', async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  const r = await sa.getSubAgent(req.user!.id, Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});
router.post('/sub-agents/:id/cancel', async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  await sa.cancelSubAgent(req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});
router.get('/agent-proposals', async (req, res) => {
  const rows = await query(
    `SELECT * FROM agent_proposals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user!.id]
  );
  res.json(rows);
});
router.post('/agent-proposals/:id/approve', quotaGuard, async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  try { res.json({ ok: true, spawned: await sa.approveProposal(req.user!.id, Number(req.params.id)) }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/agent-proposals/:id/deny', async (req, res) => {
  const sa = await import('../sub_agents/index.js');
  try { await sa.denyProposal(req.user!.id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Email drafts (IMAP+SMTP human-in-the-loop)
router.get('/email-drafts', async (req, res) => {
  const m = await import('../connectors/builtin/imap/index.js');
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json(await m.listDrafts(req.user!.id, status));
});
router.post('/email-drafts/:id/send', async (req, res) => {
  const m = await import('../connectors/builtin/imap/index.js');
  try { const d = await m.sendDraft(req.user!.id, Number(req.params.id)); res.json(d); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/email-drafts/:id/deny', async (req, res) => {
  const m = await import('../connectors/builtin/imap/index.js');
  await m.denyDraft(req.user!.id, Number(req.params.id));
  res.json({ ok: true });
});
router.post('/email/test', async (req, res) => {
  const m = await import('../connectors/builtin/imap/index.js');
  const account = String(req.body?.account ?? '');
  if (!account) return res.status(400).json({ ok: false, error: 'account label required' });
  try { res.json(await m.sendTestEmail(req.user!.id, account)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

// Custom agents + teams + team tasks
router.get('/custom-agents', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    res.json(await t.listAgents(req.user!.id));
  } catch (e: any) { console.error('[GET /custom-agents]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/custom-agents', async (req, res) => {
  const t = await import('../teams/index.js');
  try { res.json(await t.createAgent(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/custom-agents/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const r = await t.getAgent(req.user!.id, Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { console.error('[GET /custom-agents/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.put('/custom-agents/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const r = await t.updateAgent(req.user!.id, Number(req.params.id), req.body ?? {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { console.error('[PUT /custom-agents/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.delete('/custom-agents/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    await t.deleteAgent(req.user!.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) { console.error('[DELETE /custom-agents/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});

router.get('/teams', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    res.json(await t.listTeams(req.user!.id));
  } catch (e: any) { console.error('[GET /teams]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/teams', async (req, res) => {
  const t = await import('../teams/index.js');
  try { res.json(await t.createTeam(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/teams/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const r = await t.getTeam(req.user!.id, Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { console.error('[GET /teams/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.put('/teams/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const r = await t.updateTeam(req.user!.id, Number(req.params.id), req.body ?? {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { console.error('[PUT /teams/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.delete('/teams/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    await t.deleteTeam(req.user!.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) { console.error('[DELETE /teams/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.put('/teams/:id/members', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const r = await t.setTeamMembers(req.user!.id, Number(req.params.id), req.body?.members ?? []);
    if (!r) return res.status(404).json({ error: 'team not found' });
    res.json(r);
  } catch (e: any) { console.error('[PUT /teams/:id/members]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});

router.get('/team-tasks', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    res.json(await t.listTasks(req.user!.id, { status: req.query.status ? String(req.query.status) : undefined }));
  } catch (e: any) { console.error('[GET /team-tasks]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.get('/team-tasks/stats/running', async (req, res) => {
  try {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_tasks WHERE user_id=$1 AND status IN ('pending','running')`,
      [req.user!.id],
    );
    res.json({ running: rows[0]?.n ?? 0 });
  } catch (e: any) { console.error('[GET /team-tasks/stats/running]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/team-tasks', async (req, res) => {
  const t = await import('../teams/index.js');
  const b = req.body ?? {};
  try {
    res.json(await t.createTask(req.user!.id, {
      title: b.title,
      prompt: b.prompt,
      // Accept both snake_case (FE convention) and camelCase
      teamId: b.team_id ?? b.teamId ?? null,
      agentId: b.agent_id ?? b.agentId ?? null,
      createdBy: 'user',
    }));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/team-tasks/:id', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    const task = await t.getTask(req.user!.id, Number(req.params.id));
    if (!task) return res.status(404).json({ error: 'not found' });
    const events = await t.getTaskEvents(task.id);
    res.json({ task, events });
  } catch (e: any) { console.error('[GET /team-tasks/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/team-tasks/:id/cancel', async (req, res) => {
  try {
    const t = await import('../teams/index.js');
    await t.cancelTask(req.user!.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) { console.error('[POST /team-tasks/:id/cancel]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});

// Roadmap v2 — structured JSON model
router.get('/roadmap-v2', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.getRoadmap(req.user!.id)); }
  catch (e: any) { console.error('[GET /roadmap-v2]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.put('/roadmap-v2', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.saveRoadmap(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/roadmap-v2/stats', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.stats(req.user!.id)); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/roadmap-v2/:horizon/todos', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.addTodo(req.user!.id, req.params.horizon as any, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/roadmap-v2/:horizon/todos/:id', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.updateTodo(req.user!.id, req.params.horizon as any, req.params.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/roadmap-v2/:horizon/todos/:id', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.deleteTodo(req.user!.id, req.params.horizon as any, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/roadmap-v2/todos/:id/move', async (req, res) => {
  try {
    const m = await import('../roadmap/index.js');
    const { from, to } = req.body ?? {};
    res.json(await m.moveTodo(req.user!.id, from, req.params.id, to));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/roadmap-v2/strategy', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.setStrategy(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/roadmap-v2/kpis', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.upsertKpi(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/roadmap-v2/kpis/:id', async (req, res) => {
  try { const m = await import('../roadmap/index.js'); res.json(await m.deleteKpi(req.user!.id, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Flows
router.get('/flows', async (req, res) => {
  try { const m = await import('../flows/index.js'); res.json(await m.listFlows(req.user!.id)); }
  catch (e: any) { console.error('[GET /flows]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/flows', async (req, res) => {
  try { const m = await import('../flows/index.js'); res.json(await m.createFlow(req.user!.id, req.body ?? {})); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/flows/:id', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    const r = await m.getFlow(req.user!.id, Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { console.error('[GET /flows/:id]', e); res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.put('/flows/:id', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    const r = await m.updateFlow(req.user!.id, Number(req.params.id), req.body ?? {});
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/flows/:id', async (req, res) => {
  try { const m = await import('../flows/index.js'); await m.deleteFlow(req.user!.id, Number(req.params.id)); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/flows/:id/triggers', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    await m.setTriggers(req.user!.id, Number(req.params.id), req.body?.triggers ?? []);
    res.json(await m.getFlow(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/flows/:id/steps', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    await m.setSteps(req.user!.id, Number(req.params.id), req.body?.steps ?? []);
    res.json(await m.getFlow(req.user!.id, Number(req.params.id)));
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/flows/:id/runs', async (req, res) => {
  try { const m = await import('../flows/index.js'); res.json(await m.listRuns(req.user!.id, Number(req.params.id))); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.get('/flow-runs/:runId', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    const r = await m.getRun(req.user!.id, Number(req.params.runId));
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
});
router.post('/flows/:id/run', async (req, res) => {
  try {
    const m = await import('../flows/index.js');
    const runId = await m.runFlow(req.user!.id, Number(req.params.id), 'manual', req.body ?? {});
    res.json({ ok: true, run_id: runId });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// WhatsApp
router.get('/whatsapp/status', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  res.json(m.getWaStatus(req.user!.id));
});
router.post('/whatsapp/start', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.startWaForUser(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/logout', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  await m.logoutWaForUser(req.user!.id);
  res.json({ ok: true });
});
router.post('/whatsapp/chats/:jid/sync', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const batches = Number(req.body?.batches ?? 3);
  try { res.json(await m.syncOneChat(req.user!.id, req.params.jid, batches)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/:jid/auto-bonify', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const enabled = !!req.body?.enabled;
  try { res.json(await m.setChatAutoBonify(req.user!.id, req.params.jid, enabled)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/:jid/suggest', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.suggestReply(req.user!.id, req.params.jid, { hint: req.body?.hint })); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/:jid/send', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const text = String(req.body?.text ?? '');
  const source: 'user' | 'ai' = req.body?.source === 'ai' ? 'ai' : 'user';
  try { res.json(await m.sendWaMessage(req.user!.id, req.params.jid, text, 'user', source)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/merge', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const canon = String(req.body?.canon ?? '');
  const dups: string[] = Array.isArray(req.body?.dups) ? req.body.dups : [];
  if (!canon || !dups.length) return res.status(400).json({ ok: false, error: 'canon + dups required' });
  try { res.json(await m.mergeChats(req.user!.id, canon, dups)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/contacts/refresh', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.refreshContactsAndGroups(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/pics/refresh', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.forceWaPicRefresh(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/dedupe', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.dedupeChats(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/ai-dedupe', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.aiDedupeChats(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/wipe', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.wipeAllChats(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/delete', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const jids = Array.isArray(req.body?.chat_jids) ? req.body.chat_jids.map(String) : [];
  try { res.json(await m.deleteChats(req.user!.id, jids)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/:jid/display', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try {
    res.json(await m.setChatDisplayOverride(req.user!.id, req.params.jid, {
      display_name: req.body?.display_name === undefined ? undefined : (req.body.display_name === null ? null : String(req.body.display_name)),
      display_phone: req.body?.display_phone === undefined ? undefined : (req.body.display_phone === null ? null : String(req.body.display_phone)),
    }));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/chats/:jid/link', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const slug = req.body?.slug === null ? null : (req.body?.slug ? String(req.body.slug) : null);
  try { res.json(await m.linkChatToPerson(req.user!.id, req.params.jid, slug)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/sync', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  try { res.json(await m.syncWaForUser(req.user!.id)); }
  catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.get('/whatsapp/pending', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  res.json({ count: await m.pendingCount(req.user!.id) });
});
router.get('/whatsapp/unread', async (req, res) => {
  try {
    const r = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM wa_messages
       WHERE user_id=$1 AND from_me=false AND processed_at IS NULL
         AND msg_id NOT LIKE 'chat:%' AND text <> ''`, [req.user!.id]);
    res.json({ count: r[0]?.c ?? 0 });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/instagram/unread', async (req, res) => {
  try {
    const r = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ig_messages
       WHERE user_id=$1 AND from_me=false AND processed_at IS NULL AND text <> ''`,
      [req.user!.id]);
    res.json({ count: r[0]?.c ?? 0 });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.post('/whatsapp/bonify', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const limit = Number(req.body?.limit ?? 100);
  const onlyChat = req.body?.onlyChat ?? undefined;
  // fire-and-forget so HTTP returns immediately
  m.bonifyWaMessages(req.user!.id, { limit, onlyChat })
    .then((r) => console.log(`[wa:u${req.user!.id}] bonifica done`, r))
    .catch((e) => console.error('[wa] bonify error', e));
  res.json({ ok: true, started: true, limit });
});
router.get('/whatsapp/chats', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  const r = await m.listChats(req.user!.id);
  // DEBUG: when ?debug_jid=X is passed, dump exactly what listChats resolved
  // for that chat — name + linked_slug + display_name override.
  const dbg = String(req.query.debug_jid ?? '');
  if (dbg) {
    const row = (r as any[]).find((x) => x.chat_jid === dbg);
    console.log(`[wa:listChats] DEBUG jid=${dbg}`, row ? {
      sender_name: row.sender_name, linked_person_slug: row.linked_person_slug,
      display_name_override: row.display_name_override,
    } : 'NOT FOUND');
  }
  res.json(r);
});
router.get('/whatsapp/chats/:jid/messages', async (req, res) => {
  const m = await import('../connectors/builtin/whatsapp/index.js');
  res.json(await m.chatMessages(req.user!.id, req.params.jid, Math.min(Number(req.query.limit ?? 200), 500)));
});

// =====================================================================
// Instagram DM routes — mirrors WhatsApp shape
// =====================================================================
router.get('/instagram/status', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  res.json(m.getIgStatus(req.user!.id));
});
router.post('/instagram/start', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { username, password } = req.body ?? {};
  res.json(await m.startIgForUser(req.user!.id, { username, password }));
});
router.post('/instagram/2fa', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code required' });
  res.json(await m.submitIgTwoFactor(req.user!.id, String(code)));
});
router.post('/instagram/checkpoint', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code required' });
  res.json(await m.submitIgCheckpoint(req.user!.id, String(code)));
});
router.post('/instagram/logout', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  await m.logoutIgForUser(req.user!.id);
  res.json({ ok: true });
});
router.get('/instagram/threads', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  res.json(await m.listThreads(req.user!.id));
});
router.get('/instagram/threads/:id/messages', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  res.json(await m.threadMessages(req.user!.id, req.params.id, Math.min(Number(req.query.limit ?? 200), 500)));
});
router.post('/instagram/threads/:id/send', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { text, source } = req.body ?? {};
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json(await m.sendIgMessage(req.user!.id, req.params.id, String(text), 'user', source === 'ai' ? 'ai' : 'user'));
});
router.post('/instagram/threads/:id/suggest', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { hint } = req.body ?? {};
  res.json(await m.suggestIgReply(req.user!.id, req.params.id, { hint }));
});
router.post('/instagram/threads/:id/auto-bonify', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { enabled } = req.body ?? {};
  res.json(await m.setThreadAutoBonify(req.user!.id, req.params.id, !!enabled));
});
router.post('/instagram/threads/:id/auto-responder', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { enabled, goal } = req.body ?? {};
  res.json(await m.setThreadAutoResponder(req.user!.id, req.params.id, !!enabled, goal ?? null));
});
router.post('/instagram/bonify', quotaGuard, async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const { limit, onlyThread } = req.body ?? {};
  res.json(await m.bonifyIgMessages(req.user!.id, { limit, onlyThread }));
});
router.get('/instagram/pending', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  res.json({ pending: await m.pendingCount(req.user!.id) });
});
router.post('/instagram/sync', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const pages = Math.max(1, Math.min(Number(req.body?.pages ?? 3), 10));
  res.json(await m.syncIgNow(req.user!.id, pages));
});
router.post('/instagram/threads/:id/sync', async (req, res) => {
  const m = await import('../connectors/builtin/instagram/index.js');
  const pages = Math.max(1, Math.min(Number(req.body?.pages ?? 5), 20));
  res.json(await m.syncIgThread(req.user!.id, req.params.id, pages));
});

router.get('/tool-events', async (req, res) => {
  const userId = req.user!.id;
  const filter = String(req.query.filter ?? 'all'); // all|mcp|native
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;
  const server = req.query.server ? String(req.query.server) : null;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
  const parts: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  if (filter === 'mcp') parts.push('is_mcp = true');
  else if (filter === 'native') parts.push('is_mcp = false');
  if (server) { params.push(server); parts.push(`server = $${params.length}`); }
  if (cursor) { params.push(cursor); parts.push(`id < $${params.length}`); }
  params.push(limit);
  const rows = await query<any>(
    `SELECT id::int, name, server, is_mcp, brief, kind, ts FROM tool_events WHERE ${parts.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`,
    params,
  );
  res.json(rows);
});

// Plugins (.skill)
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Ingestion upload — DISK storage (streams to ~/super-agent-ingest, doesn't
// buffer 650MB in RAM) + a high 2GB ceiling. Filenames sanitized + prefixed
// with a timestamp-ish random to avoid collisions.
const ingestUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try { const { ensureIngestRoot } = await import('../ingest/index.js'); cb(null, await ensureIngestRoot()); }
      catch (e: any) { cb(e, ''); }
    },
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180);
      cb(null, `${crypto.randomBytes(4).toString('hex')}__${safe}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
router.post('/ingest', ingestUpload.single('file'), async (req, res) => {
  try {
    const f = (req as any).file;
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!f) return res.status(400).json({ error: 'file mancante' });
    if (!prompt) return res.status(400).json({ error: 'prompt mancante' });
    const { createIngestion } = await import('../ingest/index.js');
    const ing = await createIngestion(req.user!.id, {
      filename: f.originalname, absPath: f.path, sizeBytes: f.size, prompt,
    });
    res.json({ ok: true, ingestion: ing });
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});
router.get('/ingest', async (req, res) => {
  try {
    const { listIngestions } = await import('../ingest/index.js');
    res.json({ rows: await listIngestions(req.user!.id) });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/plugins', async (_req, res) => {
  const m = await import('../plugins/index.js');
  res.json(await m.listPlugins());
});
router.post('/plugins/install', upload.single('file'), async (req, res) => {
  const m = await import('../plugins/index.js');
  if (!req.file?.buffer) return res.status(400).json({ error: 'file mancante' });
  try { res.json(await m.installFromZip(req.file.buffer)); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.put('/plugins/:slug', async (req, res) => {
  const m = await import('../plugins/index.js');
  try { await m.setEnabled(req.params.slug, !!req.body?.enabled); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.delete('/plugins/:slug', async (req, res) => {
  const m = await import('../plugins/index.js');
  try { await m.uninstall(req.params.slug); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
router.get('/plugins/:slug/export', async (req, res) => {
  const m = await import('../plugins/index.js');
  try {
    const buf = await m.exportToZip(req.params.slug);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.slug}.skill"`);
    res.send(buf);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mcp/external', async (req, res) => {
  const { listExternalMcps, refreshExternalMcps } = await import('../claude/external_mcps.js');
  if (req.query.refresh === '1') await refreshExternalMcps();
  res.json(listExternalMcps());
});

// Settings
// Claude plan + 5h session usage — letto direttamente dai jsonl di Claude Code
// (~/.claude/projects/**/*.jsonl) per allineamento 1:1 con /cost del TUI.
let usageCache: { ts: number; data: any } | null = null;

// Converte l'orario di reset di `/cost` (es. "3:30pm") nel prossimo timestamp
// assoluto ISO. Ora locale del processo. Se l'orario è già passato oggi → domani.
function parseResetClock(s?: string | null): string | null {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'p') h += 12;
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const now = new Date();
  const r = new Date(now);
  r.setHours(h, min, 0, 0);
  if (r.getTime() <= now.getTime()) r.setDate(r.getDate() + 1);
  return r.toISOString();
}
router.get('/usage', async (req, res) => {
  const userId = req.user!.id;
  // Default sessionLimitTokens matches ccusage `totalTokens` scale (cache_read dominates,
  // ~hundreds of millions per 5h block on Max 5x). Empirical median Max 5x ≈ 500M tokens.
  // Plan budget is COST-based (USD), not token-based. Tokens mix input/output/cache_read with
  // very different weights — only the cost number matches /cost's % display 1:1.
  // Default cost budget for Max 5x derived empirically: ccusage costUSD ≈ $87 at 37% → ~$235.
  // Round to $250 as starting default; user fine-tunes with one calibrate click.
  const DEFAULT_BUDGET_USD = 250;
  let plan: any = (await getSetting<any>(userId, 'claude_plan')) ?? { name: 'Max (5x)', costBudgetUsd: DEFAULT_BUDGET_USD, sessionLimitTokens: 500_000_000 };
  // Auto-migrate: add costBudgetUsd if missing on legacy plans.
  if (plan.costBudgetUsd == null || Number(plan.costBudgetUsd) <= 0) {
    plan = { ...plan, costBudgetUsd: DEFAULT_BUDGET_USD };
    await setSetting(userId, 'claude_plan', plan);
  }
  // Auto-migrate old token-scale plans.
  if (Number(plan.sessionLimitTokens ?? 0) < 10_000_000) {
    plan = { ...plan, sessionLimitTokens: 500_000_000 };
    await setSetting(userId, 'claude_plan', plan);
  }
  // Cache 5min — `/cost` PTY scrape is ~12s so we don't run it on every poll.
  if (usageCache && Date.now() - usageCache.ts < 300_000) {
    const { recordUsage } = await import('../quota.js');
    recordUsage(Number(usageCache.data?.sessionPct ?? 0), Number(usageCache.data?.weekPct ?? 0));
    return res.json({ plan, ...usageCache.data });
  }
  // Use ccusage CLI (https://github.com/ryoppippi/ccusage) as canonical data source.
  // Matches Claude Code's /cost / /usage output 1:1 (parses same ~/.claude/projects/**/*.jsonl
  // with proper dedup, billing-block windows, cache token weighting).
  const { spawn } = await import('node:child_process');
  function runCcusage(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const p = spawn('npx', ['-y', 'ccusage@latest', ...args, '--json'], {
        env: { ...process.env, NO_COLOR: '1' },
      });
      let out = '', err = '';
      p.stdout.on('data', (b) => { out += b.toString(); });
      p.stderr.on('data', (b) => { err += b.toString(); });
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ccusage exit ${code}: ${err.slice(0, 200)}`));
        try { resolve(JSON.parse(out)); }
        catch (e: any) { reject(new Error(`ccusage parse: ${e.message}`)); }
      });
      p.on('error', reject);
      setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('ccusage timeout')); }, 25_000);
    });
  }
  let usedTokens = 0;
  let resetAt: string | null = null;
  let costUsd = 0;
  let breakdown: any = { in: 0, out: 0, cache_read: 0, cache_create: 0 };
  let burnRate: any = null;
  let autoBudget: number | null = null;
  // === claude TUI /cost scrape via PTY ===
  // Spawn `claude` in interactive mode through a pseudo-terminal, answer the trust prompt,
  // type `/cost`, capture rendered output, then exit. Parse the "Current session NN% used"
  // and "Current week NN% used" sections — these mirror Anthropic's gating numbers exactly.
  type CostParsed = { sessionPct: number; weekPct: number; resetAt?: string };
  async function scrapeClaudeCost(): Promise<CostParsed | null> {
    let pty: any;
    try { pty = await import('node-pty'); } catch (e) { console.error('[usage] node-pty not loaded', e); return null; }
    const home = process.env.HOME ?? '';
    const childProcess = await import('node:child_process');
    const claudeBin = childProcess.spawnSync('which', ['claude'], { env: { ...process.env, PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } }).stdout.toString().trim() || 'claude';
    return new Promise((resolve) => {
      try {
        const p: any = pty.default ? pty.default.spawn(claudeBin, [], {
          name: 'xterm-256color', cols: 140, rows: 50, cwd: home,
          env: { ...process.env, PATH: `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
        }) : pty.spawn(claudeBin, [], { name: 'xterm-256color', cols: 140, rows: 50, cwd: home, env: process.env });
        let buf = '';
        p.onData((d: string) => { buf += d; });
        // Answer trust prompt
        setTimeout(() => { try { p.write('\r'); } catch {} }, 2500);
        // Send /cost
        setTimeout(() => { try { p.write('/cost\r'); } catch {} }, 6000);
        // Kill + parse
        const finish = () => {
          try { p.write('\x03\x03'); p.kill('SIGTERM'); } catch {}
          const clean = buf
            .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\r/g, '');
          const session = clean.match(/Currentsession\s*[█▉▊▋▌▍▎▏▐\s_-]*?(\d{1,3})%used/i);
          const week = clean.match(/Currentweek[^%]*?(\d{1,3})%used/i);
          const resetM = clean.match(/Currentsession[\s\S]{0,300}?Resets([0-9: ]+[ap]m)/i);
          const sessionPct = session ? Number(session[1]) : 0;
          const weekPct = week ? Number(week[1]) : 0;
          if (sessionPct === 0 && weekPct === 0) return resolve(null);
          resolve({ sessionPct, weekPct, resetAt: resetM?.[1] });
        };
        setTimeout(finish, 12000);
        p.onExit(() => finish());
      } catch (e: any) { console.error('[usage] /cost pty spawn failed', e?.message ?? e); resolve(null); }
    });
  }
  let claudeCost: CostParsed | null = null;
  try { claudeCost = await scrapeClaudeCost(); }
  catch (e: any) { console.error('[usage] /cost scrape failed', e?.message ?? e); }
  // Historical max cost across past 5h blocks — fallback when claude-monitor unavailable.
  try {
    const histArgs = ['blocks'];
    const hist = await runCcusage(histArgs).catch(() => null);
    if (hist?.blocks?.length) {
      const completed = (hist.blocks as any[]).filter((b) => !b.isActive && !b.isGap && Number(b.costUSD) > 0);
      const maxCost = completed.reduce((m, b) => Math.max(m, Number(b.costUSD)), 0);
      if (maxCost > 5) autoBudget = maxCost;
    }
  } catch (e: any) { console.error('[usage] history scan failed', e?.message ?? e); }
  try {
    const j = await runCcusage(['blocks', '--active']);
    const active = (j.blocks ?? []).find((b: any) => b.isActive) ?? null;
    if (active) {
      const tc = active.tokenCounts ?? {};
      breakdown = {
        in: Number(tc.inputTokens ?? 0),
        out: Number(tc.outputTokens ?? 0),
        cache_read: Number(tc.cacheReadInputTokens ?? 0),
        cache_create: Number(tc.cacheCreationInputTokens ?? 0),
      };
      usedTokens = Number(active.totalTokens ?? 0);
      // ccusage `endTime` is hour-rounded (block boundary). Real Anthropic 5h window =
      // first-message-of-block + 5h. Scan jsonl for earliest msg with usage inside
      // this block window to align reset clock with /cost output.
      const blockStartMs = active.startTime ? new Date(active.startTime).getTime() : (Date.now() - 5 * 3600_000);
      try {
        const fs = await import('node:fs/promises');
        const pathMod = await import('node:path');
        const os = await import('node:os');
        const root = pathMod.join(os.homedir(), '.claude', 'projects');
        let earliest: number | null = null;
        const projects = await fs.readdir(root).catch(() => [] as string[]);
        for (const proj of projects) {
          const dir = pathMod.join(root, proj);
          let files: string[] = [];
          try { files = await fs.readdir(dir); } catch { continue; }
          for (const f of files) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = pathMod.join(dir, f);
            let stat: any;
            try { stat = await fs.stat(fp); } catch { continue; }
            if (stat.mtimeMs < blockStartMs) continue;
            let raw: string;
            try { raw = await fs.readFile(fp, 'utf8'); } catch { continue; }
            for (const line of raw.split('\n')) {
              if (!line) continue;
              let j: any;
              try { j = JSON.parse(line); } catch { continue; }
              const ts = j.timestamp ? new Date(j.timestamp).getTime() : null;
              if (ts == null || ts < blockStartMs) continue;
              const u = j?.message?.usage ?? j?.usage;
              if (!u) continue;
              if (earliest == null || ts < earliest) earliest = ts;
            }
          }
        }
        if (earliest != null) {
          resetAt = new Date(earliest + 5 * 3600_000).toISOString();
        } else {
          resetAt = active.endTime ?? null;
        }
      } catch (e: any) {
        console.error('[usage] reset scan failed', e?.message ?? e);
        resetAt = active.endTime ?? null;
      }
      costUsd = Number(active.costUSD ?? 0);
      burnRate = active.burnRate ?? null;
    }
  } catch (e: any) {
    console.error('[usage] ccusage failed', e?.message ?? e);
  }
  // Fallback when /cost scrape failed AND no manual override.
  if (!claudeCost && !plan.manuallyCalibrated) {
    if (autoBudget && Number(plan.costBudgetUsd) === DEFAULT_BUDGET_USD && Math.abs(autoBudget - DEFAULT_BUDGET_USD) > 5) {
      plan = { ...plan, costBudgetUsd: Math.round(autoBudget * 100) / 100, autoCalibrated: true };
      await setSetting(userId, 'claude_plan', plan);
    }
    if (costUsd > Number(plan.costBudgetUsd)) {
      plan = { ...plan, costBudgetUsd: Math.round(costUsd * 1.1 * 100) / 100, autoCalibrated: true };
      await setSetting(userId, 'claude_plan', plan);
    }
  }
  // If claude /cost gave us the real session %, synthesize a budget so the frontend
  // gauge (costUsd / budget) renders the exact same number Anthropic shows.
  if (claudeCost && claudeCost.sessionPct > 0) {
    const pctFrac = Math.min(0.999, claudeCost.sessionPct / 100);
    const syntheticBudget = costUsd > 0 ? costUsd / pctFrac : 100;
    plan = { ...plan, costBudgetUsd: Math.round(syntheticBudget * 100) / 100, autoCalibrated: true, source: 'claude /cost' };
    await setSetting(userId, 'claude_plan', plan);
  }
  const sessionPct = Number(claudeCost?.sessionPct ?? 0);
  const weekPct = Number(claudeCost?.weekPct ?? 0);
  const locked = sessionPct >= 95;
  // Il reset AUTOREVOLE è quello che Claude `/cost` mostra ("Resets 3:30pm") —
  // è il vero reset del limite di sessione. La stima dal blocco 5h di ccusage
  // (msg più vecchio + 5h) spesso non coincide e mostrava un orario sbagliato.
  // Se /cost ci ha dato l'orario, convertilo in timestamp assoluto e usalo.
  const costReset = parseResetClock(claudeCost?.resetAt);
  if (costReset) resetAt = costReset;
  const data = { usedTokens, resetAt, costUsd, burnRate, breakdown, autoBudget, claudeCost, sessionPct, weekPct, locked };
  usageCache = { ts: Date.now(), data };
  // Record into quota module so guards on other endpoints see fresh value.
  const { recordUsage } = await import('../quota.js');
  recordUsage(sessionPct, weekPct);
  bus.emit('usage:update', { userId, ...data });
  res.json({ plan, ...data });
});
router.put('/usage/plan', async (req, res) => {
  const userId = req.user!.id;
  const { name, sessionLimitTokens, costBudgetUsd } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = (await getSetting<any>(userId, 'claude_plan')) ?? {};
  const next: any = { ...existing, name };
  if (typeof sessionLimitTokens === 'number' && sessionLimitTokens > 0) next.sessionLimitTokens = sessionLimitTokens;
  if (typeof costBudgetUsd === 'number' && costBudgetUsd > 0) {
    next.costBudgetUsd = costBudgetUsd;
    next.manuallyCalibrated = true; // freeze further auto-adjustments
    next.autoCalibrated = false;
  }
  await setSetting(userId, 'claude_plan', next);
  usageCache = null; // bust cache
  res.json({ ok: true, plan: next });
});

router.get('/settings', async (req, res) => {
  const userId = req.user!.id;
  const profile = await getSetting<any>(userId, 'profile');
  const business = await getSetting<any>(userId, 'business');
  const telegram = await getSetting<any>(userId, 'telegram');
  const vault = await getVaultRoot(userId);
  const language = (await getSetting<string>(userId, 'language')) ?? 'it';
  const sound_on_message = (await getSetting<boolean>(userId, 'sound_on_message')) ?? true;
  const claude_model = (await getSetting<string>(userId, 'claude_model')) ?? config.claudeModel;
  res.json({ profile, business, telegram: telegram ? { chatId: telegram.chatId ?? null, hasToken: !!telegram?.token } : null, vault, language, sound_on_message, claude_model, models: AVAILABLE_MODELS });
});
// Branding (per-user customizable title + logo)
// ---------------------------------------------------------------------------
// MAIL — full email client backed by mail_messages + mail_attachments.
// ---------------------------------------------------------------------------
// Per-account auto-sync preference. Stored in user settings under
// `mail.autoSync.<accountLabel>`. When ON, the scheduler runs an
// incremental sync + bonifica every cycle (so new mail lands in the
// brain + people are linked without manual button presses).
router.get('/mail/accounts/:label/auto-sync', async (req, res) => {
  try {
    const v = await getSetting<{ enabled: boolean }>(req.user!.id, `mail.autoSync.${req.params.label}`);
    res.json({ enabled: !!v?.enabled });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});
// Per-account HTML signature. Primary source = IMAP connector account config
// (accounts[i].signature). Legacy fallback = settings key set by the older
// dialog. Composer hits this at open time.
router.get('/mail/accounts/:label/signature', async (req, res) => {
  try {
    const { listAccounts } = await import('../mail/service.js');
    const accs = await listAccounts(req.user!.id);
    const acc = accs.find((a) => a.label === req.params.label);
    let html = (acc?.signature ?? '').trim();
    let source = 'connector';
    if (!html) {
      const legacy = await getSetting<{ html: string }>(req.user!.id, `mail.signature.${req.params.label}`);
      if (legacy?.html) { html = legacy.html; source = 'settings:legacy'; }
    }
    console.log(`[mail:sig:u${req.user!.id}] label="${req.params.label}" len=${html.length} source=${source}`);
    res.json({ html });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.put('/mail/accounts/:label/auto-sync', async (req, res) => {
  try {
    await setSetting(req.user!.id, `mail.autoSync.${req.params.label}`, { enabled: !!req.body?.enabled });
    res.json({ ok: true, enabled: !!req.body?.enabled });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Lookup person row by email address. Used by the mail UI to know whether
// a sender is already linked to a brain person (and show the chip).
router.get('/people/by-email', async (req, res) => {
  try {
    const addr = String(req.query.addr ?? '').toLowerCase().trim();
    if (!addr) return res.json({ person: null });
    const rows = await query<any>(
      `SELECT id::int, slug, name, emails, phones, note_path
       FROM people
       WHERE user_id=$1 AND $2 = ANY(emails)
       LIMIT 1`,
      [req.user!.id, addr],
    );
    res.json({ person: rows[0] ?? null });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Bind an email address to an existing person. Adds it to people.emails[] if
// not already there. Re-runs brain note write so "related" reflects the new
// email mapping for downstream people_search lookups.
router.post('/people/:slug/bind-email', async (req, res) => {
  try {
    const addr = String(req.body?.email ?? '').toLowerCase().trim();
    if (!addr || !addr.includes('@')) return res.status(400).json({ error: 'email mancante o invalida' });
    const { upsertPerson } = await import('../connectors/builtin/people/index.js');
    // upsertPerson dedupes by email + name. We pass the existing slug as alias
    // hint so the engine picks the right person; in practice just adding the
    // email and letting downstream merge handle conflicts.
    const slug = String(req.params.slug);
    // Fetch existing person row
    const rows = await query<{ id: number; emails: string[]; name: string }>(
      `SELECT id::int, emails, name FROM people WHERE user_id=$1 AND slug=$2`,
      [req.user!.id, slug],
    );
    if (!rows[0]) return res.status(404).json({ error: 'persona non trovata' });
    const existing = new Set((rows[0].emails ?? []).map((e) => e.toLowerCase()));
    if (!existing.has(addr)) {
      const newEmails = [...(rows[0].emails ?? []), addr];
      await query(`UPDATE people SET emails=$1, updated_at=now() WHERE id=$2`, [newEmails, rows[0].id]);
      // Refresh the brain note for this person so the agent sees the new mapping.
      try { await upsertPerson(req.user!.id, { name: rows[0].name, emails: [addr], note: `Email manualmente collegata via UI` }); } catch {}
    }
    res.json({ ok: true, slug, email: addr });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/accounts', async (req, res) => {
  try {
    const { listAccounts } = await import('../mail/service.js');
    const accs = await listAccounts(req.user!.id);
    // Diagnostic block when empty so the UI can guide the user without
    // making the user crack open backend logs.
    let diag: any = undefined;
    if (!accs.length) {
      const rows = await query<{ config: any; enabled: boolean }>(
        `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='imap'`,
        [req.user!.id],
      );
      const r = rows[0];
      const rawAccs = (r?.config?.accounts ?? []) as any[];
      diag = {
        connectorRow: !!r,
        enabled: r?.enabled ?? null,
        rawCount: rawAccs.length,
        firstMissing: rawAccs[0]
          ? ['label', 'host', 'user', 'pass'].filter((k) => !rawAccs[0]?.[k])
          : null,
      };
    }
    res.json({
      accounts: accs.map((a) => ({ label: a.label, address: a.user, host: a.host, mailbox: a.mailbox ?? 'INBOX' })),
      diag,
    });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/messages', async (req, res) => {
  try {
    const { listMessages } = await import('../mail/service.js');
    const r = await listMessages(req.user!.id, {
      account: req.query.account ? String(req.query.account) : undefined,
      folder: req.query.folder ? String(req.query.folder) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      unread: req.query.unread === 'true',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/threads/:key', async (req, res) => {
  try {
    const { getThread } = await import('../mail/service.js');
    const r = await getThread(req.user!.id, String(req.params.key));
    res.json({ messages: r });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/messages/:id', async (req, res) => {
  try {
    const { getMessage } = await import('../mail/service.js');
    const r = await getMessage(req.user!.id, Number(req.params.id));
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.patch('/mail/messages/:id', async (req, res) => {
  try {
    const { setFlags } = await import('../mail/service.js');
    await setFlags(req.user!.id, Number(req.params.id), {
      seen: typeof req.body?.seen === 'boolean' ? req.body.seen : undefined,
      flagged: typeof req.body?.flagged === 'boolean' ? req.body.flagged : undefined,
      starred: typeof req.body?.starred === 'boolean' ? req.body.starred : undefined,
    });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.delete('/mail/messages/:id', async (req, res) => {
  try {
    const { trashMessage } = await import('../mail/service.js');
    await trashMessage(req.user!.id, Number(req.params.id));
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/attachments/:id', async (req, res) => {
  try {
    const { getAttachment } = await import('../mail/service.js');
    const a = await getAttachment(req.user!.id, Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.content_type) res.type(a.content_type);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`);
    const fs = await import('node:fs');
    fs.createReadStream(a.path).pipe(res);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.post('/mail/sync', async (req, res) => {
  try {
    const { syncAccount, syncAccountAllFolders } = await import('../mail/service.js');
    const account = String(req.body?.account ?? '');
    // If a specific folder is requested, sync just that. Otherwise iterate all.
    if (req.body?.folder) {
      const r = await syncAccount(req.user!.id, account, { limit: req.body?.limit ?? 1000, folder: String(req.body.folder) });
      res.json(r);
    } else {
      const r = await syncAccountAllFolders(req.user!.id, account, { limit: req.body?.limit ?? 1000 });
      res.json({
        ok: r.ok,
        fetched: r.totals.fetched,
        skipped: r.totals.skipped,
        scanned: r.totals.scanned,
        diag: { perFolder: r.perFolder },
      });
    }
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.get('/mail/folders', async (req, res) => {
  try {
    const { listFolders } = await import('../mail/service.js');
    const r = await listFolders(req.user!.id, String(req.query.account ?? ''));
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.post('/mail/bonify', async (req, res) => {
  try {
    const { bonifyAll } = await import('../mail/service.js');
    const r = await bonifyAll(req.user!.id, {
      account: req.body?.account ? String(req.body.account) : undefined,
      force: !!req.body?.force,
      limit: req.body?.limit ? Number(req.body.limit) : undefined,
    });
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.post('/mail/messages/:id/bonify', async (req, res) => {
  try {
    const { bonifyOne } = await import('../mail/service.js');
    const r = await bonifyOne(req.user!.id, Number(req.params.id), !!req.body?.force);
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

router.post('/mail/send', upload.array('attachments', 10), async (req, res) => {
  try {
    const { sendMail } = await import('../mail/service.js');
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const b = req.body ?? {};
    const refs: string[] = Array.isArray(b.references) ? b.references
      : typeof b.references === 'string' && b.references.length ? b.references.split(',').map((x: string) => x.trim()).filter(Boolean)
      : [];
    const r = await sendMail(req.user!.id, {
      accountLabel: String(b.account ?? ''),
      to: String(b.to ?? ''),
      cc: b.cc ? String(b.cc) : undefined,
      bcc: b.bcc ? String(b.bcc) : undefined,
      subject: String(b.subject ?? '(no subject)'),
      body: String(b.body ?? ''),
      html: b.html ? String(b.html) : undefined,
      inReplyTo: b.inReplyTo ? String(b.inReplyTo) : undefined,
      references: refs,
      attachments: files.map((f) => ({ filename: f.originalname, content: f.buffer, contentType: f.mimetype })),
    });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) { res.status(400).json({ error: String(e?.message ?? e) }); }
});

// Autosave bozza (debounce dal composer) → IMAP APPEND in Drafts.
router.post('/mail/draft', async (req, res) => {
  try {
    const { saveDraft } = await import('../mail/service.js');
    const b = req.body ?? {};
    const refs: string[] = Array.isArray(b.references) ? b.references : [];
    const r = await saveDraft(req.user!.id, {
      accountLabel: String(b.account ?? ''),
      to: b.to ? String(b.to) : undefined,
      cc: b.cc ? String(b.cc) : undefined,
      bcc: b.bcc ? String(b.bcc) : undefined,
      subject: b.subject ? String(b.subject) : undefined,
      body: b.body ? String(b.body) : undefined,
      html: b.html ? String(b.html) : undefined,
      inReplyTo: b.inReplyTo ? String(b.inReplyTo) : undefined,
      references: refs,
      replaceUid: b.replaceUid ? Number(b.replaceUid) : undefined,
    });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

router.post('/mail/draft/delete', async (req, res) => {
  try {
    const { deleteDraft } = await import('../mail/service.js');
    const b = req.body ?? {};
    if (!b.uid) return res.status(400).json({ ok: false, error: 'uid richiesto' });
    res.json(await deleteDraft(req.user!.id, String(b.account ?? ''), Number(b.uid)));
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

// L'agente gira nel contesto-sistema dell'utente (caveman mode incluso), quindi
// a volte avvolge la bozza con un preambolo ("Email body… Draft sotto:"), la
// racchiude tra fence `---` e ci attacca delle "Note (caveman)". Qui teniamo
// SOLO il corpo della mail.
function extractEmailBody(raw: string): string {
  let t = (raw ?? '').trim();
  // 1) Marcatori espliciti: prendi SOLO ciò che sta tra <<<EMAIL>>> e <<<END>>>.
  const mk = t.match(/<<<\s*EMAIL\s*>>>\s*([\s\S]*?)\s*(?:<<<\s*END\s*>>>|$)/i);
  if (mk) t = mk[1].trim();
  else {
    // 2) Fallback: corpo tra fence ---.
    const parts = t.split(/^\s*---\s*$/m);
    if (parts.length >= 3) t = parts[1].trim();
  }
  // 3) Pulizia difensiva di righe meta che a volte sfuggono comunque.
  t = t.replace(/^.*\bDraft sotto\b.*$/im, '').trim();
  t = t.replace(/^(?:Email body|Ecco (?:la|una) bozza|Bozza)[^\n]*:?\s*$/im, '').trim();
  // Taglia un eventuale blocco di note/commenti FINALE (caveman, "Nota:",
  // "Note:", "N.B.", "PS") fino a fine testo.
  t = t.replace(/\n{2,}\s*(?:Note\s*\(caveman\)|Note?:|Nota:|N\.?B\.?:?|P\.?S\.?:?)[\s\S]*$/i, '').trim();
  return t;
}

// AI-drafted reply — same pattern as WA suggestReply.
router.post('/mail/messages/:id/suggest', quotaGuard, async (req, res) => {
  try {
    const { getMessage } = await import('../mail/service.js');
    const m = await getMessage(req.user!.id, Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'not found' });
    const hint = String(req.body?.hint ?? '').slice(0, 400);
    const { runClaude } = await import('../claude/runner.js');
    const prompt = [
      `Sei l'assistente personale dell'utente. Scrivi una bozza di risposta a questa email.`,
      `Lingua: stessa dell'email originale (default italiano).`,
      `Tono: professionale ma diretto. Niente filler. Vai al punto.`,
      hint ? `Direttiva utente: ${hint}` : ``,
      ``,
      `--- EMAIL ORIGINALE ---`,
      `From: ${m.from_name ?? ''} <${m.from_addr ?? ''}>`,
      `Subject: ${m.subject ?? ''}`,
      ``,
      String(m.body_text ?? '').slice(0, 4000),
      `--- FINE EMAIL ---`,
      ``,
      `OUTPUT: restituisci ESCLUSIVAMENTE il corpo della risposta racchiuso tra i marcatori esatti qui sotto.`,
      `Vietato qualsiasi testo fuori dai marcatori: niente preamboli, niente subject, niente note/commenti/avvertenze, niente "Nota:", niente spiegazioni su placeholder o scelte. Solo il corpo della mail, pronto da inviare.`,
      `Se servono dati che non hai, lascia un placeholder tra [graffe] DENTRO il corpo — non spiegarlo fuori.`,
      `<<<EMAIL>>>`,
      `(qui SOLO il corpo della mail)`,
      `<<<END>>>`,
    ].join('\n');
    const r = await runClaude(req.user!.id, prompt, { timeoutMs: 60_000, kind: 'mail_suggest', meta: { mailId: m.id } });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.stderr || 'agent error' });
    res.json({ ok: true, draft: extractEmailBody(r.text) });
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

// AI compose ex-novo — generates subject + body in the user's own tone.
// Tone is learned from the user's recently SENT emails (most reliable
// signature of personal writing style); brain stays available via MCP tools
// if the model needs context on the recipient or topic.
router.post('/mail/compose', quotaGuard, async (req, res) => {
  try {
    const intent = String(req.body?.intent ?? '').slice(0, 1000).trim();
    if (!intent) return res.status(400).json({ ok: false, error: 'intent required' });
    const to = String(req.body?.to ?? '').slice(0, 300);
    // Sample of recently sent mail — teaches the model the user's tone.
    const sentRows = await query<any>(
      `SELECT subject, body_text FROM mail_messages
       WHERE user_id=$1 AND (direction='out' OR lower(folder) LIKE '%sent%' OR lower(folder) LIKE '%inviat%')
         AND body_text IS NOT NULL AND length(body_text) > 40
       ORDER BY ts DESC LIMIT 5`,
      [req.user!.id],
    );
    const samples = sentRows
      .map((r: any, i: number) => `--- ESEMPIO ${i + 1} (subject: ${r.subject ?? ''}) ---\n${String(r.body_text).slice(0, 1200)}`)
      .join('\n\n');
    const { runClaude } = await import('../claude/runner.js');
    const prompt = [
      `Scrivi un'email per conto dell'utente. DEVI imitare il suo stile di scrittura personale.`,
      ``,
      samples
        ? `Ecco email REALI che l'utente ha inviato — studia tono, lunghezza frasi, formule di apertura/chiusura, livello di formalità:\n\n${samples}\n\n--- FINE ESEMPI ---`
        : `Nessun esempio disponibile: usa un tono diretto, professionale ma informale, frasi brevi, niente filler. Se serve contesto sull'utente cerca nel brain.`,
      ``,
      `COSA VUOLE DIRE L'UTENTE: ${intent}`,
      to ? `DESTINATARIO: ${to} — se il brain contiene informazioni su questa persona, usale per calibrare il registro.` : ``,
      ``,
      `Regole:`,
      `- Lingua: italiano salvo che l'intent chieda altro.`,
      `- NON aggiungere firma (viene appesa automaticamente).`,
      `- NON inventare fatti, date o impegni non presenti nell'intent.`,
      ``,
      `Rispondi SOLO con JSON valido, nessun testo prima o dopo:`,
      `{"subject": "...", "body": "testo con \\n per andare a capo"}`,
    ].join('\n');
    const r = await runClaude(req.user!.id, prompt, { timeoutMs: 90_000, kind: 'mail_compose', meta: { to } });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.stderr || 'agent error' });
    // Extract the JSON blob — model may wrap it in fences or prose.
    const raw = r.text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(400).json({ ok: false, error: 'no JSON in agent output' });
    let parsed: any;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return res.status(400).json({ ok: false, error: 'invalid JSON from agent' }); }
    const subject = String(parsed.subject ?? '').trim();
    const body = String(parsed.body ?? '').trim();
    if (!body) return res.status(400).json({ ok: false, error: 'empty body from agent' });
    res.json({ ok: true, subject, body });
  } catch (e: any) { res.status(400).json({ ok: false, error: String(e?.message ?? e) }); }
});

// ---------------------------------------------------------------------------
// REPORT — time saved aggregates + PRIMA vs ADESSO radar.
// PRIMA = cold-start vector [0,1,0,0] (Comunicazione, Brain, CRM, Memoria).
// ADESSO = derived from real usage in the selected window.
// Time-saved minutes are estimates (per-channel), not measured wall-clock.
// ---------------------------------------------------------------------------
const REPORT_MIN = {
  reply_whatsapp: 3,
  reply_telegram: 2,
  reply_email: 8,
  reply_instagram: 2,
  brain_search: 4,            // every vault/people lookup
  ingest_per_msg: 0.3,         // bulk sync overhead per ingested message
  voice_baseline_min: 1,       // typing/edit overhead on top of clip length
  // Email "read" = an email landed in the mail client and was either
  // bonificata (filed in brain + people linked) or sorted by the agent.
  // Estimated 2 min you would have spent opening / scanning / triaging it.
  mail_read: 2,
};

router.get('/report', async (req, res) => {
  try {
    const userId = req.user!.id;
    const range = String(req.query.range ?? '30d');
    const interval = range === '7d' ? "7 days"
                   : range === '30d' ? "30 days"
                   : range === '90d' ? "90 days"
                   : null; // all-time
    const sinceClause = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    // Outbound by channel (sent only) — drives reply time saved + Comunicazione score
    const outbound = await query<{ channel: string; c: number }>(
      `SELECT channel, count(*)::int AS c FROM outbound_log
       WHERE user_id=$1 AND status='sent' ${sinceClause}
       GROUP BY channel`, [userId],
    );
    const outboundBy: Record<string, number> = {};
    let outboundTotal = 0;
    for (const r of outbound) { outboundBy[r.channel] = r.c; outboundTotal += r.c; }

    // Brain/people searches via tool_events
    const sinceClauseTool = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const brainSearches = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM tool_events
       WHERE user_id=$1 AND name IN ('brain_search','people_search','people_get','agent_brain_search') ${sinceClauseTool}`,
      [userId],
    );
    const searchCount = brainSearches[0]?.c ?? 0;

    // Ingestion: count of inbound messages stored in window (WA/IG/Telegram inbound)
    const sinceClauseMsg = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const waIngest = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM wa_messages WHERE user_id=$1 AND from_me=false ${sinceClauseMsg}`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ c: 0 }]; });
    const igIngest = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ig_messages WHERE user_id=$1 AND from_me=false ${sinceClauseMsg}`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ c: 0 }]; });
    const ingestCount = (waIngest[0]?.c ?? 0) + (igIngest[0]?.c ?? 0);

    // Email ingested via mail_messages (inbound only, not trashed).
    // Subset that was auto/manual bonificata is counted separately so the
    // user sees both "email lette" and "delle quali nel brain".
    const sinceClauseMail = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const mailRead = await query<{ c: number; bonified: number }>(
      `SELECT count(*)::int AS c,
              count(*) FILTER (WHERE bonified_at IS NOT NULL)::int AS bonified
       FROM mail_messages
       WHERE user_id=$1 AND direction='in' AND trashed_at IS NULL ${sinceClauseMail}`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ c: 0, bonified: 0 }]; });
    const mailReadCount = mailRead[0]?.c ?? 0;
    const mailBonifiedCount = mailRead[0]?.bonified ?? 0;

    // Voice transcribe runs — duration + baseline typing overhead
    const sinceClauseRun = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const voice = await query<{ c: number; total_dur: string | number }>(
      `SELECT count(*)::int AS c, COALESCE(sum(duration_ms),0)::bigint AS total_dur
       FROM agent_runs WHERE user_id=$1 AND kind='voice_transcribe' AND status='ok' ${sinceClauseRun}`,
      [userId],
    );
    const voiceCount = voice[0]?.c ?? 0;
    const voiceDurMin = Number(voice[0]?.total_dur ?? 0) / 60000;

    // === Time saved (minutes) ===
    const tReplies =
      (outboundBy.whatsapp ?? 0) * REPORT_MIN.reply_whatsapp
    + (outboundBy.telegram ?? 0) * REPORT_MIN.reply_telegram
    + (outboundBy.email ?? 0) * REPORT_MIN.reply_email
    + (outboundBy.instagram ?? 0) * REPORT_MIN.reply_instagram;
    const tSearches = searchCount * REPORT_MIN.brain_search;
    const tIngest = ingestCount * REPORT_MIN.ingest_per_msg;
    const tVoice = voiceCount * REPORT_MIN.voice_baseline_min + voiceDurMin;
    const tMailRead = mailReadCount * REPORT_MIN.mail_read;
    const totalMin = Math.round(tReplies + tSearches + tIngest + tVoice + tMailRead);

    // === Radar (0-10) ===
    // Comunicazione: log-scale of total outbound, capped
    const commScore = outboundTotal === 0 ? 0
                    : Math.min(10, Math.round(Math.log10(1 + outboundTotal) * 4 * 10) / 10);
    // Brain: notes count + link density (filtered by range via updated_at)
    const sinceClauseBrain = interval ? `AND updated_at >= now() - INTERVAL '${interval}'` : '';
    const brainAgg = await query<{ notes: number; refs_with_data: number }>(
      `SELECT count(*)::int AS notes,
              count(*) FILTER (WHERE jsonb_typeof(refs) = 'object' AND refs <> '{}'::jsonb)::int AS refs_with_data
       FROM brain_index WHERE user_id=$1 ${sinceClauseBrain}`, [userId],
    ).catch(() => [{ notes: 0, refs_with_data: 0 }]);
    const notes = brainAgg[0]?.notes ?? 0;
    const linkedRatio = notes === 0 ? 0 : (brainAgg[0].refs_with_data ?? 0) / notes;
    const brainScore = notes === 0 ? 0
                     : Math.min(10, Math.round((Math.log10(1 + notes) * 3 + linkedRatio * 4) * 10) / 10);
    // CRM: coverage (people with note) + psy-profile share
    // has_psy lives in brain_index (file `people/<slug>.psy-profile.md`), not in
    // people.meta. Compute via EXISTS join, same as /people route.
    const sinceClauseCrm = interval ? `AND p.updated_at >= now() - INTERVAL '${interval}'` : '';
    const crmAgg = await query<{ total: number; with_note: number; with_psy: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE p.note_path IS NOT NULL)::int AS with_note,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM brain_index bi
                WHERE bi.user_id = p.user_id
                  AND bi.path = 'people/' || p.slug || '.psy-profile.md'
              ))::int AS with_psy
       FROM people p WHERE p.user_id=$1 ${sinceClauseCrm}`, [userId],
    ).catch(() => [{ total: 0, with_note: 0, with_psy: 0 }]);
    const peopleTotal = crmAgg[0]?.total ?? 0;
    const crmScore = peopleTotal === 0 ? 0 : Math.min(10, Math.round((
      ((crmAgg[0].with_note / peopleTotal) * 6) +
      ((crmAgg[0].with_psy / peopleTotal) * 4)
    ) * 10) / 10);
    // Memoria: reflection runs + tool_use brain accesses
    const sinceClauseMem = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const memAgg = await query<{ refl: number; access: number }>(
      `SELECT
         (SELECT count(*)::int FROM agent_runs WHERE user_id=$1 AND kind='reflection' AND status='ok' ${sinceClauseMem}) AS refl,
         (SELECT count(*)::int FROM tool_events WHERE user_id=$1 AND name IN ('brain_search','agent_brain_search','people_get','people_search') ${sinceClauseMem}) AS access`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ refl: 0, access: 0 }]; });
    const reflCount = memAgg[0]?.refl ?? 0;
    const accessCount = memAgg[0]?.access ?? 0;
    const memScore = (reflCount === 0 && accessCount === 0) ? 0
                   : Math.min(10, Math.round((Math.log10(1 + reflCount) * 3 + Math.log10(1 + accessCount) * 3) * 10) / 10);

    // Automazione: flows + scheduled_tasks attivi (enabled, filtrati per range)
    const sinceClauseAuto = interval ? `AND created_at >= now() - INTERVAL '${interval}'` : '';
    const autoAgg = await query<{ flows: number; tasks: number }>(
      `SELECT
         (SELECT count(*)::int FROM flows WHERE user_id=$1 AND enabled=true ${sinceClauseAuto}) AS flows,
         (SELECT count(*)::int FROM scheduled_tasks WHERE user_id=$1 AND enabled=true ${sinceClauseAuto}) AS tasks`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ flows: 0, tasks: 0 }]; });
    const flowsCount = autoAgg[0]?.flows ?? 0;
    const tasksCount = autoAgg[0]?.tasks ?? 0;
    const autoScore = (flowsCount + tasksCount) === 0 ? 0
                    : Math.min(10, Math.round(((flowsCount * 1.5) + (tasksCount * 1.2)) * 10) / 10);

    // Triage messaggi: % wa+ig elaborati (processed_at IS NOT NULL)
    const sinceClauseTri = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const triageAgg = await query<{ wa_tot: number; wa_proc: number; ig_tot: number; ig_proc: number }>(
      `SELECT
         (SELECT count(*)::int FROM wa_messages WHERE user_id=$1 AND from_me=false ${sinceClauseTri}) AS wa_tot,
         (SELECT count(*)::int FROM wa_messages WHERE user_id=$1 AND from_me=false AND processed_at IS NOT NULL ${sinceClauseTri}) AS wa_proc,
         (SELECT count(*)::int FROM ig_messages WHERE user_id=$1 AND from_me=false ${sinceClauseTri}) AS ig_tot,
         (SELECT count(*)::int FROM ig_messages WHERE user_id=$1 AND from_me=false AND processed_at IS NOT NULL ${sinceClauseTri}) AS ig_proc`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ wa_tot: 0, wa_proc: 0, ig_tot: 0, ig_proc: 0 }]; });
    const triageTot = (triageAgg[0]?.wa_tot ?? 0) + (triageAgg[0]?.ig_tot ?? 0);
    const triageProc = (triageAgg[0]?.wa_proc ?? 0) + (triageAgg[0]?.ig_proc ?? 0);
    const triageScore = triageTot === 0 ? 0
                      : Math.min(10, Math.round((triageProc / triageTot) * 10 * 10) / 10);

    // Sub-agenti: numero di sub_agents completati con successo + custom agents/teams attivi
    const sinceClauseSub = interval ? `AND created_at >= now() - INTERVAL '${interval}'` : '';
    const subAgg = await query<{ subs: number; teams: number }>(
      `SELECT
         (SELECT count(*)::int FROM sub_agents WHERE user_id=$1 AND status='completed' ${sinceClauseSub}) AS subs,
         (SELECT count(*)::int FROM custom_agents WHERE user_id=$1 ${sinceClauseSub}) AS teams`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ subs: 0, teams: 0 }]; });
    const subsCount = subAgg[0]?.subs ?? 0;
    const customAgents = subAgg[0]?.teams ?? 0;
    const subScore = (subsCount + customAgents) === 0 ? 0
                   : Math.min(10, Math.round((Math.log10(1 + subsCount) * 4 + customAgents * 1) * 10) / 10);

    // Documentazione: snapshot count + log run total (storia preservata)
    const sinceClauseDocSnap = interval ? `AND created_at >= now() - INTERVAL '${interval}'` : '';
    const sinceClauseDocRun = interval ? `AND ts >= now() - INTERVAL '${interval}'` : '';
    const docAgg = await query<{ snaps: number; runs: number }>(
      `SELECT
         (SELECT count(*)::int FROM brain_snapshots WHERE user_id=$1 AND status='ok' ${sinceClauseDocSnap}) AS snaps,
         (SELECT count(*)::int FROM agent_runs WHERE user_id=$1 AND status='ok' ${sinceClauseDocRun}) AS runs`,
      [userId],
    ).catch((e) => { console.warn('[report] sub-query failed', e?.message ?? e); return [{ snaps: 0, runs: 0 }]; });
    const snapsCount = docAgg[0]?.snaps ?? 0;
    const runsCount = docAgg[0]?.runs ?? 0;
    const docScore = (snapsCount + runsCount) === 0 ? 0
                   : Math.min(10, Math.round((Math.log10(1 + snapsCount) * 5 + Math.log10(1 + runsCount) * 2) * 10) / 10);

    res.json({
      range,
      timeSaved: {
        totalMin,
        breakdown: {
          replies: { min: Math.round(tReplies), count: outboundTotal, byChannel: outboundBy },
          brain_searches: { min: Math.round(tSearches), count: searchCount },
          ingestion: { min: Math.round(tIngest), count: ingestCount },
          voice: { min: Math.round(tVoice), count: voiceCount, dur_min: Math.round(voiceDurMin) },
          mail_read: { min: Math.round(tMailRead), count: mailReadCount, bonified: mailBonifiedCount },
        },
      },
      radar: {
        axes: [
          'Comunicazione',
          'Brain',
          'CRM / People',
          'Memoria',
          'Automazione',
          'Triage messaggi',
          'Sub-agenti',
          'Documentazione',
        ],
        prima: [0, 1, 0, 0, 0, 0, 0, 1],
        adesso: [commScore, brainScore, crmScore, memScore, autoScore, triageScore, subScore, docScore],
        metrics: {
          comunicazione: { outbound: outboundTotal },
          brain: { notes, linked_ratio: Math.round(linkedRatio * 100) / 100 },
          crm: { total: peopleTotal, with_note: crmAgg[0]?.with_note ?? 0, with_psy: crmAgg[0]?.with_psy ?? 0 },
          memoria: { reflections: reflCount, brain_accesses: accessCount },
          automazione: { flows: flowsCount, tasks: tasksCount },
          triage: { total: triageTot, processed: triageProc },
          sub_agenti: { completed: subsCount, custom: customAgents },
          documentazione: { snapshots: snapsCount, runs: runsCount },
        },
      },
    });
  } catch (e: any) {
    console.error('[report] outer fail', e);
    // Never 500 — surface a zero-shape so the page renders + the user sees the
    // structure. error string included for diagnosis.
    res.json({
      range: String(req.query.range ?? '30d'),
      error: String(e?.message ?? e),
      timeSaved: {
        totalMin: 0,
        breakdown: {
          replies: { min: 0, count: 0, byChannel: {} },
          brain_searches: { min: 0, count: 0 },
          ingestion: { min: 0, count: 0 },
          voice: { min: 0, count: 0, dur_min: 0 },
        },
      },
      radar: {
        axes: ['Comunicazione clienti', 'Organizzazione second brain', 'CRM / People', 'Memoria contestuale'],
        prima: [0, 1, 0, 0],
        adesso: [0, 0, 0, 0],
        metrics: {},
      },
    });
  }
});

router.get('/branding', async (req, res) => {
  const b = (await getSetting<any>(req.user!.id, 'branding')) ?? null;
  res.json(b ?? { title: 'super-agent', subtitle: 'personal · brain', logoDataUrl: null });
});
// Brain colors per category
const DEFAULT_BRAIN_COLORS = {
  visibility: { protected: '#d946ef', public: '#67e8f9' },
  kind: { person: '#22d3ee', email: '#c084fc', project: '#34d399', note: '#fbbf24', daily: '#f0abfc', roadmap: '#f97316', task: '#a78bfa', attachment: '#94a3b8', whatsapp: '#25d366' },
  default: '#c084fc',
};
router.get('/brain/colors', async (req, res) => {
  const c = (await getSetting<any>(req.user!.id, 'brain_colors')) ?? null;
  res.json(c ?? DEFAULT_BRAIN_COLORS);
});
router.put('/brain/colors', async (req, res) => {
  const body = req.body ?? {};
  const isHex = (v: any) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const safe: any = { visibility: {}, kind: {}, default: DEFAULT_BRAIN_COLORS.default };
  for (const k of Object.keys(DEFAULT_BRAIN_COLORS.visibility)) {
    safe.visibility[k] = isHex(body.visibility?.[k]) ? body.visibility[k] : (DEFAULT_BRAIN_COLORS.visibility as any)[k];
  }
  for (const k of Object.keys(DEFAULT_BRAIN_COLORS.kind)) {
    safe.kind[k] = isHex(body.kind?.[k]) ? body.kind[k] : (DEFAULT_BRAIN_COLORS.kind as any)[k];
  }
  if (isHex(body.default)) safe.default = body.default;
  await setSetting(req.user!.id, 'brain_colors', safe);
  res.json({ ok: true, colors: safe });
});
router.put('/branding', async (req, res) => {
  const { title, subtitle, logoDataUrl, syncTelegram } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title required' });
  if (logoDataUrl && typeof logoDataUrl === 'string' && logoDataUrl.length > 600_000) {
    return res.status(400).json({ error: 'logo troppo grande (max ~400KB base64)' });
  }
  await setSetting(req.user!.id, 'branding', { title: title.trim(), subtitle: (subtitle ?? '').trim() || null, logoDataUrl: logoDataUrl || null });
  let telegram: any = null;
  if (syncTelegram) {
    try {
      const { updateBotProfile } = await import('../telegram/bot.js');
      telegram = await updateBotProfile(req.user!.id, { name: title.trim(), shortDescription: (subtitle ?? '').trim() });
    } catch (e: any) { telegram = { ok: false, error: String(e?.message ?? e) }; }
  }
  res.json({ ok: true, telegram });
});

router.put('/settings/language', async (req, res) => {
  const { language } = req.body ?? {};
  if (!['it', 'en'].includes(language)) return res.status(400).json({ error: 'language must be it|en' });
  await setSetting(req.user!.id, 'language', language);
  res.json({ ok: true });
});
router.put('/settings/model', async (req, res) => {
  const { model } = req.body ?? {};
  if (!MODEL_IDS.includes(model)) return res.status(400).json({ error: `model must be one of ${MODEL_IDS.join(', ')}` });
  await setSetting(req.user!.id, 'claude_model', model);
  res.json({ ok: true });
});
router.put('/settings/sound', async (req, res) => {
  const { enabled } = req.body ?? {};
  await setSetting(req.user!.id, 'sound_on_message', !!enabled);
  res.json({ ok: true });
});
router.put('/settings/vault', async (req, res) => {
  const { vaultPath } = req.body ?? {};
  if (!vaultPath) return res.status(400).json({ error: 'vaultPath required' });
  const prev = await getVaultRoot(req.user!.id);
  await setVaultRoot(req.user!.id, vaultPath);
  res.json({ ok: true, previous: prev, current: vaultPath });
});
router.put('/settings/profile', async (req, res) => { await setSetting(req.user!.id, 'profile', req.body); res.json({ ok: true }); });
router.put('/settings/business', async (req, res) => { await setSetting(req.user!.id, 'business', req.body); res.json({ ok: true }); });
router.put('/settings/telegram', async (req, res) => {
  const { token } = req.body ?? {};
  const cur = await getSetting<any>(req.user!.id, 'telegram') ?? {};
  await setSetting(req.user!.id, 'telegram', { ...cur, token: token ?? cur.token });
  await restartTelegramForUser(req.user!.id);
  res.json({ ok: true });
});
