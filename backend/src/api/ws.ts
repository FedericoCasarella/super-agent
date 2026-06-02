import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { bus } from '../bus.js';
import { verifyToken, getDevUser } from '../auth/index.js';
import { config } from '../config.js';
import { query } from '../db/index.js';
import cookie from 'cookie';

// Persist every tool:use event to DB for permanent history (paginated)
bus.on('tool:use', (m: any) => {
  if (!m?.userId || !m?.name) return;
  query(
    `INSERT INTO tool_events(user_id, name, server, is_mcp, brief, kind) VALUES($1,$2,$3,$4,$5,$6)`,
    [m.userId, m.name, m.server ?? null, !!m.isMcp, (m.brief ?? '').slice(0, 800), m.kind ?? null],
  ).catch((e) => console.error('[tool_events] insert failed', e?.message ?? e));
});

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

  wss.on('connection', async (ws, req) => {
    // Cookie auth first; fall back to the dev user in local dev (no cookie).
    const userId = parseUserId(req) ?? (await getDevUser())?.id ?? null;
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
  bus.on('brain:access', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'brain:access', payload: m }); });
  bus.on('subagent:event', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'subagent', payload: m }); });
  bus.on('tool:use', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'tool:use', payload: m }); });
  bus.on('outbound:logged', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'outbound', payload: m }); });
  bus.on('wa:qr', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:qr', payload: m }); });
  bus.on('wa:connected', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:connected', payload: m }); });
  bus.on('wa:closed', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:closed', payload: m }); });
  bus.on('wa:message', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:message', payload: m }); });
  bus.on('wa:bonify', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:bonify', payload: m }); });
  bus.on('wa:synced', (m: any) => { if (m.userId) broadcast(m.userId, { type: 'wa:synced', payload: m }); });
}
