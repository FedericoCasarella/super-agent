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
  return jwt.sign({ uid: user.id, email: user.email }, config.jwtSecret, { expiresIn: '30d' });
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

// Sovereign Mode — the instance owner is the first user (lowest id).
export async function getOwner(): Promise<User | null> {
  const rows = await query<User>('SELECT id::int, email, name FROM users ORDER BY id ASC LIMIT 1');
  return rows[0] ?? null;
}

// Sovereign Mode trust gate (defence-in-depth). ALL of these must hold before we
// authenticate as the owner without a token:
//  1. config.sovereign — the flag is armed (itself fail-closed to a loopback HOST).
//  2. loopback connection peer — blocks remote and reverse-proxied callers.
//  3. loopback Host header — blocks DNS-rebinding (a browser tricked into hitting
//     localhost under an attacker hostname still carries the attacker's Host).
//  4. Origin (if present) matches the trusted frontend — blocks cross-site CSRF from
//     other web pages; absent Origin = non-browser caller (curl, native) → allowed.
const LOOPBACK_PEERS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const LOOPBACK_HOSTNAMES = ['127.0.0.1', '::1', 'localhost'];
export function sovereignTrusted(req: Request): boolean {
  if (!config.sovereign) return false;
  const peer = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK_PEERS.includes(peer)) return false;
  const hostname = (req.headers.host ?? '').split(':')[0];
  if (!LOOPBACK_HOSTNAMES.includes(hostname)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== config.frontendOrigin) return false;
  return true;
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
  // Sovereign Mode — local-trust: authenticate as the owner without a token, but only
  // when every trust gate holds (flag + loopback peer + loopback Host + same-origin).
  // No owner yet → fall through to normal auth so onboarding can create one.
  if (sovereignTrusted(req)) {
    const owner = await getOwner();
    if (owner) { req.user = owner; return next(); }
  }
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
    httpOnly: true, sameSite: 'lax', secure: false,
    maxAge: 30 * 24 * 60 * 60_000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(config.cookieName, { path: '/' });
}
