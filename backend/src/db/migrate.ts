import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pool } from './index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Split a SQL script into top-level statements. Semicolons that are not
// statement terminators are ignored: those inside `$$`-dollar-quoted bodies
// (DO blocks / function definitions) and those inside single-quoted string
// literals (with the doubled-'' escape handled). This lets each statement run
// independently instead of as one big multi-statement query.
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    // `$$` dollar-quote boundary — only meaningful outside string literals.
    if (!inString && sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      buf += '$$';
      i++; // consume the second '$'
      continue;
    }
    const ch = sql[i];
    if (!inDollar && ch === "'") {
      if (inString && sql[i + 1] === "'") {
        // Escaped quote ('') inside a string literal — keep both, stay inside.
        buf += "''";
        i++;
        continue;
      }
      inString = !inString;
      buf += ch;
      continue;
    }
    if (ch === ';' && !inDollar && !inString) {
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
  let skipped = 0;
  // Run each statement independently. A single failure — e.g. a unique index
  // that cannot be created over pre-existing duplicate rows — is logged and
  // skipped rather than rolling back the entire migration. A single rollback
  // would otherwise leave later tables uncreated and the app querying missing
  // relations on the next boot.
  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (e: any) {
      skipped++;
      console.error(`migrate: statement skipped — ${e?.message ?? e}\n  → ${stmt.slice(0, 90).replace(/\s+/g, ' ')}…`);
    }
  }
  console.log(`migrate: ok (${statements.length} statements, ${skipped} skipped)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
