import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';

const PRICE_PER_SEC: Record<string, number> = {
  'whisper-1':                  0.006 / 60,
  'whisper-large-v3':           0.00185 / 60,
  'whisper-large-v3-turbo':     0.00067 / 60,
  'distil-whisper-large-v3-en': 0.00033 / 60,
};
function estimateCost(model: string, seconds: number): number | null {
  const rate = PRICE_PER_SEC[model];
  return rate != null ? Number((rate * seconds).toFixed(6)) : null;
}

export type VoiceConfig = {
  provider?: 'openai' | 'groq' | 'custom';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  language?: string;
};

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq:   { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
  custom: { baseUrl: '', model: 'whisper-1' },
};

export async function getVoiceConfig(userId: number): Promise<VoiceConfig> {
  const rows = await query<{ config: any; enabled: boolean }>(
    `SELECT config, enabled FROM connectors WHERE user_id=$1 AND name='voice'`, [userId]
  );
  const row = rows[0];
  if (!row?.enabled) return {};
  return row.config ?? {};
}

export async function transcribeBuffer(
  userId: number,
  buf: Buffer,
  filename: string,
  mime: string,
  audioSeconds?: number,
): Promise<{ text: string; cost?: number | null; model: string; provider: string }> {
  const cfg = await getVoiceConfig(userId);
  const provider = cfg.provider ?? 'openai';
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
  const baseUrl = cfg.baseUrl || defaults.baseUrl;
  const model = cfg.model || defaults.model;
  const apiKey = cfg.apiKey;
  if (!apiKey) throw new Error('voice connector: apiKey missing');
  if (!baseUrl) throw new Error('voice connector: baseUrl missing');

  const started = Date.now();
  const fd = new FormData();
  const uint8 = new Uint8Array(buf);
  fd.append('file', new Blob([uint8], { type: mime }), filename);
  fd.append('model', model);
  if (cfg.language) fd.append('language', cfg.language);
  fd.append('response_format', 'json');

  let ok = false;
  let text = '';
  let errMsg: string | null = null;
  try {
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });
    if (!res.ok) {
      errMsg = `${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      throw new Error(`transcription ${errMsg}`);
    }
    const data: any = await res.json();
    text = (data?.text ?? '').trim();
    ok = true;
  } finally {
    const durationMs = Date.now() - started;
    const cost = audioSeconds != null ? estimateCost(model, audioSeconds) : null;
    try {
      await query(
        `INSERT INTO agent_runs(user_id,kind,status,model,duration_ms,cost_usd,result,meta,error)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          userId,
          'voice_transcribe',
          ok ? 'ok' : 'error',
          model,
          durationMs,
          cost,
          text.slice(0, 8000) || null,
          { provider, baseUrl, audioSeconds: audioSeconds ?? null, bytes: buf.length, filename, mime },
          ok ? null : errMsg,
        ]
      );
    } catch (e) { console.error('[voice] log failed', e); }
  }

  const finalCost = audioSeconds != null ? estimateCost(model, audioSeconds) : null;
  return { text, cost: finalCost, model, provider };
}

const connector: Connector = {
  manifest: {
    name: 'voice',
    title: 'Voice Transcription',
    description: 'Transcribe Telegram voice/audio messages via Whisper (OpenAI or Groq).',
    configSchema: [
      { key: 'provider', label: 'Provider (openai | groq | custom)', type: 'text', required: true, placeholder: 'openai' },
      { key: 'apiKey', label: 'API key', type: 'password', required: true },
      { key: 'baseUrl', label: 'Base URL (optional override)', type: 'text', placeholder: 'https://api.openai.com/v1' },
      { key: 'model', label: 'Model (optional)', type: 'text', placeholder: 'whisper-1 / whisper-large-v3' },
      { key: 'language', label: 'Force language (ISO-639-1)', type: 'text', placeholder: 'it' },
    ],
  },
  tools: [
    {
      name: 'status',
      description: 'Check voice transcription provider/model in use.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const cfg = await getVoiceConfig(ctx.userId);
        if (!cfg.apiKey) return { configured: false };
        const provider = cfg.provider ?? 'openai';
        const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
        return { configured: true, provider, model: cfg.model || defaults.model, baseUrl: cfg.baseUrl || defaults.baseUrl, language: cfg.language || 'auto' };
      },
    },
  ],
};

export default connector;
