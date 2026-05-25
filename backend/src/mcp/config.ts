import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(__dirname, 'bridge.ts');

export const MCP_CONFIG_PATH = path.join(os.tmpdir(), 'polpo-brain-mcp.json');
// MCP server name MUST be a valid identifier (no dashes) — Claude prefixes
// tool names as `mcp__<server>__<tool>` and dashes break the allow-list match.
export const MCP_SERVER_NAME = 'polpo_brain';

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

export async function writeMcpConfig(): Promise<string> {
  const tsx = await findTsx();
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: tsx,
        args: [BRIDGE],
        env: {
          POLPO_BRAIN_API: `http://${config.host}:${config.port}`,
        },
      },
    },
  };
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return MCP_CONFIG_PATH;
}
