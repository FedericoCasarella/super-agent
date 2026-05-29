import path from 'node:path';
import url from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config();

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/super_agent',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
  frontendOrigin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  rootDir: path.resolve(process.cwd()),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-change-me',
  cookieName: 'super_agent_session',
};
