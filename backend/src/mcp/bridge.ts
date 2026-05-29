#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const API = process.env.SUPER_AGENT_API ?? 'http://127.0.0.1:8787';
const USER_ID = process.env.SUPER_AGENT_USER_ID ?? '';

type ToolDef = { name: string; connector: string; description: string; inputSchema: any };

async function fetchTools(): Promise<ToolDef[]> {
  const res = await fetch(`${API}/api/tools`);
  if (!res.ok) throw new Error(`tools list failed: ${res.status}`);
  return res.json();
}

async function invoke(name: string, args: any): Promise<any> {
  if (!USER_ID) throw new Error('SUPER_AGENT_USER_ID not set in bridge env');
  const res = await fetch(`${API}/api/tools/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-super-agent-user': USER_ID },
    body: JSON.stringify(args ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !(body as any).ok) {
    throw new Error((body as any).error || `tool failed: ${res.status}`);
  }
  return (body as any).result;
}

async function main() {
  const server = new Server(
    { name: 'super-agent', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  let tools: ToolDef[] = [];
  try { tools = await fetchTools(); } catch (e) { console.error('[mcp] fetch tools failed', e); }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { tools = await fetchTools(); } catch {}
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: `[${t.connector}] ${t.description}`,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await invoke(name, args ?? {});
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: String(e?.message ?? e) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => { console.error(e); process.exit(1); });
