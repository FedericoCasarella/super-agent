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

  // Explicit /start handler — Telegraf treats /start as a command and may
  // bypass generic on('message') depending on update type / entities.
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
      bus.emit('telegram:incoming', { userId, chatId, text: transcript });
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
  const parts = text.split('<<MSG>>').map((p) => p.trim()).filter(Boolean);
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
