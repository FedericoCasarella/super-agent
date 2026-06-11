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
  messageCounts: () => req<{ h24: number; d7: number; d30: number; total: number }>('/messages/counts'),
  liveKpis: () => req<{ agentsNow: number; agents24h: number; peopleTouched24h: number; upcoming: { id: number; name: string; cron: string; next_run_at: string; channel: string; modality: string }[] }>('/live/kpis'),
  connectors: () => req<any[]>('/connectors'),
  updateConnector: (name: string, body: any) => req(`/connectors/${name}`, { method: 'PUT', body: JSON.stringify(body) }),
  runConnector: (name: string) => req(`/connectors/${name}/run`, { method: 'POST' }),
  testImapAccount: (acc: any) => req<any>('/connectors/imap/test', { method: 'POST', body: JSON.stringify(acc) }),
  brainSearch: (q: string) => req<any[]>(`/brain/search?q=${encodeURIComponent(q)}`),
  brainIndex: () => req<any[]>('/brain/index'),
  brainTree: () => req<{ root: string | null; files: string[] }>('/brain/tree'),
  brainGraph: () => req<{ nodes: any[]; links: any[] }>('/brain/graph'),
  brainNote: (path: string) => req<any>(`/brain/note?path=${encodeURIComponent(path)}`),
  brainSnapshots: (opts: { vault?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.vault) p.set('vault', opts.vault);
    p.set('limit', String(opts.limit ?? 25));
    p.set('offset', String(opts.offset ?? 0));
    return req<{ rows: any[]; total: number }>(`/brain/snapshots?${p}`);
  },
  brainSnapshotRun: () => req<{ ok: boolean; snapshots: any[] }>('/brain/snapshots/run', { method: 'POST' }),
  brainProposals: (status: string = 'pending') => req<{ rows: any[] }>(`/brain/proposals?status=${encodeURIComponent(status)}`),
  brainProposalApply: (id: number) => req<{ ok: boolean; error?: string; result?: any }>(`/brain/proposals/${id}/apply`, { method: 'POST' }),
  brainProposalReject: (id: number) => req<{ ok: boolean }>(`/brain/proposals/${id}/reject`, { method: 'POST' }),
  brainSnapshotDelete: (id: number) => req<{ ok: boolean }>(`/brain/snapshots/${id}`, { method: 'DELETE' }),
  brainSnapshotRestore: (id: number) =>
    req<{ ok: boolean; restored?: number; safety_snapshot_id?: number; error?: string }>(`/brain/snapshots/${id}/restore`, { method: 'POST' }),
  brainSnapshotDirGet: () => req<{ dir: string }>('/brain/snapshots/dir'),
  brainSnapshotDirSet: (dir: string) => req<{ ok: boolean; dir: string }>('/brain/snapshots/dir', { method: 'PUT', body: JSON.stringify({ dir }) }),
  brainNoteSave: (path: string, content: string, data?: any) =>
    req<{ ok: boolean }>('/brain/note', { method: 'PUT', body: JSON.stringify({ path, content, data }) }),
  brainNoteDelete: (path: string) =>
    req<{ ok: boolean }>(`/brain/note?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  brainReveal: (path: string) =>
    req<{ ok: boolean; path: string }>('/brain/reveal', { method: 'POST', body: JSON.stringify({ path }) }),
  callTool: (name: string, args: any = {}) => req<any>(`/tools/${name}`, { method: 'POST', body: JSON.stringify(args) }),
  logs: (opts: { kinds?: string[]; statuses?: string[]; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.kinds?.length) p.set('kind', opts.kinds.join(','));
    if (opts.statuses?.length) p.set('status', opts.statuses.join(','));
    if (opts.q) p.set('q', opts.q);
    p.set('limit', String(opts.limit ?? 100));
    p.set('offset', String(opts.offset ?? 0));
    return req<{ rows: any[]; total: number }>(`/logs?${p}`);
  },
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
  peopleByEmail: (addr: string) => req<{ person: { id: number; slug: string; name: string; emails: string[]; phones: string[]; note_path: string | null } | null }>(`/people/by-email?addr=${encodeURIComponent(addr)}`),
  peopleBindEmail: (slug: string, email: string) => req<{ ok: boolean; slug: string; email: string }>(`/people/${encodeURIComponent(slug)}/bind-email`, { method: 'POST', body: JSON.stringify({ email }) }),
  peopleDelete: (slug: string, opts: { keep_note?: boolean; keep_refs?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.keep_note) q.set('keep_note', '1');
    if (opts.keep_refs) q.set('keep_refs', '1');
    return req<{ ok: boolean; slug: string; note_removed: boolean; refs_touched: number }>(
      `/people/${encodeURIComponent(slug)}${q.toString() ? '?' + q : ''}`,
      { method: 'DELETE' },
    );
  },
  peopleMerge: (canonical_slug: string, dup_slugs: string[]) =>
    req<any>('/people/merge', { method: 'POST', body: JSON.stringify({ canonical_slug, dup_slugs }) }),
  peopleResync: (prune = false) =>
    req<{ ok: boolean; scanned: number; upserted: number; pruned: number }>('/people/resync', { method: 'POST', body: JSON.stringify({ prune }) }),
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
  waRefreshPics: () => req<any>('/whatsapp/pics/refresh', { method: 'POST' }),
  waDedupe: () => req<any>('/whatsapp/chats/dedupe', { method: 'POST' }),
  waAiDedupe: () => req<any>('/whatsapp/chats/ai-dedupe', { method: 'POST' }),
  waWipe: () => req<any>('/whatsapp/chats/wipe', { method: 'POST' }),
  waDeleteChats: (chat_jids: string[]) => req<{ ok: boolean; deleted_messages: number; deleted_contacts: number }>('/whatsapp/chats/delete', { method: 'POST', body: JSON.stringify({ chat_jids }) }),
  waLinkChat: (jid: string, slug: string | null) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/link`, { method: 'POST', body: JSON.stringify({ slug }) }),
  waSetChatDisplay: (jid: string, payload: { display_name?: string | null; display_phone?: string | null }) =>
    req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/display`, { method: 'POST', body: JSON.stringify(payload) }),
  waMergeChats: (canon: string, dups: string[]) => req<any>('/whatsapp/chats/merge', { method: 'POST', body: JSON.stringify({ canon, dups }) }),
  waSuggestReply: (jid: string, hint?: string) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/suggest`, { method: 'POST', body: JSON.stringify({ hint }) }),
  waSyncChat: (jid: string, batches = 3) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/sync`, { method: 'POST', body: JSON.stringify({ batches }) }),
  waSetChatAutoBonify: (jid: string, enabled: boolean) => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/auto-bonify`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  ttsTest: (text?: string) => req<{ ok: boolean; fallback?: string | null; error?: string | null; hint?: string; bytes?: number; ext?: string }>('/connectors/tts/test', { method: 'POST', body: JSON.stringify({ text }) }),
  outboundList: (opts: { channels?: string[]; statuses?: string[]; channel?: 'whatsapp' | 'email' | 'telegram' | 'instagram'; status?: 'sent' | 'error'; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.channels?.length) p.set('channel', opts.channels.join(','));
    else if (opts.channel) p.set('channel', opts.channel);
    if (opts.statuses?.length) p.set('status', opts.statuses.join(','));
    else if (opts.status) p.set('status', opts.status);
    if (opts.q) p.set('q', opts.q);
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    return req<{ rows: any[]; total: number; totals: any }>(`/outbound?${p}`);
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
  // Flows
  flowsList: () => req<any[]>('/flows'),
  flowGet: (id: number) => req<any>(`/flows/${id}`),
  flowCreate: (data: any) => req<any>('/flows', { method: 'POST', body: JSON.stringify(data) }),
  flowUpdate: (id: number, data: any) => req<any>(`/flows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  flowDelete: (id: number) => req<any>(`/flows/${id}`, { method: 'DELETE' }),
  flowSetTriggers: (id: number, triggers: any[]) => req<any>(`/flows/${id}/triggers`, { method: 'PUT', body: JSON.stringify({ triggers }) }),
  flowSetSteps: (id: number, steps: any[]) => req<any>(`/flows/${id}/steps`, { method: 'PUT', body: JSON.stringify({ steps }) }),
  flowRunsList: (id: number) => req<any[]>(`/flows/${id}/runs`),
  flowRunGet: (runId: number) => req<any>(`/flow-runs/${runId}`),
  flowRunNow: (id: number, payload?: any) => req<any>(`/flows/${id}/run`, { method: 'POST', body: JSON.stringify(payload ?? {}) }),
  // Roadmap v2
  roadmapGet: () => req<any>('/roadmap-v2'),
  roadmapStats: () => req<any>('/roadmap-v2/stats'),
  roadmapAddTodo: (horizon: 'shortTerm' | 'midTerm' | 'longTerm', data: any) => req<any>(`/roadmap-v2/${horizon}/todos`, { method: 'POST', body: JSON.stringify(data) }),
  roadmapUpdateTodo: (horizon: 'shortTerm' | 'midTerm' | 'longTerm', id: string, data: any) => req<any>(`/roadmap-v2/${horizon}/todos/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  roadmapDeleteTodo: (horizon: 'shortTerm' | 'midTerm' | 'longTerm', id: string) => req<any>(`/roadmap-v2/${horizon}/todos/${id}`, { method: 'DELETE' }),
  roadmapMoveTodo: (id: string, from: string, to: string) => req<any>(`/roadmap-v2/todos/${id}/move`, { method: 'POST', body: JSON.stringify({ from, to }) }),
  roadmapSetStrategy: (data: any) => req<any>('/roadmap-v2/strategy', { method: 'PUT', body: JSON.stringify(data) }),
  roadmapUpsertKpi: (data: any) => req<any>('/roadmap-v2/kpis', { method: 'POST', body: JSON.stringify(data) }),
  roadmapDeleteKpi: (id: string) => req<any>(`/roadmap-v2/kpis/${id}`, { method: 'DELETE' }),
  waSendMessage: (jid: string, text: string, source: 'user' | 'ai' = 'user') => req<any>(`/whatsapp/chats/${encodeURIComponent(jid)}/send`, { method: 'POST', body: JSON.stringify({ text, source }) }),
  waChats: () => req<any[]>('/whatsapp/chats'),
  waChatMessages: (jid: string) => req<any[]>(`/whatsapp/chats/${encodeURIComponent(jid)}/messages`),
  waPending: () => req<any>('/whatsapp/pending'),
  waBonify: (limit: number, onlyChat?: string) => req<any>('/whatsapp/bonify', { method: 'POST', body: JSON.stringify({ limit, onlyChat }) }),
  subAgentsList: (status?: string) => req<any[]>(`/sub-agents${status ? `?status=${status}` : ''}`),
  subAgentsListPaginated: (opts: { statuses?: string[]; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams({ paginated: '1' });
    if (opts.statuses?.length) p.set('status', opts.statuses.join(','));
    if (opts.q) p.set('q', opts.q);
    p.set('limit', String(opts.limit ?? 25));
    p.set('offset', String(opts.offset ?? 0));
    return req<{ rows: any[]; total: number }>(`/sub-agents?${p}`);
  },
  subAgentsActive: () => req<any[]>('/sub-agents/active'),
  subAgentsStats: () => req<any>('/sub-agents/stats'),
  subAgentGet: (id: number) => req<any>(`/sub-agents/${id}`),
  subAgentCancel: (id: number) => req<any>(`/sub-agents/${id}/cancel`, { method: 'POST' }),
  proposalsList: () => req<any[]>('/agent-proposals'),
  proposalApprove: (id: number) => req<any>(`/agent-proposals/${id}/approve`, { method: 'POST' }),
  proposalDeny: (id: number) => req<any>(`/agent-proposals/${id}/deny`, { method: 'POST' }),

  // Instagram DM
  igStatus: () => req<any>('/instagram/status'),
  igStart: (username?: string, password?: string) => req<any>('/instagram/start', { method: 'POST', body: JSON.stringify({ username: username || undefined, password: password || undefined }) }),
  ig2fa: (code: string) => req<any>('/instagram/2fa', { method: 'POST', body: JSON.stringify({ code }) }),
  igCheckpoint: (code: string) => req<any>('/instagram/checkpoint', { method: 'POST', body: JSON.stringify({ code }) }),
  igLogout: () => req<any>('/instagram/logout', { method: 'POST' }),
  igThreads: () => req<any[]>('/instagram/threads'),
  igThreadMessages: (id: string) => req<any[]>(`/instagram/threads/${encodeURIComponent(id)}/messages`),
  igSendMessage: (id: string, text: string, source: 'user' | 'ai' = 'user') => req<any>(`/instagram/threads/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ text, source }) }),
  igSuggestReply: (id: string, hint?: string) => req<any>(`/instagram/threads/${encodeURIComponent(id)}/suggest`, { method: 'POST', body: JSON.stringify({ hint }) }),
  igSetThreadAutoBonify: (id: string, enabled: boolean) => req<any>(`/instagram/threads/${encodeURIComponent(id)}/auto-bonify`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  igSetThreadAutoResponder: (id: string, enabled: boolean, goal?: string | null) => req<any>(`/instagram/threads/${encodeURIComponent(id)}/auto-responder`, { method: 'POST', body: JSON.stringify({ enabled, goal }) }),
  igBonify: (limit: number, onlyThread?: string) => req<any>('/instagram/bonify', { method: 'POST', body: JSON.stringify({ limit, onlyThread }) }),
  igPending: () => req<any>('/instagram/pending'),
  igSync: (pages = 3) => req<any>('/instagram/sync', { method: 'POST', body: JSON.stringify({ pages }) }),
  igSyncThread: (id: string, pages = 5) => req<any>(`/instagram/threads/${encodeURIComponent(id)}/sync`, { method: 'POST', body: JSON.stringify({ pages }) }),
  report: (range: '7d' | '30d' | '90d' | 'all' = '30d') => req<any>(`/report?range=${range}`),
  // ----- MAIL CLIENT -----
  mailAccounts: () => req<{ accounts: { label: string; address: string; host: string; mailbox: string }[] }>('/mail/accounts'),
  mailList: (opts: { account?: string; folder?: string; q?: string; unread?: boolean; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (opts.account) p.set('account', opts.account);
    if (opts.folder) p.set('folder', opts.folder);
    if (opts.q) p.set('q', opts.q);
    if (opts.unread) p.set('unread', 'true');
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.offset) p.set('offset', String(opts.offset));
    return req<{ rows: any[]; total: number }>(`/mail/messages?${p}`);
  },
  mailGet: (id: number) => req<any>(`/mail/messages/${id}`),
  mailThread: (key: string) => req<{ messages: any[] }>(`/mail/threads/${encodeURIComponent(key)}`),
  mailMark: (id: number, patch: { seen?: boolean; flagged?: boolean; starred?: boolean }) => req<any>(`/mail/messages/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  mailTrash: (id: number) => req<any>(`/mail/messages/${id}`, { method: 'DELETE' }),
  mailSync: (account: string, limit = 1000) => req<any>('/mail/sync', { method: 'POST', body: JSON.stringify({ account, limit }) }),
  mailBonify: (opts: { account?: string; force?: boolean; limit?: number } = {}) => req<any>('/mail/bonify', { method: 'POST', body: JSON.stringify(opts) }),
  mailBonifyOne: (id: number, force = false) => req<any>(`/mail/messages/${id}/bonify`, { method: 'POST', body: JSON.stringify({ force }) }),
  mailFolders: (account: string) => req<{ ok: boolean; folders: { name: string; label: string; kind: string; subscribed: boolean }[]; error?: string }>(`/mail/folders?account=${encodeURIComponent(account)}`),
  mailAutoSyncGet: (account: string) => req<{ enabled: boolean }>(`/mail/accounts/${encodeURIComponent(account)}/auto-sync`),
  mailAutoSyncSet: (account: string, enabled: boolean) => req<{ ok: boolean; enabled: boolean }>(`/mail/accounts/${encodeURIComponent(account)}/auto-sync`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  mailSignatureGet: (account: string) => req<{ html: string }>(`/mail/accounts/${encodeURIComponent(account)}/signature`),
  waUnread: () => req<{ count: number }>('/whatsapp/unread'),
  igUnread: () => req<{ count: number }>('/instagram/unread'),
  mailSuggest: (id: number, hint?: string) => req<any>(`/mail/messages/${id}/suggest`, { method: 'POST', body: JSON.stringify({ hint }) }),
  mailCompose: (intent: string, to?: string) => req<{ ok: boolean; subject: string; body: string; error?: string }>('/mail/compose', { method: 'POST', body: JSON.stringify({ intent, to }) }),
  mailSend: (payload: { account: string; to: string; cc?: string; bcc?: string; subject: string; body: string; html?: string; inReplyTo?: string; references?: string[]; attachments?: File[] }) => {
    const fd = new FormData();
    fd.append('account', payload.account);
    fd.append('to', payload.to);
    if (payload.cc) fd.append('cc', payload.cc);
    if (payload.bcc) fd.append('bcc', payload.bcc);
    fd.append('subject', payload.subject);
    fd.append('body', payload.body);
    if (payload.html) fd.append('html', payload.html);
    if (payload.inReplyTo) fd.append('inReplyTo', payload.inReplyTo);
    if (payload.references?.length) fd.append('references', payload.references.join(','));
    for (const f of (payload.attachments ?? [])) fd.append('attachments', f);
    return fetch('/api/mail/send', { method: 'POST', credentials: 'include', body: fd }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    });
  },
  mailAttachmentUrl: (id: number) => `/api/mail/attachments/${id}`,
};
