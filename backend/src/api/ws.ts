import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { bus } from '../bus.js';
import { verifyToken } from '../auth/index.js';
import { config } from '../config.js';
import cookie from 'cookie';

type Client = { ws: WebSocket; userId: number };

function parseUserId(req: any): number | null {
  const cookies = cookie.parse(req.headers.cookie ?? '');
  const tok = cookies[config.cookieName];
  if (!tok) return null;
  const d = verifyToken(tok);
  return d?.uid ?? null;
}

export function attachWs(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<Client>();

  wss.on('connection', (ws, req) => {
    const userId = parseUserId(req);
    if (!userId) { ws.close(1008, 'unauthenticated'); return; }
    const client: Client = { ws, userId };
    clients.add(client);
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
    ws.on('close', () => clients.delete(client));
  });

  function broadcast(userId: number, msg: any) {
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  bus.on('message:logged', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'message', payload: m }); });
  bus.on('connector:event', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'connector', payload: m }); });
  bus.on('connectors:changed', () => { for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ type: 'connectors:changed' })); });
}
