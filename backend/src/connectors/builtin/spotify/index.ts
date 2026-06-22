import type { Connector, ConnectorContext } from '../../types.js';

// Spotify connector — controlla la riproduzione sul PC dell'utente.
// L'agente chiama gli strumenti spotify_* (esposti via bridge MCP):
//   - spotify_play  → "metti un po' di musica" / "metti gli AC/DC" / "metti Thunderstruck degli AC/DC"
//   - spotify_pause / spotify_resume / spotify_next / spotify_now
// Auth: OAuth Authorization Code (refresh token salvato nello state del
// connettore). Il flow è gestito dalle rotte /connectors/spotify/auth|callback.
// Richiede Spotify Premium + un dispositivo attivo (app Spotify aperta).

export const SPOTIFY_SCOPES = [
  'user-modify-playback-state',
  'user-read-playback-state',
  'user-top-read',
  'user-read-recently-played',
];

const API = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

async function getAccessToken(ctx: ConnectorContext): Promise<string> {
  const clientId = ctx.config?.clientId;
  const clientSecret = ctx.config?.clientSecret;
  const st = ctx.state ?? {};
  const refreshToken = st.refreshToken;
  if (!clientId || !clientSecret) throw new Error('Spotify non configurato: inserisci Client ID e Client Secret nelle impostazioni del connettore.');
  if (!refreshToken) throw new Error('Spotify non collegato: vai su Connettori → Spotify → "Collega account".');
  // Token valido in cache (margine 30s).
  if (st.accessToken && st.expiresAt && Date.now() < st.expiresAt - 30_000) return st.accessToken;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Refresh token Spotify fallito: ' + (j.error_description || j.error || res.status));
  const accessToken = j.access_token as string;
  const expiresAt = Date.now() + ((j.expires_in ?? 3600) as number) * 1000;
  await ctx.saveState({ ...st, accessToken, expiresAt, refreshToken: j.refresh_token ?? refreshToken });
  return accessToken;
}

async function api(ctx: ConnectorContext, method: string, path: string, body?: any): Promise<any> {
  const tok = await getAccessToken(ctx);
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + tok, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const txt = await res.text();
  let j: any = {};
  try { j = txt ? JSON.parse(txt) : {}; } catch { j = { raw: txt }; }
  if (!res.ok) {
    const reason = j?.error?.reason || j?.error?.message || `Spotify ${res.status}`;
    const e: any = new Error(reason);
    e.status = res.status;
    throw e;
  }
  return j;
}

// Dispositivo su cui suonare: preferisci quello attivo, poi un Computer, poi il primo.
async function pickDeviceId(ctx: ConnectorContext): Promise<string | undefined> {
  const d = await api(ctx, 'GET', '/me/player/devices');
  const devices: any[] = d.devices ?? [];
  if (!devices.length) return undefined;
  const chosen = devices.find((x) => x.is_active) ?? devices.find((x) => x.type === 'Computer') ?? devices[0];
  return chosen?.id;
}

async function startPlayback(ctx: ConnectorContext, opts: { uris?: string[]; context_uri?: string }): Promise<void> {
  const deviceId = await pickDeviceId(ctx);
  if (!deviceId) throw new Error('Nessun dispositivo Spotify attivo. Apri l\'app Spotify sul PC (o avvia una riproduzione qualsiasi) e riprova.');
  await api(ctx, 'PUT', `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, opts);
}

const enc = encodeURIComponent;
const fmtTrack = (t: any) => `${t.name} — ${(t.artists ?? []).map((a: any) => a.name).join(', ')}`;

const connector: Connector = {
  manifest: {
    name: 'spotify',
    title: 'Spotify',
    description: 'Controlla la musica su Spotify dal PC. "Metti un po\' di musica" suona sui tuoi gusti; "metti gli AC/DC" suona l\'artista; "metti Thunderstruck degli AC/DC" suona il brano.',
    configSchema: [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'Dal Spotify Developer Dashboard' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Dal Spotify Developer Dashboard' },
    ],
  },
  tools: [
    {
      name: 'play',
      description:
        'Avvia la riproduzione su Spotify. Usa SOLO i parametri pertinenti alla richiesta. ' +
        'Brano specifico → passa "track" (e "artist" se citato): es. "metti Thunderstruck degli AC/DC" → {track:"Thunderstruck", artist:"AC/DC"}. ' +
        'Solo artista → "artist": es. "metti gli AC/DC" → {artist:"AC/DC"}. ' +
        'Richiesta generica/vaga ("metti un po\' di musica", "metti qualcosa") → NESSUN parametro: suona un mix basato sui gusti dell\'utente. ' +
        'Usa "query" solo se non riesci a distinguere artista da brano.',
      inputSchema: {
        type: 'object',
        properties: {
          track: { type: 'string', description: 'Titolo del brano' },
          artist: { type: 'string', description: 'Nome artista' },
          query: { type: 'string', description: 'Ricerca libera (fallback)' },
        },
      },
      handler: async (ctx, args) => {
        const track = (args?.track ?? '').toString().trim();
        const artist = (args?.artist ?? '').toString().trim();
        const query = (args?.query ?? '').toString().trim();

        // 1) Brano esplicito (eventualmente + artista).
        if (track) {
          const q = artist ? `track:${track} artist:${artist}` : track;
          const r = await api(ctx, 'GET', `/search?type=track&limit=1&q=${enc(q)}`);
          const item = r.tracks?.items?.[0];
          if (!item) throw new Error(`Brano non trovato: ${track}${artist ? ' di ' + artist : ''}`);
          await startPlayback(ctx, { uris: [item.uri] });
          return { ok: true, playing: fmtTrack(item) };
        }
        // 2) Solo artista → suona la radio/top dell'artista.
        if (artist) {
          const r = await api(ctx, 'GET', `/search?type=artist&limit=1&q=${enc(artist)}`);
          const a = r.artists?.items?.[0];
          if (!a) throw new Error(`Artista non trovato: ${artist}`);
          await startPlayback(ctx, { context_uri: a.uri });
          return { ok: true, playing: `${a.name} (artista)` };
        }
        // 3) Query libera → decidi brano vs artista.
        if (query) {
          const r = await api(ctx, 'GET', `/search?type=track,artist&limit=1&q=${enc(query)}`);
          const t0 = r.tracks?.items?.[0];
          const a0 = r.artists?.items?.[0];
          if (t0) { await startPlayback(ctx, { uris: [t0.uri] }); return { ok: true, playing: fmtTrack(t0) }; }
          if (a0) { await startPlayback(ctx, { context_uri: a0.uri }); return { ok: true, playing: `${a0.name} (artista)` }; }
          throw new Error(`Niente trovato per: ${query}`);
        }
        // 4) Generico → mix sui gusti dell'utente (top tracks, fallback recenti).
        let uris: string[] = [];
        try {
          const top = await api(ctx, 'GET', '/me/top/tracks?limit=40&time_range=medium_term');
          uris = (top.items ?? []).map((t: any) => t.uri).filter(Boolean);
        } catch { /* scope o nessun dato */ }
        if (!uris.length) {
          const rec = await api(ctx, 'GET', '/me/player/recently-played?limit=40');
          uris = (rec.items ?? []).map((i: any) => i.track?.uri).filter(Boolean);
        }
        if (!uris.length) throw new Error('Non trovo abbastanza ascolti per dedurre i tuoi gusti. Dimmi un artista o un brano.');
        // Dedup + shuffle leggero per varietà.
        uris = [...new Set(uris)].sort(() => Math.random() - 0.5).slice(0, 30);
        await startPlayback(ctx, { uris });
        return { ok: true, playing: `Mix sui tuoi gusti (${uris.length} brani)` };
      },
    },
    {
      name: 'pause',
      description: 'Mette in pausa la riproduzione Spotify.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (ctx) => { await api(ctx, 'PUT', '/me/player/pause'); return { ok: true, paused: true }; },
    },
    {
      name: 'resume',
      description: 'Riprende la riproduzione Spotify in pausa.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (ctx) => { await startPlayback(ctx, {}); return { ok: true, resumed: true }; },
    },
    {
      name: 'next',
      description: 'Salta al brano successivo su Spotify.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (ctx) => { await api(ctx, 'POST', '/me/player/next'); return { ok: true, skipped: true }; },
    },
    {
      name: 'now',
      description: 'Cosa sta suonando ora su Spotify.',
      inputSchema: { type: 'object', properties: {} },
      handler: async (ctx) => {
        const r = await api(ctx, 'GET', '/me/player/currently-playing');
        if (!r || !r.item) return { ok: true, playing: null, note: 'Niente in riproduzione.' };
        return { ok: true, playing: fmtTrack(r.item), isPlaying: !!r.is_playing };
      },
    },
  ],
};

export default connector;
