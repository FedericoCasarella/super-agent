#!/usr/bin/env node
// super-agent — reset password utente (single-user local app, no recovery flow).
// Uso:  node backend/reset-password.mjs <email> [nuovaPassword]
// Se ometti la password, te la chiede in modo nascosto (non finisce nella history).
import pg from 'pg';
import bcrypt from 'bcryptjs';
import readline from 'node:readline';

const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/polpo_brain';
const email = process.argv[2];
let pwd = process.argv[3];

if (!email) {
  console.error('Uso: node backend/reset-password.mjs <email> [nuovaPassword]');
  process.exit(1);
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // input nascosto
  const stdin = process.stdin;
  return new Promise((resolve) => {
    process.stdout.write(q);
    let val = '';
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '') {
        stdin.setRawMode?.(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); rl.close(); resolve(val);
      } else if (ch === '') { process.exit(1); }
      else if (ch === '') { val = val.slice(0, -1); }
      else { val += ch; }
    };
    stdin.on('data', onData);
  });
}

const c = new pg.Client({ connectionString: DB });
await c.connect();
const { rows } = await c.query('SELECT id, email FROM users WHERE lower(email)=lower($1)', [email]);
if (!rows[0]) { console.error(`❌ Nessun utente con email ${email} in ${DB.split('@')[1]}`); await c.end(); process.exit(1); }

if (!pwd) pwd = await ask('Nuova password (nascosta): ');
if (!pwd || pwd.length < 6) { console.error('❌ Password troppo corta (min 6).'); await c.end(); process.exit(1); }

const hash = await bcrypt.hash(pwd, 10);
await c.query('UPDATE users SET pass_hash=$1 WHERE id=$2', [hash, rows[0].id]);
await c.end();
console.log(`✅ Password aggiornata per ${rows[0].email}. Ora puoi fare login su http://localhost:5173`);
