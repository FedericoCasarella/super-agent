import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pool } from './index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Split a SQL script into top-level statements, respecting `$$`-dollar-quoted
// bodies (DO blocks / functions) so semicolons inside them don't split.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; buf += '$$'; i++; continue; }
    const ch = sql[i];
    if (ch === ';' && !inDollar) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);
  let failed = 0;
  // Each statement runs independently: one failure (e.g. a unique index that
  // can't be created over pre-existing duplicate data) is logged and skipped
  // instead of rolling back the entire migration. Prevents partial-schema
  // crash-loops after merges (sess.2941).
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (e: any) {
      failed++;
      console.error(`migrate: statement skipped — ${e?.message ?? e}\n  → ${stmt.slice(0, 90).replace(/\s+/g, ' ')}…`);
    }
  }
  console.log(`migrate: ok (${statements.length} statements, ${failed} skipped)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
