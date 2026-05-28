const base = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base + path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

export const auth = {
  me: () => req<{ user: { id: number; email: string; name: string | null } | null }>('/auth/me'),
  bootstrap: () => req<{ usersExist: boolean; count: number }>('/auth/bootstrap'),
  initialize: (email: string, password: string, name?: string) =>
    req<{ user: any; claimedOrphans?: boolean }>('/auth/initialize', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    req<{ user: any }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/auth/logout', { method: 'POST' }),
};

export const api = {
  status: () => req<any>('/status'),
  setProfile: (data: any) => req('/onboarding/profile', { method: 'POST', body: JSON.stringify(data) }),
  setBusiness: (data: any) => req('/onboarding/business', { method: 'POST', body: JSON.stringify(data) }),
  setVault: (vaultPath: string) => req('/onboarding/vault', { method: 'POST', body: JSON.stringify({ vaultPath }) }),
  setTelegram: (token: string) => req<any>('/onboarding/telegram', { method: 'POST', body: JSON.stringify({ token }) }),
  messages: (limit = 100) => req<any[]>(`/messages?limit=${limit}`),
  connectors: () => req<any[]>('/connectors'),
  updateConnector: (name: string, body: any) => req(`/connectors/${name}`, { method: 'PUT', body: JSON.stringify(body) }),
  runConnector: (name: string) => req(`/connectors/${name}/run`, { method: 'POST' }),
  testImapAccount: (acc: any) => req<any>('/connectors/imap/test', { method: 'POST', body: JSON.stringify(acc) }),
  brainSearch: (q: string) => req<any[]>(`/brain/search?q=${encodeURIComponent(q)}`),
  brainIndex: () => req<any[]>('/brain/index'),
  brainGraph: () => req<{ nodes: any[]; links: any[] }>('/brain/graph'),
  brainNote: (path: string) => req<any>(`/brain/note?path=${encodeURIComponent(path)}`),
  callTool: (name: string, args: any = {}) => req<any>(`/tools/${name}`, { method: 'POST', body: JSON.stringify(args) }),
  logs: (kind?: string, limit = 100) => req<any[]>(`/logs?limit=${limit}${kind ? `&kind=${kind}` : ''}`),
  log: (id: number) => req<any>(`/logs/${id}`),
  logStats: () => req<any>('/logs/stats/summary'),
  agentState: () => req<any>('/agent/state'),
  externalMcps: (refresh = false) => req<any[]>(`/mcp/external${refresh ? '?refresh=1' : ''}`),
  internalAgents: () => req<any[]>('/internal-agents'),
  updateInternalAgent: (name: string, data: any) => req(`/internal-agents/${name}`, { method: 'PUT', body: JSON.stringify(data) }),
  runInternalAgent: (name: string) => req<{ status: string; report: any }>(`/internal-agents/${name}/run`, { method: 'POST' }),
  brainIndexFiltered: (visibility: 'all' | 'public' | 'protected') => req<any[]>(`/brain/index?visibility=${visibility}`),
  // Multi-vault drift shim (sess.2818): upstream Federico has originFilter +
  // returns origins[]/vaults[]; polpo-fork backend ignores extra args. The
  // optional 2nd parameter and union return type unblock tsc on consumers
  // (BrainGraph3DConstellation) until we integrate the multi-vault feature.
  brainGraphFiltered: (visibility: 'all' | 'public' | 'protected', _originFilter?: string) =>
    req<{ nodes: any[]; links: any[]; origins?: string[]; vaults?: any[] }>(`/brain/graph?visibility=${visibility}`),
  tasks: () => req<any[]>('/tasks'),
  taskCreate: (data: any) => req('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  taskUpdate: (id: number, data: any) => req(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  taskDelete: (id: number) => req(`/tasks/${id}`, { method: 'DELETE' }),
  taskRun: (id: number) => req(`/tasks/${id}/run`, { method: 'POST' }),
  agentWake: () => req<any>('/agent/wake', { method: 'POST' }),
  settings: () => req<any>('/settings'),
  updateVault: (vaultPath: string) => req<any>('/settings/vault', { method: 'PUT', body: JSON.stringify({ vaultPath }) }),
  updateProfile: (data: any) => req('/settings/profile', { method: 'PUT', body: JSON.stringify(data) }),
  updateBusiness: (data: any) => req('/settings/business', { method: 'PUT', body: JSON.stringify(data) }),
  updateTelegram: (token: string) => req('/settings/telegram', { method: 'PUT', body: JSON.stringify({ token }) }),
  updateSound: (enabled: boolean) => req('/settings/sound', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // H3 (sess.2818) — Telegram chatId binding via one-time code
  telegramLinkCode: () => req<{ code: string; expires_at: string; instructions: string }>('/telegram/link-code', { method: 'POST' }),
  telegramUnlink: () => req<{ ok: boolean }>('/telegram/unlink', { method: 'POST' }),
};
