// Task Supervisor — Step 1: digest mattutino.
// Legge gli stati delle task ClickUp di Marco (la verità) e manda 2 messaggi su
// Telegram alle 9:00 Lun-Ven: (1) cosa aspetta TE, per cliente, con azione;
// (2) panoramica di tutte. Zero matching, zero LLM — deterministico.
// Blueprint: vault operativo/task-supervisor-architecture.md.

import cron from 'node-cron';
import { query } from '../db/index.js';
import { isClickUpConfigured, getOpenTasks, type ClickUpTask } from '../clickup/client.js';
import { isSupervised } from './scope.js';

// Stato ClickUp → di chi è la palla (dalla call: lo stato È la verità).
const BALL: Record<string, 'te' | 'cliente' | 'luca' | 'assistenza' | 'standby'> = {
  'to do': 'te',
  'in progress': 'te',
  'mandare mex cliente': 'te',
  'waiting feedback internal': 'luca',
  'waiting feedback 3rd part': 'assistenza',
  'waiting feedback client': 'cliente',
  'standby': 'standby',
};

// Azione suggerita per le task che aspettano Marco.
const ACTION: Record<string, string> = {
  'to do': 'inizia',
  'in progress': 'completa e chiudi',
  'mandare mex cliente': 'manda update al cliente (/comunica)',
};

function clientName(listName: string): string {
  return listName.replace(/^[^\p{L}\p{N}]+/u, '').trim() || listName; // toglie l'emoji iniziale
}

function ball(status: string) { return BALL[status] ?? 'te'; }

function overdueOrToday(t: ClickUpTask, now: Date): 'scaduta' | 'oggi' | null {
  if (!t.dueDate) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t.dueDate < start) return 'scaduta';
  if (t.dueDate < start + 86400000) return 'oggi';
  return null;
}

export function buildDigest(tasks: ClickUpTask[], now: Date = new Date()): { msg1: string; msg2: string } {
  const open = tasks.filter((t) => isSupervised(t) && t.status !== 'cancelled' && t.status !== 'completato');

  // ── Msg 1 "Agisci ora" (scope Medio): mandare mex + in progress + scadute/oggi ──
  const act1 = open.filter((t) =>
    t.status === 'mandare mex cliente' ||
    t.status === 'in progress' ||
    (ball(t.status) === 'te' && overdueOrToday(t, now) !== null));

  const byClient = new Map<string, ClickUpTask[]>();
  for (const t of act1) {
    const c = clientName(t.list.name);
    const a = byClient.get(c) ?? [];
    a.push(t);
    byClient.set(c, a);
  }
  const l1: string[] = [`☀️ Buongiorno Marco. Agisci ora (${act1.length}):`];
  for (const [c, ts] of [...byClient].sort((a, b) => a[0].localeCompare(b[0]))) {
    l1.push('', `▸ ${c}`);
    for (const t of ts) {
      const due = overdueOrToday(t, now);
      const flag = due === 'scaduta' ? '⚠️ SCADUTA ' : due === 'oggi' ? '⏰ oggi ' : '';
      const act = ACTION[t.status] ? ` → ${ACTION[t.status]}` : '';
      l1.push(`   ${flag}[${t.status}] ${t.name}${act}`);
    }
  }
  if (!act1.length) l1.push('', 'Niente da agire oggi. 🎉');

  // ── Msg 2 "Panoramica": conteggi + backlog ──
  const counts: Record<string, number> = {};
  const balls: Record<string, number> = { te: 0, cliente: 0, luca: 0, assistenza: 0, standby: 0 };
  let noDue = 0, overdue = 0;
  for (const t of open) {
    counts[t.status] = (counts[t.status] ?? 0) + 1;
    balls[ball(t.status)]++;
    if (!t.dueDate) noDue++;
    else if (overdueOrToday(t, now) === 'scaduta') overdue++;
  }
  const todo = counts['to do'] ?? 0;
  const l2: string[] = [
    `📊 Panoramica — ${open.length} task aperte`,
    '',
    `Palla: te ${balls.te} · cliente ${balls.cliente} · Luca ${balls.luca} · assistenza ${balls.assistenza} · standby ${balls.standby}`,
    '',
    `Backlog: to do ${todo} · senza scadenza ${noDue} · scadute ${overdue}`,
    '',
    'Per stato:',
    ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `   ${s}: ${n}`),
  ];

  return { msg1: l1.join('\n'), msg2: l2.join('\n') };
}

export async function sendDigest(userId: number): Promise<{ ok: boolean; error?: string }> {
  if (!isClickUpConfigured()) return { ok: false, error: 'CLICKUP_API_TOKEN non configurato' };
  const tasks = await getOpenTasks();
  const { msg1, msg2 } = buildDigest(tasks);
  const { sendTelegram } = await import('../telegram/bot.js');
  await sendTelegram(userId, msg1, 'task-digest');
  await sendTelegram(userId, msg2, 'task-digest');
  return { ok: true };
}

let started = false;
export function startDigestScheduler(): void {
  if (started) return;
  started = true;
  // 9:00 Lun-Ven Europe/Rome.
  cron.schedule('0 9 * * 1-5', async () => {
    try {
      const users = await query<{ id: number }>(`SELECT id FROM users`);
      for (const u of users) await sendDigest(u.id).catch((e) => console.error('[supervisor] digest', e));
    } catch (e) { console.error('[supervisor] digest scheduler', e); }
  }, { timezone: 'Europe/Rome' });
  console.log('[supervisor] task-digest scheduler armed (9:00 Lun-Ven Europe/Rome)');
}
