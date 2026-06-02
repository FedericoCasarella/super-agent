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
  register: (email: string, password: string, name?: string) =>
    req<{ user: any; claimedOrphans?: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),
  login: (email: string, password: string) =>
    req<{ user: any }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/auth/logout', { method: 'POST' }),
  deleteAccount: (password: string) => req('/auth/me', { method: 'DELETE', body: JSON.stringify({ password }) }),
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
  brainGraphFiltered: (visibility: 'all' | 'public' | 'protected', origin: string = 'all', vault: string = 'all') =>
    req<{ nodes: any[]; links: any[]; origins: string[]; vaults: string[] }>(`/brain/graph?visibility=${visibility}&origin=${encodeURIComponent(origin)}&vault=${encodeURIComponent(vault)}`),
  brainStats: () => req<any>('/brain/stats'),
  people: (opts: { q?: string; limit?: number; offset?: number; sort?: string; dir?: 'asc' | 'desc' } = {}) => {
    const p = new URLSearchParams();
    if (opts.q) p.set('q', opts.q);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    if (opts.sort) p.set('sort', opts.sort);
    if (opts.dir) p.set('dir', opts.dir);
    return req<{ rows: any[]; total: number; limit: number; offset: number }>(`/people?${p}`);
  },
  peopleDedupeAgent: () => req<{ ok: boolean; subAgentId: number }>('/people/dedupe-agent', { method: 'POST' }),
  personGraph: (slug: string, hops = 2) => req<{ nodes: any[]; links: any[]; center: string | null }>(`/people/${encodeURIComponent(slug)}/graph?hops=${hops}`),
  personPsyProfile: (slug: string) => req<any>(`/people/${encodeURIComponent(slug)}/psy-profile`),
  brainColors: () => req<any>('/brain/colors'),
  updateBrainColors: (c: any) => req<any>('/brain/colors', { method: 'PUT', body: JSON.stringify(c) }),
  branding: () => req<{ title: string; subtitle: string | null; logoDataUrl: string | null }>('/branding'),
  updateBranding: (b: { title: string; subtitle?: string | null; logoDataUrl?: string | null; syncTelegram?: boolean }) =>
    req<any>('/branding', { method: 'PUT', body: JSON.stringify(b) }),
  usage: () => req<any>('/usage'),
  updatePlan: (data: { name: string; sessionLimitTokens?: number; costBudgetUsd?: number }) => req<any>('/usage/plan', { method: 'PUT', body: JSON.stringify(data) }),
  toolEvents: (opts: { filter?: 'all' | 'mcp' | 'native'; cursor?: number; server?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.filter && opts.filter !== 'all') p.set('filter', opts.filter);
    if (opts.cursor) p.set('cursor', String(opts.cursor));
    if (opts.server) p.set('server', opts.server);
    if (opts.limit) p.set('limit', String(opts.limit));
    const qs = p.toString();
    return req<any[]>(`/tool-events${qs ? `?${qs}` : ''}`);
  },
  vaultsList: () => req<any[]>('/vaults'),
  vaultsCreate: (data: { name: string; path: string; seed?: boolean; makePrimary?: boolean }) => req<any>('/vaults', { method: 'POST', body: JSON.stringify(data) }),
  vaultsSetPrimary: (id: number) => req<any>(`/vaults/${id}/primary`, { method: 'POST' }),
  vaultsDelete: (id: number) => req<any>(`/vaults/${id}`, { method: 'DELETE' }),
  netDiscover: () => req<any[]>('/network/discover'),
  netPeers: () => req<any[]>('/network/peers'),
  netConnect: (email: string) => req<any>('/network/connect', { method: 'POST', body: JSON.stringify({ email }) }),
  netRespondConnection: (id: number, accept: boolean) => req<any>(`/network/connection/${id}/respond`, { method: 'POST', body: JSON.stringify({ accept }) }),
  netIncoming: () => req<any[]>('/network/share/incoming'),
  netOutgoing: () => req<any[]>('/network/share/outgoing'),
  netShareQuery: (email: string, query: string) => req<any>('/network/share', { method: 'POST', body: JSON.stringify({ email, query }) }),
  netReviewShare: (id: number) => req<any>(`/network/share/${id}/review`, { method: 'POST' }),
  netApproveShare: (id: number, paths: string[]) => req<any>(`/network/share/${id}/approve`, { method: 'POST', body: JSON.stringify({ paths }) }),
  netDenyShare: (id: number, reason?: string) => req<any>(`/network/share/${id}/deny`, { method: 'POST', body: JSON.stringify({ reason }) }),
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
  // Sub-agents
  emailTest: (account: string) => req<any>('/email/test', { method: 'POST', body: JSON.stringify({ account }) }),
  waStatus: () => req<any>('/whatsapp/status'),
  waStart: () => req<any>('/whatsapp/start', { method: 'POST' }),
  waLogout: () => req<any>('/whatsapp/logout', { method: 'POST' }),
  waSync: () => req<any>('/whatsapp/sync', { method: 'POST' }),
  waRefreshContacts: () => req<any>('/whatsapp/contacts/refresh', { method: 'POST' }),
  waMergeChats: (canon: string, dups: string[]) => req<any>('/whatsapp/chats/merge', { method: 'POST', body: JSON.stringify({ canon, dups }) }),
  waSuggestReply: (jid: string, hint?: string) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/suggest`, { method: 'POST', body: JSON.stringify({ hint }) }),
  waSyncChat: (jid: string, batches = 3) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/sync`, { method: 'POST', body: JSON.stringify({ batches }) }),
  waSetChatAutoBonify: (jid: string, enabled: boolean) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/auto-bonify`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  outboundList: (opts: { channel?: 'whatsapp' | 'email' | 'telegram'; status?: 'sent' | 'error'; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.channel) p.set('channel', opts.channel);
    if (opts.status) p.set('status', opts.status);
    if (opts.q) p.set('q', opts.q);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    return req<{ rows: any[]; totals: any }>(`/outbound?${p}`);
  },
  outboundGet: (id: number) => req<any>(`/outbound/${id}`),
  // Custom agents
  customAgentsList: () => req<any[]>('/custom-agents'),
  customAgentGet: (id: number) => req<any>(`/custom-agents/${id}`),
  customAgentCreate: (data: any) => req<any>('/custom-agents', { method: 'POST', body: JSON.stringify(data) }),
  customAgentUpdate: (id: number, data: any) => req<any>(`/custom-agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  customAgentDelete: (id: number) => req<any>(`/custom-agents/${id}`, { method: 'DELETE' }),
  // Teams
  teamsList: () => req<any[]>('/teams'),
  teamGet: (id: number) => req<any>(`/teams/${id}`),
  teamCreate: (data: any) => req<any>('/teams', { method: 'POST', body: JSON.stringify(data) }),
  teamUpdate: (id: number, data: any) => req<any>(`/teams/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  teamDelete: (id: number) => req<any>(`/teams/${id}`, { method: 'DELETE' }),
  teamSetMembers: (id: number, members: any[]) => req<any>(`/teams/${id}/members`, { method: 'PUT', body: JSON.stringify({ members }) }),
  // Team tasks
  teamTasksList: (status?: string) => req<any[]>(`/team-tasks${status ? `?status=${status}` : ''}`),
  teamTaskGet: (id: number) => req<any>(`/team-tasks/${id}`),
  teamTaskCreate: (data: { title: string; prompt: string; team_id?: number; agent_id?: number }) => req<any>('/team-tasks', { method: 'POST', body: JSON.stringify(data) }),
  teamTaskCancel: (id: number) => req<any>(`/team-tasks/${id}/cancel`, { method: 'POST' }),
  teamTasksRunningCount: () => req<{ running: number }>('/team-tasks/stats/running'),
  waSendMessage: (jid: string, text: string) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/send`, { method: 'POST', body: JSON.stringify({ text }) }),
  waChats: () => req<any[]>('/whatsapp/chats'),
  waChatMessages: (jid: string) => req<any[]>(`/whatsapp/chats/${encodeURIComponent(jid)}/messages`),
  waPending: () => req<any>('/whatsapp/pending'),
  waBonify: (limit: number, onlyChat?: string) => req<any>('/whatsapp/bonify', { method: 'POST', body: JSON.stringify({ limit, onlyChat }) }),
  subAgentsList: (status?: string) => req<any[]>(`/sub-agents${status ? `?status=${status}` : ''}`),
  subAgentsActive: () => req<any[]>('/sub-agents/active'),
  subAgentsStats: () => req<any>('/sub-agents/stats'),
  subAgentGet: (id: number) => req<any>(`/sub-agents/${id}`),
  subAgentCancel: (id: number) => req<any>(`/sub-agents/${id}/cancel`, { method: 'POST' }),
  proposalsList: () => req<any[]>('/agent-proposals'),
  proposalApprove: (id: number) => req<any>(`/agent-proposals/${id}/approve`, { method: 'POST' }),
  proposalDeny: (id: number) => req<any>(`/agent-proposals/${id}/deny`, { method: 'POST' }),
};
