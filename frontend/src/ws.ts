import { useEffect, useRef } from 'react';

export function useWS(onMessage: (msg: any) => void) {
  const ref = useRef<WebSocket | null>(null);
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ref.current = ws;
    ws.onmessage = (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch {}
    };
    return () => ws.close();
  }, []);
  return ref;
}
