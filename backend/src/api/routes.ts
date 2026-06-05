import { Router } from 'express';
import { query, getSetting, setSetting } from '../db/index.js';
import { quotaGuard } from '../quota.js';
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
  const cfgJson = config !== undefined ? JSON.stringify(config) : null;
  await query(
    `UPDATE connectors SET enabled=COALESCE($3,enabled), config=COALESCE($4::jsonb,config), updated_at=now() WHERE user_id=$1 AND name=$2`,
    [req.user!.id, req.params.name, enabled ?? null, cfgJson]
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
  const origin = req.query.origin ? String(req.query.origin) : 'all';
  const vaultFilter = req.query.vault ? String(req.query.vault) : 'all';
  const g = await buildGraph(req.user!.id, { vaultFilter });
  let nodes = g.nodes;
  if (filter !== 'all') nodes = nodes.filter((n) => n.visibility === filter);
  if (origin === 'native') nodes = nodes.filter((n) => !n.origin_user_id);
  else if (origin !== 'all') nodes = nodes.filter((n) => n.origin_email === origin);
  const ids = new Set(nodes.map((n) => n.id));
  const links = g.links.filter((l) => ids.has(l.source) && ids.has(l.target));
  const origins = Array.from(new Set(g.nodes.map((n) => n.origin_email).filter(Boolean))) as string[];
  res.json({ nodes, links, origins, vaults: g.vaults });
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

// Outbound communications audit log
router.get('/outbound', async (req, res) => {
  const userId = req.user!.id;
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const channel = req.query.channel ? String(req.query.channel) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const where: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  if (channel && ['whatsapp','email','telegram'].includes(channel)) { where.push(`channel=$${params.length + 1}`); params.push(channel); }
  if (status && ['sent','error'].includes(status)) { where.push(`status=$${params.length + 1}`); params.push(status); }
  if (q) { where.push(`(lower(coalesce(recipient,'')) LIKE $${params.length + 1} OR lower(coalesce(recipient_name,'')) LIKE $${params.length + 1} OR lower(coalesce(subject,'')) LIKE $${params.length + 1} OR lower(coalesce(body,'')) LIKE $${params.length + 1})`); params.push(`%${q.toLowerCase()}%`); }
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
            count(*) FILTER (WHERE channel='telegram')::int AS telegram
     FROM outbound_log WHERE user_id=$1`,
    [userId],
  );
  res.json({ rows, totals: totals[0] ?? { total: 0 } });
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

router.post('/people/dedupe-agent', async (req, res) => {
  const { spawnSubAgent } = await import('../sub_agents/index.js');
  const userId = req.user!.id;
  const prompt = `=== BONIFICA DUPLICATI PEOPLE ===

Compito: trova e unifica i duplicati nella tabella People del DB e nelle note del second brain.

PROCEDURA:
1. Leggi tutti i record People via tool \`mcp__super_agent__people_search\` (o query equivalente). Ottieni name, slug, aliases, emails, phones, note_path.
2. Identifica gruppi di duplicati usando:
   - Stesso normalized name (lowercase, trim, no accenti)
   - Email in comune (case-insensitive)
   - Telefono in comune (solo digits)
   - Slug simili (Levenshtein ≤ 2)
3. Per ogni gruppo di duplicati:
   a. Scegli canonical = record con più dati popolati (più aliases/emails/phones/note size).
   b. Merge: unisci aliases/emails/phones distinct nel canonical via \`mcp__super_agent__people_upsert\`.
   c. Per le note brain dei NON-canonical (\`people/<slug>.md\`):
      - Leggi contenuto via Read tool
      - Append nel canonical (\`people/<canonical_slug>.md\`) sotto sezione "## Merged from <old_slug>" + data
      - Elimina file vecchio
   d. Update riferimenti in altre note del brain (Grep su [[old_slug]] o "people/old_slug.md" → sostituire con canonical).
4. Aggiorna brain_index per riallineare i path (se necessario via tool dedicato).
5. Log finale: quanti gruppi trovati, quanti merge fatti, file rimossi.

REGOLE:
- NESSUNA conferma utente: agire deterministico.
- Se gruppo ambiguo (es. 2 omonimi senza email/phone overlap) → NON unire, log come "ambiguous, skipped".
- Mai inviare msg Telegram.
- VIETATO chiamare \`mcp__super_agent__people_dedupe_run\`: TU SEI già il dedupe runner. Chiamarlo = ricorsione infinita.
- Output finale: 1 paragrafo riepilogo (gruppi, merge, skip, errori).`;

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
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json(await sa.listSubAgents(req.user!.id, { status }));
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
  res.json(await m.listChats(req.user!.id));
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
  res.json({ profile, business, telegram: telegram ? { chatId: telegram.chatId ?? null, hasToken: !!telegram?.token } : null, vault, language, sound_on_message });
});
// Branding (per-user customizable title + logo)
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
