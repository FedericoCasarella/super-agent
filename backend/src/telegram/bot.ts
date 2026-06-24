import { Telegraf } from 'telegraf';
import { getSetting, setSetting, query } from '../db/index.js';
import { bus } from '../bus.js';

type BotEntry = { bot: Telegraf; token: string };
const bots = new Map<number, BotEntry>(); // userId → bot
// In-flight start dedupe: eager startAllTelegramBots() and lazy start-on-send
// can race during boot, both passing the bots.get() guard before either sets
// the entry → two Telegraf instances polling the same token → permanent 409.
// Coalesce concurrent starts for a user onto a single promise.
const starting = new Map<number, Promise<void>>(); // userId → in-flight start

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SENTINEL = '\x01';

function toTelegramHtml(raw: string): string {
  const blocks: string[] = [];
  const wrap = (html: string) => {
    blocks.push(html);
    return `${SENTINEL}${blocks.length - 1}${SENTINEL}`;
  };
  // Pre-pass: mask existing markdown links FIRST so the bare-URL autolinker
  // doesn't double-wrap them. Without this, `[name](http://x)` becomes
  // `[name]([http://x](http://x))` → garbage href + trailing `)` leaks.
  let pre = raw.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => wrap(`<a href="${url}">${escapeHtml(label)}</a>`));
  // Merge "filename + URL on next line" into a single markdown link.
  pre = pre.replace(
    /(^|\n)([ \t]*[-*•]?[ \t]*)([^\s\n][^\n]*?)\n[ \t]+(https?:\/\/\S+)/g,
    (_m, lead, bullet, label, url) => `${lead}${bullet}` + wrap(`<a href="${url}">${escapeHtml(label.trim())}</a>`),
  );
  // Auto-link bare URLs (not inside an already-masked link block).
  pre = pre.replace(/(^|[\s])(https?:\/\/[^\s<>]+)/g, (_m, lead, url) => `${lead}` + wrap(`<a href="${url}">${escapeHtml(url)}</a>`));
  // Telegram aggressively autodetects bare `.md` strings as `.md` (Moldova
  // TLD) domains. Wrap any leftover `*.md` filename in <code> so it stays
  // inert. Skip ones already inside a sentinel block (already linked).
  pre = pre.replace(/\b([A-Za-z0-9_-][A-Za-z0-9_./-]{2,})\.md\b/g, (m, _name) => {
    if (m.includes(SENTINEL)) return m;
    return wrap(`<code>${escapeHtml(m)}</code>`);
  });
  let s = pre.replace(/```([\s\S]*?)```/g, (_m, code) => wrap(`<pre>${escapeHtml(code)}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => wrap(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^\n*]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_([^\n_]+)_/g, '$1<i>$2</i>');
  const re = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  s = s.replace(re, (_m, i) => blocks[Number(i)]);
  return s;
}

function startBotForUser(userId: number): Promise<void> {
  const inflight = starting.get(userId);
  if (inflight) return inflight;
  const p = _startBotForUser(userId).finally(() => starting.delete(userId));
  starting.set(userId, p);
  return p;
}

async function _startBotForUser(userId: number) {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token) return;
  const existing = bots.get(userId);
  if (existing && existing.token === cfg.token) return;
  await stopBotForUser(userId);
  const bot = new Telegraf(cfg.token);

  // Explicit /start handler — Telegraf treats /start as a command and may
  // bypass generic on('message') depending on update type / entities.
  // /agents command — show active sub-agents
  // Catalog of agent-supported slash commands. Single source of truth — used
  // both to wire handlers and to populate Telegram's native /-menu via
  // setMyCommands at launch.
  const COMMAND_CATALOG: Array<{ command: string; description: string }> = [
    { command: 'start',   description: 'Collega questa chat al tuo agent' },
    { command: 'help',    description: 'Mostra i comandi disponibili' },
    { command: 'agents',  description: 'Lista sub-agent in esecuzione' },
    { command: 'status',  description: 'Stato agent: quota, agent attivi, ultima riflessione' },
    { command: 'tasks',   description: 'Task schedulati attivi' },
    { command: 'think',   description: 'Butta un pensiero: lo analizzo e lo collego al second brain' },
    { command: 'thoughts',description: 'Pensieri di oggi · on/off per la modalità diario' },
    { command: 'reset',   description: 'Pulisci la cronologia conversazione (ultimi 30 msg)' },
    { command: 'stop',    description: 'Mette in pausa le risposte automatiche' },
    { command: 'resume',  description: 'Riprende le risposte automatiche' },
  ];

  bot.command('help', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    const body = COMMAND_CATALOG.map((c) => `/${c.command} — ${c.description}`).join('\n');
    await ctx.reply(`🤖 Comandi disponibili:\n\n${body}`);
  });

  // ── Thought Analyzer (sess.8266) ───────────────────────────────────────────
  // Cattura DB-first (ack istantaneo), poi analisi leggera asincrona che non blocca.
  const captureAndReply = async (ctx: any, text: string) => {
    const { captureThought, analyzeThoughtLight, lightReplyLine } = await import('../brain/thoughts.js');
    let id: number;
    try {
      ({ id } = await captureThought(userId, text, 'telegram'));
    } catch (e: any) {
      await ctx.reply(`⚠️ Non sono riuscito a salvare il pensiero: ${String(e?.message ?? e).slice(0, 120)}`).catch(() => {});
      return;
    }
    await ctx.reply('🐙 Salvato.').catch(() => {});
    // Analisi leggera in background — l'ack non aspetta mai l'LLM.
    (async () => {
      const stop = await startTyping(userId).catch(() => (() => {}));
      try {
        const r = await analyzeThoughtLight(userId, id, text);
        if (r.ok && r.analysis) await sendTelegram(userId, lightReplyLine(r.analysis), 'thought');
      } catch (e) { console.error('[thoughts] capture analyze failed', e); }
      finally { try { stop(); } catch {} }
    })();
  };

  bot.command('think', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    const text = ctx.message.text.replace(/^\/think(@\S+)?/, '').trim();
    if (!text) { await ctx.reply('🐙 Scrivi il pensiero dopo /think, oppure /thoughts on per la modalità diario.'); return; }
    await captureAndReply(ctx, text);
  });

  bot.command('thoughts', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    const arg = ctx.message.text.replace(/^\/thoughts(@\S+)?/, '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await setSetting(userId, 'thought_mode', arg === 'on');
      await ctx.reply(arg === 'on'
        ? '🐙 Thought-mode ON — ogni messaggio diventa un pensiero analizzato. /thoughts off per tornare alla chat.'
        : '🐙 Thought-mode OFF — torno l\'agente conversazionale.');
      return;
    }
    const { thoughtsToday } = await import('../brain/thoughts.js');
    const list = await thoughtsToday(userId);
    if (!list.length) { await ctx.reply('🐙 Nessun pensiero oggi. Buttane uno con /think, o /thoughts on per la modalità diario.'); return; }
    const lines = list.map((t, i) => {
      const hhmm = new Date(t.ts).toISOString().slice(11, 16);
      const tag = t.themes?.length ? ` · ${t.themes.join('/')}` : (t.analyzed ? '' : ' · …');
      return `${i + 1}. [${hhmm}] ${t.text.slice(0, 80)}${tag}`;
    });
    const mode = await getSetting<boolean>(userId, 'thought_mode');
    await ctx.reply(`🐙 Pensieri di oggi (${list.length})${mode ? ' · mode ON' : ''}:\n\n${lines.join('\n')}`);
  });

  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { isQuotaLocked } = await import('../quota.js');
      const { listActive } = await import('../sub_agents/index.js');
      const active = await listActive(userId);
      const paused = (await getSetting<any>(userId, 'agent_paused'))?.value === true;
      const lastReflection = (await getSetting<any>(userId, 'agent_next_reflection_at'))?.at;
      const quotaIcon = isQuotaLocked() ? '🚫 lock' : '✅ ok';
      const pauseIcon = paused ? '⏸ in pausa' : '▶️ attivo';
      const lines = [
        `Quota: ${quotaIcon}`,
        `Stato: ${pauseIcon}`,
        `Sub-agent attivi: ${active.length}`,
        lastReflection ? `Prossima riflessione: ${new Date(lastReflection).toLocaleString('it-IT')}` : 'Riflessione: nessuna pianificata',
      ];
      await ctx.reply(`📊 Status\n\n${lines.join('\n')}`);
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  });

  bot.command('tasks', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { query } = await import('../db/index.js');
      const rows = await query<{ id: number; title: string; cron: string; next_run_at: string | null; enabled: boolean }>(
        `SELECT id::int, title, cron, next_run_at, enabled
           FROM scheduled_tasks WHERE user_id=$1 AND enabled=true
          ORDER BY next_run_at NULLS LAST LIMIT 20`,
        [userId],
      );
      if (!rows.length) { await ctx.reply('Nessun task schedulato attivo.'); return; }
      const lines = rows.map((r, i) => {
        const next = r.next_run_at ? new Date(r.next_run_at).toLocaleString('it-IT') : 'n/a';
        return `${i + 1}. ${r.title}\n   ⏰ ${r.cron} · prox ${next}`;
      });
      await ctx.reply(`📅 Task attivi (${rows.length}):\n\n${lines.join('\n\n')}`);
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  });

  bot.command('reset', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { query } = await import('../db/index.js');
      const r = await query<{ n: number }>(
        `WITH d AS (
           DELETE FROM messages
           WHERE id IN (
             SELECT id FROM messages
             WHERE user_id=$1 AND channel='telegram'
             ORDER BY id DESC LIMIT 30
           )
           RETURNING 1
         ) SELECT count(*)::int AS n FROM d`,
        [userId],
      );
      await ctx.reply(`🧹 Cronologia cancellata (${r[0]?.n ?? 0} msg). Prossimo messaggio parte da contesto pulito.`);
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  });

  bot.command('stop', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    await setSetting(userId, 'agent_paused', { value: true, at: new Date().toISOString() });
    await ctx.reply('⏸ Risposte automatiche in pausa. Usa /resume per riprenderle.');
  });

  bot.command('resume', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    await setSetting(userId, 'agent_paused', { value: false, at: new Date().toISOString() });
    await ctx.reply('▶️ Risposte automatiche riattivate.');
  });

  bot.command('agents', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { listActive } = await import('../sub_agents/index.js');
      const active = await listActive(userId);
      if (!active.length) { await ctx.reply('Nessun sub-agent in esecuzione.'); return; }
      const lines = active.map((s, i) => `${i + 1}. **${s.title}** — ${s.status === 'running' ? '⚡ in corso' : '⏳ in coda'}\n   _${(s.brief ?? '').slice(0, 120)}_`);
      await ctx.reply(`🤖 ${active.length} agent${active.length > 1 ? 'i' : 'e'} attivo${active.length > 1 ? 'i' : ''}:\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' as any });
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  });

  // The "arm": draft client update messages from the ClickUp "mandare mex
  // cliente" pile. On-demand — Marco runs it when he wants to clear the pile.
  bot.command('comunica', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      await ctx.reply('📨 Controllo le task in "mandare mex cliente"…');
      const { proposeClientMessages } = await import('../arm/client_messages.js');
      const r = await proposeClientMessages(userId);
      const parts = [`Bozze pronte: ${r.created}`];
      if (r.held) parts.push(`in attesa di mappatura gruppo: ${r.held}`);
      if (r.skipped) parts.push(`clienti non in mappa: ${r.skipped}`);
      if (!r.created && !r.held) parts.push('niente da comunicare.');
      await ctx.reply(`✅ ${parts.join(' · ')}`);
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  });

  // Task Supervisor: digest on-demand (stesso contenuto del digest 9:00).
  bot.command('digest', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { sendDigest } = await import('../supervisor/task_digest.js');
      const r = await sendDigest(userId);
      if (!r.ok) await ctx.reply(`Errore: ${r.error}`);
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  });

  // Task Supervisor: nudge on-demand (task ferme oltre soglia).
  bot.command('nudge', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    try {
      const { sendNudges } = await import('../supervisor/nudge.js');
      const r = await sendNudges(userId);
      if (r.ok && r.count === 0) await ctx.reply('Nessuna task ferma oltre soglia. 👍');
    } catch (e: any) {
      await ctx.reply(`Errore: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  });

  // Interruttore auto-follow-up al cliente (step 2b).
  bot.command('followups', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (cur?.chatId !== chatId) return;
    const arg = (ctx.message as any)?.text?.split(/\s+/)[1]?.toLowerCase();
    if (arg === 'on' || arg === 'off') {
      await setSetting(userId, 'autofollowup', { enabled: arg === 'on' });
      await ctx.reply(arg === 'on' ? '✅ Auto-follow-up al cliente ATTIVO.' : '⏸ Auto-follow-up al cliente DISATTIVATO (i solleciti li gestisci tu).');
    } else {
      const s = await getSetting<{ enabled?: boolean }>(userId, 'autofollowup');
      const on = s?.enabled !== false;
      await ctx.reply(`Auto-follow-up al cliente: ${on ? 'ATTIVO' : 'disattivato'}. Usa /followups on | off.`);
    }
  });

  // Inline keyboard callback — approve/deny proposals + email drafts
  bot.on('callback_query', async (ctx) => {
    const cq: any = ctx.callbackQuery;
    const data: string = cq?.data ?? '';
    // Proposals (sub-agents)
    let m = data.match(/^proposal:(\d+):(approve|deny)$/);
    if (m) {
      const proposalId = Number(m[1]);
      const action = m[2];
      try {
        const subAgents = await import('../sub_agents/index.js');
        if (action === 'approve') {
          const spawned = await subAgents.approveProposal(userId, proposalId);
          await ctx.answerCbQuery(`✅ ${spawned.length} agent lanciat${spawned.length > 1 ? 'i' : 'o'}`);
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText(`✅ Approvato. ${spawned.length} agent in esecuzione.`); } catch {}
        } else {
          await subAgents.denyProposal(userId, proposalId);
          await ctx.answerCbQuery('❌ Rifiutato');
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('❌ Rifiutato.'); } catch {}
        }
      } catch (e: any) {
        await ctx.answerCbQuery(`Errore: ${String(e?.message ?? e).slice(0, 100)}`);
      }
      return;
    }
    // Goal plan approval — approve applica piano+KPI e propone le azioni
    // settimana 1 (che arrivano come ULTERIORE keyboard agent_proposals).
    m = data.match(/^goalplan:(\d+):(approve|reject)$/);
    if (m) {
      const goalId = Number(m[1]);
      const action = m[2];
      try {
        const goals = await import('../goals/index.js');
        if (action === 'approve') {
          const r = await goals.approvePlan(userId, goalId);
          if (!r.ok) throw new Error(r.error);
          await ctx.answerCbQuery('✅ Piano approvato');
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('✅ Piano approvato — obiettivo attivo. Le azioni della settimana 1 arrivano in un attimo (✅/❌).'); } catch {}
        } else {
          await goals.rejectPlan(userId, goalId);
          await ctx.answerCbQuery('❌ Piano scartato');
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('❌ Piano scartato. Dimmi cosa non andava e ne genero un altro.'); } catch {}
        }
      } catch (e: any) {
        await ctx.answerCbQuery(`Errore: ${String(e?.message ?? e).slice(0, 100)}`);
      }
      return;
    }
    // Email draft approval
    m = data.match(/^email_draft:(\d+):(send|deny)$/);
    if (m) {
      const draftId = Number(m[1]);
      const action = m[2];
      try {
        const email = await import('../connectors/builtin/imap/index.js');
        if (action === 'send') {
          await ctx.answerCbQuery('📤 invio in corso…');
          await email.sendDraft(userId, draftId);
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('✅ Email inviata.'); } catch {}
        } else {
          await email.denyDraft(userId, draftId);
          await ctx.answerCbQuery('❌ Bozza scartata');
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('❌ Bozza scartata.'); } catch {}
        }
      } catch (e: any) {
        await ctx.answerCbQuery(`Errore: ${String(e?.message ?? e).slice(0, 100)}`);
      }
      return;
    }

    // Client message (the arm) approval
    m = data.match(/^cmsg:(\d+):(approve|deny)$/);
    if (m) {
      const msgId = Number(m[1]);
      const action = m[2];
      try {
        const arm = await import('../arm/client_messages.js');
        if (action === 'approve') {
          await ctx.answerCbQuery('📤 elaboro…');
          const r = await arm.approveClientMsg(userId, msgId);
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          const txt = !r.ok ? `⚠️ ${r.error}`
            : r.queued ? `📅 In coda — parte ${r.when} (fuori dall'orario invii Lun-Ven 9:00-18:30).`
            : '✅ Inviato al cliente. Task → waiting feedback client.';
          try { await ctx.editMessageText(txt); } catch {}
        } else {
          await arm.denyClientMsg(userId, msgId);
          await ctx.answerCbQuery('❌ Bozza scartata');
          try { await ctx.editMessageReplyMarkup(undefined); } catch {}
          try { await ctx.editMessageText('❌ Bozza scartata.'); } catch {}
        }
      } catch (e: any) {
        await ctx.answerCbQuery(`Errore: ${String(e?.message ?? e).slice(0, 100)}`);
      }
      return;
    }
    await ctx.answerCbQuery('Unknown action');
  });

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (!cur?.chatId) {
      await setSetting(userId, 'telegram', { ...cur, chatId });
    } else if (cur.chatId !== chatId) {
      await ctx.reply('Not authorized.');
      return;
    }
    await ctx.reply("Linked. I'm online.");
  });

  bot.on('message', async (ctx) => {
    const chatId = ctx.chat.id;
    const cur = await getSetting<any>(userId, 'telegram');
    if (!cur?.chatId) {
      await setSetting(userId, 'telegram', { ...cur, chatId });
      await ctx.reply("Linked. I'm online.");
    } else if (cur.chatId !== chatId) {
      await ctx.reply('Not authorized.');
      return;
    }
    const text = 'text' in ctx.message ? ctx.message.text : '';
    if (text) {
      const messageId = (ctx.message as any).message_id;
      try { await setSetting(userId, 'telegram_last_incoming', { chatId, messageId, ts: Date.now() }); } catch {}
      // Thought-mode: ogni messaggio (non-comando) è un pensiero da catturare+analizzare,
      // NON un turno conversazionale. Default OFF → il bot resta l'agente di sempre.
      if (!text.startsWith('/')) {
        const tmode = await getSetting<boolean>(userId, 'thought_mode');
        if (tmode) { await captureAndReply(ctx, text); return; }
      }
      bus.emit('telegram:incoming', { userId, chatId, text, messageId });
      return;
    }
    const msg: any = ctx.message;

    // Photo path (Telegram delivers msg.photo[] sized array) — pick largest, archive, give Claude absolute path
    const photos = Array.isArray(msg.photo) ? msg.photo : null;
    if (photos && photos.length > 0) {
      try {
        await ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
        const best = photos.reduce((a: any, b: any) => ((b.file_size ?? 0) > (a.file_size ?? 0) ? b : a));
        const link = await ctx.telegram.getFileLink(best.file_id);
        const pres = await fetch(link.href);
        if (!pres.ok) throw new Error(`download ${pres.status}`);
        const buf = Buffer.from(await pres.arrayBuffer());
        const mime = 'image/jpeg';
        const filename = `photo-${Date.now()}.jpg`;
        const { archiveAttachment } = await import('../brain/extract.js');
        const a = await archiveAttachment(userId, filename, buf, mime);
        const sizeKb = (buf.length / 1024).toFixed(1);
        const caption = (msg.caption ?? '').toString();
        await ctx.reply(`🖼 ${filename} (${sizeKb}KB)${caption ? ` — "${caption.slice(0, 80)}"` : ''}. Sto analizzando…`).catch(() => {});
        const userPayload = `[Immagine ricevuta: ${filename} · ${best.width}x${best.height} · ${buf.length}B]
Raw file (assoluto): \`${a.rawAbsPath}\`
${caption ? `\nCaption utente: "${caption}"\n` : ''}
Usa lo strumento Read sul percorso assoluto per vedere l'immagine (Claude Code supporta immagini PNG/JPG nativamente). Descrivi cosa vedi, estrai testo se presente, collegala a note esistenti se rilevante, e dimmi cosa farne.`;
        bus.emit('telegram:incoming', { userId, chatId, text: userPayload });
      } catch (e: any) {
        console.error('[telegram] photo error', e);
        await ctx.reply(`⚠️ Errore elaborando l'immagine: ${String(e?.message ?? e).slice(0, 160)}`);
      }
      return;
    }

    // Document path (pdf, docx, txt, …) — save raw, let Claude read via Read tool
    const doc = msg.document;
    if (doc?.file_id) {
      try {
        await ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
        const link = await ctx.telegram.getFileLink(doc.file_id);
        const dres = await fetch(link.href);
        if (!dres.ok) throw new Error(`download ${dres.status}`);
        const buf = Buffer.from(await dres.arrayBuffer());
        const { archiveAttachment } = await import('../brain/extract.js');
        const a = await archiveAttachment(userId, doc.file_name ?? 'file', buf, doc.mime_type);
        const sizeKb = (buf.length / 1024).toFixed(1);
        await ctx.reply(`📎 ${doc.file_name} (${a.kind}, ${sizeKb}KB). Sto analizzando…`).catch(() => {});
        const preview = (a.inlineText ?? '').slice(0, 300).replace(/\s+/g, ' ');
        const userPayload = `[Allegato ricevuto: ${doc.file_name} · ${a.kind} · ${a.bytes}B]
Note metadata: \`${a.notePath}\`
Raw file (assoluto): \`${a.rawAbsPath}\`

${a.inlineText ? `Anteprima inline:\n"${preview}…"\n\n` : ''}Per analizzarlo a fondo usa lo strumento Read sul percorso assoluto del raw file. Claude Code legge PDF e file di testo nativamente. Estrai i punti chiave, collega a note esistenti (related:) e dimmi cosa farne in relazione alla roadmap.`;
        bus.emit('telegram:incoming', { userId, chatId, text: userPayload });
      } catch (e: any) {
        console.error('[telegram] document error', e);
        await ctx.reply(`⚠️ Errore elaborando il file: ${String(e?.message ?? e).slice(0, 160)}`);
      }
      return;
    }

    // Voice/audio path
    const audio = msg.voice ?? msg.audio ?? msg.video_note;
    if (!audio?.file_id) return;
    try {
      await ctx.telegram.sendChatAction(chatId, 'typing').catch(() => {});
      const link = await ctx.telegram.getFileLink(audio.file_id);
      const res = await fetch(link.href);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = audio.mime_type ?? 'audio/ogg';
      const ext = mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'mp4' : 'ogg';
      const { transcribeBuffer } = await import('../connectors/builtin/voice/index.js');
      const audioSeconds = typeof audio.duration === 'number' ? audio.duration : undefined;
      const { text: transcript } = await transcribeBuffer(userId, buf, `voice.${ext}`, mime, audioSeconds);
      if (!transcript) { await ctx.reply('🎙 (vuoto)'); return; }
      await ctx.reply(`🎙 "${transcript}"`).catch(() => {});
      bus.emit('telegram:incoming', { userId, chatId, text: transcript, voice: true });
    } catch (e: any) {
      console.error('[telegram] voice error', e);
      await ctx.reply(`⚠️ Voice transcription failed: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  });

  bot.catch((err) => console.error(`[telegram:${userId}] error`, err));
  bots.set(userId, { bot, token: cfg.token });
  // Launch with retry on 409 Conflict (stale polling from prior instance)
  const launchWithRetry = (attempt = 0) => {
    bot.launch().catch((e: any) => {
      const is409 = e?.response?.error_code === 409;
      const delay = Math.min(2000 + attempt * 3000, 30_000);
      console.error(`[telegram:${userId}] launch fail (attempt ${attempt}, retry in ${delay}ms)`, is409 ? '409 Conflict' : e?.message ?? e);
      if (attempt < 6 && bots.get(userId)?.bot === bot) {
        setTimeout(() => launchWithRetry(attempt + 1), delay);
      }
    });
  };
  launchWithRetry();
  // Register the slash-menu Telegram shows when user types `/`. Best-effort —
  // failures don't block the bot from working.
  bot.telegram.setMyCommands(COMMAND_CATALOG)
    .then(() => console.log(`[telegram:${userId}] /-menu registered (${COMMAND_CATALOG.length} commands)`))
    .catch((e: any) => console.warn(`[telegram:${userId}] setMyCommands failed`, e?.message ?? e));
  // Persistent "Menu" button next to the input — opens the commands list.
  bot.telegram.setChatMenuButton({ menuButton: { type: 'commands' } })
    .catch((e: any) => console.warn(`[telegram:${userId}] setChatMenuButton failed`, e?.message ?? e));
  console.log(`[telegram:${userId}] started`);
}

export async function stopBotForUser(userId: number) {
  const entry = bots.get(userId);
  if (!entry) return;
  try { entry.bot.stop(); } catch {}
  bots.delete(userId);
}

// Stop ALL Telegraf instances in parallel. Used by dev shutdown so each bot
// gets a chance to ack its current update batch before the process exits,
// preventing Telegram replay loops on respawn.
export async function stopAllTelegramBots(): Promise<void> {
  const ids = Array.from(bots.keys());
  await Promise.all(ids.map((id) => stopBotForUser(id)));
}

export async function startAllTelegramBots() {
  const rows = await query<{ user_id: number }>(
    `SELECT DISTINCT user_id FROM settings WHERE key='telegram' AND user_id IS NOT NULL`
  );
  for (const r of rows) await startBotForUser(r.user_id);
}

export async function restartTelegramForUser(userId: number) {
  await startBotForUser(userId);
}

// Scan a message for local file paths (absolute or ~-relative) that exist on
// disk and replace them with file-gateway URLs. Markdown-style [label](path)
// is preserved by rewriting just the URL part.
export async function linkifyLocalPaths(text: string): Promise<string> {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const { config } = await import('../config.js');
  const { signFilePath } = await import('../api/routes.js');
  // lvh.me origin (Telegram won't linkify "localhost") + HMAC sig so the
  // click works without a session cookie.
  const toUrl = (p: string) => `${config.fileGatewayOrigin}/api/files?path=${encodeURIComponent(p)}&sig=${signFilePath(p)}`;
  const resolve = (raw: string): string | null => {
    let p = raw.startsWith('~') ? pathMod.join(os.homedir(), raw.slice(1)) : raw;
    p = pathMod.resolve(p);
    try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
  };
  // Candidate tokens: absolute or ~ paths with an extension, no spaces.
  return text.replace(/(~?\/[A-Za-z0-9._\-\/]+\.[A-Za-z0-9]{1,8})/g, (m) => {
    const p = resolve(m);
    return p ? toUrl(p) : m;
  });
}

export async function sendTelegram(userId: number, text: string, origin: string = 'agent') {
  const { logOutbound } = await import('../comm/outbound_log.js');
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) {
    await logOutbound({ userId, channel: 'telegram', status: 'error', body: text, origin, error: 'telegram not configured' });
    throw new Error(`telegram not configured for user ${userId}`);
  }
  // Lazy-start if bots map is empty (tsx-watch reload can wipe singleton)
  if (!bots.get(userId)) {
    console.log(`[telegram:${userId}] lazy-start before send`);
    await startBotForUser(userId);
  }
  const entry = bots.get(userId);
  if (!entry) {
    await logOutbound({ userId, channel: 'telegram', status: 'error', recipient: String(cfg.chatId), body: text, origin, error: 'telegram bot init failed' });
    throw new Error(`telegram bot init failed for user ${userId}`);
  }
  // Hard split by 4000 chars (Telegram limit 4096, leave headroom for HTML
  // entity expansion). Long Claude outputs (SOPs, dossiers) hit 5–10k chars
  // and Telegram rejected the call silently — orchestrator logged "sent" but
  // user got nothing. Now split FIRST, then split by explicit <<MSG>> markers.
  // Rewrite local file paths into clickable gateway links. The agent often
  // references generated files by path ("/Users/x/report.pdf" or "~/y.csv");
  // raw paths are useless on a phone. Every existing absolute path becomes
  // http://<frontend>/api/files?path=<enc> which serves the real file to the
  // authenticated browser session.
  text = await linkifyLocalPaths(text);
  const MAX = 4000;
  function chunkByLen(s: string): string[] {
    if (s.length <= MAX) return [s];
    const out: string[] = [];
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + MAX, s.length);
      if (end < s.length) {
        const nl = s.lastIndexOf('\n', end);
        if (nl > i + MAX / 2) end = nl;
      }
      out.push(s.slice(i, end));
      i = end;
    }
    return out;
  }
  const parts = text
    .split('<<MSG>>')
    .flatMap((p) => chunkByLen(p))
    .map((p) => p.trim())
    .filter(Boolean);
  console.log(`[telegram:${userId}] sending ${parts.length} parts (total ${text.length} chars)`);
  for (const p of parts) {
    let sentOk = true;
    let err: string | null = null;
    try {
      await entry.bot.telegram.sendMessage(cfg.chatId, toTelegramHtml(p), { parse_mode: 'HTML' });
    } catch (e: any) {
      try {
        await entry.bot.telegram.sendMessage(cfg.chatId, p.replace(/\*\*|__|`/g, ''));
      } catch (e2: any) {
        sentOk = false;
        err = String(e2?.message ?? e2 ?? e?.message ?? e).slice(0, 500);
      }
    }
    await logOutbound({
      userId, channel: 'telegram',
      status: sentOk ? 'sent' : 'error',
      recipient: String(cfg.chatId), body: p, origin,
      error: err, meta: { parts: parts.length },
    });
    await new Promise((r) => setTimeout(r, 250));
  }
}

// TTS reply path: synthesize via ElevenLabs (or any TTS provider configured)
// and post as a Telegram voice note. Falls back silently to text via the
// caller if TTS not configured or fails. Logs to outbound_log.
export async function sendTelegramVoice(userId: number, text: string, origin: string = 'agent'): Promise<{ ok: boolean; fallback?: 'text'; error?: string }> {
  const { logOutbound } = await import('../comm/outbound_log.js');
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return { ok: false, error: 'telegram not configured' };
  const { synthesize } = await import('../connectors/builtin/tts/index.js');
  const audio = await synthesize(userId, text);
  if (!audio) {
    // Fallback: send as text so the user still gets the reply.
    try { await sendTelegram(userId, text, origin); }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
    return { ok: true, fallback: 'text' };
  }
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, error: 'telegram bot init failed' };
  try {
    // Telegraf voice expects an audio source. For mp3 use sendAudio; for ogg
    // sendVoice. Telegram voice notes appear as the WhatsApp-style waveform.
    if (audio.ext === 'ogg') {
      await entry.bot.telegram.sendVoice(cfg.chatId, { source: audio.buf });
    } else {
      await entry.bot.telegram.sendAudio(cfg.chatId, { source: audio.buf, filename: `voice.${audio.ext}` });
    }
    await logOutbound({ userId, channel: 'telegram', status: 'sent', recipient: String(cfg.chatId), body: text, origin, meta: { tts: true, ext: audio.ext, bytes: audio.buf.length } });
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 500);
    await logOutbound({ userId, channel: 'telegram', status: 'error', recipient: String(cfg.chatId), body: text, origin, error: err, meta: { tts: true } });
    // Fallback to text on send failure
    try { await sendTelegram(userId, text, origin); return { ok: true, fallback: 'text', error: err }; }
    catch { return { ok: false, error: err }; }
  }
}

// Send a local file as a Telegram document (PDF, immagini, zip, qualunque
// file generato dall'agente). 50MB bot API limit. Photos sent as photo for
// inline preview, everything else as document.
export async function sendTelegramDocument(
  userId: number,
  filePath: string,
  caption?: string,
  origin: string = 'agent',
): Promise<{ ok: boolean; error?: string }> {
  const { logOutbound } = await import('../comm/outbound_log.js');
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return { ok: false, error: 'telegram not configured' };
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let stat;
  try { stat = await fs.stat(filePath); }
  catch { return { ok: false, error: `file non trovato: ${filePath}` }; }
  if (!stat.isFile()) return { ok: false, error: `non è un file: ${filePath}` };
  const MAX_BYTES = 50 * 1024 * 1024; // Telegram bot API hard limit
  if (stat.size > MAX_BYTES) return { ok: false, error: `file troppo grande (${Math.round(stat.size / 1024 / 1024)}MB > 50MB)` };
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, error: 'telegram bot init failed' };
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const cap = caption ? String(caption).slice(0, 1024) : undefined;
  try {
    const src = { source: filePath, filename };
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      await entry.bot.telegram.sendPhoto(cfg.chatId, src, { caption: cap });
    } else {
      await entry.bot.telegram.sendDocument(cfg.chatId, src, { caption: cap });
    }
    await logOutbound({ userId, channel: 'telegram', status: 'sent', recipient: String(cfg.chatId), body: cap ?? filename, origin, meta: { file: filename, bytes: stat.size } });
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 500);
    await logOutbound({ userId, channel: 'telegram', status: 'error', recipient: String(cfg.chatId), body: cap ?? filename, origin, error: err, meta: { file: filename } });
    return { ok: false, error: err };
  }
}

// Allowed Telegram reaction emojis (free for bots, no premium)
const TG_REACTIONS = new Set(['👍','👎','❤','🔥','🥰','👏','😁','🤔','🤯','😱','🤬','😢','🎉','🤩','🤮','💩','🙏','👌','🕊','🤡','🥱','🥴','😍','🐳','❤‍🔥','🌚','🌭','💯','🤣','⚡','🍌','🏆','💔','🤨','😐','🍓','🍾','💋','🖕','😈','😴','😭','🤓','👻','👨‍💻','👀','🎃','🙈','😇','😨','🤝','✍','🤗','🫡','🎅','🎄','☃','💅','🤪','🗿','🆒','💘','🙉','🦄','😘','💊','🙊','😎','👾','🤷‍♂','🤷','🤷‍♀','😡']);

// Built-in Telegram emoji shortcodes for animated emoji ("custom emoji")
// reachable from any bot. These use the standard Unicode glyphs but render
// animated on Telegram clients. Useful for sparkly replies.
export const TG_ANIMATED_EMOJI = ['🎲','🎯','🏀','⚽','🎰','🎳'] as const;

// Send a sticker by file_id (preferred) OR by URL. file_id is reusable across
// bots once obtained — see getStickerSet for popular packs.
export async function sendTelegramSticker(userId: number, stickerRef: string, origin: string = 'agent'): Promise<{ ok: boolean; error?: string }> {
  const { logOutbound } = await import('../comm/outbound_log.js');
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return { ok: false, error: 'telegram not configured' };
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, error: 'telegram bot init failed' };
  try {
    await entry.bot.telegram.sendSticker(cfg.chatId, stickerRef);
    await logOutbound({ userId, channel: 'telegram', status: 'sent', recipient: String(cfg.chatId), body: `[sticker] ${stickerRef.slice(0, 80)}`, origin });
    return { ok: true };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 400);
    await logOutbound({ userId, channel: 'telegram', status: 'error', recipient: String(cfg.chatId), body: `[sticker] ${stickerRef.slice(0, 80)}`, origin, error: err });
    return { ok: false, error: err };
  }
}

// Send an animated emoji (Telegram "dice" API — 🎲 🎯 🏀 ⚽ 🎰 🎳 only).
// Each one returns a random outcome; great for playful one-shot reactions.
export async function sendTelegramAnimatedEmoji(userId: number, emoji: string, origin: string = 'agent'): Promise<{ ok: boolean; value?: number; error?: string }> {
  const { logOutbound } = await import('../comm/outbound_log.js');
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return { ok: false, error: 'telegram not configured' };
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, error: 'telegram bot init failed' };
  if (!(TG_ANIMATED_EMOJI as readonly string[]).includes(emoji)) return { ok: false, error: `emoji "${emoji}" non animata. Usa una di: ${TG_ANIMATED_EMOJI.join(' ')}` };
  try {
    const res: any = await entry.bot.telegram.sendDice(cfg.chatId, { emoji });
    await logOutbound({ userId, channel: 'telegram', status: 'sent', recipient: String(cfg.chatId), body: `[animated ${emoji}] value=${res?.dice?.value}`, origin });
    return { ok: true, value: res?.dice?.value };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 400);
    return { ok: false, error: err };
  }
}

// List a public sticker set so the agent can browse + pick (returns file_ids).
export async function listTelegramStickerSet(userId: number, name: string): Promise<{ ok: boolean; stickers?: { file_id: string; emoji?: string }[]; error?: string }> {
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, error: 'telegram bot init failed' };
  try {
    const set: any = await entry.bot.telegram.getStickerSet(name);
    return { ok: true, stickers: (set.stickers ?? []).map((s: any) => ({ file_id: s.file_id, emoji: s.emoji })) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 400) };
  }
}

export async function updateBotProfile(userId: number, opts: { name?: string; shortDescription?: string }): Promise<{ ok: boolean; updated: string[]; error?: string }> {
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return { ok: false, updated: [], error: 'telegram bot not initialized' };
  const updated: string[] = [];
  try {
    if (opts.name && opts.name.trim()) {
      await entry.bot.telegram.callApi('setMyName' as any, { name: opts.name.slice(0, 64) });
      updated.push('name');
    }
    if (opts.shortDescription !== undefined) {
      await entry.bot.telegram.callApi('setMyShortDescription' as any, { short_description: (opts.shortDescription ?? '').slice(0, 120) });
      updated.push('short_description');
    }
    return { ok: true, updated };
  } catch (e: any) {
    return { ok: false, updated, error: String(e?.message ?? e).slice(0, 300) };
  }
}

export async function sendReaction(userId: number, chatId: number, messageId: number, emoji: string): Promise<boolean> {
  if (!TG_REACTIONS.has(emoji)) throw new Error(`emoji not allowed: ${emoji}`);
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) throw new Error(`telegram bot init failed for user ${userId}`);
  try {
    await entry.bot.telegram.callApi('setMessageReaction' as any, {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
      is_big: false,
    });
    return true;
  } catch (e: any) {
    console.error('[telegram] setMessageReaction failed', e?.message ?? e);
    return false;
  }
}

export async function sendProposalKeyboard(userId: number, proposal: { id: number; title: string; reason: string | null; proposals: { title: string; brief: string }[] }): Promise<{ message_id: number; chat_id: number } | null> {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return null;
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return null;
  const chatId = cfg.chatId;
  const body = [
    `🤖 *${proposal.title}*`,
    proposal.reason ? `\n${proposal.reason}` : '',
    '',
    'Vorrei lanciare in parallelo:',
    ...proposal.proposals.map((p, i) => `${i + 1}. *${p.title}* — ${p.brief}`),
    '',
    'Procedo?',
  ].filter(Boolean).join('\n');
  try {
    const sent = await entry.bot.telegram.sendMessage(chatId, body, {
      parse_mode: 'Markdown' as any,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Sì, procedi', callback_data: `proposal:${proposal.id}:approve` },
          { text: '❌ No', callback_data: `proposal:${proposal.id}:deny` },
        ]],
      },
    });
    return { message_id: (sent as any).message_id, chat_id: chatId };
  } catch (e: any) {
    console.error('[telegram] proposal send failed', e?.message ?? e);
    return null;
  }
}

// Piano di un Goal in attesa di approvazione — riassunto + keyboard. L'utente
// può anche semplicemente RISPONDERE in chat per discuterlo: l'agente chiama
// agent_goal_revise e questo messaggio viene reinviato col piano aggiornato.
export async function sendGoalPlanKeyboard(userId: number, goal: { id: number; title: string; objective: string; deadline: string | null; pending_plan: any }): Promise<{ message_id: number; chat_id: number } | null> {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return null;
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return null;
  const p = goal.pending_plan ?? {};
  const lines = [
    `🎯 *Piano per: ${goal.title}*`,
    goal.deadline ? `_${goal.objective} · entro ${goal.deadline}_` : `_${goal.objective}_`,
    p.notes ? `\n${p.notes}` : '',
  ];
  if (p.kpis?.length) {
    lines.push('', '*KPI proposti:*');
    for (const k of p.kpis) lines.push(`• ${k.name}: ${k.current ?? 0} → ${k.target}${k.unit ? ` ${k.unit}` : ''}`);
  }
  if (p.milestones?.length) {
    lines.push('', '*Milestones:*');
    p.milestones.forEach((m: any, i: number) => lines.push(`${i + 1}. ${m.title}${m.due ? ` — ${m.due}` : ''}`));
  }
  if (p.next_actions?.length) {
    lines.push('', '*Settimana 1:*');
    for (const a of p.next_actions) lines.push(`• ${a.title}`);
  }
  lines.push('', 'Approva, scarta, o *rispondimi* con le modifiche che vuoi e lo sistemo.');
  try {
    const sent = await entry.bot.telegram.sendMessage(cfg.chatId, lines.filter(Boolean).join('\n'), {
      parse_mode: 'Markdown' as any,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approva piano', callback_data: `goalplan:${goal.id}:approve` },
          { text: '❌ Scarta', callback_data: `goalplan:${goal.id}:reject` },
        ]],
      },
    });
    return { message_id: (sent as any).message_id, chat_id: cfg.chatId };
  } catch (e: any) {
    console.error('[telegram] goal plan send failed', e?.message ?? e);
    return null;
  }
}

// Client update message (the "arm"). Mirrors sendEmailDraftKeyboard. When held
// (no verified WhatsApp mapping), shows no send button — just informs Marco.
export async function sendClientMsgKeyboard(userId: number, draft: { id: number; client_name: string; body: string; held: boolean; dest?: string | null }): Promise<{ message_id: number; chat_id: number } | null> {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return null;
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return null;
  const chatId = cfg.chatId;
  const header = draft.held
    ? `📨 *Messaggio cliente — ${draft.client_name}*\n⚠️ Canale non configurato: bozza pronta ma non inviabile. Definisci il canale in \`client-wa-map.json\`.`
    : `📨 *Messaggio cliente pronto — ${draft.client_name}*${draft.dest ? `\n→ ${draft.dest}` : ''}`;
  const msg = [header, '', '```', draft.body, '```', '', draft.held ? '' : 'Invio?'].join('\n');
  try {
    const sent = await entry.bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'Markdown' as any,
      reply_markup: draft.held ? undefined : {
        inline_keyboard: [[
          { text: '📤 Invia', callback_data: `cmsg:${draft.id}:approve` },
          { text: '❌ Scarta', callback_data: `cmsg:${draft.id}:deny` },
        ]],
      },
    });
    return { message_id: (sent as any).message_id, chat_id: chatId };
  } catch (e: any) {
    console.error('[telegram] client_msg send failed', e?.message ?? e);
    return null;
  }
}

export async function sendEmailDraftKeyboard(userId: number, draft: { id: number; to_addr: string; subject: string; body: string; meta?: any }): Promise<{ message_id: number; chat_id: number } | null> {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return null;
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return null;
  const chatId = cfg.chatId;
  const bodyPreview = draft.body.length > 500 ? draft.body.slice(0, 500) + '…' : draft.body;
  const attachments: string[] = Array.isArray(draft.meta?.attachments) ? draft.meta.attachments : [];
  const msg = [
    '✉️ *Bozza email pronta*',
    '',
    `*A:* \`${draft.to_addr}\``,
    `*Oggetto:* ${draft.subject}`,
    ...(attachments.length ? [`*Allegati:* ${attachments.map((p) => `📎 ${p.split('/').pop()}`).join(' · ')}`] : []),
    '',
    '```',
    bodyPreview,
    '```',
    '',
    'Invio?',
  ].join('\n');
  try {
    const sent = await entry.bot.telegram.sendMessage(chatId, msg, {
      parse_mode: 'Markdown' as any,
      reply_markup: {
        inline_keyboard: [[
          { text: '📤 Invia', callback_data: `email_draft:${draft.id}:send` },
          { text: '❌ Scarta', callback_data: `email_draft:${draft.id}:deny` },
        ]],
      },
    });
    return { message_id: (sent as any).message_id, chat_id: chatId };
  } catch (e: any) {
    console.error('[telegram] email_draft send failed', e?.message ?? e);
    return null;
  }
}

export async function startTyping(userId: number): Promise<() => void> {
  const cfg = await getSetting<{ chatId?: number }>(userId, 'telegram');
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry || !cfg?.chatId) return () => {};
  const chatId = cfg.chatId;
  const tick = () => { entry.bot.telegram.sendChatAction(chatId, 'typing').catch(() => {}); };
  tick();
  const t = setInterval(tick, 4000);
  return () => clearInterval(t);
}
