// Minimal ClickUp REST client for the deterministic backend (the headless
// Claude turn has the claude.ai ClickUp MCP, but the "client-message arm" runs
// as plain backend code and needs its own access). Token is a personal ClickUp
// API token (pk_...). Configure via env: CLICKUP_API_TOKEN.
//
// Endpoints used:
//   GET  /team/{team}/task   — filtered view (status, assignee, list)
//   GET  /task/{id}/comment  — read comments (preview link lives here)
//   PUT  /task/{id}          — move status after send

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

export async function setTaskStatus(taskId: string, status: string): Promise<void> {
  await cu(`/task/${taskId}`, { method: 'PUT', body: JSON.stringify({ status }) });
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
