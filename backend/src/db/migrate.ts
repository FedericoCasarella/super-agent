import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pool } from './index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  // Fixups — ALTERs for tables that already exist (CREATE IF NOT EXISTS skips them).
  // mail_messages: IMAP UID is unique per FOLDER, original constraint lacked folder.
  await pool.query(`
    ALTER TABLE mail_messages DROP CONSTRAINT IF EXISTS mail_messages_user_id_account_label_uid_key;
    CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_user_acct_folder_uid_uniq
      ON mail_messages(user_id, account_label, folder, uid);
  `);
  console.log('migrate: ok');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
