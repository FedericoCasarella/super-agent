#!/usr/bin/env node
// Dev runner for the backend. Replaces `tsx watch` (whose parent process can
// stay alive while its child is force-killed, leaving port 8787 dead until a
// file change). This script owns BOTH responsibilities:
//
//   1. File watching: fs.watch on src/ → respawn child on .ts/.mjs/.json change
//   2. Liveness watchdog: ping /health every 10s; after 2 consecutive misses
//      (past a boot grace) SIGKILL + respawn. Catches "sleep mode" hangs.
//
// Plain crash → respawn with exponential backoff (500ms → 8s). Resets after
// the child has been up for >5s.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import http from 'node:http';
import fs from 'node:fs';

// Resolve tsx CLI regardless of workspace hoisting.
const require = createRequire(import.meta.url);
const tsxPkgPath = require.resolve('tsx/package.json');
const tsxPkg = require('tsx/package.json');
const tsxBin = path.resolve(path.dirname(tsxPkgPath), typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx);

const MAX_BACKOFF_MS = 8000;
const HEALTH_PORT = Number(process.env.PORT ?? 8787);
const HEALTH_INTERVAL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;
const HEALTH_GRACE_MS = 30_000;     // grace window post-spawn
const HEALTH_MAX_FAILS = 2;
const RESTART_DEBOUNCE_MS = 250;    // collapse bursts of file events

let attempt = 0;
let child = null;
let childStartedAt = 0;
let healthFails = 0;
let healthTimer = null;
let restartTimer = null;
let shuttingDown = false;

function pingHealth() {
  if (!child || shuttingDown) return;
  if (Date.now() - childStartedAt < HEALTH_GRACE_MS) return;
  const req = http.request(
    { host: '127.0.0.1', port: HEALTH_PORT, path: '/health', method: 'GET', timeout: HEALTH_TIMEOUT_MS },
    (res) => {
      res.resume();
      if (res.statusCode === 200) { healthFails = 0; return; }
      onHealthMiss(`status ${res.statusCode}`);
    },
  );
  req.on('error', (e) => onHealthMiss(e.code ?? e.message));
  req.on('timeout', () => { req.destroy(); onHealthMiss('timeout'); });
  req.end();
}

function onHealthMiss(reason) {
  healthFails++;
  console.warn(`[dev-loop] health miss ${healthFails}/${HEALTH_MAX_FAILS} (${reason})`);
  if (healthFails >= HEALTH_MAX_FAILS) {
    console.error('[dev-loop] backend unresponsive — SIGKILL + respawn');
    healthFails = 0;
    killChild('SIGKILL');
  }
}

function killChild(signal) {
  if (!child || child.killed) return;
  const pid = child.pid;
  // Il child è `node tsx/dist/cli.mjs` che a sua volta spawna il VERO server
  // (`node --require preflight … src/index.ts`). child.kill() colpisce solo il
  // wrapper tsx → il server-grandchild resta orfano (ppid 1) e continua a girare
  // → istanze duplicate. Con detached:true il child è capostipite del suo
  // process group, quindi `process.kill(-pid)` abbatte TUTTO l'albero.
  const send = (sig) => {
    try { process.kill(-pid, sig); }
    catch { try { child.kill(sig); } catch {} }
  };
  send(signal);
  // Backstop: if SIGTERM doesn't deliver an exit in 3s, escalate.
  if (signal !== 'SIGKILL') {
    setTimeout(() => {
      if (child && !child.exitCode && !child.killed) {
        console.warn('[dev-loop] child ignored SIGTERM — escalating to SIGKILL');
        send('SIGKILL');
      }
    }, 3000).unref?.();
  }
}

function spawnChild() {
  const start = Date.now();
  childStartedAt = start;
  healthFails = 0;
  child = spawn(
    process.execPath,
    [tsxBin, 'src/index.ts'],   // no `watch` — this script owns reloading
    // detached:true → il child diventa leader del proprio process group, così
    // killChild può abbattere l'intero albero (wrapper tsx + server reale) e
    // non lasciare orfani.
    { stdio: 'inherit', env: process.env, detached: true },
  );
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const ran = Date.now() - start;
    if (ran > 5000) attempt = 0;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    attempt++;
    console.error(`\n[dev-loop] child exited code=${code} signal=${signal}. Respawn in ${delay}ms (attempt ${attempt}).`);
    setTimeout(spawnChild, delay);
  });
}

function scheduleRestart(reason) {
  if (shuttingDown) return;
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    console.log(`[dev-loop] file change (${reason}) — restarting`);
    killChild('SIGTERM');   // child SIGTERM → graceful → exit handler respawns
  }, RESTART_DEBOUNCE_MS);
}

// Recursive fs.watch works on macOS + Windows. Linux fallback below.
let watcher = null;
try {
  watcher = fs.watch('src', { recursive: true }, (_evt, file) => {
    if (!file) return;
    if (!/\.(ts|tsx|mjs|cjs|js|json|sql)$/.test(file)) return;
    scheduleRestart(file);
  });
} catch (e) {
  console.warn('[dev-loop] fs.watch recursive failed — file watch disabled', e?.message);
}

function shutdown(sig) {
  shuttingDown = true;
  if (healthTimer) clearInterval(healthTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (watcher) try { watcher.close(); } catch {}
  killChild(sig);
  restoreLaunchdBackend(); // hand the bot back to the launchd prod backend
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Kill any pre-existing process bound to our port. Stale tsx-watch from
// before dev-loop landed, or a previous dev-loop that crashed, can leave
// zombies polling WA/Telegram → "stream:error conflict replaced" loops and
// 3 backends fighting at once. Fail-loud if we can't.
function killExistingOnPort() {
  try {
    const r = spawnSync('lsof', ['-ti', `tcp:${HEALTH_PORT}`], { encoding: 'utf8' });
    const pids = (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).map(Number);
    const ours = process.pid;
    const others = pids.filter((p) => p !== ours);
    if (!others.length) return;
    console.warn(`[dev-loop] killing stale processes on port ${HEALTH_PORT}: ${others.join(', ')}`);
    spawnSync('kill', ['-9', ...others.map(String)]);
  } catch {}
}
// Also nuke any orphan tsx/dev-loop processes from prior `npm run dev`
// sessions. Match on cwd substring to avoid touching unrelated tsx procs.
function killOrphanDevProcs() {
  try {
    const ps = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    const ours = process.pid;
    const ppid = process.ppid;
    const cwd = process.cwd();
    const lines = (ps.stdout ?? '').split('\n');
    const victims = [];
    for (const line of lines) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const cmd = m[2];
      if (pid === ours || pid === ppid) continue;
      if (!cmd.includes(cwd)) continue;
      if (!/tsx|dev-loop\.mjs|src\/index\.ts/.test(cmd)) continue;
      victims.push(pid);
    }
    if (!victims.length) return;
    console.warn(`[dev-loop] killing orphan dev procs: ${victims.join(', ')}`);
    spawnSync('kill', ['-9', ...victims.map(String)]);
  } catch {}
}
// Mutual-exclusion guard vs the launchd-managed PROD backend (sess.8411).
// The 24/7 bot runs under launchd `com.polpo.brain.backend` (node dist/index.js).
// A manual `npm run dev` here spins a SECOND backend (tsx) that fights it for
// port 8787 AND for the SAME Telegram bot token → 409 Conflict → one poller
// gives up silently → bot goes mute. Root fix: dev and prod must never coexist.
// On startup we bootout the launchd backend (runtime-only; it auto-reloads on
// next login). On shutdown we bootstrap it back, so quitting dev never leaves
// the bot dead. macOS-only + plist-gated → no-op everywhere else.
const LAUNCHD_LABEL = 'com.polpo.brain.backend';
const LAUNCHD_PLIST = path.join(process.env.HOME ?? '', 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
let bootedOutLaunchd = false;

function launchdGuardAvailable() {
  return process.platform === 'darwin' && typeof process.getuid === 'function' && fs.existsSync(LAUNCHD_PLIST);
}

function stopLaunchdBackend() {
  if (!launchdGuardAvailable()) return;
  const domain = `gui/${process.getuid()}/${LAUNCHD_LABEL}`;
  const r = spawnSync('launchctl', ['bootout', domain], { encoding: 'utf8' });
  if (r.status === 0) {
    bootedOutLaunchd = true;
    console.warn(`[dev-loop] launchd ${LAUNCHD_LABEL} booted out — dev owns the bot token now (restored on exit)`);
  } // non-zero = wasn't loaded → nothing to stop
}

function restoreLaunchdBackend() {
  if (!bootedOutLaunchd) return;
  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootstrap', domain, LAUNCHD_PLIST], { encoding: 'utf8' });
  console.warn(`[dev-loop] launchd ${LAUNCHD_LABEL} restored — prod backend resumes the bot`);
}

stopLaunchdBackend();
killOrphanDevProcs();
killExistingOnPort();

spawnChild();
healthTimer = setInterval(pingHealth, HEALTH_INTERVAL_MS);
