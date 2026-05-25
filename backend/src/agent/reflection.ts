import { query, getSetting, setSetting, listActiveUsers } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { buildSystemContext } from '../claude/prompts.js';
import { sendTelegram } from '../telegram/bot.js';
import { getVaultRoot } from '../brain/vault.js';

export async function runReflectionForUser(userId: number) {
  const quiet = await getSetting<any>(userId, 'agent_quiet_until');
  if (quiet?.until && new Date(quiet.until) > new Date()) return;
  const sleep = await getSetting<any>(userId, 'agent_next_reflection_at');
  if (sleep?.until && new Date(sleep.until) > new Date()) return;
  await setSetting(userId, 'last_reflection_at', new Date().toISOString());

  const history = await query<{ direction: string; content: string; ts: string }>(
    `SELECT direction, content, ts FROM messages WHERE user_id=$1 AND channel='telegram' ORDER BY id DESC LIMIT 30`, [userId]
  );
  if (!history.length) return;

  const lastOut = history.find((m) => m.direction === 'out');
  const lastIn = history.find((m) => m.direction === 'in');
  const lastOutAt = lastOut ? new Date(lastOut.ts).getTime() : 0;
  const lastInAt = lastIn ? new Date(lastIn.ts).getTime() : 0;
  const now = Date.now();
  const userReplied = lastInAt > lastOutAt;
  const minutesSinceLastOut = lastOutAt ? Math.round((now - lastOutAt) / 60000) : null;

  const sys = await buildSystemContext(userId);
  const hist = history.slice().reverse().map((m) => `[${m.ts}] ${m.direction === 'in' ? 'USER' : m.direction === 'out' ? 'YOU' : 'SYSTEM'}: ${m.content}`).join('\n');

  const prompt = `${sys}

=== REFLECTION CYCLE ===

RECENT (last 30):
${hist}

STATE:
- user_replied_to_last: ${userReplied}
- minutes_since_last_out: ${minutesSinceLastOut ?? 'n/a'}

TASKS:

1) UPDATE PROFILE — read \`meta/user-profile.md\` (create if missing), extract communication style/insecurities/strengths/quirks. Keep <80 lines.

2) REVIEW ROADMAP — \`mcp__polpo_brain__roadmap_get\`, tick answered Discovery, draft Strategy/Execution when ready.

3) DECIDE PING — BIAS: ASK when info gap.
   a) If user said "stop/smettila" → \`agent_set_quiet\` + silent.
   b) Roadmap items with [ ] / [~] containing "unknown/TBD/?/missing" AND not asked in last 6h → PING one sharp question.
   c) Overdue deadline → flag.
   d) Discovery empty + >6h silent → ask most leveraged question (MRR or bottleneck).
   e) Otherwise silent.
   Hard rule: in_progress item with "unknown" + last 5 outbound no question on it → FAILING. PING.

4) PICK NEXT WAKE — before SKIP, call \`agent_sleep_until\`. Heuristics: post-reply 10-20min; idle 2-6h; night → next morning; deadline today 30-60min.

5) OUTPUT (strict):
   - PING: only message(s), <<MSG>> split. NO preamble.
   - SKIP: literal 4 chars S K I P. Nothing else.`;

  const vault = await getVaultRoot(userId);
  const res = await runClaude(userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 180_000, kind: 'reflection' });
  if (!res.ok) { console.log(`[reflection:u${userId}] failed`); return; }
  const out = res.text.trim();
  if (!out || /(^|\n)\s*SKIP\s*($|\n)/i.test(out) || out.toUpperCase().trim() === 'SKIP') {
    const cur = await getSetting<any>(userId, 'agent_next_reflection_at');
    if (!cur?.until || new Date(cur.until) <= new Date()) {
      const fallback = new Date(Date.now() + 30 * 60_000).toISOString();
      await setSetting(userId, 'agent_next_reflection_at', { until: fallback, reason: 'fallback', setAt: new Date().toISOString() });
    }
    return;
  }
  await setSetting(userId, 'agent_next_reflection_at', null);
  try {
    await sendTelegram(userId, out);
    await query(`INSERT INTO messages(user_id, direction, channel, content, meta) VALUES($1,'out','telegram',$2,$3)`, [userId, out, { reflection: true }]);
  } catch (e) { console.error(`[reflection:u${userId}] send`, e); }
}

export async function runReflectionAllUsers() {
  const users = await listActiveUsers();
  for (const u of users) {
    try { await runReflectionForUser(u.id); } catch (e) { console.error(`[reflection:u${u.id}]`, e); }
  }
}
