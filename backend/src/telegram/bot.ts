import { Telegraf } from 'telegraf';
import { getSetting, setSetting, query } from '../db/index.js';
import { bus } from '../bus.js';

type BotEntry = { bot: Telegraf; token: string };
const bots = new Map<number, BotEntry>(); // userId → bot

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

async function startBotForUser(userId: number) {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token) return;
  const existing = bots.get(userId);
  if (existing && existing.token === cfg.token) return;
  await stopBotForUser(userId);
  const bot = new Telegraf(cfg.token);

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
  bot.launch().catch((e) => console.error(`[telegram:${userId}] launch`, e));
  bots.set(userId, { bot, token: cfg.token });
  console.log(`[telegram:${userId}] started`);
}

export async function stopBotForUser(userId: number) {
  const entry = bots.get(userId);
  if (!entry) return;
  try { entry.bot.stop(); } catch {}
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

export async function sendTelegram(userId: number, text: string) {
  const cfg = await getSetting<{ token: string; chatId?: number }>(userId, 'telegram');
  if (!cfg?.token || !cfg?.chatId) throw new Error(`telegram not configured for user ${userId}`);
  // Lazy-start if bots map is empty (tsx-watch reload can wipe singleton)
  if (!bots.get(userId)) {
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
  if (!bots.get(userId)) await startBotForUser(userId);
  const entry = bots.get(userId);
  if (!entry || !cfg?.chatId) return () => {};
  const chatId = cfg.chatId;
  const tick = () => { entry.bot.telegram.sendChatAction(chatId, 'typing').catch(() => {}); };
  tick();
  const t = setInterval(tick, 4000);
  return () => clearInterval(t);
}
