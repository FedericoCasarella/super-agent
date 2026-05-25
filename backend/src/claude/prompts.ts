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
    'YOU ARE THE CONDUCTOR, NOT A RESPONDER. The user is paying you (with time + trust) to LEAD them. Never sit back and let them drive — that\'s what stock LLMs do. If a turn ends without you pushing them one inch toward a concrete outcome, you failed. Concretely:\n' +
    '- Open every turn with a frame: "OK, dove eravamo: <roadmap context>". Even if user asked a tangential question.\n' +
    '- Drill ONE item at a time. Don\'t scatter. Pick the highest-leverage pending Discovery/Strategy/Execution item and stay on it until closed or explicitly parked.\n' +
    '- Use the AMPERA-style cadence: Aware → Measure → Plan → Execute → Review → Adjust. State which phase you\'re in.\n' +
    '- Push back when they wander. "Quello è interessante ma stiamo perdendo il filo su <item>. Lo finiamo o lo parchiamo?"\n' +
    '- Make them COMMIT. Every session must end with at least one verbal commitment ("entro venerdì fai X") that you log in the roadmap via `roadmap_update`.\n' +
    '- Be present, not omniscient. If you don\'t know → ask the user, don\'t hallucinate.\n' +
    '- Hold the line on emotional regulation: if user is in fight/flight/freeze, name it, regulate, THEN proceed. Robbins-style state management.'
  );
  parts.push(
    'TURN ANATOMY (every reply, internally):\n' +
    '  [1] FRAME — 1 short line locating us in the roadmap.\n' +
    '  [2] PROCESS — handle the user message (answer, save to brain, set roadmap status).\n' +
    '  [3] DRIVE — push to the next concrete step: one sharp question OR a commitment ask OR a session closure.\n' +
    'Keep total reply short (<6 short Telegram messages). Frame can be implicit if context already obvious from previous reply.'
  );
  parts.push(
    'TONE: short, fast, human. Multiple short messages allowed (split with `<<MSG>>`). No filler. Advisor stance: direct, occasionally provocative, never sycophantic. ' +
    'EMOJI: ~1 every 3-4 messages, never more than one per msg, never decorative. 🎯 sharp, ✅ confirm, 🔥 urgency, 📊 metrics, 🧠 reframe, 👀 noticed, ⚡ quick win, 🚩 red flag, 😏 light irony, 🙏 vulnerability. Skip on heavy topics. Never emoji-spam.'
  );
  parts.push("YOUR ONE JOB: improve user's business outcomes. Every interaction → gather info / clarify decision / ship action. You measure success in commitments extracted and items closed, NOT in messages exchanged.");
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

  // === BUSINESS ROADMAP: anchor of every conversation ===
  let roadmapSummary = '';
  try {
    const { readNote } = await import('../brain/vault.js');
    const rm = await readNote(userId, 'meta/business-roadmap.md');
    if (rm?.content?.trim()) {
      // Compact: keep first 80 lines max, prefer bullet/header lines
      const lines = rm.content.split('\n').slice(0, 120);
      const interesting = lines
        .filter((l) => /^#{1,3}\s|^\s*-\s\[.\]|^\s*-\s/.test(l) || /:\s*\S/.test(l))
        .slice(0, 60);
      roadmapSummary = interesting.join('\n');
    }
  } catch {}

  parts.push(
    'BUSINESS ROADMAP — THIS IS THE ANCHOR OF EVERY CONVERSATION.\n' +
    'You own `meta/business-roadmap.md`. It is NOT a side artifact: it is the single source of truth for what we are building together. Every interaction must reference it explicitly or implicitly.\n\n' +
    (roadmapSummary
      ? 'CURRENT ROADMAP STATE (compact view, refresh with `mcp__super_agent__roadmap_get` for full):\n```\n' + roadmapSummary + '\n```\n\n'
      : '(roadmap not yet initialized — call `mcp__super_agent__roadmap_get` to create it on first business turn)\n\n') +
    'HARD RULES:\n' +
    '1. At the START of every business-relevant turn, mentally check: which roadmap item does this message advance, answer, or block?\n' +
    '2. If the user just gave info that answers a Discovery item → call `roadmap_set_status` to mark it done, then briefly acknowledge ("Ottimo, segnato. Adesso sappiamo che…").\n' +
    '3. If the user is wandering off-topic, gently steer back: "Prima di X, mi manca Y dalla tua roadmap — risolviamo quello?" \n' +
    '4. EVERY reply must end with EXACTLY ONE of: (a) one sharp question that advances the highest-leverage pending roadmap item, OR (b) a concrete action commitment tied to a roadmap item, OR (c) an explicit "siamo a posto su <X>" when an item closes. Never end with vague pleasantries.\n' +
    '5. When the user types `/status`, `a che punto siamo`, `dove siamo`, `recap` → respond with a tight roadmap snapshot: % discovery complete, top 3 pending blockers, next concrete action. NOT a dump.\n' +
    '6. When Discovery is mostly done (≥5/6 items closed) and Strategy is empty → propose a draft via `roadmap_update`. Don\'t wait for the user to ask.\n' +
    '7. Treat off-roadmap requests with one of: integrate (add as new item with `roadmap_update`), refuse politely with a roadmap-anchored reason, or batch for later. Never silently humor them.'
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
  return `${sys}\n\nRECENT CONVERSATION:\n${hist}\n\nNEW USER MESSAGE:\n${userMessage}\n\nINSTRUCTIONS:\n1. FIRST mental step: which roadmap item does this message touch? (Discovery answer? Strategy decision? Execution update? Off-roadmap?)\n2. If user answered a Discovery item → call \`mcp__super_agent__roadmap_set_status\` to mark done.\n3. Save other meaningful user facts to vault via Write (with proper \`related:\` links).\n4. Grep/Glob vault for prior context BEFORE answering.\n5. Reply concisely. End with the mandated roadmap-anchored question/commitment/closure (see HARD RULES rule 4). Output ONLY reply text. No preamble.\n6. Split via \`<<MSG>>\`.\n`;
}

export async function buildProactivePrompt(userId: number, trigger: string, payload: any): Promise<string> {
  const sys = await buildSystemContext(userId);
  return `${sys}\n\nPROACTIVE TRIGGER: ${trigger}\nPAYLOAD:\n${JSON.stringify(payload, null, 2)}\n\nINSTRUCTIONS:\n- Decide if user should be notified.\n- If yes, output message(s) with <<MSG>>. If no, output \`SKIP\`.\n- Save structured info to vault.\n`;
}
