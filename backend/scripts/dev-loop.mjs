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
import { spawn } from 'node:child_process';
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
  try { child.kill(signal); } catch {}
  // Backstop: if SIGTERM doesn't deliver an exit in 3s, escalate.
  if (signal !== 'SIGKILL') {
    setTimeout(() => {
      if (child && !child.exitCode && !child.killed) {
        console.warn('[dev-loop] child ignored SIGTERM — escalating to SIGKILL');
        try { child.kill('SIGKILL'); } catch {}
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
    { stdio: 'inherit', env: process.env },
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
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

spawnChild();
healthTimer = setInterval(pingHealth, HEALTH_INTERVAL_MS);
