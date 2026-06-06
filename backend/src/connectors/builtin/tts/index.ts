import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';

// ElevenLabs (and compatible) text-to-speech. Used by the Telegram bot to
// reply with a voice note when the user originally sent a voice message —
// see orchestrator.ts handleIncoming and bot.ts sendTelegramVoice.

export type TtsConfig = {
  apiKey?: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  format?: string;
};

// Premade voice IDs that ARE on free tier (not the legacy "library" voices
// like Rachel `21m00Tcm4TlvDq8ikWAM` which now return 402 for free users).
// Order = preference. We retry through the list on 402.
const FREE_TIER_VOICES = [
  { id: '9BWtsMINqrJLrRacOk9x', name: 'Aria' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam' },
];
const DEFAULT_VOICE = FREE_TIER_VOICES[0].id;
// Free tier supports turbo/flash models. Multilingual_v2 requires paid.
const DEFAULT_MODEL = 'eleven_turbo_v2_5';

export async function getTtsConfig(userId: number): Promise<TtsConfig> {
  const rows = await query<{ config: any; enabled: boolean }>(
    `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='tts'`, [userId],
  );
  const row = rows[0];
  if (!row?.enabled) return {};
  return row.config ?? {};
}

// Synthesize speech. Returns a Buffer in opus/ogg (best for Telegram voice
// notes) or null on failure. Always logs errors.
export type TtsResult =
  | { ok: true; buf: Buffer; mime: string; ext: string }
  | { ok: false; error: string };

export async function synthesizeDetailed(userId: number, text: string): Promise<TtsResult> {
  const cfg = await getTtsConfig(userId);
  // Surface concrete reasons so the test button + orchestrator log say
  // exactly why no audio came back (missing key, disabled connector, wrong
  // voice id, exhausted quota, etc.).
  const rows = await query<{ enabled: boolean }>(`SELECT enabled FROM connectors WHERE user_id=$1 AND name='tts'`, [userId]);
  if (!rows[0]) return { ok: false, error: 'connettore TTS non registrato' };
  if (!rows[0].enabled) return { ok: false, error: 'connettore TTS disattivato' };
  if (!cfg.apiKey) return { ok: false, error: 'apiKey vuota' };
  // Strip whitespace + any zero-width chars that sneak in via copy-paste.
  const apiKey = String(cfg.apiKey).replace(/[\s​-‍﻿]/g, '');
  if (!apiKey) return { ok: false, error: 'apiKey solo whitespace' };
  console.log(`[tts:u${userId}] using key prefix="${apiKey.slice(0, 6)}…" len=${apiKey.length}`);
  // If no voiceId set, pull the FIRST voice from the user's own account
  // (cloned/generated/owned) — free tier can only use its own voices via
  // API, library voices return 402 Payment Required.
  let voiceId = cfg.voiceId || '';
  if (!voiceId) {
    try {
      const list = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
      if (list.ok) {
        const data: any = await list.json();
        const owned = (data?.voices ?? []).find((v: any) => v?.category !== 'premade');
        const fallback = (data?.voices ?? [])[0];
        voiceId = owned?.voice_id ?? fallback?.voice_id ?? DEFAULT_VOICE;
        console.log(`[tts:u${userId}] auto-picked voiceId=${voiceId} (${owned ? 'owned' : fallback ? 'first available' : 'default'})`);
      } else {
        voiceId = DEFAULT_VOICE;
      }
    } catch { voiceId = DEFAULT_VOICE; }
  }
  const modelId = cfg.modelId || DEFAULT_MODEL;
  const outputFormat = cfg.format || 'mp3_44100_128';
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  const body = {
    text,
    model_id: modelId,
    voice_settings: {
      stability: Number(cfg.stability ?? 0.5),
      similarity_boost: Number(cfg.similarityBoost ?? 0.75),
      style: Number(cfg.style ?? 0),
      use_speaker_boost: true,
    },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
        'accept': outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'audio/ogg',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      // 402 = library voice on free tier. Try a curated list of premade free
      // voices first, then any owned voices from the user account.
      if (res.status === 402 && /paid_plan|library|payment_required/i.test(detail)) {
        const candidates: { id: string; name: string }[] = [...FREE_TIER_VOICES];
        try {
          const list = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
          if (list.ok) {
            const data: any = await list.json();
            for (const v of (data?.voices ?? []) as any[]) {
              if (v.category && v.category !== 'premade' && !candidates.find((c) => c.id === v.voice_id)) {
                candidates.push({ id: v.voice_id, name: v.name });
              }
            }
          }
        } catch {}
        console.log(`[tts:u${userId}] 402 retry over ${candidates.length} fallback voices`);
        for (const v of candidates) {
          if (v.id === voiceId) continue;
          const retryUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(v.id)}?output_format=${encodeURIComponent(outputFormat)}`;
          const r2 = await fetch(retryUrl, {
            method: 'POST',
            headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', 'accept': outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'audio/ogg' },
            body: JSON.stringify(body),
          });
          if (r2.ok) {
            console.warn(`[tts:u${userId}] succeeded with ${v.id} (${v.name})`);
            const buf = Buffer.from(await r2.arrayBuffer());
            const mime = outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'audio/ogg';
            const ext = outputFormat.startsWith('mp3') ? 'mp3' : 'ogg';
            return { ok: true, buf, mime, ext };
          }
        }
        return { ok: false, error: `Free tier ElevenLabs ha bloccato tutte le voci provate (Aria, Sarah, Roger, George, Liam + owned). Crea voce su elevenlabs.io/app/voice-library (Instant Voice Clone) o upgrade plan.` };
      }
      const err = `elevenlabs ${res.status} ${res.statusText}: ${detail}`;
      console.error(`[tts:u${userId}] ${err}`);
      return { ok: false, error: err };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'elevenlabs ritornato body vuoto' };
    const mime = outputFormat.startsWith('mp3') ? 'audio/mpeg' : 'audio/ogg';
    const ext = outputFormat.startsWith('mp3') ? 'mp3' : 'ogg';
    return { ok: true, buf, mime, ext };
  } catch (e: any) {
    const err = String(e?.message ?? e).slice(0, 300);
    console.error(`[tts:u${userId}] synthesize threw ${err}`);
    return { ok: false, error: err };
  }
}

// Back-compat wrapper.
export async function synthesize(userId: number, text: string): Promise<{ buf: Buffer; mime: string; ext: string } | null> {
  const r = await synthesizeDetailed(userId, text);
  return r.ok ? { buf: r.buf, mime: r.mime, ext: r.ext } : null;
}

const connector: Connector = {
  manifest: {
    name: 'tts',
    title: 'Text-to-Speech (ElevenLabs)',
    description: 'Genera audio dalla voce di un agente. Usata per rispondere ai vocali Telegram con un vocale.',
    configSchema: [
      { key: 'apiKey', label: 'ElevenLabs API key', type: 'password', required: true },
      { key: 'voiceId', label: 'Voice ID (vuoto = auto-pick dalla tua libreria)', type: 'text', placeholder: 'lascia vuoto' },
      { key: 'modelId', label: 'Model', type: 'text', placeholder: 'eleven_turbo_v2_5' },
      { key: 'format', label: 'Output format', type: 'text', placeholder: 'mp3_44100_128' },
      { key: 'stability', label: 'Stability (0-1)', type: 'text', placeholder: '0.5' },
      { key: 'similarityBoost', label: 'Similarity boost (0-1)', type: 'text', placeholder: '0.75' },
    ],
  },
  tools: [
    {
      name: 'status',
      description: 'Mostra config TTS attiva (voce, model).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const cfg = await getTtsConfig(ctx.userId);
        if (!cfg.apiKey) return { configured: false };
        return {
          configured: true,
          voiceId: cfg.voiceId || DEFAULT_VOICE,
          modelId: cfg.modelId || DEFAULT_MODEL,
          format: cfg.format || 'mp3_44100_128',
        };
      },
    },
    {
      name: 'speak_telegram',
      description: 'Sintetizza il testo via ElevenLabs e invia come voice note Telegram all\'utente. Da usare per replicare lo stile vocale.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'], additionalProperties: false,
      },
      handler: async (ctx, { text }) => {
        const { sendTelegramVoice } = await import('../../../telegram/bot.js');
        const r = await sendTelegramVoice(ctx.userId, String(text), 'agent_tool');
        return r;
      },
    },
  ],
};

export default connector;
