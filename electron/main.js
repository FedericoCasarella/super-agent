// =====================================================================
// Super Agent — Electron main process
//
// Boot sequence:
//   1. Start embedded Postgres (data dir: userData/pgdata, port 55432)
//   2. Apply schema.sql if first boot
//   3. Spawn backend node process (resources/backend/dist/index.js) with
//      DATABASE_URL pointing at embedded pg
//   4. Wait for backend /health to respond
//   5. Open BrowserWindow → http://127.0.0.1:8787  (backend serves frontend)
//
// On quit: stop backend, stop pg, save data dir under userData (persistent
// across upgrades).
// =====================================================================
const { app, BrowserWindow, shell, dialog, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const http = require('node:http');

const PG_PORT = 55432;
const PG_USER = 'super_agent';
const PG_PASSWORD = 'super_agent_local';
const PG_DATABASE = 'super_agent';
const BACKEND_PORT = 8787;
const BACKEND_HOST = '127.0.0.1';

let mainWindow = null;
let backendProc = null;
let pg = null;
let quitting = false;

const isPackaged = app.isPackaged;
const resourcesPath = isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
const backendDir = isPackaged
  ? path.join(resourcesPath, 'backend')
  : path.resolve(__dirname, '..', 'backend');
const backendEntry = path.join(backendDir, 'dist', 'index.js');
const frontendDir = isPackaged
  ? path.join(resourcesPath, 'frontend')
  : path.resolve(__dirname, '..', 'frontend', 'dist');
const schemaPath = isPackaged
  ? path.join(backendDir, 'schema.sql')
  : path.join(backendDir, 'src', 'db', 'schema.sql');

const userDataDir = app.getPath('userData');
const pgDataDir = path.join(userDataDir, 'pgdata');
const logsDir = path.join(userDataDir, 'logs');

function ensureDirs() {
  for (const d of [pgDataDir, logsDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function logStream(name) {
  const f = path.join(logsDir, `${name}.log`);
  return fs.createWriteStream(f, { flags: 'a' });
}

async function startPostgres() {
  // embedded-postgres is ESM-only — dynamic import from CJS main process.
  const mod = await import('embedded-postgres');
  const EmbeddedPostgres = mod.default ?? mod.EmbeddedPostgres ?? mod;
  pg = new EmbeddedPostgres({
    databaseDir: pgDataDir,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
  });
  // First-boot init; safe to call repeatedly — embedded-postgres detects
  // existing data dir.
  const initialized = fs.existsSync(path.join(pgDataDir, 'PG_VERSION'));
  if (!initialized) {
    console.log('[pg] initializing fresh cluster…');
    await pg.initialise();
  }
  await pg.start();
  // Always try createDatabase — embedded-postgres throws "already exists" if
  // present, which we swallow. Covers the case where a prior boot initialised
  // the cluster but failed before creating the app db.
  try { await pg.createDatabase(PG_DATABASE); console.log('[pg] db created'); }
  catch (e) { /* already exists is expected */ }
  // Schema always (re)applied — idempotent. Catches partial first-boot
  // failures and picks up any new tables on app upgrade.
  await applySchema();
}

async function applySchema() {
  console.log('[pg] applying schema…');
  const sql = await fsp.readFile(schemaPath, 'utf-8');
  // Explicit connection to the app database — getPgClient() defaults to the
  // bootstrap db which is NOT where the backend reads from.
  const { Client } = require('pg');
  const client = new Client({
    host: '127.0.0.1', port: PG_PORT,
    user: PG_USER, password: PG_PASSWORD, database: PG_DATABASE,
  });
  await client.connect();
  await client.query(`SET search_path TO public`);
  // schema.sql has out-of-order ALTER/INDEX statements that reference tables
  // declared later. Run twice: pass 1 creates everything we can; pass 2 fills
  // the gaps. Split on top-level semicolons and execute one-by-one so a
  // single failure doesn't abort the remaining statements.
  const statements = splitSql(sql);
  for (let pass = 1; pass <= 2; pass++) {
    let errs = 0;
    for (const stmt of statements) {
      try { await client.query(stmt); }
      catch (e) { errs++; if (pass === 2) console.warn(`[pg:schema] ${e.message}`); }
    }
    console.log(`[pg] schema pass ${pass}: ${statements.length - errs}/${statements.length} ok`);
  }
  await client.end();
}

// Split SQL on semicolons, respecting $$-quoted blocks (DO $$ … $$).
function splitSql(sql) {
  const out = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; buf += '$$'; i++; continue; }
    if (c === ';' && !inDollar) { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const s = buf.trim(); if (s) out.push(s);
  return out;
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`,
      PORT: String(BACKEND_PORT),
      HOST: BACKEND_HOST,
      FRONTEND_DIST: frontendDir,
      JWT_SECRET: process.env.JWT_SECRET || 'desktop-local-' + app.getPath('userData').length,
    };
    console.log('[backend] spawning', backendEntry);
    const nodeBin = process.execPath; // electron binary acts as node when ELECTRON_RUN_AS_NODE=1
    backendProc = spawn(nodeBin, [backendEntry], {
      cwd: backendDir,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = logStream('backend');
    backendProc.stdout.pipe(out);
    backendProc.stderr.pipe(out);
    backendProc.on('exit', (code) => {
      console.log('[backend] exited', code);
      if (!quitting) {
        dialog.showErrorBox('Backend crashed', `Exit code: ${code}. Logs: ${logsDir}/backend.log`);
        app.quit();
      }
    });
    // poll /health
    const started = Date.now();
    const tick = () => {
      const req = http.get({ host: BACKEND_HOST, port: BACKEND_PORT, path: '/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else setTimeout(tick, 250);
      });
      req.on('error', () => {
        if (Date.now() - started > 30_000) reject(new Error('backend did not become ready in 30s'));
        else setTimeout(tick, 250);
      });
      req.on('timeout', () => { req.destroy(); setTimeout(tick, 250); });
    };
    tick();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Super Agent',
    backgroundColor: '#0b0b0f',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadURL(`http://${BACKEND_HOST}:${BACKEND_PORT}`);
  // open external links in default browser, not in the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://${BACKEND_HOST}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function boot() {
  ensureDirs();
  try {
    await startPostgres();
    await startBackend();
    createWindow();
  } catch (e) {
    console.error('[boot] failed', e);
    dialog.showErrorBox('Boot failed', String(e?.stack || e?.message || e));
    app.quit();
  }
}

app.whenReady().then(() => {
  // Set dock icon on macOS — uses login logo so brand matches app shell.
  if (process.platform === 'darwin') {
    try {
      const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
      if (!img.isEmpty()) app.dock.setIcon(img);
    } catch {}
  }
  boot();
});

// Close any window → quit the whole app (and tear down pg + backend). The
// "keep running in dock" behaviour for macOS is wrong here: closing the
// window must shut everything down per user request.
app.on('window-all-closed', () => { app.quit(); });

app.on('activate', () => { if (mainWindow === null) createWindow(); });

async function shutdown() {
  if (quitting) return;
  quitting = true;
  console.log('[quit] stopping backend + pg…');
  // Backend: SIGTERM, wait up to 5s, SIGKILL fallback.
  try {
    if (backendProc && !backendProc.killed) {
      backendProc.kill('SIGTERM');
      await new Promise((r) => {
        const t = setTimeout(() => { try { backendProc.kill('SIGKILL'); } catch {} ; r(); }, 5000);
        backendProc.once('exit', () => { clearTimeout(t); r(); });
      });
    }
  } catch (e) { console.warn('[quit:backend]', e); }
  // Postgres: clean stop persists data.
  try { if (pg) await pg.stop(); } catch (e) { console.warn('[quit:pg]', e); }
  console.log('[quit] done');
}

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  shutdown().finally(() => app.exit(0));
});

// Catch hard kills (Cmd+Q twice, terminal SIGINT) to still close pg cleanly.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { shutdown().finally(() => process.exit(0)); });
}

// Minimal app menu for macOS — Cmd+Q, Cmd+W work natively
if (process.platform === 'darwin') {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
