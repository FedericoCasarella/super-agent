import path from 'node:path';
import url from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

// C1 (sess.2818) — JWT_SECRET fail-fast: no hardcoded fallback in OSS repo.
// Forge with: openssl rand -base64 32
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error(
    'JWT_SECRET env var is required (>=32 chars). Generate one with: openssl rand -base64 32'
  );
}

const isProduction = process.env.NODE_ENV === 'production';

// Sovereign Mode (sess.2839) — local-trust auth for the sovereign owner.
// When ON, requireUser recognizes the instance owner WITHOUT a token: no login wall,
// onboarding-once instead. Default OFF → token auth stays fully intact for remote /
// shared deploys (Federico, student forks). A personal AI on your own machine has no
// "other" to lock out — see vault neuron "Sovereign Mode — Auth per AI Personale vs SaaS".
// FAIL-CLOSED to loopback: refuse to boot if armed on a network-exposed host —
// otherwise sovereign mode would be an auth bypass for anyone who can reach the port.
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
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/polpo_brain',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  rootDir: path.resolve(process.cwd()),
  jwtSecret,
  isProduction,
  sovereign,
  cookieName: 'polpo_brain_session',
  appName: 'Polpo Brain',
};
