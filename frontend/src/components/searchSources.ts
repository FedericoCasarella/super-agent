import { api } from '../api';
import type { Option } from './SearchSelect';

// Reusable async data sources for SearchSelect across Flow trigger/step config drawers.
// Each fetcher returns a small filtered list (≤ 50). Client-side filter on top of
// existing backend list endpoints — good enough until lists grow huge.

function filt(items: Option[], q: string): Option[] {
  const s = q.trim().toLowerCase();
  if (!s) return items.slice(0, 50);
  return items.filter((o) => o.label.toLowerCase().includes(s) || (o.sublabel ?? '').toLowerCase().includes(s) || o.value.toLowerCase().includes(s)).slice(0, 50);
}

export async function fetchWaChats(q: string): Promise<Option[]> {
  try {
    const chats: any[] = await api.waChats();
    return filt(chats.map((c) => ({
      value: c.chat_jid,
      label: c.sender_name || c.chat_jid,
      sublabel: c.is_group ? `gruppo · ${c.chat_jid}` : c.sender_phone ? `+${c.sender_phone}` : c.chat_jid,
    })), q);
  } catch { return []; }
}

export async function fetchIgThreads(q: string): Promise<Option[]> {
  try {
    const threads: any[] = await api.igThreads();
    return filt(threads.map((t) => ({
      value: t.thread_id,
      label: t.title || t.thread_id,
      sublabel: t.is_group ? `gruppo · ${t.thread_id}` : t.thread_id,
    })), q);
  } catch { return []; }
}

export async function fetchTeams(q: string): Promise<Option[]> {
  try {
    const r: any[] = await api.teamsList();
    return filt(r.map((t) => ({ value: String(t.id), label: t.name, sublabel: t.description ?? `id ${t.id}` })), q);
  } catch { return []; }
}

export async function fetchCustomAgents(q: string): Promise<Option[]> {
  try {
    const r: any[] = await api.customAgentsList();
    return filt(r.map((a) => ({ value: String(a.id), label: a.name, sublabel: a.role ?? `id ${a.id}` })), q);
  } catch { return []; }
}

export async function fetchPerks(q: string): Promise<Option[]> {
  try {
    const r: any[] = await api.internalAgents();
    return filt(r.map((p) => ({ value: p.name, label: p.title ?? p.name, sublabel: p.name })), q);
  } catch { return []; }
}

export async function fetchScheduledTasks(q: string): Promise<Option[]> {
  try {
    const r: any[] = await api.tasks();
    return filt(r.map((t) => ({ value: String(t.id), label: t.name, sublabel: t.cron ?? `id ${t.id}` })), q);
  } catch { return []; }
}

export async function fetchEmailAccounts(q: string): Promise<Option[]> {
  try {
    const connectors: any[] = await api.connectors();
    const imap = connectors.find((c) => c.manifest?.name === 'imap');
    const accounts = imap?.config?.accounts ?? [];
    return filt(accounts.map((a: any) => ({ value: a.label, label: a.label, sublabel: a.imap?.user ?? a.smtp?.user ?? '' })), q);
  } catch { return []; }
}

export async function fetchClaudeModels(q: string): Promise<Option[]> {
  const models = [
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ];
  return filt(models, q);
}
