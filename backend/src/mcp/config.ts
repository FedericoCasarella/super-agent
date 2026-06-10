import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { config } from '../config.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// dev (tsx) → questo file è .ts e il bridge gira con tsx; prod (node dist) →
// è .js e il bridge gira con node sul .js compilato. Deriviamo l'estensione dal runtime.
const MOD_EXT = path.extname(__filename) || '.js';
const BRIDGE = path.resolve(__dirname, `bridge${MOD_EXT}`);

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

export async function writeMcpConfig(): Promise<string> {
  // In prod il bridge è già JS compilato → lo lanciamo con node (niente tsx runtime).
  // In dev resta tsx sul sorgente .ts.
  const isProd = MOD_EXT === '.js';
  const command = isProd ? process.execPath : await findTsx();
  const cfg = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command,
        args: [BRIDGE],
        env: {
          SUPER_AGENT_API: `http://${config.host}:${config.port}`,
        },
      },
    },
  };
  await fs.writeFile(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return MCP_CONFIG_PATH;
}
