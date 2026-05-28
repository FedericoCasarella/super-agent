import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { countUsers, createUser, getUserByEmail, getUserById, getOwner, sovereignTrusted, claimOrphanData, signToken, setAuthCookie, clearAuthCookie, requireUser, verifyPassword, verifyToken, bumpTokenVersion } from './index.js';
import { config } from '../config.js';

export const authRouter = Router();

// H1 (sess.2818) — rate limit /login per-IP, prevent bruteforce.
// /register removed sess.2817 — Polpo Brain is not a SaaS: one user per instance,
// created via /initialize one-shot on first boot. Subsequent /initialize calls 409.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many login attempts, retry in 15 minutes' },
});
// Sess.2817 sec-review — tighter limit on /initialize (1-shot endpoint).
// Even though gated by countUsers, rate-limit prevents pre-setup DDoS + reduces
// TOCTOU race window. Schema-level unique index (users_singleton) is the real
// guarantee; this limiter is defense-in-depth.
const initializeLimiter = rateLimit({
  windowMs: 60 * 60_000,  // 1 hour
  max: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many initialize attempts, retry in 1 hour' },
});

authRouter.get('/me', async (req, res) => {
  // Sovereign Mode (sess.2839) — the owner is "logged in" on their own machine, but only
  // under the full trust gate (flag + loopback peer + loopback Host + same-origin).
  // Frontend sees user != null → enters the app, never renders the login wall.
  if (sovereignTrusted(req)) {
    const owner = await getOwner();
    return res.json({ user: owner });
  }
  const token = (req as any).cookies?.[config.cookieName];
  if (!token) return res.json({ user: null });
  const data = verifyToken(token);
  if (!data) return res.json({ user: null });
  const user = await getUserById(data.uid);
  res.json({ user });
});

authRouter.get('/bootstrap', async (req, res) => {
  const c = await countUsers();
  // per-request sovereign flag (gates checked) so the frontend can skip the login wall.
  res.json({ usersExist: c > 0, count: c, sovereign: sovereignTrusted(req) });
});

// One-shot initialization for fresh Polpo Brain instance. Single-user per instance
// (not a SaaS). After first user is created, this endpoint returns 409 forever.
// Onboarding wizard (frontend) is the only legitimate caller.
//
// Sess.2817 sec-review hardening:
//  - Schema-level unique index `users_singleton` (partial unique on TRUE) guarantees
//    at most 1 row even under concurrent /initialize calls (closes TOCTOU race).
//  - Rate limit 3/hour per IP (defense-in-depth) via initializeLimiter.
//  - Fast-path 409 if countUsers > 0 (UX), but real safety is the catch on 23505.
authRouter.post('/initialize', initializeLimiter, async (req, res) => {
  const existingCount = await countUsers();
  if (existingCount > 0) {
    return res.status(409).json({ error: 'instance already initialized — single user per Polpo Brain instance' });
  }
  const { email, password, name } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short (>= 6)' });
  try {
    const user = await createUser(email, password, name ?? null);
    await claimOrphanData(user.id);
    // merge sess.2938: adotta il seed default tasks di Federico (kickoff + evening commit)
    // dentro il nostro /initialize single-shot. Scartata la logica register (ridondante:
    // countUsers fast-path + 23505 catch garantiscono già single-user).
    try {
      const { seedDefaultTasksForUser } = await import('../scheduler/seed_tasks.js');
      const { refreshTasks } = await import('../scheduler/tasks.js');
      if (await seedDefaultTasksForUser(user.id)) await refreshTasks();
    } catch (e) { console.error('[initialize] seed tasks', e); }
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user, claimedOrphans: true });
  } catch (e: any) {
    // PostgreSQL 23505 = unique_violation. Hits either email-unique OR
    // users_singleton (concurrent /initialize race). Both → 409.
    if (e?.code === '23505') {
      return res.status(409).json({ error: 'instance already initialized — single user per Polpo Brain instance' });
    }
    throw e;
  }
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  const u = await getUserByEmail(email);
  if (!u) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await verifyPassword(password, u.pass_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const user = { id: u.id, email: u.email, name: u.name };
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user });
});

authRouter.post('/logout', requireUser, async (req, res) => {
  // Sess.2817 — bump token_version so any other live JWT for this user
  // (e.g. cookie copied to another device) is invalidated server-side.
  // Closes long-lived cookie revocation hole flagged by security-review.
  if (req.user) await bumpTokenVersion(req.user.id);
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.delete('/me', requireUser, async (req, res) => {
  const { password } = req.body ?? {};
  if (!password) return res.status(400).json({ error: 'password required' });
  const { getUserByEmail, verifyPassword } = await import('./index.js');
  const me = req.user!;
  const full = await getUserByEmail(me.email);
  if (!full) return res.status(404).json({ error: 'user not found' });
  const ok = await verifyPassword(password, full.pass_hash);
  if (!ok) return res.status(401).json({ error: 'wrong password' });

  // Stop Telegram bot before destroying DB rows
  try {
    const { stopBotForUser } = await import('../telegram/bot.js');
    await stopBotForUser(me.id);
  } catch {}

  const { query } = await import('../db/index.js');
  await query('DELETE FROM users WHERE id=$1', [me.id]);
  clearAuthCookie(res);
  res.json({ ok: true });
});
