// =====================================================================
// Instagram DM connector — Playwright-driven (replaces instagram-private-api).
//
// Why Playwright: the unofficial signed-request lib was getting flagged with
// HTTP 467 on first inbox call even on clean IPs (its signature key + headers
// are fingerprinted by IG). A real Chromium browser carries authentic web
// session cookies, X-CSRFToken, X-IG-App-ID etc. — IG can't tell us apart
// from a desktop browser tab.
//
// Architecture: one persistent BrowserContext per user, storageState saved
// under ~/.super-agent/ig-sessions/u{id}/storage.json. After login we hit
// IG's internal `/api/v1/direct_v2/*` endpoints via `page.request` so we get
// JSON responses (no DOM scraping).
//
// Public surface stays identical to the old impl so API routes / MCP tools /
// frontend don't need changes.
// =====================================================================
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Connector } from '../../types.js';
import { bus } from '../../../bus.js';
import { query } from '../../../db/index.js';
import { upsertPerson } from '../people/index.js';

type Status = 'starting' | '2fa' | 'checkpoint' | 'connected' | 'closed';

type Session = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  status: Status;
  username?: string;
  me?: { pk: string; username: string; full_name?: string };
  pollIntervalMs?: number;
  startedAt: number;
  pollTimer?: NodeJS.Timeout;
  lastError?: string;
};

const sessions = new Map<number, Session>();

// Auto-polling enabled by default as a safety net. Realtime hooks capture
// most updates, but if the page strays from /direct/inbox/ (sending a DM
// navigates to /direct/t/<id>/) we'd miss inbound messages. The fallback
// poll is 2 minutes — quiet enough to stay under IG radar.
const AUTOPOLL_ENABLED = process.env.IG_AUTOPOLL !== '0';
const POLL_INTERVAL_BASE_MS = 30_000;
const POLL_INTERVAL_MAX_MS = 30 * 60_000;
const POLL_FIRST_DELAY_MS = 25_000;

const IG_BASE = 'https://www.instagram.com';
// Use the SAME origin the browser is on — i.instagram.com is the mobile-app
// host and trips IG's anti-bot heuristics when called from a desktop UA with
// www.instagram.com cookies scope.
const IG_API = 'https://www.instagram.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function sessionDir(userId: number): string {
  return path.join(os.homedir(), '.super-agent', 'ig-sessions', `u${userId}`);
}
function storagePath(userId: number): string {
  return path.join(sessionDir(userId), 'storage.json');
}
async function ensureDir(p: string) { await fs.mkdir(p, { recursive: true }); }

async function saveStorage(userId: number, ctx: BrowserContext) {
  try {
    await ensureDir(sessionDir(userId));
    await ctx.storageState({ path: storagePath(userId) });
    console.log(`[ig:u${userId}] storage saved → ${storagePath(userId)}`);
  } catch (e: any) {
    console.error(`[ig:u${userId}] saveStorage failed`, e?.message ?? e);
  }
}

async function storageExists(userId: number): Promise<boolean> {
  try { await fs.access(storagePath(userId)); return true; } catch { return false; }
}

async function newContext(userId: number): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const storage = (await storageExists(userId)) ? storagePath(userId) : undefined;
  const context = await browser.newContext({
    storageState: storage,
    userAgent: UA,
    viewport: { width: 1280, height: 800 },
    locale: 'it-IT',
  });
  // Inject a fetch/XHR/WebSocket hook BEFORE any page script runs. Once IG's
  // inbox page is loaded it continuously fetches/streams new DMs via
  // /api/v1/direct_v2/*; we tap into that data flow so we never have to poll
  // explicitly. Each captured payload is bubbled back to Node via the
  // __sa_onMessage binding (registered per-page below).
  await context.addInitScript(() => {
    function emit(payload: any) {
      try { (window as any).__sa_onMessage?.(payload); } catch {}
    }
    function isDirect(url: string): boolean {
      return /\/api\/v1\/direct_v2\//.test(url) || /\/direct\//.test(url);
    }
    // fetch hook
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (this: any, ...args: any[]) {
      const res = await (origFetch as any).apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (isDirect(url)) {
          const clone = res.clone();
          clone.json().then((j: any) => emit({ source: 'fetch', url, body: j })).catch(() => {});
        }
      } catch {}
      return res;
    } as any;
    // XHR hook
    const OrigXHR = window.XMLHttpRequest as any;
    window.XMLHttpRequest = class extends OrigXHR {
      private __url = '';
      open(method: string, url: string, ...rest: any[]) {
        this.__url = url;
        return super.open(method, url, ...(rest as []));
      }
      send(body?: any) {
        this.addEventListener('load', () => {
          try {
            if (this.__url && isDirect(this.__url)) {
              const j = JSON.parse(this.responseText);
              emit({ source: 'xhr', url: this.__url, body: j });
            }
          } catch {}
        });
        return super.send(body);
      }
    } as any;
    // WebSocket hook — IG sometimes uses MQTT-over-WSS for realtime push
    const OrigWS = window.WebSocket as any;
    window.WebSocket = class extends OrigWS {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        try {
          this.addEventListener('message', (ev: MessageEvent) => {
            try {
              // IG WS frames are usually JSON or binary MQTT. We forward raw
              // text so the Node side can decide.
              const data = typeof ev.data === 'string' ? ev.data : '[binary]';
              if (data.includes('direct_') || data.includes('thread')) {
                emit({ source: 'ws', url: this.url, body: data.slice(0, 4000) });
              }
            } catch {}
          });
        } catch {}
      }
    } as any;
  });
  const page = await context.newPage();
  return { browser, context, page };
}

// IG renders form submit as `<div role="button" aria-label="...">` rather
// than a native `<button>`. Try each aria-label, fall back to pressing Enter
// on the supplied input. Returns true if a click landed.
async function submitAriaButton(page: Page, labels: string[], enterFallback?: any): Promise<boolean> {
  for (const lbl of labels) {
    const sels = [
      `div[role="button"][aria-label="${lbl}"]`,
      `div[role="button"][aria-label*="${lbl}" i]`,
      `button[type="submit"]:has-text("${lbl}")`,
      `button:has-text("${lbl}")`,
    ];
    for (const sel of sels) {
      const btn = page.locator(sel).first();
      try {
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 4_000 });
          return true;
        }
      } catch {}
    }
  }
  if (enterFallback) {
    try { await enterFallback.press('Enter'); return true; } catch {}
  }
  return false;
}

// Once we have a logged-in page, navigate to /direct/inbox/ and keep it
// loaded. The injected hooks will pipe new DM payloads back to ingestThread()
// in realtime — no explicit polling needed.
async function attachRealtime(userId: number, page: Page) {
  try {
    await page.exposeBinding('__sa_onMessage', async (_source, payload: any) => {
      try {
        const url = payload?.url ?? '';
        const body = payload?.body;
        if (!body || typeof body !== 'object') return;
        const threads: any[] = body.inbox?.threads ?? (body.thread ? [body.thread] : []);
        if (threads.length === 0) return;
        console.log(`[ig:rt:u${userId}] capture ${payload.source}: ${threads.length} threads from ${url.slice(0, 80)}`);
        for (const t of threads) {
          if (!t || !t.thread_id) continue;
          try { await ingestThread(userId, t); } catch (e) { console.error('[ig:rt:ingest]', e); }
        }
      } catch (e) { console.warn('[ig:rt] binding handler error', e); }
    });
  } catch (e: any) {
    if (!/already registered/i.test(String(e?.message ?? ''))) console.warn('[ig:rt] exposeBinding', e?.message);
  }
  // Land on inbox so IG starts pushing realtime updates we can capture.
  try {
    await page.goto(IG_BASE + '/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e: any) { console.warn('[ig:rt] inbox goto', e?.message); }
  console.log(`[ig:u${userId}] realtime attached — listening to inbox push`);
}

async function teardown(s: Session) {
  try { if (s.pollTimer) clearTimeout(s.pollTimer); } catch {}
  try { await s.context?.close(); } catch {}
  try { await s.browser?.close(); } catch {}
}

// ----------------------------------------------------------------------
// Page-context API helpers — hit IG's internal JSON endpoints using the
// browser's cookies + native headers. Returns parsed JSON or null on failure.
// ----------------------------------------------------------------------
// Same trick as apiPost — run fetch INSIDE the page so IG's required session
// headers (x-ig-www-claim, x-instagram-ajax, x-fb-lsd, …) are attached
// automatically. Node-level page.request.get() misses these and gets HTML.
async function apiGet(page: Page, urlPath: string, qs: Record<string, string | number | boolean> = {}): Promise<any | null> {
  try {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(qs)) params[k] = String(v);
    const data: any = await page.evaluate(async (args: any) => {
      const url = new URL(args.path, location.origin);
      for (const [k, v] of Object.entries(args.params)) url.searchParams.set(k, v as string);
      const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
      const r = await fetch(url.toString(), {
        credentials: 'include',
        headers: {
          'x-csrftoken': csrf,
          'x-ig-app-id': '936619743392459',
          'x-asbd-id': '129477',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      const txt = await r.text();
      try { return JSON.parse(txt); } catch { return { __nonjson: true, status: r.status, body: txt.slice(0, 300) }; }
    }, { path: urlPath, params });
    if (data?.__nonjson) {
      console.warn(`[ig:api] GET ${urlPath} non-json ${data.status}: ${data.body}`);
      return null;
    }
    return data;
  } catch (e: any) {
    console.warn(`[ig:api] GET ${urlPath} threw`, e?.message);
    return null;
  }
}

// Execute a POST INSIDE the page context. page.request.post() from Node misses
// IG's auto-injected headers (x-ig-www-claim etc.) and gets the HTML login
// page back. Doing the fetch in-page reuses every header the IG web app would
// normally set, so endpoints accept the request.
async function apiPost(page: Page, urlPath: string, form: Record<string, string>): Promise<any | null> {
  try {
    return await page.evaluate(async (args: any) => {
      const fd = new URLSearchParams();
      for (const [k, v] of Object.entries(args.form)) fd.set(k, String(v));
      const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '';
      const r = await fetch(args.path, {
        method: 'POST',
        body: fd,
        credentials: 'include',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrftoken': csrf,
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      const txt = await r.text();
      try { return JSON.parse(txt); } catch { return { __nonjson: true, status: r.status, body: txt.slice(0, 300) }; }
    }, { path: urlPath, form });
  } catch (e: any) {
    console.warn(`[ig:api] POST ${urlPath} threw`, e?.message);
    return null;
  }
}

// Identify "me" via /api/v1/users/web_profile_info/?username=<self> after login.
// Cheaper: the page already has the user info in window._sharedData/document.cookie.
async function detectMe(page: Page): Promise<{ pk: string; username: string; full_name?: string } | null> {
  try {
    // Dismiss "Save login info" / onetap / similar interstitials so we land on /
    if (/\/(onetap|accounts\/(onetap|two_factor|login\/two_factor))/.test(page.url())) {
      try {
        const skip = page.locator('div[role="button"]:has-text("Non ora"), div[role="button"]:has-text("Not now"), button:has-text("Non ora"), button:has-text("Not now")').first();
        if (await skip.count() > 0) await skip.click({ timeout: 3_000 });
      } catch {}
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    }
    // Primary signal: ds_user_id cookie set means we're logged in.
    const cookies = await page.context().cookies();
    const dsUserId = cookies.find((c) => c.name === 'ds_user_id')?.value;
    if (!dsUserId) return null;
    // Try profile info — best effort. If API 401/spam, fall back to cookie data.
    let username = '?';
    let full_name: string | undefined;
    try {
      const info = await apiGet(page, `/api/v1/users/${dsUserId}/info/`);
      if (info?.user) {
        username = info.user.username ?? username;
        full_name = info.user.full_name ?? undefined;
      }
    } catch {}
    if (username === '?') {
      // Second-best: scrape from rendered page header (window.__additionalDataLoaded or DOM)
      try {
        username = await page.evaluate(() => {
          // Look in any inline script for "username":"..."
          const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? '');
          for (const t of scripts) {
            const m = t.match(/"username":"([^"]+)"/);
            if (m) return m[1];
          }
          return '?';
        });
      } catch {}
    }
    return { pk: dsUserId, username, full_name };
  } catch { return null; }
}

// ----------------------------------------------------------------------
// Login flow — fill the public IG login form, handle 2FA & checkpoint pages.
// ----------------------------------------------------------------------
export async function startIgForUser(userId: number, opts?: { username?: string; password?: string }): Promise<{ ok: boolean; status: string; needs2fa?: boolean; needsCheckpoint?: boolean; error?: string }> {
  const existing = sessions.get(userId);
  if (existing && existing.status === 'connected') return { ok: true, status: 'connected' };
  if (existing && (existing.status === '2fa' || existing.status === 'checkpoint' || existing.status === 'starting')) {
    return { ok: false, status: existing.status, needs2fa: existing.status === '2fa', needsCheckpoint: existing.status === 'checkpoint', error: existing.lastError };
  }
  // Reuse stored session if present and no fresh creds provided.
  const hasStorage = await storageExists(userId);
  if (hasStorage && !opts?.username) {
    return restoreSession(userId);
  }
  if (!opts?.username || !opts?.password) {
    return { ok: false, status: 'idle', error: 'username/password required' };
  }
  return doFreshLogin(userId, opts.username, opts.password);
}

async function restoreSession(userId: number): Promise<{ ok: boolean; status: string; needs2fa?: boolean; needsCheckpoint?: boolean; error?: string }> {
  const { browser, context, page } = await newContext(userId);
  const session: Session = { browser, context, page, status: 'starting', startedAt: Date.now() };
  sessions.set(userId, session);
  bus.emit('ig:status', { userId, status: 'starting' });
  try {
    // Navigate to inbox — if cookies valid we land there, else IG redirects to /login.
    await page.goto(IG_BASE + '/direct/inbox/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const url = page.url();
    if (/\/accounts\/login\//.test(url)) {
      console.warn(`[ig:u${userId}] storage stale → fresh login required`);
      await teardown(session);
      sessions.delete(userId);
      // Don't wipe storage.json — it's harmless if invalid and a successful
      // fresh login will overwrite it. Wiping racy state has caused login
      // loops; better to leave it.
      bus.emit('ig:status', { userId, status: 'closed', error: 'session expired' });
      return { ok: false, status: 'closed', error: 'session expired' };
    }
    if (/\/challenge\//.test(url) || /\/accounts\/disabled_popup\//.test(url)) {
      console.warn(`[ig:u${userId}] restore landed on challenge page — keeping session live for code submit`);
      session.status = 'checkpoint';
      session.lastError = 'Instagram richiede verifica. Controlla email/SMS e inserisci il codice.';
      // KEEP session + page alive so submitIgCheckpoint can fill the form.
      // Also keep storage.json untouched — a freshly-validated checkpoint
      // will overwrite it via saveStorage on success.
      bus.emit('ig:status', { userId, status: 'checkpoint', error: session.lastError });
      return { ok: false, status: 'checkpoint', needsCheckpoint: true, error: session.lastError };
    }
    const me = await detectMe(page);
    if (!me) {
      console.warn(`[ig:u${userId}] restore: couldn't detect me, treating as closed`);
      await teardown(session);
      sessions.delete(userId);
      bus.emit('ig:status', { userId, status: 'closed', error: 'detectMe failed' });
      return { ok: false, status: 'closed', error: 'detectMe failed' };
    }
    session.me = me;
    session.username = me.username;
    session.status = 'connected';
    await saveStorage(userId, context);
    bus.emit('ig:status', { userId, status: 'connected', me });
    await attachRealtime(userId, sessions.get(userId)!.page); startPolling(userId);
    console.log(`[ig:u${userId}] restored as @${me.username}`);
    return { ok: true, status: 'connected' };
  } catch (e: any) {
    console.error(`[ig:u${userId}] restore failed`, e?.message);
    await teardown(session);
    sessions.delete(userId);
    bus.emit('ig:status', { userId, status: 'closed', error: String(e?.message ?? e).slice(0, 200) });
    return { ok: false, status: 'closed', error: String(e?.message ?? e).slice(0, 200) };
  }
}

async function doFreshLogin(userId: number, username: string, password: string): Promise<{ ok: boolean; status: string; needs2fa?: boolean; needsCheckpoint?: boolean; error?: string }> {
  // Wipe any stale storage so we start clean
  try { await fs.rm(storagePath(userId), { force: true }); } catch {}
  const { browser, context, page } = await newContext(userId);
  const session: Session = { browser, context, page, status: 'starting', username, startedAt: Date.now() };
  sessions.set(userId, session);
  bus.emit('ig:status', { userId, status: 'starting' });
  try {
    await page.goto(IG_BASE + '/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await ensureDir(sessionDir(userId));
    // Baseline screenshot right after navigation so we always have something.
    try { await page.screenshot({ path: path.join(sessionDir(userId), 'login-debug.png'), fullPage: true }); } catch (e: any) { console.error('[ig] screenshot fail', e?.message); }
    try { const html = await page.content(); await fs.writeFile(path.join(sessionDir(userId), 'login-debug.html'), html, 'utf-8'); } catch {}
    console.log(`[ig:u${userId}] login page loaded → ${page.url()}`);
    // Cookie banner — click "Consenti tutti i cookie" (Accept). Reliable closer.
    // Trying "Rifiuta" sometimes leaves the modal half-open in headless. Accept
    // is purely a UI signal here; we control the actual cookie storage.
    const bannerSelectors = [
      'button:has-text("Consenti tutti i cookie")',
      'button:has-text("Allow all cookies")',
      'button:has-text("Accept all")',
      'button:has-text("Allow all")',
      // fallbacks
      'button:has-text("Rifiuta cookie facoltativi")',
      'button:has-text("Decline optional cookies")',
    ];
    for (const sel of bannerSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.count() > 0) {
          await btn.click({ timeout: 5_000 });
          console.log(`[ig:u${userId}] dismissed cookie banner via "${sel}"`);
          break;
        }
      } catch {}
    }
    // Wait for modal to actually go away. role=dialog should detach.
    try {
      await page.waitForFunction(() => !document.querySelector('div[role="dialog"]'), null, { timeout: 8_000 });
    } catch {}
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

    // Locate username/password — IG ships different selectors per A/B. Try a list.
    const userSelectors = [
      'input[name="username"]',
      'input[aria-label*="username" i]',
      'input[aria-label*="phone" i]',
      'input[aria-label*="email" i]',
      'input[autocomplete="username"]',
      'input[type="text"]',
    ];
    const passSelectors = [
      'input[name="password"]',
      'input[aria-label*="password" i]',
      'input[autocomplete="current-password"]',
      'input[type="password"]',
    ];
    let userInput = null;
    for (const sel of userSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) { userInput = loc; break; }
    }
    let passInput = null;
    for (const sel of passSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) { passInput = loc; break; }
    }
    if (!userInput || !passInput) {
      // Dump screenshot + html for debug
      try {
        await ensureDir(sessionDir(userId));
        await page.screenshot({ path: path.join(sessionDir(userId), 'login-debug.png'), fullPage: true });
        const html = await page.content();
        await fs.writeFile(path.join(sessionDir(userId), 'login-debug.html'), html, 'utf-8');
        console.error(`[ig:u${userId}] login form not found. Debug → ${sessionDir(userId)}/login-debug.{png,html}`);
      } catch {}
      throw new Error('Login form non trovato (IG ha cambiato layout). Vedi ' + sessionDir(userId) + '/login-debug.png');
    }
    // React form: use real keystrokes, not .fill(), so onChange fires.
    await userInput.click({ timeout: 15_000 });
    await userInput.fill('');
    await page.keyboard.type(username, { delay: 50 });
    await passInput.click();
    await passInput.fill('');
    await page.keyboard.type(password, { delay: 50 });
    await page.waitForTimeout(500);
    const clicked = await submitAriaButton(page, ['Accedi', 'Log in', 'Login'], passInput);
    console.log(`[ig:u${userId}] login submit clicked=${clicked}`);
    // Wait for URL to leave /accounts/login/ (IG redirects on success / 2fa / challenge).
    try {
      await page.waitForURL((url) => !/\/accounts\/login(\/?|\?)/.test(url.toString()), { timeout: 30_000 });
    } catch {
      console.warn(`[ig:u${userId}] login URL didn't change after 30s`);
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    console.log(`[ig:u${userId}] post-submit URL = ${page.url()}`);
    try { await page.screenshot({ path: path.join(sessionDir(userId), 'post-submit.png'), fullPage: true }); } catch {}
    try { const html = await page.content(); await fs.writeFile(path.join(sessionDir(userId), 'post-submit.html'), html, 'utf-8'); } catch {}
    // Look for explicit error message ("password errata", "wrong password")
    try {
      const errText = await page.locator('p[id^="slfErrorAlert"], [role="alert"]').first().textContent({ timeout: 2_000 });
      if (errText) console.warn(`[ig:u${userId}] login error banner: "${errText}"`);
    } catch {}
    // Wait for navigation to settle (could be: home, /challenge/, /accounts/onetap/, /accounts/login/two_factor)
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    const url = page.url();
    if (/\/two_factor\//.test(url) || await page.locator('input[name="verificationCode"]').count() > 0) {
      session.status = '2fa';
      session.lastError = 'Inserisci il codice 2FA inviato da Instagram.';
      bus.emit('ig:status', { userId, status: '2fa' });
      return { ok: false, status: '2fa', needs2fa: true };
    }
    if (/\/challenge\//.test(url)) {
      session.status = 'checkpoint';
      session.lastError = 'Instagram chiede una verifica di sicurezza. Inserisci il codice ricevuto via email/SMS.';
      // Many IG checkpoints land on a page with a single radio/email button; click submit if visible to trigger code send.
      try {
        const submitBtn = page.locator('button[type="submit"], button:has-text("Send"), button:has-text("Invia")').first();
        if (await submitBtn.count() > 0) await submitBtn.click({ timeout: 3_000 });
      } catch {}
      bus.emit('ig:status', { userId, status: 'checkpoint', error: session.lastError });
      return { ok: false, status: 'checkpoint', needsCheckpoint: true, error: session.lastError };
    }
    // Onetap / "save login info" page — dismiss with "Not now"
    if (/\/onetap\//.test(url)) {
      try {
        const skipBtn = page.getByRole('button', { name: /(not now|non ora)/i });
        await skipBtn.click({ timeout: 3_000 });
      } catch {}
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
    // Confirm we landed on the feed
    const me = await detectMe(page);
    if (!me) {
      const err = 'Login non riuscito — controlla credenziali.';
      session.status = 'closed';
      session.lastError = err;
      bus.emit('ig:status', { userId, status: 'closed', error: err });
      await teardown(session);
      sessions.delete(userId);
      return { ok: false, status: 'closed', error: err };
    }
    session.me = me;
    session.status = 'connected';
    await saveStorage(userId, context);
    bus.emit('ig:status', { userId, status: 'connected', me });
    await attachRealtime(userId, sessions.get(userId)!.page); startPolling(userId);
    console.log(`[ig:u${userId}] logged in as @${me.username}`);
    return { ok: true, status: 'connected' };
  } catch (e: any) {
    console.error(`[ig:u${userId}] login failed`, e?.message);
    await teardown(session);
    sessions.delete(userId);
    const err = String(e?.message ?? e).slice(0, 300);
    bus.emit('ig:status', { userId, status: 'closed', error: err });
    return { ok: false, status: 'closed', error: err };
  }
}

export async function submitIgTwoFactor(userId: number, code: string): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== '2fa') return { ok: false, error: '2FA not pending' };
  const clean = code.replace(/\s+/g, '').trim();
  try {
    const inputSelectors = [
      'input[name="verificationCode"]',
      'input[aria-label*="codice" i]',
      'input[aria-label*="code" i]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
    ];
    let input = null;
    for (const sel of inputSelectors) {
      const loc = s.page.locator(sel).first();
      if (await loc.count() > 0) { input = loc; break; }
    }
    if (!input) throw new Error('input codice 2FA non trovato');
    // IG validates the verification code via React state; `.fill()` bypasses
    // the onChange listeners. Use keyboard.type with delay so each digit fires
    // an input event the React form picks up.
    await input.click({ timeout: 10_000 });
    await input.fill('');
    await s.page.keyboard.type(clean, { delay: 80 });
    await s.page.waitForTimeout(800); // let "Conferma" enable
    // Click the now-enabled aria-button, with Enter fallback.
    await submitAriaButton(s.page, ['Conferma', 'Confirm', 'Continue', 'Continua', 'Verifica', 'Verify'], input);
    try {
      await s.page.waitForURL((url) => !/two_factor/.test(url.toString()), { timeout: 60_000 });
    } catch {
      // Stuck on /two_factor/. Could be: invalid code, IG rate-limit silent fail,
      // or extra step injected. Capture state, surface to user.
      console.warn(`[ig:u${userId}] 2fa URL didn't change after 60s`);
      try { await s.page.screenshot({ path: path.join(sessionDir(userId), 'post-2fa-stuck.png'), fullPage: true }); } catch {}
      // Detect explicit error message
      let errBanner = '';
      try {
        const banner = await s.page.locator('[role="alert"], p[id^="twoFactorErrorAlert"]').first().textContent({ timeout: 2_000 });
        errBanner = (banner || '').trim();
      } catch {}
      return { ok: false, error: errBanner || 'Codice 2FA non accettato — probabilmente scaduto (TOTP cambia ogni 30s) o IG ha bloccato la richiesta. Riprova con nuovo codice.' };
    }
    await s.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await s.page.waitForTimeout(1_500);
    console.log(`[ig:u${userId}] post-2fa URL = ${s.page.url()}`);
    // Force navigation to root — sometimes IG sets ds_user_id only on a subsequent
    // page load after the 2fa redirect chain settles.
    try {
      await s.page.goto(IG_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await s.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    } catch {}
    try { await ensureDir(sessionDir(userId)); await s.page.screenshot({ path: path.join(sessionDir(userId), 'post-2fa.png'), fullPage: true }); } catch {}
    try { const html = await s.page.content(); await fs.writeFile(path.join(sessionDir(userId), 'post-2fa.html'), html, 'utf-8'); } catch {}
    const cookies = await s.context.cookies();
    const dsUserId = cookies.find((c) => c.name === 'ds_user_id')?.value;
    const sessionId = cookies.find((c) => c.name === 'sessionid')?.value;
    console.log(`[ig:u${userId}] post-2fa cookies: ds_user_id=${dsUserId ?? 'MISSING'} sessionid=${sessionId ? 'OK' : 'MISSING'}`);
    await s.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    const url = s.page.url();
    if (/\/two_factor\//.test(url) || (await s.page.locator('text=/incorrect|sbagliato|wrong/i').count()) > 0) {
      return { ok: false, error: 'Codice 2FA errato.' };
    }
    if (/\/challenge\//.test(url)) {
      s.status = 'checkpoint';
      s.lastError = 'Verifica di sicurezza richiesta.';
      bus.emit('ig:status', { userId, status: 'checkpoint', error: s.lastError });
      return { ok: false, error: s.lastError };
    }
    const me = await detectMe(s.page);
    if (!me) return { ok: false, error: 'detectMe failed after 2fa' };
    s.me = me;
    s.username = me.username;
    s.status = 'connected';
    s.lastError = undefined;
    await saveStorage(userId, s.context);
    bus.emit('ig:status', { userId, status: 'connected', me });
    await attachRealtime(userId, sessions.get(userId)!.page); startPolling(userId);
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 300);
    s.lastError = err;
    return { ok: false, error: err };
  }
}

export async function submitIgCheckpoint(userId: number, code: string): Promise<{ ok: boolean; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'checkpoint') return { ok: false, error: 'no checkpoint pending' };
  const clean = code.replace(/\s+/g, '').trim();
  try {
    const inputSelectors = [
      'input[name="security_code"]',
      'input[name="verificationCode"]',
      'input[name="code"]',
      'input[aria-label*="codice" i]',
      'input[aria-label*="code" i]',
      'input[autocomplete="one-time-code"]',
      'input[type="tel"]',
    ];
    let input = null;
    for (const sel of inputSelectors) {
      const loc = s.page.locator(sel).first();
      if (await loc.count() > 0) { input = loc; break; }
    }
    if (!input) throw new Error('input codice checkpoint non trovato');
    await input.fill(clean, { timeout: 10_000 });
    await submitAriaButton(s.page, ['Conferma', 'Confirm', 'Submit', 'Invia', 'Continue', 'Continua', 'Verifica', 'Verify'], input);
    try {
      await s.page.waitForURL((url) => !/\/challenge\//.test(url.toString()), { timeout: 30_000 });
    } catch {
      console.warn(`[ig:u${userId}] checkpoint URL didn't change after 30s`);
    }
    await s.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await s.page.waitForTimeout(1_500);
    console.log(`[ig:u${userId}] post-checkpoint URL = ${s.page.url()}`);
    await s.page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    const url = s.page.url();
    if (/\/challenge\//.test(url)) {
      return { ok: false, error: 'Codice errato o ulteriore step richiesto.' };
    }
    const me = await detectMe(s.page);
    if (!me) return { ok: false, error: 'detectMe failed after checkpoint' };
    s.me = me;
    s.username = me.username;
    s.status = 'connected';
    s.lastError = undefined;
    await saveStorage(userId, s.context);
    bus.emit('ig:status', { userId, status: 'connected', me });
    await attachRealtime(userId, sessions.get(userId)!.page); startPolling(userId);
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 300);
    s.lastError = err;
    return { ok: false, error: err };
  }
}

export async function stopIgForUser(userId: number): Promise<void> {
  const s = sessions.get(userId);
  if (!s) return;
  await teardown(s);
  sessions.delete(userId);
  bus.emit('ig:status', { userId, status: 'closed' });
}

export async function logoutIgForUser(userId: number): Promise<void> {
  await stopIgForUser(userId);
  try { await fs.rm(sessionDir(userId), { recursive: true, force: true }); } catch {}
}

export function getIgStatus(userId: number): { status: string; me?: any; error?: string } {
  const s = sessions.get(userId);
  if (s) return { status: s.status, me: s.me, error: s.lastError };
  // Lazy restore if storage on disk exists.
  storageExists(userId).then((exists) => {
    if (exists && !sessions.get(userId)) {
      console.log(`[ig:u${userId}] lazy restore from storage…`);
      startIgForUser(userId).catch((e) => console.error('[ig] lazy restore', e));
    }
  });
  return { status: 'idle' };
}

// ----------------------------------------------------------------------
// Polling — manual default, auto-opt-in via IG_AUTOPOLL=1
// ----------------------------------------------------------------------
function startPolling(userId: number) {
  const s = sessions.get(userId);
  if (!s) return;
  if (s.pollTimer) clearTimeout(s.pollTimer);
  if (!AUTOPOLL_ENABLED) {
    console.log(`[ig:u${userId}] auto-polling disabled. Manual sync only.`);
    return;
  }
  s.pollIntervalMs = POLL_INTERVAL_BASE_MS;
  const schedule = (delay: number) => {
    s.pollTimer = setTimeout(async () => {
      const cur = sessions.get(userId);
      if (!cur) return;
      try {
        const r = await pollOnce(userId);
        if (r.error && /spam|rate|429|467/i.test(r.error)) {
          cur.pollIntervalMs = Math.min(POLL_INTERVAL_MAX_MS, (cur.pollIntervalMs ?? POLL_INTERVAL_BASE_MS) * 2);
        } else if (r.ok) {
          cur.pollIntervalMs = POLL_INTERVAL_BASE_MS;
        }
      } catch (e) { console.error(`[ig:u${userId}] poll fail`, e); }
      const base = cur.pollIntervalMs ?? POLL_INTERVAL_BASE_MS;
      const jitter = base * (0.8 + Math.random() * 0.4);
      schedule(jitter);
    }, delay);
  };
  schedule(POLL_FIRST_DELAY_MS);
}

async function pollOnce(userId: number, opts: { pages?: number } = {}): Promise<{ ok: boolean; threads: number; items: number; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, threads: 0, items: 0, error: 'not connected' };
  console.log(`[ig:u${userId}] poll start (pages=${opts.pages ?? 1})`);
  const allThreads: any[] = [];
  let cursor: string | undefined;
  const maxPages = Math.max(1, Math.min(opts.pages ?? 1, 10));
  for (let i = 0; i < maxPages; i++) {
    const qs: Record<string, string | number | boolean> = {
      visual_message_return_type: 'unseen',
      thread_message_limit: 10,
      persistentBadging: true,
      limit: 20,
    };
    if (cursor) qs.cursor = cursor;
    const data = await apiGet(s.page, '/api/v1/direct_v2/inbox/', qs);
    if (!data) return { ok: false, threads: 0, items: 0, error: 'inbox fetch failed' };
    const inbox = data.inbox ?? data;
    const threads: any[] = inbox.threads ?? [];
    allThreads.push(...threads);
    if (!inbox.has_older || !inbox.oldest_cursor) break;
    cursor = inbox.oldest_cursor;
  }
  let totalItems = 0;
  for (const t of allThreads) {
    try { totalItems += (t.items?.length ?? 0); await ingestThread(userId, t); } catch (e) { console.error('[ig:ingest]', e); }
  }
  console.log(`[ig:u${userId}] poll done: ${allThreads.length} threads, ${totalItems} items`);
  await saveStorage(userId, s.context);
  return { ok: true, threads: allThreads.length, items: totalItems };
}

export async function syncIgNow(userId: number, pages = 3): Promise<{ ok: boolean; threads: number; items: number; error?: string }> {
  bus.emit('ig:sync', { userId, kind: 'start' });
  const r = await pollOnce(userId, { pages });
  bus.emit('ig:sync', { userId, kind: 'done', ...r });
  return r;
}

export async function syncIgThread(userId: number, threadId: string, pages = 5): Promise<{ ok: boolean; items: number; error?: string }> {
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') return { ok: false, items: 0, error: 'not connected' };
  let cursor: string | undefined;
  let total = 0;
  // First fetch base thread metadata from inbox
  const inbox = await apiGet(s.page, '/api/v1/direct_v2/inbox/', { thread_message_limit: 0, limit: 20 });
  const baseThread = inbox?.inbox?.threads?.find((t: any) => String(t.thread_id) === threadId);
  if (!baseThread) return { ok: false, items: 0, error: 'thread not found in inbox' };
  for (let i = 0; i < pages; i++) {
    const qs: Record<string, string | number | boolean> = { visual_message_return_type: 'unseen', limit: 20 };
    if (cursor) qs.cursor = cursor;
    const data = await apiGet(s.page, `/api/v1/direct_v2/threads/${encodeURIComponent(threadId)}/`, qs);
    const thr = data?.thread;
    if (!thr) break;
    const items = thr.items ?? [];
    if (!items.length) break;
    await ingestThread(userId, { ...baseThread, ...thr, items });
    total += items.length;
    if (!thr.has_older || !thr.oldest_cursor) break;
    cursor = thr.oldest_cursor;
  }
  return { ok: true, items: total };
}

// ----------------------------------------------------------------------
// Ingestion (DB + bus) — shape matches the old impl 1:1.
// ----------------------------------------------------------------------
async function ingestThread(userId: number, t: any) {
  const threadId = String(t.thread_id);
  const participants = (t.users ?? []).map((u: any) => ({
    pk: String(u.pk), username: u.username, full_name: u.full_name,
    profile_pic_url: u.profile_pic_url, is_verified: !!u.is_verified,
  }));
  const isGroup = participants.length > 1;
  const title = t.thread_title || participants.map((p: any) => p.username).join(', ');
  await query(
    `INSERT INTO ig_threads(user_id, thread_id, title, is_group, participants, last_activity, updated_at)
     VALUES($1,$2,$3,$4,$5::jsonb, to_timestamp($6/1000000.0), now())
     ON CONFLICT(user_id, thread_id) DO UPDATE
       SET title=EXCLUDED.title, is_group=EXCLUDED.is_group, participants=EXCLUDED.participants,
           last_activity=EXCLUDED.last_activity, updated_at=now()`,
    [userId, threadId, title, isGroup, JSON.stringify(participants), t.last_activity_at ?? Date.now() * 1000],
  );
  for (const u of participants) {
    await query(
      `INSERT INTO ig_contacts(user_id, ig_id, username, full_name, profile_pic_url, is_verified, updated_at)
       VALUES($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT(user_id, ig_id) DO UPDATE
         SET username=EXCLUDED.username, full_name=EXCLUDED.full_name,
             profile_pic_url=EXCLUDED.profile_pic_url, is_verified=EXCLUDED.is_verified, updated_at=now()`,
      [userId, u.pk, u.username, u.full_name, u.profile_pic_url, u.is_verified],
    );
  }
  const session = sessions.get(userId);
  const meId = session?.me?.pk;
  const items = (t.items ?? []).slice().reverse(); // oldest → newest
  for (const it of items) {
    const itemId = String(it.item_id);
    const senderId = String(it.user_id);
    const fromMe = meId ? senderId === meId : false;
    const itemType = String(it.item_type ?? 'text');
    let text = '';
    if (itemType === 'text') text = String(it.text ?? '');
    else if (itemType === 'media_share') text = `[media share] ${it.media_share?.caption?.text ?? ''}`;
    else if (itemType === 'story_share') text = `[story share] ${it.story_share?.message ?? ''}`;
    else if (itemType === 'reel_share') text = `[reel share] ${it.reel_share?.text ?? ''}`;
    else if (itemType === 'link') text = `[link] ${it.link?.text ?? ''} ${it.link?.link_context?.link_url ?? ''}`.trim();
    else if (itemType === 'voice_media') text = '[voice message]';
    else if (itemType === 'animated_media') text = '[gif]';
    else if (itemType === 'media') text = '[image/video]';
    else text = `[${itemType}]`;
    const sender = participants.find((p: any) => p.pk === senderId);
    const senderUsername = fromMe ? session?.me?.username : sender?.username;
    const senderName = fromMe ? 'TU' : (sender?.full_name ?? sender?.username);
    let personSlug: string | null = null;
    if (!fromMe && sender?.username) {
      try {
        const p = await upsertPerson(userId, { name: sender.full_name || sender.username, aliases: [`ig:${sender.username}`] });
        personSlug = p.slug;
      } catch {}
    }
    const ts = it.timestamp ? new Date(Number(it.timestamp) / 1000).toISOString() : new Date().toISOString();
    const ins = await query<{ id: number }>(
      `INSERT INTO ig_messages(user_id, msg_id, thread_id, sender_ig_id, sender_username, sender_name, person_slug, from_me, text, item_type, ts)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(user_id, msg_id) DO NOTHING
       RETURNING id::int`,
      [userId, itemId, threadId, senderId, senderUsername, senderName, personSlug, fromMe, text, itemType, ts],
    );
    if (ins.length > 0) {
      bus.emit('ig:message', {
        userId,
        msg: { id: itemId, thread_id: threadId, sender_ig_id: senderId, sender_username: senderUsername, sender_name: senderName, person_slug: personSlug, from_me: fromMe, text, item_type: itemType, ts },
      });
    }
  }
}

// ----------------------------------------------------------------------
// Send DM via internal API
// ----------------------------------------------------------------------
export async function sendIgMessage(userId: number, threadId: string, text: string, origin: string = 'user', source: 'user' | 'ai' = 'user'): Promise<{ ok: boolean; error?: string }> {
  const { logOutbound } = await import('../../../comm/outbound_log.js');
  const s = sessions.get(userId);
  if (!s || s.status !== 'connected') {
    await logOutbound({ userId, channel: 'instagram', status: 'error', recipient: threadId, body: text, origin, error: 'Instagram non connesso' });
    return { ok: false, error: 'Instagram non connesso' };
  }
  if (!text?.trim()) return { ok: false, error: 'empty text' };
  let recipientName: string | null = null;
  try {
    const r = await query<{ title: string | null }>(`SELECT title FROM ig_threads WHERE user_id=$1 AND thread_id=$2`, [userId, threadId]);
    recipientName = r[0]?.title ?? null;
  } catch {}
  try {
    // Direct API call to broadcast/text/ returns HTML on web (claim header
    // mismatch). Instead drive the actual UI: navigate to thread page, type
    // text in textarea, press Enter. Slower but matches what a real user does.
    await s.page.goto(`${IG_BASE}/direct/t/${encodeURIComponent(threadId)}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await s.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    console.log(`[ig:u${userId}] send: thread URL = ${s.page.url()}`);
    // Try multiple composer selectors — IG rotates them.
    const composerSelectors = [
      'div[role="textbox"][contenteditable="true"]',
      'textarea[placeholder*="Messaggio" i]',
      'textarea[placeholder*="Message" i]',
      'div[aria-label*="Messaggio" i][contenteditable]',
      'div[aria-label*="Message" i][contenteditable]',
      'div[contenteditable="true"]',
    ];
    let composer: any = null;
    for (const sel of composerSelectors) {
      const loc = s.page.locator(sel).first();
      try {
        await loc.waitFor({ state: 'visible', timeout: 4_000 });
        composer = loc;
        console.log(`[ig:u${userId}] composer found via "${sel}"`);
        break;
      } catch {}
    }
    if (!composer) {
      try { await ensureDir(sessionDir(userId)); await s.page.screenshot({ path: path.join(sessionDir(userId), 'send-debug.png'), fullPage: true }); } catch {}
      try { const html = await s.page.content(); await fs.writeFile(path.join(sessionDir(userId), 'send-debug.html'), html, 'utf-8'); } catch {}
      throw new Error(`composer non trovato. Vedi ${sessionDir(userId)}/send-debug.png`);
    }
    await composer.click();
    await s.page.keyboard.type(text, { delay: 20 });
    await s.page.waitForTimeout(300);
    await composer.press('Enter');
    // IG echoes the sent message back via the realtime hook — DO NOT INSERT a
    // local copy here, that's what produced duplicates. The hook ingests with
    // the real item_id; ON CONFLICT prevents double rows.
    await s.page.waitForTimeout(800);
    // Navigate back to inbox so realtime hooks keep receiving push fetches.
    try { await s.page.goto(`${IG_BASE}/direct/inbox/`, { waitUntil: 'domcontentloaded', timeout: 15_000 }); } catch {}
    await logOutbound({ userId, channel: 'instagram', status: 'sent', recipient: threadId, recipient_name: recipientName, body: text, origin });
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 500);
    await logOutbound({ userId, channel: 'instagram', status: 'error', recipient: threadId, recipient_name: recipientName, body: text, origin, error: err });
    return { ok: false, error: err };
  }
}

// ----------------------------------------------------------------------
// DB helpers (unchanged from old impl — still drive the UI and MCP tools).
// ----------------------------------------------------------------------
export async function setThreadAutoBonify(userId: number, threadId: string, enabled: boolean): Promise<{ ok: boolean }> {
  await query(
    `INSERT INTO ig_threads(user_id, thread_id, auto_bonify, updated_at)
     VALUES($1,$2,$3, now())
     ON CONFLICT(user_id, thread_id) DO UPDATE SET auto_bonify=EXCLUDED.auto_bonify, updated_at=now()`,
    [userId, threadId, !!enabled],
  );
  return { ok: true };
}

// Follow-up escalation steps (hours). Agent waits each delay; if no incoming
// message arrives, sends a follow-up. Caps at 3 attempts to avoid spam.
const FOLLOW_UP_DELAYS_H = [6, 24, 72];

async function scheduleFollowUp(userId: number, threadId: string) {
  const r = await query<{ follow_up_count: number }>(
    `SELECT follow_up_count FROM ig_threads WHERE user_id=$1 AND thread_id=$2`,
    [userId, threadId],
  );
  const count = r[0]?.follow_up_count ?? 0;
  if (count >= FOLLOW_UP_DELAYS_H.length) {
    await query(`UPDATE ig_threads SET follow_up_at=NULL WHERE user_id=$1 AND thread_id=$2`, [userId, threadId]);
    return;
  }
  const hoursDelay = FOLLOW_UP_DELAYS_H[count];
  await query(
    `UPDATE ig_threads SET follow_up_at = now() + ($3::int || ' hours')::interval, last_outbound_at = now()
     WHERE user_id=$1 AND thread_id=$2`,
    [userId, threadId, hoursDelay],
  );
  console.log(`[ig:followup:u${userId}] scheduled follow-up #${count + 1} for ${threadId} in ${hoursDelay}h`);
}

// Cancel pending follow-up (called when counterpart replies).
async function cancelFollowUp(userId: number, threadId: string) {
  await query(
    `UPDATE ig_threads SET follow_up_at=NULL, follow_up_count=0 WHERE user_id=$1 AND thread_id=$2 AND follow_up_at IS NOT NULL`,
    [userId, threadId],
  );
}

// Run follow-up: build agent reply with "follow-up" hint. Skips if agent
// outputs SKIP (e.g. inappropriate to nudge).
async function runFollowUp(userId: number, threadId: string) {
  const r = await query<{ auto_responder_goal: string | null; follow_up_count: number }>(
    `SELECT auto_responder_goal, follow_up_count FROM ig_threads WHERE user_id=$1 AND thread_id=$2`,
    [userId, threadId],
  );
  const goal = r[0]?.auto_responder_goal ?? undefined;
  const count = r[0]?.follow_up_count ?? 0;
  emitActivity(userId, threadId, 'thinking', `Formulo follow-up #${count + 1}…`);
  const hint = `Stai inviando un FOLLOW-UP perché la controparte non ha risposto al tuo messaggio precedente. Tono naturale, breve, NON insistente. Riprendi il filo senza far pesare il silenzio. Se ritieni che NON sia opportuno scrivere ancora (es. interlocutore manifestamente disinteressato, troppi nudge già fatti), output \`SKIP\`. Sei al follow-up numero ${count + 1} su 3.`;
  const sugg = await suggestIgReply(userId, threadId, { goal, hint });
  if (!sugg.ok || !sugg.draft || /^SKIP\b/i.test(sugg.draft.trim())) {
    emitActivity(userId, threadId, 'waiting', 'Salto follow-up.');
    // Mark as done so we don't re-fire endlessly.
    await query(`UPDATE ig_threads SET follow_up_at=NULL WHERE user_id=$1 AND thread_id=$2`, [userId, threadId]);
    return;
  }
  emitActivity(userId, threadId, 'sending', 'Invio follow-up…');
  const sent = await sendIgMessage(userId, threadId, sugg.draft, `autoresponder-followup-${count + 1}`, 'ai');
  if (sent.ok) {
    emitActivity(userId, threadId, 'sent', `Follow-up #${count + 1} inviato.`);
    await query(`UPDATE ig_threads SET follow_up_count=follow_up_count+1 WHERE user_id=$1 AND thread_id=$2`, [userId, threadId]);
    await scheduleFollowUp(userId, threadId);
  } else {
    emitActivity(userId, threadId, 'error', sent.error || 'Invio fallito.');
    await query(`UPDATE ig_threads SET follow_up_at=NULL WHERE user_id=$1 AND thread_id=$2`, [userId, threadId]);
  }
}

// Cron tick — invoked from scheduler. Walks due follow-ups and fires them.
export async function tickIgFollowUps() {
  const due = await query<{ user_id: number; thread_id: string }>(
    `SELECT user_id::int, thread_id FROM ig_threads
     WHERE auto_responder=true AND follow_up_at IS NOT NULL AND follow_up_at <= now()`,
  );
  for (const row of due) {
    try { await runFollowUp(row.user_id, row.thread_id); } catch (e) { console.error('[ig:followup]', e); }
  }
}

// Helper to emit activity status on the realtime bus. Frontend drawer listens
// and shows "sto leggendo / sto scrivendo / sto inviando / attendo".
function emitActivity(userId: number, threadId: string, kind: 'reading' | 'thinking' | 'sending' | 'sent' | 'waiting' | 'error', label?: string) {
  bus.emit('ig:activity', { userId, threadId, kind, label: label ?? '', ts: new Date().toISOString() });
}

// Auto-responder: agent watches incoming DMs on this thread and replies
// automatically, steering conversation toward `goal`. Set goal=null to disable.
// When enabled, fires a kickoff worker that reads the existing transcript and,
// if appropriate, sends an opening message so the user doesn't need to seed it.
export async function setThreadAutoResponder(userId: number, threadId: string, enabled: boolean, goal?: string | null): Promise<{ ok: boolean }> {
  await query(
    `INSERT INTO ig_threads(user_id, thread_id, auto_responder, auto_responder_goal, updated_at)
     VALUES($1,$2,$3,$4, now())
     ON CONFLICT(user_id, thread_id) DO UPDATE
       SET auto_responder=EXCLUDED.auto_responder,
           auto_responder_goal=EXCLUDED.auto_responder_goal,
           updated_at=now()`,
    [userId, threadId, !!enabled, enabled ? (goal ?? null) : null],
  );
  // Kickoff: agent reads transcript + decides whether to seed the conversation.
  if (enabled && goal) {
    setImmediate(() => runAutoResponderKickoff(userId, threadId, goal).catch((e) => console.error('[ig:kickoff]', e)));
  }
  return { ok: true };
}

async function runAutoResponderKickoff(userId: number, threadId: string, goal: string) {
  emitActivity(userId, threadId, 'reading', 'Leggo la conversazione…');
  // Check if anyone has talked recently — if last message was very recent and
  // not from me, the normal autoResponder listener will handle it.
  const recent = await query<{ from_me: boolean; ts: string }>(
    `SELECT from_me, ts FROM ig_messages WHERE user_id=$1 AND thread_id=$2 ORDER BY ts DESC LIMIT 1`,
    [userId, threadId],
  );
  const last = recent[0];
  const minutesSinceLast = last ? (Date.now() - new Date(last.ts).getTime()) / 60_000 : Infinity;
  // If counterpart just spoke (<2min) and not me, listener will reply → noop.
  if (last && !last.from_me && minutesSinceLast < 2) {
    emitActivity(userId, threadId, 'waiting', 'Risposta gestita dal listener.');
    return;
  }
  emitActivity(userId, threadId, 'thinking', 'Decido se aprire la conversazione…');
  // Build kickoff hint
  const hint = `Stai ATTIVANDO ora l'auto-responder su questa conversazione. Sei tu a dover iniziare/riprendere il flusso verso l'obiettivo. Manda UN messaggio di apertura naturale, breve, che riconosca dove eravamo rimasti (se transcript esiste) e che inizi a portare verso il goal. Se la conversazione è chiusa da molto tempo, riapri in modo non invadente. Se NON ha senso scrivere ora (es. ultimo messaggio MIO e non ancora risposto), output \`SKIP\`.`;
  const sugg = await suggestIgReply(userId, threadId, { goal, hint });
  if (!sugg.ok || !sugg.draft || /^SKIP\b/i.test(sugg.draft.trim())) {
    emitActivity(userId, threadId, 'waiting', sugg.draft && /SKIP/i.test(sugg.draft) ? 'Aspetto un suo messaggio.' : (sugg.error || 'Nessuna bozza generata.'));
    return;
  }
  emitActivity(userId, threadId, 'sending', 'Invio messaggio di apertura…');
  const sent = await sendIgMessage(userId, threadId, sugg.draft, 'autoresponder-kickoff', 'ai');
  if (sent.ok) {
    emitActivity(userId, threadId, 'sent', 'Apertura inviata.');
    await scheduleFollowUp(userId, threadId);
  } else emitActivity(userId, threadId, 'error', sent.error || 'Invio fallito.');
}

export async function listThreads(userId: number): Promise<any[]> {
  const rows = await query<any>(
    `WITH last_per_thread AS (
       SELECT DISTINCT ON (thread_id) thread_id, text, ts, from_me, sender_username, sender_name
       FROM ig_messages WHERE user_id=$1 ORDER BY thread_id, ts DESC
     ),
     stats AS (
       SELECT thread_id,
              count(*) FILTER (WHERE text <> '')::int AS total,
              count(*) FILTER (WHERE text <> '' AND processed_at IS NOT NULL)::int AS bonified,
              count(*) FILTER (WHERE text <> '' AND processed_at IS NULL AND NOT from_me)::int AS pending
       FROM ig_messages WHERE user_id=$1 GROUP BY thread_id
     )
     SELECT t.thread_id, t.title, t.is_group, t.participants, t.last_activity, t.auto_bonify, t.auto_responder, t.auto_responder_goal,
            l.text AS last_text, l.ts AS last_ts, l.from_me AS last_from_me,
            COALESCE(s.total, 0) AS total_count,
            COALESCE(s.bonified, 0) AS bonified_count,
            COALESCE(s.pending, 0) AS pending_count
     FROM ig_threads t
     LEFT JOIN last_per_thread l ON l.thread_id = t.thread_id
     LEFT JOIN stats s ON s.thread_id = t.thread_id
     WHERE t.user_id=$1
     ORDER BY COALESCE(l.ts, t.last_activity) DESC NULLS LAST`,
    [userId],
  );
  return rows;
}

export async function threadMessages(userId: number, threadId: string, limit = 200): Promise<any[]> {
  const rows = await query<any>(
    `SELECT id::int, msg_id, thread_id, sender_ig_id, sender_username, sender_name, person_slug, from_me, text, item_type, ts, source
     FROM ig_messages WHERE user_id=$1 AND thread_id=$2
     ORDER BY ts DESC LIMIT $3`,
    [userId, threadId, limit],
  );
  return rows.reverse();
}

export async function pendingCount(userId: number): Promise<number> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ig_messages WHERE user_id=$1 AND processed_at IS NULL AND text <> '' AND NOT from_me`,
    [userId],
  );
  return rows[0]?.n ?? 0;
}

export async function bonifyIgMessages(userId: number, opts: { limit?: number; onlyThread?: string } = {}): Promise<{ ok: boolean; processed: number; runId?: number; cost?: number; error?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 5000);
  const whereT = opts.onlyThread ? 'AND thread_id=$3' : '';
  const params: any[] = [userId, limit];
  if (opts.onlyThread) params.push(opts.onlyThread);
  const rows = await query<any>(
    `SELECT id::int, msg_id, thread_id, sender_ig_id, sender_username, sender_name, person_slug, text, ts
     FROM ig_messages
     WHERE user_id=$1 AND processed_at IS NULL AND text <> '' AND NOT from_me
     ${whereT} ORDER BY ts ASC LIMIT $2`,
    params,
  );
  if (rows.length === 0) return { ok: true, processed: 0 };
  bus.emit('ig:bonify', { userId, kind: 'start', total: rows.length, onlyThread: opts.onlyThread ?? null });
  const { runClaude } = await import('../../../claude/runner.js');
  const { getVaultRoot } = await import('../../../brain/vault.js');
  const { buildScheduledTaskContext } = await import('../../../claude/prompts.js');
  const sys = await buildScheduledTaskContext(userId);
  const vault = await getVaultRoot(userId);
  const batch = rows.map((r) => ({
    id: r.id, thread: r.thread_id, sender: r.sender_name ?? r.sender_username,
    username: r.sender_username, person_slug: r.person_slug, ts: r.ts,
    text: (r.text ?? '').slice(0, 800),
  }));
  const prompt = `${sys}\n\n=== BONIFICA INSTAGRAM DM — BATCH DI ${batch.length} MESSAGGI ===\n\nDati grezzi:\n\`\`\`json\n${JSON.stringify(batch, null, 2)}\n\`\`\`\n\nFAI:\n1. Per ogni messaggio, classifica per rilevanza (skip spam, mass DM, follower bot, broadcast).\n2. Aggrega per persona/conversazione. Usa upsert su People (tag con \`instagram\` = username) se manca.\n3. Per ogni persona con messaggi significativi, scrivi/aggiorna nota in \`people/<slug>.md\` con sezione \"## Instagram DM — <data>\" con contesto + topic + azioni.\n4. NON scrivere una nota per ogni singolo messaggio. Aggrega.\n5. NON inviare nulla all'utente via Telegram. Lavora silenzioso.\n\nOUTPUT: \`SKIP\` + 1-3 righe riepilogo. NIENTE narrazione.`;
  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(), timeoutMs: 900_000, kind: 'instagram-bonifica',
    meta: { count: batch.length, onlyThread: opts.onlyThread ?? null },
  });
  if (!res.ok) {
    bus.emit('ig:bonify', { userId, kind: 'error', total: rows.length, error: res.stderr?.slice(0, 300) });
    return { ok: false, processed: 0, runId: res.runId, cost: res.costUsd, error: res.stderr?.slice(0, 300) };
  }
  const ids = rows.map((r) => r.id);
  await query(`UPDATE ig_messages SET processed_at=now() WHERE user_id=$1 AND id = ANY($2::int[])`, [userId, ids]);
  bus.emit('ig:bonify', { userId, kind: 'done', processed: ids.length, runId: res.runId, cost: res.costUsd, durationMs: res.durationMs });
  return { ok: true, processed: ids.length, runId: res.runId, cost: res.costUsd };
}

export async function suggestIgReply(userId: number, threadId: string, opts: { hint?: string; goal?: string } = {}): Promise<{ ok: boolean; draft?: string; error?: string }> {
  const msgs = await query<any>(
    `SELECT sender_username, sender_name, person_slug, from_me, text, ts
     FROM ig_messages WHERE user_id=$1 AND thread_id=$2 AND text <> ''
     ORDER BY ts DESC LIMIT 30`,
    [userId, threadId],
  );
  if (!msgs.length) return { ok: false, error: 'no messages in thread' };
  msgs.reverse();
  const last = msgs[msgs.length - 1];
  const personSlug = last.person_slug ?? msgs.find((m: any) => m.person_slug)?.person_slug;
  const senderName = last.sender_name ?? last.sender_username ?? 'utente';
  let personContext = '';
  if (personSlug) {
    try {
      const { readNote } = await import('../../../brain/vault.js');
      const note = await readNote(userId, `people/${personSlug}.md`);
      if (note?.content) personContext = note.content.slice(0, 6000);
    } catch {}
  }
  const transcript = msgs.map((m: any) =>
    `[${new Date(m.ts).toLocaleString('it-IT')}] ${m.from_me ? 'TU' : (m.sender_name ?? m.sender_username)}: ${m.text}`,
  ).join('\n');
  const { runClaude } = await import('../../../claude/runner.js');
  const { getVaultRoot } = await import('../../../brain/vault.js');
  const { buildScheduledTaskContext } = await import('../../../claude/prompts.js');
  const sys = await buildScheduledTaskContext(userId);
  const vault = await getVaultRoot(userId);
  const goalBlock = opts.goal ? `\n🎯 OBIETTIVO della conversazione: ${opts.goal}\nOgni risposta deve avvicinare a questo obiettivo SENZA risultare forzata o di vendita aggressiva. Naturale.\n` : '';
  const prompt = `${sys}\n\n=== SUGGERISCI RISPOSTA INSTAGRAM DM ===\n\nDestinatario: ${senderName}${personSlug ? ` (slug: ${personSlug})` : ''}.\nThread: ${threadId}.${goalBlock}\n\n${personContext ? `CONTESTO PERSONA (dal second brain):\n\`\`\`\n${personContext}\n\`\`\`\n\n` : ''}TRANSCRIPT ULTIMI ${msgs.length} MESSAGGI:\n\`\`\`\n${transcript}\n\`\`\`\n\n${opts.hint ? `HINT UTENTE: ${opts.hint}\n\n` : ''}REGOLE:\n- Rispondi all'ULTIMO messaggio.\n- Mirror del tone usato dall'utente nei suoi messaggi precedenti.\n- Italiano informale ma asciutto. NO emoji a raffica. NO markdown.\n- Lunghezza simile ai messaggi precedenti dell'utente.\n- Se manca contesto: output solo \`MISSING_CONTEXT: <cosa serve>\`.\n\nOUTPUT: solo il testo della risposta. Niente preamboli.`;
  const res = await runClaude(userId, prompt, {
    cwd: vault ?? process.cwd(), timeoutMs: 120_000, kind: 'ig-suggest-reply', meta: { threadId, personSlug },
  });
  if (!res.ok) return { ok: false, error: res.stderr?.slice(0, 300) };
  const draft = res.text.trim();
  if (!draft || /^MISSING_CONTEXT:/i.test(draft)) return { ok: false, error: draft || 'empty' };
  return { ok: true, draft };
}

const connector: Connector = {
  manifest: {
    name: 'instagram',
    title: 'Instagram DM (Playwright)',
    description: 'Legge e risponde ai DM Instagram via browser headless Chromium. Username/password come prima — niente fingerprint API da unofficial client.',
    configSchema: [],
  },
  tools: [
    {
      name: 'status',
      description: 'Stato della sessione Instagram (idle/2fa/checkpoint/connected).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => getIgStatus(ctx.userId),
    },
    {
      name: 'list_threads',
      description: 'Lista DM Instagram recenti (anche NON bonificati).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'number', default: 50 } },
        additionalProperties: false,
      },
      handler: async (ctx, { query: q, limit }) => {
        const all = await listThreads(ctx.userId);
        const filtered = q ? all.filter((t: any) => (t.title || '').toLowerCase().includes(String(q).toLowerCase())) : all;
        return filtered.slice(0, limit ?? 50);
      },
    },
    {
      name: 'thread_messages',
      description: 'Leggi messaggi raw di un thread Instagram.',
      inputSchema: {
        type: 'object',
        properties: { thread_id: { type: 'string' }, limit: { type: 'number', default: 100 } },
        required: ['thread_id'], additionalProperties: false,
      },
      handler: async (ctx, { thread_id, limit }) => threadMessages(ctx.userId, thread_id, Math.min(Number(limit ?? 100), 500)),
    },
    {
      name: 'search_messages',
      description: 'Cerca testo full-text nei DM Instagram raw.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, since_days: { type: 'number', default: 30 }, limit: { type: 'number', default: 30 } },
        required: ['query'], additionalProperties: false,
      },
      handler: async (ctx, { query: q, since_days, limit }) => {
        const rows = await query<any>(
          `SELECT m.thread_id, t.title AS thread_title, m.sender_username, m.sender_name, m.from_me, m.text, m.ts, m.person_slug
           FROM ig_messages m
           LEFT JOIN ig_threads t ON t.user_id=$1 AND t.thread_id=m.thread_id
           WHERE m.user_id=$1 AND m.text ILIKE $2 AND m.ts > now() - ($3::int || ' days')::interval
           ORDER BY m.ts DESC LIMIT $4`,
          [ctx.userId, `%${q}%`, since_days ?? 30, Math.min(Number(limit ?? 30), 200)],
        );
        return rows;
      },
    },
    {
      name: 'send_message',
      description: 'Invia un DM Instagram.',
      inputSchema: {
        type: 'object',
        properties: { thread_id: { type: 'string' }, text: { type: 'string' } },
        required: ['thread_id', 'text'], additionalProperties: false,
      },
      handler: async (ctx, { thread_id, text }) => sendIgMessage(ctx.userId, thread_id, text, 'agent', 'ai'),
    },
  ],
};

// =====================================================================
// Auto-responder dispatcher — fires on every incoming DM. If the thread has
// auto_responder=true, generates a reply via suggestIgReply (goal injected)
// and sends it. Cooldown 20s per thread to avoid loops. Skips from_me and
// MISSING_CONTEXT drafts.
// =====================================================================
const autoResponderCooldown = new Map<string, number>(); // `${userId}:${threadId}` → ts
bus.on('ig:message', async (m: any) => {
  try {
    if (!m?.userId || !m?.msg) return;
    if (m.msg.from_me) return;
    const key = `${m.userId}:${m.msg.thread_id}`;
    const last = autoResponderCooldown.get(key) ?? 0;
    if (Date.now() - last < 20_000) return;
    const rows = await query<{ auto_responder: boolean; auto_responder_goal: string | null }>(
      `SELECT auto_responder, auto_responder_goal FROM ig_threads WHERE user_id=$1 AND thread_id=$2`,
      [m.userId, m.msg.thread_id],
    );
    if (!rows[0]?.auto_responder) return;
    autoResponderCooldown.set(key, Date.now());
    const goal = rows[0].auto_responder_goal ?? undefined;
    const tid = m.msg.thread_id;
    console.log(`[ig:autoresponder:u${m.userId}] firing on ${tid} (goal=${goal ?? 'none'})`);
    emitActivity(m.userId, tid, 'reading', 'Leggo il nuovo messaggio…');
    emitActivity(m.userId, tid, 'thinking', 'Formulo risposta…');
    const sugg = await suggestIgReply(m.userId, tid, { goal });
    if (!sugg.ok || !sugg.draft) {
      console.warn(`[ig:autoresponder:u${m.userId}] suggest failed: ${sugg.error}`);
      emitActivity(m.userId, tid, 'error', sugg.error || 'Nessuna bozza.');
      return;
    }
    // Counterpart spoke → cancel any pending follow-up timer.
    await cancelFollowUp(m.userId, tid);
    emitActivity(m.userId, tid, 'sending', 'Invio risposta…');
    const sent = await sendIgMessage(m.userId, tid, sugg.draft, 'autoresponder', 'ai');
    if (!sent.ok) { console.warn(`[ig:autoresponder:u${m.userId}] send failed: ${sent.error}`); emitActivity(m.userId, tid, 'error', sent.error || 'Invio fallito.'); }
    else {
      emitActivity(m.userId, tid, 'sent', 'Risposta inviata.');
      await scheduleFollowUp(m.userId, tid);
    }
  } catch (e) { console.error('[ig:autoresponder]', e); }
});

export default connector;
