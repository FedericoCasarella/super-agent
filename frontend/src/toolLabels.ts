// Friendly labels + descriptions for tool names shown in UI.
export type ToolMeta = { label: string; desc: string };

const NATIVE: Record<string, ToolMeta> = {
  Read:       { label: 'Legge file',          desc: 'Apre e legge il contenuto di un file dal disco o dal second brain.' },
  Write:      { label: 'Scrive file',          desc: 'Crea o sovrascrive un file (es. una nota nel brain).' },
  Edit:       { label: 'Modifica file',        desc: 'Cambia parti di un file esistente.' },
  Glob:       { label: 'Cerca file',           desc: 'Trova file usando un pattern (es. *.md).' },
  Grep:       { label: 'Cerca testo',          desc: 'Cerca una stringa o regex dentro file.' },
  Bash:       { label: 'Esegue comando',       desc: 'Lancia un comando shell. Usato per operazioni di sistema.' },
  WebFetch:   { label: 'Visita pagina web',    desc: 'Scarica e legge il contenuto di un URL.' },
  WebSearch:  { label: 'Cerca sul web',        desc: 'Esegue una ricerca web e ritorna i risultati.' },
  Task:       { label: 'Sub-agente',           desc: 'Lancia un agente specializzato in background.' },
  TodoWrite:  { label: 'Aggiorna TODO',         desc: 'Modifica la lista interna di task in corso.' },
  NotebookEdit:{ label: 'Modifica notebook',   desc: 'Cambia celle di un Jupyter notebook.' },
};

// MCP server-level labels (server name → "user-facing")
const MCP_SERVERS: Record<string, string> = {
  super_agent:   'super-agent',
  'super-agent': 'super-agent',
  canva:         'Canva',
  notion:        'Notion',
  gmail:         'Gmail',
  calendar:      'Calendar',
  whatsapp:      'WhatsApp',
  telegram:      'Telegram',
  flowspace:     'Flowspace',
  drive:         'Google Drive',
};

// MCP tool suffix → friendly (best-effort heuristics)
function humanizeMcpToolSuffix(s: string): string {
  if (!s) return 'azione';
  return s
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function describeTool(name: string, server: string | null, isMcp: boolean): ToolMeta {
  if (!isMcp) {
    return NATIVE[name] ?? { label: name, desc: `Tool nativo Claude "${name}".` };
  }
  // mcp__<server>__<tool> or already split
  const parts = name.split('__');
  const srv = (server ?? parts[1] ?? 'sconosciuto').toLowerCase();
  const tool = parts.slice(2).join('_') || parts[parts.length - 1] || '';
  const srvLabel = MCP_SERVERS[srv] ?? srv;
  const toolLabel = humanizeMcpToolSuffix(tool);
  return {
    label: `${srvLabel} · ${toolLabel}`,
    desc: `Tool MCP esterno del server "${srvLabel}". Azione: ${toolLabel || 'n/a'}.`,
  };
}
