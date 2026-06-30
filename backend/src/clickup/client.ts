// Minimal ClickUp REST client for the deterministic backend (the headless
// Claude turn has the claude.ai ClickUp MCP, but the "client-message arm" runs
// as plain backend code and needs its own access). Token is a personal ClickUp
// API token (pk_...). Configure via env: CLICKUP_API_TOKEN.
//
// Endpoints used:
//   GET  /team/{team}/task   — filtered view (status, assignee, list)
//   GET  /task/{id}/comment  — read comments (preview link lives here)
//   PUT  /task/{id}          — move status after send

import { query } from '../db/index.js';

const BASE = 'https://api.clickup.com/api/v2';

// Defaults for Marco's Performa workspace; overridable via env.
const TEAM_ID = process.env.CLICKUP_TEAM_ID ?? '9015286262';
const ASSIGNEE_ID = process.env.CLICKUP_ASSIGNEE_ID ?? '84001538';

export function isClickUpConfigured(): boolean {
  return !!process.env.CLICKUP_API_TOKEN;
}

function token(): string {
  const t = process.env.CLICKUP_API_TOKEN;
  if (!t) throw new Error('CLICKUP_API_TOKEN non configurato (.env)');
  return t;
}

async function cu<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: token(), 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ClickUp ${init?.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export type ClickUpTask = {
  id: string;
  name: string;
  status: string;
  list: { id: string; name: string };
  text_content?: string;
  url: string;
  dueDate?: number | null;
  updatedAt?: number | null;
};

// Fetch tasks assigned to Marco currently in a given status. ClickUp's filtered
// team view paginates at 100; for the "mandare mex cliente" pile that's plenty,
// but we expose page for completeness.
export async function getTasksByStatus(status: string, page = 0): Promise<ClickUpTask[]> {
  const qs = new URLSearchParams();
  qs.set('page', String(page));
  qs.append('assignees[]', ASSIGNEE_ID);
  qs.append('statuses[]', status);
  qs.set('subtasks', 'true');
  qs.set('include_closed', 'false');
  const data = await cu<{ tasks: any[] }>(`/team/${TEAM_ID}/task?${qs.toString()}`);
  return (data.tasks ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    status: t.status?.status ?? '',
    list: { id: t.list?.id ?? '', name: t.list?.name ?? '' },
    text_content: t.text_content ?? t.description ?? '',
    url: t.url,
  }));
}

// All open tasks assigned to Marco (any status except closed). Used by the
// task-supervisor digest. include_closed=false drops `completato`; `cancelled`
// is filtered in the digest. subtasks=true so [PDP] subtasks are included.
export async function getOpenTasks(): Promise<ClickUpTask[]> {
  const all: ClickUpTask[] = [];
  // ClickUp pagina a 100 per pagina: cicla finché una pagina è piena.
  for (let page = 0; ; page++) {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.append('assignees[]', ASSIGNEE_ID);
    qs.set('subtasks', 'true');
    qs.set('include_closed', 'false');
    const data = await cu<{ tasks: any[] }>(`/team/${TEAM_ID}/task?${qs.toString()}`);
    const batch = data.tasks ?? [];
    for (const t of batch) all.push({
      id: t.id,
      name: t.name,
      status: t.status?.status ?? '',
      list: { id: t.list?.id ?? '', name: t.list?.name ?? '' },
      text_content: t.text_content ?? t.description ?? '',
      url: t.url,
      dueDate: t.due_date ? Number(t.due_date) : null,
      updatedAt: t.date_updated ? Number(t.date_updated) : null,
    });
    if (batch.length < 100) break;
  }
  return all;
}

export type ClickUpComment = { id: string; text: string; date: string };

export async function getTaskComments(taskId: string): Promise<ClickUpComment[]> {
  const data = await cu<{ comments: any[] }>(`/task/${taskId}/comment`);
  return (data.comments ?? []).map((c) => ({
    id: c.id,
    text: c.comment_text ?? '',
    date: c.date ?? '',
  }));
}

// Pull the most recent preview link (shopifypreview.com or a bare URL) from a
// task's comments. Returns null when none — the arm then holds the draft.
export async function findPreviewLink(taskId: string): Promise<string | null> {
  const comments = await getTaskComments(taskId);
  const urlRe = /(https?:\/\/[^\s]+)/g;
  // Newest first.
  for (const c of comments.sort((a, b) => Number(b.date) - Number(a.date))) {
    const urls = c.text.match(urlRe);
    if (!urls) continue;
    const preview = urls.find((u) => /shopifypreview\.com|myshopify\.com|preview/i.test(u)) ?? urls[0];
    if (preview) return preview;
  }
  return null;
}

// Opzioni di logging per l'automation meter. Quando `userId` è presente, ogni
// transizione di stato riuscita viene registrata in task_action_log — l'unica
// fonte di verità per "l'ha fatto l'agente" (col token pk_ ClickUp attribuisce
// la mossa a Marco, indistinguibile lato ClickUp). `isClose` segna le mosse
// verso uno stato terminale; il rate finale incrocia comunque con le task
// realmente chiuse via API, quindi questo flag è solo report/indice.
export type StatusLog = {
  userId: number;
  origin?: string;
  isClose?: boolean;
  statusType?: string;
  taskName?: string;
  clientName?: string;
};

export async function setTaskStatus(taskId: string, status: string, log?: StatusLog): Promise<void> {
  await cu(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ status }) });
  if (log?.userId) {
    try {
      await query(
        `INSERT INTO task_action_log(user_id, task_id, task_name, client_name, to_status, status_type, is_close, origin)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [log.userId, taskId, log.taskName ?? null, log.clientName ?? null, status,
         log.statusType ?? null, log.isClose ?? false, log.origin ?? 'agent'],
      );
    } catch (e: any) {
      // Il log non deve mai far fallire la mossa di stato (best-effort audit).
      console.error('[task_action_log] insert failed', e?.message ?? e);
    }
  }
}

// Task assegnate a Marco entrate in stato terminale (done/closed) dopo `sinceMs`.
// Denominatore dell'automation meter. Usa include_closed=true + date_updated_gt
// come superset, poi filtra sul `type` dello status (configurabile per lista,
// quindi rilevato a runtime, non hardcodato) e su date_closed/date_done nella
// finestra. `status` è il nome dello stato finale: il numeratore matcha proprio
// quel nome contro il ledger (la mossa di chiusura fatta dall'agente).
export type ClosedTask = { id: string; name: string; status: string; statusType: string; closedAt: number };

export async function getRecentlyClosedTasks(sinceMs: number): Promise<ClosedTask[]> {
  const out: ClosedTask[] = [];
  for (let page = 0; ; page++) {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.append('assignees[]', ASSIGNEE_ID);
    qs.set('subtasks', 'true');
    qs.set('include_closed', 'true');
    qs.set('date_updated_gt', String(sinceMs));
    const data = await cu<{ tasks: any[] }>(`/team/${TEAM_ID}/task?${qs.toString()}`);
    const batch = data.tasks ?? [];
    for (const t of batch) {
      const type = t.status?.type ?? '';
      if (type !== 'done' && type !== 'closed') continue;
      const closedAt = Number(t.date_closed ?? t.date_done ?? t.date_updated ?? 0);
      if (!closedAt || closedAt < sinceMs) continue;
      out.push({ id: t.id, name: t.name, status: t.status?.status ?? '', statusType: type, closedAt });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// Post a comment on a task (kept as a fallback option).
export async function createComment(taskId: string, text: string): Promise<void> {
  await cu(`/task/${taskId}/comment`, {
    method: 'POST',
    body: JSON.stringify({ comment_text: text, notify_all: true }),
  });
}

// Post a message to a ClickUp Chat channel (v3 API) — used for clients whose
// update channel is the [EXT] client chat (e.g. Boutique Tones, Emanuel Folco).
export async function createChatMessage(channelId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.clickup.com/api/v3/workspaces/${TEAM_ID}/chat/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: token(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', content: text, content_format: 'text/md' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ClickUp Chat POST ${channelId} → ${res.status} ${body.slice(0, 200)}`);
  }
}

// Leggi i messaggi recenti di un canale Chat [EXT] (v3 API). Usato dallo step 3
// del supervisore per capire se il cliente ha risposto. `authorId` permette di
// distinguere i messaggi del cliente da quelli di Marco/agente (che usano il
// token pk_ → autore = Marco, ID 84001538). Best-effort sui campi: la v3 espone
// `date` (ms epoch) e l'autore in forme diverse a seconda della versione.
export type ChatMessage = { id: string; authorId: string; text: string; dateMs: number };

export async function getChatMessages(channelId: string, limit = 50): Promise<ChatMessage[]> {
  const res = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${TEAM_ID}/chat/channels/${channelId}/messages?limit=${limit}`,
    { headers: { Authorization: token(), 'Content-Type': 'application/json' } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ClickUp Chat GET ${channelId} → ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { data?: any[] };
  return (data.data ?? []).map((m) => ({
    id: String(m.id ?? ''),
    authorId: String(m.user?.id ?? m.userid ?? m.user_id ?? ''),
    text: String(m.content ?? m.comment_text ?? ''),
    dateMs: Number(m.date ?? m.created_at ?? 0),
  }));
}
