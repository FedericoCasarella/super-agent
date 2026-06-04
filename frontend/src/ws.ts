import { useEffect, useRef } from 'react';

// =====================================================================
// Shared WebSocket — a single connection, pub/sub for the whole app.
// Hot pages used to open one socket per useWS() call which racked up many
// connections. Now everything subscribes through one socket.
//
// Reconnect with exponential backoff (1s → 30s) if the server drops.
// =====================================================================

type Listener = (msg: any) => void;

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: any = null;
const listeners = new Set<Listener>();
let connected = false;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { connected = true; reconnectAttempt = 0; };
  ws.onmessage = (ev) => {
    let msg: any = null;
    try { msg = JSON.parse(ev.data); } catch { return; }
    for (const l of listeners) {
      try { l(msg); } catch (e) { console.error('[ws listener]', e); }
    }
  };
  const reconnect = () => {
    connected = false; ws = null;
    if (reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
  };
  ws.onclose = reconnect;
  ws.onerror = () => { try { ws?.close(); } catch {} };
}

function ensureConnected() {
  if (!ws) connect();
}

// Subscribe to all socket messages. Returns cleanup fn.
export function subscribeWs(listener: Listener): () => void {
  ensureConnected();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useWS(onMessage: Listener) {
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;
  useEffect(() => {
    return subscribeWs((m) => cbRef.current(m));
  }, []);
  const ref = useRef<WebSocket | null>(ws);
  ref.current = ws;
  return ref;
}

// =====================================================================
// useLiveData — replaces setInterval polls with WS-driven invalidation.
//
//   useLiveData(loaderFn, {
//     refreshOn: ['team_task', 'team_task_tokens'],
//     fallbackMs: 60_000,         // safety net; can be set to 0 to disable
//     deps: [someId],             // re-run loader when these change
//   });
//
// loader is called:
//   - immediately on mount (and whenever deps change)
//   - whenever a matching WS message arrives (debounced 250ms so a burst of
//     events triggers a single refresh)
//   - every fallbackMs as a safety net
// =====================================================================
export function useLiveData(
  loader: () => void | Promise<void>,
  opts: { refreshOn: string[]; fallbackMs?: number; deps?: any[]; debounceMs?: number } = { refreshOn: [] },
) {
  const { refreshOn, fallbackMs = 60_000, deps = [], debounceMs = 250 } = opts;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: any = null;
    const fire = () => {
      if (cancelled) return;
      Promise.resolve(loaderRef.current()).catch(() => {});
    };
    const schedule = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fire, debounceMs);
    };

    fire(); // initial load

    const types = new Set(refreshOn);
    const off = subscribeWs((m) => { if (m?.type && types.has(m.type)) schedule(); });

    let fallback: any = null;
    if (fallbackMs > 0) fallback = setInterval(fire, fallbackMs);

    return () => {
      cancelled = true;
      off();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (fallback) clearInterval(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
