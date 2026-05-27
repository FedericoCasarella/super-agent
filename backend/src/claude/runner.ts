import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { MCP_CONFIG_PATH, MCP_SERVER_NAME } from '../mcp/config.js';
import { query } from '../db/index.js';
import { externalMcpAllowEntries } from './external_mcps.js';
import { listVaults } from '../brain/vaults.js';
import { bus } from '../bus.js';

export type ClaudeRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  useMcp?: boolean;
  kind?: string;
  meta?: Record<string, any>;
};

export type ClaudeResult = {
  ok: boolean;
  text: string;
  stderr: string;
  exitCode: number | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  numTurns?: number;
  durationMs?: number;
  runId?: number;
};

export async function runClaude(userId: number, prompt: string, opts: ClaudeRunOptions = {}): Promise<ClaudeResult> {
  const started = Date.now();
  const kind = opts.kind ?? 'turn';

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', config.claudeModel];
  if (opts.useMcp !== false) {
    args.push('--mcp-config', MCP_CONFIG_PATH);
  }
  const allowed = opts.allowedTools ?? [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash',
    `mcp__${MCP_SERVER_NAME}`,
    ...externalMcpAllowEntries(),
  ];
  args.push('--allowed-tools', allowed.join(','));

  // Pre-load vault paths for brain:access mapping
  const vaults = await listVaults(userId).catch(() => []);
  function mapBrainAccess(filePath: string): { vaultName: string; rel: string } | null {
    const norm = path.resolve(filePath);
    for (const v of vaults) {
      const vp = path.resolve(v.path);
      if (norm === vp || norm.startsWith(vp + path.sep)) {
        const rel = norm === vp ? '' : norm.slice(vp.length + 1);
        if (!rel.toLowerCase().endsWith('.md')) return null;
        return { vaultName: v.name, rel };
      }
    }
    return null;
  }

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null; finalEvent: any | null }>((resolve) => {
    const child = spawn(config.claudeBin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, SUPER_AGENT_USER_ID: String(userId) },
    });
    let stdout = '', stderr = '';
    let buf = '';
    let finalEvent: any = null;
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      buf += s;
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          // Detect tool_use blocks → emit brain:access
          if (ev?.type === 'assistant' && ev.message?.content) {
            for (const block of ev.message.content) {
              if (block?.type !== 'tool_use') continue;
              const name = block.name as string;
              const input = block.input ?? {};
              const candidatePaths: string[] = [];
              if (name === 'Read' || name === 'Write' || name === 'Edit') {
                if (input.file_path) candidatePaths.push(input.file_path);
              } else if (name === 'Grep' || name === 'Glob') {
                if (input.path) candidatePaths.push(input.path);
              }
              for (const p of candidatePaths) {
                const hit = mapBrainAccess(p);
                if (hit) {
                  bus.emit('brain:access', {
                    userId, vaultName: hit.vaultName, rel: hit.rel,
                    tool: name, ts: Date.now(),
                  });
                }
              }
            }
          }
          if (ev?.type === 'result') finalEvent = ev;
        } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, finalEvent }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', stderr: String(err), code: null, finalEvent: null }); });
  });

  const durationMs = Date.now() - started;
  const parsed: any = result.finalEvent;

  const text = (parsed?.result ?? '').trim();
  const usage = parsed?.usage ?? {};
  const ok = result.code === 0 && !!parsed && parsed.subtype !== 'error_during_execution';

  const out: ClaudeResult = {
    ok, text, stderr: result.stderr.trim(), exitCode: result.code,
    costUsd: parsed?.total_cost_usd,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    numTurns: parsed?.num_turns,
    durationMs,
  };

  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO agent_runs(user_id,kind,status,model,duration_ms,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,num_turns,prompt,result,meta,error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING id`,
      [
        userId, kind, ok ? 'ok' : 'error', config.claudeModel, durationMs,
        out.inputTokens ?? null, out.outputTokens ?? null,
        out.cacheCreationTokens ?? null, out.cacheReadTokens ?? null,
        out.costUsd ?? null, out.numTurns ?? null,
        prompt.slice(0, 8000), text.slice(0, 8000),
        JSON.stringify(opts.meta ?? {}),
        ok ? null : (result.stderr || `exit ${result.code}`).slice(0, 2000),
      ]
    );
    out.runId = rows[0]?.id;
  } catch (e) { console.error('[runner] failed to log run', e); }

  return out;
}
