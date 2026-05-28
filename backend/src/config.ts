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

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/polpo_brain',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  rootDir: path.resolve(process.cwd()),
  jwtSecret,
  isProduction,
  cookieName: 'polpo_brain_session',
  appName: 'Polpo Brain',
};
