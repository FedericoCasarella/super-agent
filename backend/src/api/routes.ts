import { Router } from 'express';
import { query, getSetting, setSetting } from '../db/index.js';
import { setVaultRoot, getVaultRoot, searchNotes, readNote } from '../brain/vault.js';
import { buildGraph } from '../brain/graph.js';
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
router.use(requireUser);

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
  await query(
    `UPDATE connectors SET enabled=COALESCE($3,enabled), config=COALESCE($4,config), updated_at=now() WHERE user_id=$1 AND name=$2`,
    [req.user!.id, req.params.name, enabled ?? null, config ?? null]
  );
  bus.emit('connectors:changed');
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

router.get('/brain/graph', async (req, res) => {
  const filter = String(req.query.visibility ?? 'all');
  const origin = req.query.origin ? String(req.query.origin) : 'all'; // 'all' | 'native' | <email>
  const g = await buildGraph(req.user!.id);
  let nodes = g.nodes;
  if (filter !== 'all') nodes = nodes.filter((n) => n.visibility === filter);
  if (origin === 'native') nodes = nodes.filter((n) => !n.origin_user_id);
  else if (origin !== 'all') nodes = nodes.filter((n) => n.origin_email === origin);
  const ids = new Set(nodes.map((n) => n.id));
  const links = g.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  // Collect distinct origin emails for the filter UI
  const origins = Array.from(new Set(g.nodes.map((n) => n.origin_email).filter(Boolean))) as string[];
  res.json({ nodes, links, origins });
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
  const p = String(req.query.path ?? '');
  const note = await readNote(req.user!.id, p);
  if (!note) return res.status(404).json({ error: 'not found' });
  res.json(note);
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
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const kind = req.query.kind ? String(req.query.kind) : null;
  const where = kind ? 'WHERE user_id=$1 AND kind=$3' : 'WHERE user_id=$1';
  const params: any[] = [req.user!.id, limit];
  if (kind) params.push(kind);
  const rows = await query(
    `SELECT id::int, ts, kind, status, model, duration_ms, input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, cost_usd::float8, num_turns,
            LEFT(result, 240) AS preview, meta, error
     FROM agent_runs ${where}
     ORDER BY id DESC LIMIT $2`, params
  );
  res.json(rows);
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

router.get('/mcp/external', async (req, res) => {
  const { listExternalMcps, refreshExternalMcps } = await import('../claude/external_mcps.js');
  if (req.query.refresh === '1') await refreshExternalMcps();
  res.json(listExternalMcps());
});

// Settings
router.get('/settings', async (req, res) => {
  const userId = req.user!.id;
  const profile = await getSetting<any>(userId, 'profile');
  const business = await getSetting<any>(userId, 'business');
  const telegram = await getSetting<any>(userId, 'telegram');
  const vault = await getVaultRoot(userId);
  const language = (await getSetting<string>(userId, 'language')) ?? 'it';
  const sound_on_message = (await getSetting<boolean>(userId, 'sound_on_message')) ?? true;
  res.json({ profile, business, telegram: telegram ? { chatId: telegram.chatId ?? null, hasToken: !!telegram?.token } : null, vault, language, sound_on_message });
});
router.put('/settings/language', async (req, res) => {
  const { language } = req.body ?? {};
  if (!['it', 'en'].includes(language)) return res.status(400).json({ error: 'language must be it|en' });
  await setSetting(req.user!.id, 'language', language);
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
