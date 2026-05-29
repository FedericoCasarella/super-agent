import type { Connector } from '../../types.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Polpo connector (additive, upstream-safe) — sess.2261.
// ElevenLabs Text-to-Speech. Lets the agent reply with VOICE (the built-in
// `voice` connector is STT/Whisper only — this is the missing speak-back half).
// API ground-truthed from ~/scripts/voice_briefing.py.

const BASE = 'https://api.elevenlabs.io/v1';

const connector: Connector = {
  manifest: {
    name: 'elevenlabs',
    title: 'ElevenLabs Voice (TTS)',
    description: 'Text-to-speech via ElevenLabs. Synthesizes an mp3 the agent can send back as a Telegram voice note (e.g. Jarvis "Andy M"). Tool: speak.',
    configSchema: [
      { key: 'apiKey', label: 'ElevenLabs API Key', type: 'password', required: true },
      { key: 'voiceId', label: 'Voice ID', type: 'text', required: true, placeholder: 'es. Andy M voice id' },
      { key: 'modelId', label: 'Model (optional)', type: 'text', placeholder: 'eleven_turbo_v2_5' },
    ],
  },
  tools: [
    {
      name: 'speak',
      description: 'Synthesize speech from text via ElevenLabs and return the saved mp3 file path (the Telegram layer can then send it as a voice note). Use to reply with voice.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          voiceId: { type: 'string', description: 'Override the configured voice id.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      handler: async (ctx, { text, voiceId }) => {
        const apiKey = ctx.config?.apiKey;
        const vid = voiceId || ctx.config?.voiceId;
        if (!apiKey || !vid) throw new Error('elevenlabs: apiKey/voiceId missing');
        const model = ctx.config?.modelId || 'eleven_turbo_v2_5';
        const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(vid)}`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify({
            text,
            model_id: model,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });
        if (!res.ok) throw new Error(`elevenlabs TTS → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const out = path.join(os.tmpdir(), `eleven-${Date.now()}.mp3`);
        await fs.writeFile(out, buf);
        ctx.log('spoke', { chars: text.length, file: out, bytes: buf.length });
        return { file: out, bytes: buf.length, model };
      },
    },
  ],
};

export default connector;
