import path from 'node:path';
import url from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

// Sovereign Mode — local-trust auth for a single-owner instance on the owner's own
// machine. When ON, requireUser recognizes the instance owner without a token (no login
// wall; onboarding-once). FAIL-CLOSED to loopback: refuses to boot if armed on a
// network-exposed host — otherwise it would be an auth bypass for anyone who can reach
// the port. Default OFF → token auth stays fully enforced for remote / shared deploys.
const host = process.env.HOST ?? '127.0.0.1';
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];
const sovereign = process.env.POLPO_SOVEREIGN === '1';
if (sovereign && !LOOPBACK_HOSTS.includes(host)) {
  throw new Error(
    `POLPO_SOVEREIGN=1 requires a loopback HOST (got '${host}'). Refusing to disable auth on a network interface.`
  );
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host,
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/super_agent',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  rootDir: path.resolve(process.cwd()),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-change-me',
  cookieName: 'super_agent_session',
  sovereign,
};
