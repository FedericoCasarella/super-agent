import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/index.js';
import { config } from '../config.js';

export type User = { id: number; email: string; name: string | null };

declare module 'express-serve-static-core' {
  interface Request { user?: User; }
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function signToken(user: User): string {
  // Sess.2817 — Polpo Brain is single-user per instance + local-trust device.
  // 365d TTL: Mattia's master instance and student forks should not see /login
  // friction across normal usage. Cookie httpOnly + sameSite still protect from XSS/CSRF.
  return jwt.sign({ uid: user.id, email: user.email }, config.jwtSecret, { expiresIn: '365d' });
}
export function verifyToken(token: string): { uid: number; email: string } | null {
  try { return jwt.verify(token, config.jwtSecret) as any; } catch { return null; }
}

export async function getUserById(id: number): Promise<User | null> {
  const rows = await query<User>('SELECT id::int, email, name FROM users WHERE id=$1', [id]);
  return rows[0] ?? null;
}
export async function getUserByEmail(email: string): Promise<{ id: number; email: string; pass_hash: string; name: string | null } | null> {
  const rows = await query<any>('SELECT id::int, email, pass_hash, name FROM users WHERE lower(email)=lower($1)', [email]);
  return rows[0] ?? null;
}

export async function countUsers(): Promise<number> {
  const rows = await query<{ c: number }>('SELECT count(*)::int AS c FROM users');
  return rows[0]?.c ?? 0;
}

export async function createUser(email: string, password: string, name: string | null): Promise<User> {
  const hash = await hashPassword(password);
  const rows = await query<User>(
    `INSERT INTO users(email, pass_hash, name) VALUES($1,$2,$3) RETURNING id::int, email, name`,
    [email.trim(), hash, name]
  );
  return rows[0];
}

// On first user, claim all legacy rows (user_id IS NULL) for that user.
export async function claimOrphanData(userId: number): Promise<void> {
  for (const table of ['settings', 'messages', 'connectors', 'brain_index', 'people', 'agent_runs', 'scheduled_tasks', 'jobs']) {
    try { await query(`UPDATE ${table} SET user_id=$1 WHERE user_id IS NULL`, [userId]); } catch (e) { console.error(`[auth] claim ${table}`, e); }
  }
}

export async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = (req as any).cookies?.[config.cookieName];
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'invalid token' });
  const user = await getUserById(data.uid);
  if (!user) return res.status(401).json({ error: 'user not found' });
  req.user = user;
  next();
}

export function setAuthCookie(res: Response, token: string) {
  res.cookie(config.cookieName, token, {
    // C3 (sess.2818) — secure flag gated on NODE_ENV=production.
    // In dev (HTTP localhost) secure:true would prevent cookie set entirely.
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: 365 * 24 * 60 * 60_000,  // 1 year — sess.2817 single-user persistent login
    path: '/',
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(config.cookieName, { path: '/' });
}
