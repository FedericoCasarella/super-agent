import { Router } from 'express';
import { countUsers, createUser, getUserByEmail, getUserById, claimOrphanData, signToken, setAuthCookie, clearAuthCookie, requireUser, verifyPassword, verifyToken } from './index.js';
import { config } from '../config.js';

export const authRouter = Router();

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

authRouter.post('/register', async (req, res) => {
  const { email, password, name } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'email + password required' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short (>= 6)' });
  const existing = await getUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'email already registered' });
  const isFirst = (await countUsers()) === 0;
  const user = await createUser(email, password, name ?? null);
  if (isFirst) await claimOrphanData(user.id);
  // Seed default daily anchor tasks (kickoff + evening commit)
  try {
    const { seedDefaultTasksForUser } = await import('../scheduler/seed_tasks.js');
    const { refreshTasks } = await import('../scheduler/tasks.js');
    if (await seedDefaultTasksForUser(user.id)) await refreshTasks();
  } catch (e) { console.error('[register] seed tasks', e); }
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ user, claimedOrphans: isFirst });
});

authRouter.post('/login', async (req, res) => {
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
