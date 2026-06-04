import cron from 'node-cron';
import { query, listActiveUsers, getSetting } from '../../db/index.js';
import { bus } from '../../bus.js';
import { config } from '../../config.js';
import type { InternalAgent, Lang } from './types.js';
import brainClassifier from './brain_classifier.js';
import linkWeaver from './link_weaver.js';
import peopleAnalyzer from './people_analyzer.js';
import vaultDreamer from './vault_dreamer.js';
import vaultLibrarian from './vault_librarian.js';
import vaultGardener from './vault_gardener.js';
import { sendTelegram } from '../../telegram/bot.js';

const REGISTRY: InternalAgent[] = [brainClassifier, linkWeaver, peopleAnalyzer, vaultDreamer, vaultLibrarian, vaultGardener];

export function listInternalAgents(): InternalAgent[] {
  return REGISTRY;
}
export function getInternalAgent(name: string): InternalAgent | undefined {
  return REGISTRY.find((a) => a.name === name);
}

export async function ensureUserAgentRows(userId: number) {
  for (const a of REGISTRY) {
    await query(
      `INSERT INTO internal_agents(user_id, name, hour, minute, interval_hours)
       VALUES($1, $2, $3, $4, $5) ON CONFLICT(user_id, name) DO NOTHING`,
      [userId, a.name, a.defaultHour, a.defaultMinute, a.defaultIntervalHours ?? null]
    );
  }
}

export async function listUserAgents(userId: number) {
  await ensureUserAgentRows(userId);
  const rows = await query<any>(
    `SELECT id::int, name, enabled, hour, minute, interval_hours, running, notify_on_run, last_run_at, last_status, last_report
     FROM internal_agents WHERE user_id=$1 ORDER BY name`,
    [userId]
  );
  return rows.map((r) => {
    const meta = REGISTRY.find((a) => a.name === r.name);
    return { ...r, title: meta?.title ?? r.name, description: meta?.description ?? '' };
  });
}

function fallbackHumanize(title: string, report: any, lang: Lang, status: 'ok' | 'error'): string {
  if (status === 'error') {
    return lang === 'it'
      ? `**${title}** — esecuzione fallita: ${String(report?.error ?? 'errore sconosciuto')}`
      : `**${title}** — run failed: ${String(report?.error ?? 'unknown error')}`;
  }
  return lang === 'it' ? `**${title}** — completato.` : `**${title}** — done.`;
}

// Extract list of vault paths the agent created/wrote, from the report.
// Each agent should populate `report.created_paths: string[]`. We also opportunistically
// scan known shapes (single `path`, `details[].path`, people-analyzer slug → psy-profile).
function extractCreatedPaths(agentName: string, report: any): string[] {
  if (!report || typeof report !== 'object') return [];
  const paths = new Set<string>();
  const push = (p: any) => { if (typeof p === 'string' && p.length && p.endsWith('.md')) paths.add(p); };
  if (Array.isArray(report.created_paths)) report.created_paths.forEach(push);
  if (Array.isArray(report.modified_paths)) report.modified_paths.forEach(push);
  if (Array.isArray(report.paths)) report.paths.forEach(push);
  push(report.path);
  if (Array.isArray(report.details)) {
    for (const d of report.details) {
      if (!d || typeof d !== 'object') continue;
      push(d.path);
      // people_analyzer convention: details[].slug → people/<slug>.psy-profile.md
      if (agentName === 'people_analyzer' && d.ok && typeof d.slug === 'string') {
        push(`people/${d.slug}.psy-profile.md`);
      }
    }
  }
  return [...paths];
}

function appendFileLinks(msg: string, paths: string[], lang: Lang): string {
  if (!paths.length) return msg;
  // Telegram HTML mode strips `<a href>` when host = localhost on some clients,
  // and Markdown-mode link parens conflict with URL query-strings. Emit URL as plain text:
  // Telegram autolinks any `http(s)://...` substring, so a bare URL on its own line is
  // always clickable, regardless of client/parse-mode quirks.
  const base = (config.frontendOrigin ?? '').replace(/\/+$/, '') || 'http://localhost:5173';
  const lines = paths.slice(0, 15).map((p) => {
    // Encode each segment but keep `/` raw — Telegram + frontend handle
    // path-style URLs cleanly, `%2F` looks broken and some clients truncate
    // links at the percent sign.
    const enc = p.split('/').map(encodeURIComponent).join('/');
    const name = p.split('/').pop() ?? p;
    return `• ${name}\n  ${base}/brain?note=${enc}`;
  });
  const extra = paths.length > 15 ? `\n_+${paths.length - 15} altri file_` : '';
  const heading = lang === 'it' ? '\n\n📂 **File creati:**' : '\n\n📂 **Created files:**';
  return `${msg}${heading}\n${lines.join('\n')}${extra}`;
}

export async function runInternalAgent(userId: number, name: string) {
  const agent = getInternalAgent(name);
  if (!agent) throw new Error(`unknown agent: ${name}`);
  // Flip running=true so sidebar badge can show live activity
  await query(`UPDATE internal_agents SET running=true, updated_at=now() WHERE user_id=$1 AND name=$2`, [userId, name]);
  bus.emit('internal_agent:event', { userId, name, kind: 'start' });
  let report: any;
  let status = 'ok';
  try {
    report = await agent.run(userId);
  } catch (e: any) {
    status = 'error';
    report = { error: String(e?.message ?? e) };
  }
  await query(`UPDATE internal_agents SET running=false, updated_at=now() WHERE user_id=$1 AND name=$2`, [userId, name]);
  await query(
    `UPDATE internal_agents SET last_run_at=now(), last_status=$3, last_report=$4::jsonb, updated_at=now()
     WHERE user_id=$1 AND name=$2`,
    [userId, name, status, JSON.stringify(report ?? {})]
  );
  bus.emit('internal_agent:event', { userId, name, kind: 'done', status });
  // Telegram notify if enabled
  try {
    const rows = await query<{ notify_on_run: boolean }>(
      `SELECT notify_on_run FROM internal_agents WHERE user_id=$1 AND name=$2`,
      [userId, name]
    );
    console.log(`[internal-agents:u${userId}:${name}] notify_on_run=${rows[0]?.notify_on_run}`);
    if (rows[0]?.notify_on_run) {
      const lang = ((await getSetting<string>(userId, 'language')) ?? 'it') as Lang;
      let msg = agent.humanize
        ? agent.humanize(report, lang, status as 'ok' | 'error')
        : fallbackHumanize(agent.title, report, lang, status as 'ok' | 'error');
      if (status === 'ok') {
        const paths = extractCreatedPaths(name, report);
        msg = appendFileLinks(msg, paths, lang);
      }
      console.log(`[internal-agents:u${userId}:${name}] sending telegram (${lang})`);
      await sendTelegram(userId, msg, `perk:${name}`);
      console.log(`[internal-agents:u${userId}:${name}] telegram sent`);
    }
  } catch (e) { console.error(`[internal-agents:u${userId}:${name}] notify failed`, e); }
  return { status, report };
}

export async function updateAgentSchedule(userId: number, name: string, p: { hour?: number; minute?: number; enabled?: boolean; notify_on_run?: boolean; interval_hours?: number | null }) {
  const fields: string[] = [];
  const vals: any[] = [];
  let i = 2;
  if (p.hour !== undefined)          { fields.push(`hour=$${++i}`); vals.push(Math.max(0, Math.min(23, p.hour))); }
  if (p.minute !== undefined)        { fields.push(`minute=$${++i}`); vals.push(Math.max(0, Math.min(59, p.minute))); }
  if (p.enabled !== undefined)       { fields.push(`enabled=$${++i}`); vals.push(!!p.enabled); }
  if (p.notify_on_run !== undefined) { fields.push(`notify_on_run=$${++i}`); vals.push(!!p.notify_on_run); }
  if (p.interval_hours !== undefined) {
    const v = p.interval_hours == null ? null : Math.max(1, Math.min(168, Number(p.interval_hours)));
    fields.push(`interval_hours=$${++i}`); vals.push(v);
  }
  if (!fields.length) return;
  await query(
    `UPDATE internal_agents SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND name=$2`,
    [userId, name, ...vals],
  );
  bus.emit('internal_agent:event', { userId, name, kind: 'updated' });
}

// Catch-up: if scheduled time today passed and last_run_at < that time → fire now.
// Survives app downtime — daily agents will fire on next boot.
async function catchUpInternalAgents() {
  const users = await listActiveUsers();
  const now = new Date();
  for (const u of users) {
    await ensureUserAgentRows(u.id);
    const rows = await query<{ name: string; enabled: boolean; hour: number; minute: number; interval_hours: number | null; last_run_at: string | null }>(
      `SELECT name, enabled, hour, minute, interval_hours, last_run_at FROM internal_agents WHERE user_id=$1`,
      [u.id],
    );
    for (const r of rows) {
      if (!r.enabled) continue;
      const lastRun = r.last_run_at ? new Date(r.last_run_at) : null;
      // Interval-based agents: fire if elapsed >= interval (or never ran).
      if (r.interval_hours && r.interval_hours > 0) {
        const intervalMs = r.interval_hours * 3600_000;
        const due = !lastRun || (now.getTime() - lastRun.getTime()) >= intervalMs;
        if (due) {
          console.log(`[internal-agents:u${u.id}:${r.name}] catch-up: interval ${r.interval_hours}h, last_run ${lastRun ? lastRun.toISOString() : 'never'} → firing`);
          setTimeout(() => runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents:catchup]', e)), 4000 + Math.random() * 3000);
        }
        continue;
      }
      // Daily anchor agents: fire if today's scheduled time passed and not yet run.
      const sched = new Date(now);
      sched.setHours(r.hour, r.minute, 0, 0);
      const passed = now >= sched;
      const missedToday = passed && (!lastRun || lastRun < sched);
      if (missedToday) {
        const ageH = lastRun ? Math.floor((now.getTime() - lastRun.getTime()) / 3_600_000) : null;
        console.log(`[internal-agents:u${u.id}:${r.name}] catch-up: scheduled ${r.hour}:${String(r.minute).padStart(2,'0')}, last_run ${ageH != null ? `${ageH}h ago` : 'never'} → firing`);
        setTimeout(() => runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents:catchup]', e)), 4000 + Math.random() * 3000);
      }
    }
  }
}

// 1-minute tick: fires daily-anchor agents matching current hour:minute,
// AND interval-based agents whose elapsed time since last_run_at >= interval_hours.
export function startInternalAgentsScheduler() {
  // Reset stale running flags from previous crash
  query(`UPDATE internal_agents SET running=false WHERE running=true`).catch((e) => console.error('[internal-agents] reset running failed', e));
  catchUpInternalAgents().catch((e) => console.error('[internal-agents] catch-up failed', e));
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    try {
      const users = await listActiveUsers();
      for (const u of users) {
        // Daily anchor match
        const dailyRows = await query<{ name: string; enabled: boolean }>(
          `SELECT name, enabled FROM internal_agents
           WHERE user_id=$1 AND hour=$2 AND minute=$3 AND (interval_hours IS NULL OR interval_hours = 0)`,
          [u.id, h, m]
        );
        for (const r of dailyRows) {
          if (!r.enabled) continue;
          console.log(`[internal-agents:u${u.id}] firing ${r.name} (daily anchor)`);
          runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents]', e));
        }
        // Interval-based: any agent where elapsed >= interval_hours
        const intRows = await query<{ name: string; enabled: boolean; interval_hours: number; last_run_at: string | null }>(
          `SELECT name, enabled, interval_hours, last_run_at FROM internal_agents
           WHERE user_id=$1 AND interval_hours IS NOT NULL AND interval_hours > 0`,
          [u.id]
        );
        for (const r of intRows) {
          if (!r.enabled) continue;
          const last = r.last_run_at ? new Date(r.last_run_at).getTime() : 0;
          const due = (now.getTime() - last) >= r.interval_hours * 3600_000;
          if (!due) continue;
          console.log(`[internal-agents:u${u.id}] firing ${r.name} (interval ${r.interval_hours}h)`);
          runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents]', e));
        }
      }
    } catch (e) { console.error('[internal-agents] tick error', e); }
  });
  console.log('[internal-agents] scheduler armed (1-min tick, daily anchor + interval)');
}
