import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { countUsers, createUser, getUserByEmail, getUserById, claimOrphanData, signToken, setAuthCookie, clearAuthCookie, requireUser, verifyPassword, verifyToken } from './index.js';
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

authRouter.get('/me', async (req, res) => {
  const token = (req as any).cookies?.[config.cookieName];
  if (!token) return res.json({ user: null });
  const data = verifyToken(token);
  if (!data) return res.json({ user: null });
  const user = await getUserById(data.uid);
  res.json({ user });
});

authRouter.get('/bootstrap', async (_req, res) => {
  const c = await countUsers();
  res.json({ usersExist: c > 0, count: c });
});

// One-shot initialization for fresh Polpo Brain instance. Single-user per instance
// (not a SaaS). After first user is created, this endpoint returns 409 forever.
// Onboarding wizard (frontend) is the only legitimate caller.
authRouter.post('/initialize', async (req, res) => {
  const existingCount = await countUsers();
  if (existingCount > 0) {
    return res.status(409).json({ error: 'instance already initialized — single user per Polpo Brain instance' });
  }
  const { email, password, name } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short (>= 6)' });
  const user = await createUser(email, password, name ?? null);
  await claimOrphanData(user.id);
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user, claimedOrphans: true });
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

authRouter.post('/logout', requireUser, (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});
