import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { MCP_CONFIG_PATH, MCP_SERVER_NAME } from '../mcp/config.js';
import { query } from '../db/index.js';
import { externalMcpAllowEntries } from './external_mcps.js';

export type ClaudeKind = 'reflection' | 'chat_turn' | 'chitchat' | 'proactive' | 'scheduled' | 'turn' | string;

export type ClaudeRunOptions = {
  cwd?: string;
  timeoutMs?: number;
  allowedTools?: string[];
  useMcp?: boolean;
  kind?: ClaudeKind;
  meta?: Record<string, any>;
  // Override esplicito del modello (precedenza assoluta su routing)
  model?: string;
  // Testo utente (solo per kind='chat_turn') usato dall'heuristic chitchat.
  // Se <=30 char AND no '?' -> route a haiku (10x piu' economico).
  userText?: string;
};

const HAIKU_MODEL = process.env.CLAUDE_HAIKU_MODEL || 'claude-haiku-4-5-20251001';
const CHITCHAT_MAX_CHARS = 30;

// Heuristic model routing — chitchat/saluti vanno su Haiku, il resto su Sonnet.
// Cosi' un "ok"/"grazie"/"ciao" costa ~10x meno di un turn analitico.
function pickModel(opts: ClaudeRunOptions): string {
  if (opts.model) return opts.model;
  const kind = opts.kind ?? 'turn';
  if (kind === 'chitchat') return HAIKU_MODEL;
  if (kind === 'chat_turn' && opts.userText) {
    const t = opts.userText.trim();
    if (t.length > 0 && t.length <= CHITCHAT_MAX_CHARS && !t.includes('?')) return HAIKU_MODEL;
  }
  return config.claudeModel;
}

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
  const model = pickModel(opts);

  const args = ['-p', prompt, '--output-format', 'json', '--model', model];
  if (opts.useMcp !== false) {
    args.push('--mcp-config', MCP_CONFIG_PATH);
  }
  const allowed = opts.allowedTools ?? [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    `mcp__${MCP_SERVER_NAME}`,
    ...externalMcpAllowEntries(),
  ];
  args.push('--allowed-tools', allowed.join(','));

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(config.claudeBin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, POLPO_BRAIN_USER_ID: String(userId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ stdout: '', stderr: String(err), code: null }); });
  });

  const durationMs = Date.now() - started;
  let parsed: any = null;
  try { parsed = JSON.parse(result.stdout); } catch {}

  const text = (parsed?.result ?? result.stdout).trim();
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
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        userId, kind, ok ? 'ok' : 'error', model, durationMs,
        out.inputTokens ?? null, out.outputTokens ?? null,
        out.cacheCreationTokens ?? null, out.cacheReadTokens ?? null,
        out.costUsd ?? null, out.numTurns ?? null,
        prompt.slice(0, 8000), text.slice(0, 8000),
        opts.meta ?? {},
        ok ? null : (result.stderr || `exit ${result.code}`).slice(0, 2000),
      ]
    );
    out.runId = rows[0]?.id;
  } catch (e) { console.error('[runner] failed to log run', e); }

  return out;
}
