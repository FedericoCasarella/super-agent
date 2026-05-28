import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/index.js';
import { config } from '../config.js';

export type User = { id: number; email: string; name: string | null; token_version?: number };

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
  // tv (token_version) is bumped on logout/password-change → server-side revocation
  // even before TTL expiry. Closes long-lived JWT hole flagged by security-review sess.2817.
  return jwt.sign(
    { uid: user.id, email: user.email, tv: user.token_version ?? 0 },
    config.jwtSecret,
    { expiresIn: '365d' }
  );
}
export function verifyToken(token: string): { uid: number; email: string; tv?: number } | null {
  try { return jwt.verify(token, config.jwtSecret) as any; } catch { return null; }
}

// Bump token_version → invalidates all JWTs issued before this point.
// Called on logout, password change, or "revoke all sessions".
export async function bumpTokenVersion(userId: number): Promise<void> {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [userId]);
}

export async function getUserById(id: number): Promise<User | null> {
  const rows = await query<User>('SELECT id::int, email, name, token_version::int AS token_version FROM users WHERE id=$1', [id]);
  return rows[0] ?? null;
}
export async function getUserByEmail(email: string): Promise<{ id: number; email: string; pass_hash: string; name: string | null; token_version: number } | null> {
  const rows = await query<any>('SELECT id::int, email, pass_hash, name, token_version::int AS token_version FROM users WHERE lower(email)=lower($1)', [email]);
  return rows[0] ?? null;
}

export async function countUsers(): Promise<number> {
  const rows = await query<{ c: number }>('SELECT count(*)::int AS c FROM users');
  return rows[0]?.c ?? 0;
}

// Sovereign Mode (sess.2839) — the instance owner is the first user (lowest id).
// The single-user-per-instance invariant (users_singleton index) makes this unambiguous.
export async function getOwner(): Promise<User | null> {
  const rows = await query<User>('SELECT id::int, email, name, token_version::int AS token_version FROM users ORDER BY id ASC LIMIT 1');
  return rows[0] ?? null;
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
  // Sovereign Mode (sess.2839) — local-trust: recognize the owner without a token.
  // Gated by POLPO_SOVEREIGN=1 (default OFF). If no owner exists yet, fall through to
  // the normal flow so onboarding can create one. Remote/shared deploys keep token auth.
  if (config.sovereign) {
    const owner = await getOwner();
    if (owner) { req.user = owner; return next(); }
  }
  const token = (req as any).cookies?.[config.cookieName];
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'invalid token' });
  const user = await getUserById(data.uid);
  if (!user) return res.status(401).json({ error: 'user not found' });
  // Sess.2817 — server-side revocation: reject JWTs older than current token_version.
  // Bumped by logout/password-change. Closes long-lived cookie hole.
  const tokenTv = data.tv ?? 0;
  const currentTv = user.token_version ?? 0;
  if (tokenTv !== currentTv) return res.status(401).json({ error: 'token revoked' });
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
