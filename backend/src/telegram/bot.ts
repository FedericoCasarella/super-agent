import { Telegraf } from 'telegraf';
import { getSetting, setSetting, query } from '../db/index.js';
import { bus } from '../bus.js';

type BotState = 'starting' | 'running' | 'stopping' | 'stopped';
type BotEntry = {
  bot: Telegraf;
  token: string;
  state: BotState;
  launchPromise: Promise<void>;
};
const bots = new Map<number, BotEntry>(); // userId → bot
const startInFlight = new Map<number, Promise<void>>(); // userId → in-flight start promise
// After Telegram returns 409, the server-side getUpdates slot needs ~3-5s to free.
// We hold a cooldown to prevent immediate restart loops. Raised 1500→5000 sess.2379
// after recurring 409 in err.log during tsx-watch hot reloads.
const TELEGRAM_STOP_GRACE_MS = 5000;
const TELEGRAM_LAUNCH_MAX_RETRIES = 3;
const TELEGRAM_LAUNCH_RETRY_BASE_MS = 3000;

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

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
  let s = raw.replace(/```([\s\S]*?)```/g, (_m, code) => wrap(`<pre>${escapeHtml(code)}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => wrap(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*([^\n*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^\n*]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(])_([^\n_]+)_/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  const re = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  s = s.replace(re, (_m, i) => blocks[Number(i)]);
  return s;
}

async function startBotForUser(userId: number): Promise<void> {
  // Coalesce concurrent starts: any caller while a start is in-flight awaits the same promise.
  const inFlight = startInFlight.get(userId);
  if (inFlight) return inFlight;

  const p = (async () => {
    const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
    if (!cfg?.token) return;
    const existing = bots.get(userId);
    // Already running with same token → no-op (this is the lazy-start race guard).
    if (existing && existing.token === cfg.token && (existing.state === 'running' || existing.state === 'starting')) {
      return;
    }
    // Token rotated or bot in stopped state → tear down first and wait for the slot to free.
    if (existing) {
      await stopBotForUser(userId);
    }
    const bot = new Telegraf(cfg.token);
    const entry: BotEntry = { bot, token: cfg.token, state: 'starting', launchPromise: Promise.resolve() };
    bots.set(userId, entry);

    // /agents command — show active sub-agents
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
      await ctx.answerCbQuery('Unknown action');
    });

    bot.on('message', async (ctx) => {
      const chatId = ctx.chat.id;
      const cur = await getSetting<any>(userId, 'telegram');
      const text = 'text' in ctx.message ? ctx.message.text : '';

      // H3 (sess.2818) — chatId binding requires one-time verification code.
      // Previously: first /start from ANY chat won the binding (race vulnerability
      // for leaked tokens). Now: code must be generated server-side via
      // POST /api/telegram/link-code (authed) and sent via /link CODE here.
      if (!cur?.chatId) {
        const linkMatch = text.match(/^\/link\s+([A-Z0-9]{4,8})\s*$/i);
        if (!linkMatch) {
          await ctx.reply('🔒 To link this chat, generate a code in the web UI (Settings → Telegram → Generate link code) and send: /link <CODE>');
          return;
        }
        const code = linkMatch[1].toUpperCase();
        const pending = await getSetting<{ code: string; expires_at: string }>(userId, 'telegram_link_pending');
        if (!pending) {
          await ctx.reply('⚠️ No link code pending. Generate one in the web UI first.');
          return;
        }
        if (new Date(pending.expires_at) < new Date()) {
          await ctx.reply('⏰ Code expired. Generate a fresh one in the web UI.');
          return;
        }
        if (pending.code !== code) {
          await ctx.reply('❌ Invalid code.');
          return;
        }
        await setSetting(userId, 'telegram', { ...cur, chatId });
        await setSetting(userId, 'telegram_link_pending', null);
        await ctx.reply("✅ Chat linked. I'm online.");
        return;
      } else if (cur.chatId !== chatId) {
        await ctx.reply('Not authorized.');
        return;
      }

      if (text) {
        // messageId tracking (Federico) per reaction/reply targeting.
        const messageId = (ctx.message as any).message_id;
        try { await setSetting(userId, 'telegram_last_incoming', { chatId, messageId, ts: Date.now() }); } catch {}
        bus.emit('telegram:incoming', { userId, chatId, text, messageId });
        return;
      }
      const msg: any = ctx.message;

      // Photo path (Federico) — archivia immagine, dà a Claude il path assoluto.
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

      // Document path (pdf, docx, txt, …) — save raw, let Claude read via Read tool.
      // Cherry-picked from upstream 02bfc31 sess.2379. Integrated above voice/audio path.
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
        bus.emit('telegram:incoming', { userId, chatId, text: transcript });
      } catch (e: any) {
        console.error('[telegram] voice error', e);
        await ctx.reply(`⚠️ Voice transcription failed: ${String(e?.message ?? e).slice(0, 160)}`);
      }
    });

    bot.catch((err) => console.error(`[telegram:${userId}] error`, err));
    // launch() returns a promise that resolves only when polling loop exits (after stop()).
    // We mark state='running' via onLaunch callback (fired AFTER getMe but BEFORE getUpdates loop).
    // Retry-with-backoff on 409 sess.2379: prior code marked state='stopped' on first 409,
    // requiring an external restart trigger that never came → bot stayed dead until next sendTelegram.
    const launchWithRetry = async () => {
      for (let attempt = 1; attempt <= TELEGRAM_LAUNCH_MAX_RETRIES; attempt++) {
        try {
          await bot.launch({}, () => {
            if (entry.state === 'starting') entry.state = 'running';
          });
          return;
        } catch (e: any) {
          const code = e?.response?.error_code ?? e?.code;
          const is409 = code === 409;
          if (is409 && attempt < TELEGRAM_LAUNCH_MAX_RETRIES) {
            const wait = TELEGRAM_LAUNCH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
            console.warn(`[telegram:${userId}] 409 attempt ${attempt}/${TELEGRAM_LAUNCH_MAX_RETRIES}, retry in ${wait}ms`);
            await sleep(wait);
            continue;
          }
          console.error(`[telegram:${userId}] launch (attempt ${attempt})`, e);
          entry.state = 'stopped';
          return;
        }
      }
    };
    entry.launchPromise = launchWithRetry();
    console.log(`[telegram:${userId}] started`);
  })();

  startInFlight.set(userId, p);
  try {
    await p;
  } finally {
    startInFlight.delete(userId);
  }
}

export async function stopBotForUser(userId: number) {
  const entry = bots.get(userId);
  if (!entry) return;
  if (entry.state === 'stopping' || entry.state === 'stopped') {
    bots.delete(userId);
    return;
  }
  entry.state = 'stopping';
  try { entry.bot.stop('stopBotForUser'); } catch {}
  // Await the launch promise → resolves when polling loop's finally block completes.
  // Add a safety race so a hung getUpdates can't block us forever.
  await Promise.race([
    entry.launchPromise.catch(() => {}),
    sleep(5000),
  ]);
  // Hold cooldown so Telegram server frees the long-polling slot before any restart.
  await sleep(TELEGRAM_STOP_GRACE_MS);
  entry.state = 'stopped';
  bots.delete(userId);
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

function isLive(entry: BotEntry | undefined): entry is BotEntry {
  return !!entry && (entry.state === 'running' || entry.state === 'starting');
}

export async function sendTelegram(userId: number, text: string) {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) throw new Error(`telegram not configured for user ${userId}`);
  // Lazy-start only if no live bot for this user (handles tsx-watch reload wiping singleton).
  // startBotForUser is now race-safe: concurrent callers share one in-flight start promise,
  // and a running bot with the same token is a no-op (no duplicate Telegraf instance).
  if (!isLive(bots.get(userId))) {
    console.log(`[telegram:${userId}] lazy-start before send`);
    await startBotForUser(userId);
  }
  const entry = bots.get(userId);
  if (!entry) throw new Error(`telegram bot init failed for user ${userId}`);
  const parts = text.split('<<MSG>>').map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    try {
      await entry.bot.telegram.sendMessage(cfg.chatId, toTelegramHtml(p), { parse_mode: 'HTML' });
    } catch {
      await entry.bot.telegram.sendMessage(cfg.chatId, p.replace(/\*\*|__|`/g, ''));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function startTyping(userId: number): Promise<() => void> {
  const cfg = await getSetting<{ chatId?: number }>(userId, 'telegram');
  if (!isLive(bots.get(userId))) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry || !cfg?.chatId) return () => {};
  const chatId = cfg.chatId;
  const tick = () => { entry.bot.telegram.sendChatAction(chatId, 'typing').catch(() => {}); };
  tick();
  const t = setInterval(tick, 4000);
  return () => clearInterval(t);
}

// merge sess.2938: innestati da origin/main (Federico) — usati da sub_agents + agent connector.
// Il nostro --ours bot.ts non li aveva → tsc TS2339. Grafted per sbloccare la compilazione.
const TG_REACTIONS = new Set(['👍','👎','❤','🔥','🥰','👏','😁','🤔','🤯','😱','🤬','😢','🎉','🤩','🤮','💩','🙏','👌','🕊','🤡','🥱','🥴','😍','🐳','❤‍🔥','🌚','🌭','💯','🤣','⚡','🍌','🏆','💔','🤨','😐','🍓','🍾','💋','🖕','😈','😴','😭','🤓','👻','👨‍💻','👀','🎃','🙈','😇','😨','🤝','✍','🤗','🫡','🎅','🎄','☃','💅','🤪','🗿','🆒','💘','🙉','🦄','😘','💊','🙊','😎','👾','🤷‍♂','🤷','🤷‍♀','😡']);

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
<<<<<<< HEAD

export async function sendEmailDraftKeyboard(userId: number, draft: { id: number; to_addr: string; subject: string; body: string }): Promise<{ message_id: number; chat_id: number } | null> {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) return null;
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry) return null;
  const chatId = cfg.chatId;
  const bodyPreview = draft.body.length > 500 ? draft.body.slice(0, 500) + '…' : draft.body;
  const msg = [
    '✉️ *Bozza email pronta*',
    '',
    `*A:* \`${draft.to_addr}\``,
    `*Oggetto:* ${draft.subject}`,
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
=======
>>>>>>> origin/polpo-fork
