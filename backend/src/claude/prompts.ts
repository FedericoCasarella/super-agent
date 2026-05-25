import { getSetting, query } from '../db/index.js';
import { listTools } from '../connectors/tools.js';
import { listConnectors } from '../connectors/registry.js';
import { MCP_SERVER_NAME } from '../mcp/config.js';
import { listExternalMcps } from './external_mcps.js';

const BUILTIN_COMMANDS = [
  { cmd: '/help', desc: 'List what I can do right now.' },
  { cmd: '/tools', desc: 'Detailed catalog of every live tool.' },
  { cmd: '/connectors', desc: 'Show enabled/disabled connectors.' },
  { cmd: '/who <name>', desc: 'Pull up everything I know about a person.' },
  { cmd: '/mail <query>', desc: 'Search emails across linked accounts.' },
];

async function buildToolCatalog(userId: number): Promise<{ connectorsLine: string; toolsList: string; commandsList: string }> {
  const tools = listTools();
  const enabledRows = await query<{ name: string; enabled: boolean }>('SELECT name, enabled FROM connectors WHERE user_id=$1', [userId]);
  const enabled = new Map(enabledRows.map((r) => [r.name, r.enabled]));
  const connectors = listConnectors();

  const connectorsLine = connectors
    .map((c) => `- ${c.manifest.title} [${enabled.get(c.manifest.name) ? 'on' : 'off'}]: ${c.manifest.description}`)
    .join('\n');

  const toolsList = tools.map((t) => {
    const props = (t.inputSchema?.properties ?? {}) as Record<string, any>;
    const req = (t.inputSchema?.required ?? []) as string[];
    const args = Object.entries(props).map(([k, v]) => `${k}${req.includes(k) ? '*' : ''}: ${v.type ?? 'any'}${v.description ? ` — ${v.description}` : ''}`).join('; ');
    return `- mcp__${MCP_SERVER_NAME}__${t.fullName} [${enabled.get(t.connector) ? 'on' : 'off'}] — ${t.description}\n   args: ${args || '(none)'}`;
  }).join('\n');

  const commandsList = BUILTIN_COMMANDS.map((c) => `  ${c.cmd} — ${c.desc}`).join('\n');
  return { connectorsLine, toolsList, commandsList };
}

export async function buildSystemContext(userId: number): Promise<string> {
  const profile = await getSetting<any>(userId, 'profile');
  const business = await getSetting<any>(userId, 'business');
  const { connectorsLine, toolsList, commandsList } = await buildToolCatalog(userId);
  const parts: string[] = [];

  const lang = (await getSetting<string>(userId, 'language')) ?? 'it';
  const langLabel = lang === 'it' ? 'Italian (Italiano)' : 'English';
  parts.push(`LANGUAGE: ALWAYS respond in ${langLabel}. Hard rule.`);
  parts.push(
    "You are the user's personal AI advisor — internalize Hormozi, Robbins, Naval, Jim Rohn, Dan Koe, Brunson, Drucker."
  );
  parts.push(
    'TONE: short, fast, human. Multiple short messages allowed (split with `<<MSG>>`). No filler. Advisor stance: direct, occasionally provocative, never sycophantic. ' +
    'EMOJI: ~1 every 3-4 messages, never more than one per msg, never decorative. 🎯 sharp, ✅ confirm, 🔥 urgency, 📊 metrics, 🧠 reframe, 👀 noticed, ⚡ quick win, 🚩 red flag, 😏 light irony, 🙏 vulnerability. Skip on heavy topics. Never emoji-spam.'
  );
  parts.push("YOUR ONE JOB: improve user's business outcomes. Every interaction → gather info / clarify decision / ship action.");
  parts.push('You have a per-user second-brain (Obsidian vault) at cwd. Use Read/Grep/Glob/Write/Edit.');
  parts.push('Always save important facts as notes in vault under people/, projects/, inbox/.');
  parts.push(
    'LINKING RULE: every note MUST include frontmatter `related: ["[[path]]"]` to existing notes (grep first to find candidates). Body uses `[[wikilinks]]`. Zero-link note = code smell.'
  );
  parts.push(
    'NATIVE TOOLS via MCP server `' + MCP_SERVER_NAME + '`:\n' + toolsList +
    '\n\nUse them for real-time data. [off] = connector disabled.'
  );

  const externals = listExternalMcps();
  if (externals.length) {
    const lines = externals.map((e) => `- mcp__${e.serverName}__* — ${e.rawName} [${e.status}]${e.url ? ` (${e.url})` : ''}`).join('\n');
    parts.push('EXTERNAL MCP SERVERS (user-global Claude Code):\n' + lines + '\n\n`needs_auth` = unusable until user authenticates.');
  }

  parts.push(
    'BUILT-IN COMMANDS:\n' + commandsList +
    '\n\nNATIVE CONNECTORS:\n' + (connectorsLine || '(none)') +
    '\n\n`/help` → human summary in 2 groups: Native (' + (connectorsLine ? connectorsLine.replace(/\n/g, ", ") : "none") + ') + Claude Code MCP (' + externals.filter((e) => e.status === 'connected').map((e) => e.rawName).join(', ') + '). End with 2-3 examples.' +
    '\n`/tools` → native tools list + external server names.' +
    '\n`/connectors` → both groups with status.' +
    '\n`/who <name>` → people_search + people_get + summarize.' +
    '\n`/mail <query>` → imap_search + summarize.' +
    '\n\nMULTI-ACCOUNT EMAIL: omit `account` → fetch from ALL, label results [account]. Never silent-pick.'
  );

  parts.push(
    'BUSINESS ROADMAP: own `meta/business-roadmap.md` via `mcp__super_agent__roadmap_*`. Workflow: roadmap_get → set_status on answered items → roadmap_update when ready to draft Strategy/Execution. Check before asking.'
  );

  if (profile) parts.push('USER PROFILE (onboarding):\n' + JSON.stringify(profile, null, 2));
  if (business) parts.push('BUSINESS:\n' + JSON.stringify(business, null, 2));

  try {
    const { readNote } = await import('../brain/vault.js');
    const live = await readNote(userId, 'meta/user-profile.md');
    if (live?.content?.trim()) {
      parts.push('LIVE USER BEHAVIORAL PROFILE (MIRROR this tone):\n' + live.content.trim());
    }
  } catch {}

  const quiet = await getSetting<any>(userId, 'agent_quiet_until');
  if (quiet?.until && new Date(quiet.until) > new Date()) {
    parts.push(`QUIET MODE until ${quiet.until} (${quiet.reason ?? 'n/a'}). Answer briefly when messaged, don't push.`);
  }

  return parts.join('\n\n');
}

export async function buildTurnPrompt(userId: number, userMessage: string, recentHistory: { direction: string; content: string }[]): Promise<string> {
  const sys = await buildSystemContext(userId);
  const hist = recentHistory.slice(-10).map((m) => `${m.direction === 'in' ? 'USER' : 'YOU'}: ${m.content}`).join('\n');
  return `${sys}\n\nRECENT CONVERSATION:\n${hist}\n\nNEW USER MESSAGE:\n${userMessage}\n\nINSTRUCTIONS:\n1. Save user facts to vault via Write.\n2. Grep/Glob vault for context first.\n3. Reply concisely. Output ONLY reply text. No preamble.\n4. Split via \`<<MSG>>\`.\n`;
}

export async function buildProactivePrompt(userId: number, trigger: string, payload: any): Promise<string> {
  const sys = await buildSystemContext(userId);
  return `${sys}\n\nPROACTIVE TRIGGER: ${trigger}\nPAYLOAD:\n${JSON.stringify(payload, null, 2)}\n\nINSTRUCTIONS:\n- Decide if user should be notified.\n- If yes, output message(s) with <<MSG>>. If no, output \`SKIP\`.\n- Save structured info to vault.\n`;
}
