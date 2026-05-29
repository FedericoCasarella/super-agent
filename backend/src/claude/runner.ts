import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from '../config.js';
import { MCP_CONFIG_PATH, MCP_SERVER_NAME } from '../mcp/config.js';
import { query } from '../db/index.js';
import { externalMcpAllowEntries } from './external_mcps.js';
import { listVaults } from '../brain/vaults.js';
import { bus } from '../bus.js';

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
  // Cooperative cancellation (sess.2939): abort kills the claude child process so a
  // user-cancelled sub-agent actually stops burning tokens instead of running to completion.
  signal?: AbortSignal;
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
  toolCalls?: Array<{ name: string; brief: string; ts: number }>;
};

export async function runClaude(userId: number, prompt: string, opts: ClaudeRunOptions = {}): Promise<ClaudeResult> {
  const started = Date.now();
  const kind = opts.kind ?? 'turn';
  const model = pickModel(opts);

  // Inject current datetime (Claude CLI has no clock).
  const finalPrompt = `now=${new Date().toISOString()}\n\n${prompt}`;

  const args = ['-p', finalPrompt, '--output-format', 'stream-json', '--verbose', '--model', config.claudeModel];
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
  const claudeCwd = opts.cwd ?? process.cwd();
  function mapBrainAccess(filePath: string): { vaultName: string; rel: string } | null {
    // Resolve against Claude CLI's cwd (vault root), not node process cwd.
    const norm = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(claudeCwd, filePath);
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

  const toolCalls: Array<{ name: string; brief: string; ts: number }> = [];
  function briefForTool(name: string, input: any): string {
    if (!input || typeof input !== 'object') return '';
    if (name === 'Read' || name === 'Write' || name === 'Edit') return String(input.file_path ?? '').slice(0, 200);
    if (name === 'Grep') return `${input.pattern ?? ''} ${input.path ? `in ${input.path}` : ''}`.slice(0, 200);
    if (name === 'Glob') return String(input.pattern ?? input.path ?? '').slice(0, 200);
    if (name === 'Bash') return String(input.command ?? '').slice(0, 200);
    if (name === 'WebFetch' || name === 'WebSearch') return String(input.url ?? input.query ?? '').slice(0, 200);
    // MCP tools — surface first string-like arg
    for (const k of Object.keys(input)) {
      const v = input[k];
      if (typeof v === 'string' && v.length) return `${k}: ${v.slice(0, 180)}`;
    }
    return '';
  }
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null; finalEvent: any | null; assistantText: string }>((resolve) => {
    const child = spawn(config.claudeBin, args, {
      cwd: opts.cwd ?? process.cwd(),
      // merge sess.2938: rebrand POLPO_BRAIN_USER_ID + shim SUPER_AGENT_USER_ID
      // così sia il nostro codice rebrandizzato sia le feature nuove di Federico leggono lo userId.
      env: { ...process.env, POLPO_BRAIN_USER_ID: String(userId), SUPER_AGENT_USER_ID: String(userId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let buf = '';
    let finalEvent: any = null;
<<<<<<< HEAD
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      console.error(`[runner:u${userId}:${kind}] TIMEOUT after ${timeoutMs}ms — sending SIGTERM`);
      child.kill('SIGTERM');
    }, timeoutMs);
=======
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      console.error(`[runner:u${userId}:${kind}] TIMEOUT after ${timeoutMs}ms — sending SIGTERM`);
      child.kill('SIGTERM');
    }, timeoutMs);
    let lastAssistantText = ''; // fallback if the 'result' event never arrives (truncation/SIGTERM)
    const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
>>>>>>> origin/polpo-fork
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
            const turnTexts: string[] = [];
            for (const block of ev.message.content) {
              if (block?.type === 'text' && typeof block.text === 'string') turnTexts.push(block.text);
              if (block?.type !== 'tool_use') continue;
              const name = block.name as string;
              const input = block.input ?? {};
              const briefStr = briefForTool(name, input);
              toolCalls.push({ name, brief: briefStr, ts: Date.now() });
              // Broadcast tool use (mcp + native) for live UI
              const isMcp = name.startsWith('mcp__');
              bus.emit('tool:use', {
                userId,
                name,
                brief: briefStr,
                isMcp,
                // pretty server: mcp__<server>__tool → <server>
                server: isMcp ? (name.split('__')[1] ?? null) : null,
                ts: Date.now(),
              });
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
            if (turnTexts.length) lastAssistantText = turnTexts.join('');
          }
          if (ev?.type === 'result') finalEvent = ev;
        } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, code, finalEvent, assistantText: lastAssistantText }); });
    child.on('error', (err) => { clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); resolve({ stdout: '', stderr: String(err), code: null, finalEvent: null, assistantText: lastAssistantText }); });
  });

  const durationMs = Date.now() - started;
  const parsed: any = result.finalEvent;

  // Fallback (sess.2939): stream-json only sets finalEvent on a 'result' line. On a
  // truncated / SIGTERM'd run that event never arrives → parsed is null → the reply was
  // silently empty. Fall back to the last streamed assistant text so the user still gets
  // the partial answer instead of nothing, and treat a clean-exit-with-text as ok.
  const text = (parsed?.result ?? result.assistantText ?? '').trim();
  const usage = parsed?.usage ?? {};
  const ok = result.code === 0 && (parsed ? parsed.subtype !== 'error_during_execution' : text.length > 0);

  // Build richer stderr when failure: include error subtype + last stdout lines for diagnosis
  let combinedStderr = result.stderr.trim();
  if (!ok) {
    const tail = result.stdout.split('\n').filter(Boolean).slice(-6).join('\n');
    const subtype = parsed?.subtype ? `subtype=${parsed.subtype}` : '';
    const isErr = parsed?.is_error ? 'is_error=true' : '';
    const exit = `exit=${result.code}`;
    combinedStderr = [combinedStderr, subtype, isErr, exit, tail ? `tail:\n${tail}` : '']
      .filter(Boolean).join(' · ').slice(0, 4000);
    console.error(`[runner:u${userId}:${kind}] failed`, { exit: result.code, subtype: parsed?.subtype, stderrLen: result.stderr.length, stdoutLen: result.stdout.length });
  }

  const out: ClaudeResult = {
    ok, text, stderr: combinedStderr, exitCode: result.code,
    costUsd: parsed?.total_cost_usd,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    numTurns: parsed?.num_turns,
    toolCalls,
    durationMs,
  };

  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO agent_runs(user_id,kind,status,model,duration_ms,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,num_turns,prompt,result,meta,error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15) RETURNING id`,
      [
        userId, kind, ok ? 'ok' : 'error', model, durationMs,
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
