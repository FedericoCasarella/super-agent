import { useEffect, useRef, useState } from 'react';

// Auto-reconnecting WebSocket with exposed connection state (sess.2939).
// Previously the socket never reconnected on drop — which is why pages layered
// setInterval polling on top as a safety net. With reconnect + `connected` state,
// pages can trust the WS for liveness (honest "realtime" indicator) and keep only
// a slow poll for data the socket doesn't push.
export function useWS(onMessage: (msg: any) => void) {
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closedByUs = false;
    let backoff = 1000;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onmessage = (ev) => { try { cbRef.current(JSON.parse(ev.data)); } catch {} };
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) { retry = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); }
      };
      ws.onerror = () => { try { ws?.close(); } catch {} };
    }
    connect();

    return () => { closedByUs = true; if (retry) clearTimeout(retry); ws?.close(); };
  }, []);

  return { connected };
}
