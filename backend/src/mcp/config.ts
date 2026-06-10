import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, 'bridge.ts');

export const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'super-agent-mcp.json');
// MCP server name MUST be a valid identifier (no dashes) — Claude prefixes
// tool names as `mcp__<server>__<tool>` and dashes break the allow-list match.
export const MCP_SERVER_NAME = 'super_agent';

async function findTsx(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, '../../node_modules/.bin/tsx'),
    path.resolve(__dirname, '../../../node_modules/.bin/tsx'),
  ];
  for (const c of candidates) {
    try { await fs.access(c); return c; } catch {}
  }
  return 'tsx';
}

// Pull the user's local `mcpServers` from `~/.claude.json` (root + every
// project entry) so headless `claude -p --mcp-config <path>` keeps access to
// command/stdio MCPs the user already registered (figma, custom local
// scripts, etc.). claude.ai-scope OAuth MCPs are NOT here — those live in
// the Claude cloud config and require interactive re-auth when expired.
async function readUserMcpServers(): Promise<Record<string, any>> {
  const merged: Record<string, any> = {};
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed.mcpServers ?? {})) {
      if (v && typeof v === 'object') merged[k] = v;
    }
    for (const proj of Object.values(parsed.projects ?? {}) as any[]) {
      for (const [k, v] of Object.entries(proj?.mcpServers ?? {})) {
        if (v && typeof v === 'object' && !merged[k]) merged[k] = v;
      }
    }
  } catch {}
  return merged;
}

export async function writeMcpConfig(): Promise<string> {
  const tsx = await findTsx();
  const userServers = await readUserMcpServers();
  const cfg = {
    mcpServers: {
      ...userServers,
      // Our bridge wins on name conflict — never overridden by user config.
      [MCP_SERVER_NAME]: {
        command: tsx,
        args: [BRIDGE],
        env: {
          SUPER_AGENT_API: `http://${config.host}:${config.port}`,
        },
      },
    },
  };
  const ext = Object.keys(userServers);
  if (ext.length) console.log(`[mcp:config] merged ${ext.length} user mcpServers: ${ext.join(', ')}`);
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return MCP_CONFIG_PATH;
}
