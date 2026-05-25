import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pool } from './index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('migrate: ok');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
