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

// `claude mcp list` prints one line per server: "<name>: <cmd-or-url> - <status>".
// Two traps make a naive `name: <token> - <status>` regex silently drop servers:
//   1. Status glyph is U+2714 "✔" (HEAVY CHECK MARK), not U+2713 "✓", and may
//      change across CLI versions — so we match the keyword, never the glyph.
//   2. The command/url segment is NOT a single token: locals are "bash -c …",
//      HTTP servers carry a " (HTTP)" suffix, python servers have multi-word
//      commands. The old regex only matched these by accident (e.g. on the dash
//      in "bash -c"), dropping every HTTP server (windsor/supabase/…).
// Robust approach: split the name on the first colon-whitespace, then read the
// status from a keyword anywhere in the remainder.
function parse(stdout: string): ExternalMcp[] {
  const out: ExternalMcp[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim(); // strip ANSI colour codes
    if (!/(Connected|Needs authentication|Failed to connect)/i.test(line)) continue;
    const m = line.match(/^(.+?):\s+(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2].trim();
    if (!name) continue;
    let status: ExternalMcp['status'] = 'error';
    if (/Needs authentication/i.test(rest)) status = 'needs_auth';
    else if (/connected/i.test(rest)) status = 'connected';
    const di = rest.lastIndexOf(' - ');
    const url = (di > 0 ? rest.slice(0, di) : rest).trim();
    out.push({ rawName: name, serverName: normalize(name), url, status });
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

// Claude prefixes MCP tools as `mcp__<internalServerName>__<tool>`, but
// `claude mcp list` shows the *display* name (e.g. "claude.ai flowspace"),
// not the actual internal server id (which can be a UUID for claude.ai-scope
// MCPs). Mapping display→internal isn't possible from the CLI output, so we
// just allow all MCP tools via a wildcard. Users can still gate per-MCP by
// disabling servers in claude.ai or removing them with `claude mcp remove`.
// Claude CLI requires `mcp__<server>__<toolPattern>` for allow rules.
// Bare `mcp__*` is rejected ("Wildcard tool name not supported in allow rules").
// Server names are normalize(rawName): "claude.ai flowspace" → "claude_ai_flowspace".
// We emit one wildcard per connected server. needs_auth excluded — Claude treats
// them as connectable and may try calls that hang.
export function externalMcpAllowEntries(): string[] {
  return cache
    .filter((x) => x.status === 'connected')
    .map((x) => `mcp__${x.serverName}__*`);
}
