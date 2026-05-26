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
// After Telegram returns 409, the server-side getUpdates slot needs ~3s to free.
// We hold a short cooldown to prevent immediate restart loops.
const TELEGRAM_STOP_GRACE_MS = 1500;

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
        bus.emit('telegram:incoming', { userId, chatId, text });
        return;
      }
      const msg: any = ctx.message;
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
    entry.launchPromise = bot
      .launch({}, () => {
        // onLaunch: botInfo is set; polling loop is about to start.
        if (entry.state === 'starting') entry.state = 'running';
      })
      .catch((e) => {
        console.error(`[telegram:${userId}] launch`, e);
        // 409 / 401 / network → mark stopped so next call can retry from clean slate.
        entry.state = 'stopped';
      });
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
