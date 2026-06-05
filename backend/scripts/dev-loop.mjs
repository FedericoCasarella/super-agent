#!/usr/bin/env node
// Auto-restart wrapper around `tsx watch`. Plain `tsx watch` keeps the parent
// alive but does NOT re-spawn the child on a hard crash unless a file changes.
// This wrapper respawns with exponential backoff so a transient throw doesn't
// leave the backend dead until the next save.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// Resolve tsx CLI regardless of workspace hoisting (root node_modules vs local).
const require = createRequire(import.meta.url);
const tsxPkgPath = require.resolve('tsx/package.json');
const tsxPkg = require('tsx/package.json');
const tsxBin = path.resolve(path.dirname(tsxPkgPath), typeof tsxPkg.bin === 'string' ? tsxPkg.bin : tsxPkg.bin.tsx);

const MAX_BACKOFF_MS = 8000;
let attempt = 0;
let child = null;
let shuttingDown = false;

function spawnChild() {
  const start = Date.now();
  child = spawn(
    process.execPath,
    [tsxBin, 'watch', 'src/index.ts'],
    { stdio: 'inherit', env: process.env },
  );
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const ran = Date.now() - start;
    // If the child ran for more than 5 s before dying, treat it as a fresh
    // crash and reset backoff — usually a runtime error after long uptime.
    if (ran > 5000) attempt = 0;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    attempt++;
    console.error(`\n[dev-loop] tsx exited code=${code} signal=${signal}. Respawn in ${delay}ms (attempt ${attempt}).`);
    setTimeout(spawnChild, delay);
  });
}

function shutdown(sig) {
  shuttingDown = true;
  if (child && !child.killed) child.kill(sig);
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

spawnChild();
