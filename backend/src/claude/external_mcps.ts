import { spawn } from 'node:child_process';
import { config } from '../config.js';

export type ExternalMcp = {
  rawName: string;     // "claude.ai Notion"
  serverName: string;  // "claude_ai_Notion" — what Claude prefixes tools with
  status: 'connected' | 'needs_auth' | 'error';
  url?: string;
};

let cache: ExternalMcp[] = [];
let cachedAt = 0;

function normalize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]+/g, '_');
}

function parse(stdout: string): ExternalMcp[] {
  const out: ExternalMcp[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(.+?):\s*(\S+)\s*-\s*(.+)$/);
    if (!m) continue;
    const [, name, url, statusRaw] = m;
    let status: ExternalMcp['status'] = 'error';
    if (/✓\s*Connected/i.test(statusRaw)) status = 'connected';
    else if (/Needs authentication/i.test(statusRaw)) status = 'needs_auth';
    out.push({ rawName: name.trim(), serverName: normalize(name.trim()), url: url.trim(), status });
  }
  return out;
}

export function listExternalMcps(): ExternalMcp[] {
  return cache;
}

export async function refreshExternalMcps(): Promise<ExternalMcp[]> {
  return new Promise((resolve) => {
    const child = spawn(config.claudeBin, ['mcp', 'list'], { env: process.env });
    let stdout = '';
    const t = setTimeout(() => child.kill('SIGTERM'), 15_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('close', () => {
      clearTimeout(t);
      cache = parse(stdout);
      cachedAt = Date.now();
      console.log(`[mcp:external] detected ${cache.length} servers (${cache.filter((x) => x.status === 'connected').length} connected)`);
      resolve(cache);
    });
    child.on('error', () => { clearTimeout(t); resolve(cache); });
  });
}

export function externalMcpAllowEntries(): string[] {
  return cache.filter((x) => x.status === 'connected').map((x) => `mcp__${x.serverName}`);
}
