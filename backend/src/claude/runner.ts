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
  toolCalls?: Array<{ name: string; brief: string; ts: number }>;
  diagnosis?: { title: string; hint: string; rawTail?: string } | null;
};

function diagnose(opts: {
  exitCode: number | null;
  parsed: any;
  stderr: string;
  stdout: string;
}): { title: string; hint: string; rawTail?: string } | null {
  const { exitCode, parsed, stderr, stdout } = opts;
  const tail = stdout.split('\n').filter(Boolean).slice(-6).join('\n');
  const subtype = parsed?.subtype ?? '';

  // Exit 143 = SIGTERM (timeout)
  if (exitCode === 143) {
    return {
      title: '⏱️ Timeout',
      hint: 'Operazione superata il limite di tempo. Probabile MCP esterno lento (Canva, Notion, ecc.) o conversazione molto lunga. Riprova o spezza la richiesta in step più piccoli.',
      rawTail: tail,
    };
  }
  // Hook failure (SessionStart, PostToolUse, ecc.)
  if (/hook_response|hook_name|SessionStart|PreToolUse|PostToolUse/i.test(tail)) {
    const hookName = tail.match(/"hook_name":"([^"]+)"/)?.[1] ?? 'sconosciuto';
    return {
      title: '🪝 Hook fallito',
      hint: `Hook Claude "${hookName}" ha risposto con errore. Controlla la config dei plugin/hooks installati su Claude Code (~/.claude). Potrebbe essere un hook che si aspetta input o credenziali mancanti.`,
      rawTail: tail,
    };
  }
  // Max turns reached
  if (subtype === 'error_max_turns' || /max_turns|maximum.*turns/i.test(stderr + tail)) {
    return {
      title: '🔁 Limite turni raggiunto',
      hint: 'L\'agente ha esaurito il budget di turni interni senza concludere. Probabile loop. Riformula la richiesta in modo più specifico o limita l\'ambito.',
      rawTail: tail,
    };
  }
  // MCP server connect error
  const mcpMatch = /MCP.*server.*"([^"]+)".*(fail|error|disconnect)/i.exec(stderr + tail);
  if (mcpMatch) {
    return {
      title: `🔌 MCP server "${mcpMatch[1]}" non raggiungibile`,
      hint: 'Riconnetti il server MCP dalla pagina Connettori (sezione MCP esterni → Aggiorna) o ricarica il binario Claude CLI.',
      rawTail: tail,
    };
  }
  // Rate limit / quota
  if (/rate.?limit|quota|429|insufficient_quota/i.test(stderr + tail)) {
    return {
      title: '🚫 Rate limit / quota',
      hint: 'Hai superato il rate limit dell\'API Claude. Aspetta qualche minuto e riprova, oppure controlla credito/quota sulla console Anthropic.',
      rawTail: tail,
    };
  }
  // Auth / API key
  if (/authentication|unauthorized|401|403|invalid.*api.?key/i.test(stderr + tail)) {
    return {
      title: '🔑 Autenticazione fallita',
      hint: 'API key Claude mancante, scaduta o invalida. Verifica `~/.claude` o variabili ambiente `ANTHROPIC_API_KEY`.',
      rawTail: tail,
    };
  }
  // Network
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(stderr + tail)) {
    return {
      title: '🌐 Rete non disponibile',
      hint: 'Errore di connessione. Verifica la rete o se un firewall sta bloccando le chiamate API.',
      rawTail: tail,
    };
  }
  // is_error true with success subtype (the screenshot case)
  if (subtype === 'success' && parsed?.is_error) {
    return {
      title: '⚠️ Risposta vuota o tool error',
      hint: 'Il CLI ha chiuso senza output utile. Spesso causato da un hook che intercetta la sessione o da uno strumento che ha fallito silently. Riprova il prompt.',
      rawTail: tail,
    };
  }
  // Fallback: exit + subtype
  return {
    title: `Errore runtime (exit=${exitCode}${subtype ? `, ${subtype}` : ''})`,
    hint: 'Errore non classificato. Controlla i log del backend per dettagli completi.',
    rawTail: tail,
  };
}

export async function runClaude(userId: number, prompt: string, opts: ClaudeRunOptions = {}): Promise<ClaudeResult> {
  const started = Date.now();
  const kind = opts.kind ?? 'turn';

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
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null; finalEvent: any | null }>((resolve) => {
    const child = spawn(config.claudeBin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, SUPER_AGENT_USER_ID: String(userId) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let buf = '';
    let finalEvent: any = null;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      console.error(`[runner:u${userId}:${kind}] TIMEOUT after ${timeoutMs}ms — sending SIGTERM`);
      child.kill('SIGTERM');
    }, timeoutMs);
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
                // Origin tag — perk name, sub-agent title prefix, or generic "agent"
                kind: opts.kind ?? null,
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

  let combinedStderr = result.stderr.trim();
  let diagnosis: ReturnType<typeof diagnose> = null;
  if (!ok) {
    diagnosis = diagnose({ exitCode: result.code, parsed, stderr: result.stderr, stdout: result.stdout });
    const tail = result.stdout.split('\n').filter(Boolean).slice(-6).join('\n');
    const subtype = parsed?.subtype ? `subtype=${parsed.subtype}` : '';
    const isErr = parsed?.is_error ? 'is_error=true' : '';
    const exit = `exit=${result.code}`;
    combinedStderr = [combinedStderr, subtype, isErr, exit, tail ? `tail:\n${tail}` : '']
      .filter(Boolean).join(' · ').slice(0, 4000);
    console.error(`[runner:u${userId}:${kind}] failed`, { exit: result.code, subtype: parsed?.subtype, diagnosis: diagnosis?.title, stderrLen: result.stderr.length, stdoutLen: result.stdout.length });
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
    diagnosis,
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
