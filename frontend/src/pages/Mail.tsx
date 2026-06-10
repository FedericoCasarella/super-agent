import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useWS } from '../ws';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDialog } from '../components/dialog';
import { Mail as MailIcon, Inbox, Send, Star, Trash2, RefreshCw, Reply, ReplyAll, Forward, Sparkles, Paperclip, X, Search, AlertCircle, Loader2, Wand2, MailOpen, CheckCheck, ChevronDown, FileEdit, Archive, ShieldAlert, Tag, FolderIcon } from 'lucide-react';

type Account = { label: string; address: string; host: string; mailbox: string };
type MsgRow = {
  id: number; account_label: string; uid: number | null; message_id: string | null;
  from_addr: string | null; from_name: string | null; to_addrs: string[]; cc_addrs: string[];
  subject: string | null; preview: string | null; ts: string; seen: boolean; flagged: boolean; starred: boolean;
  direction: 'in' | 'out'; folder: string; attach_count?: number;
  thread_key?: string | null;
};
type FullMsg = MsgRow & {
  in_reply_to: string | null;
  refs: string[];
  body_text: string | null; body_html: string | null;
  bcc_addrs: string[];
  attachments: { id: number; filename: string; content_type: string | null; size_bytes: number; inline: boolean; cid: string | null }[];
};

type Folder = string; // can be 'INBOX' | 'Sent' | 'starred' | 'unread' | 'trash' | any IMAP folder name

type FixedFolder = { key: string; label: string; icon: any; virtual?: boolean };
const FIXED_FOLDERS: FixedFolder[] = [
  { key: 'INBOX', label: 'In arrivo', icon: Inbox },
  { key: 'Sent', label: 'Inviati', icon: Send },
  { key: 'starred', label: 'Speciali', icon: Star, virtual: true },
  { key: 'unread', label: 'Non letti', icon: MailIcon, virtual: true },
  { key: 'trash', label: 'Cestino', icon: Trash2, virtual: true },
];

function fmtDate(s: string): string {
  const d = new Date(s);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', ...(sameYear ? {} : { year: '2-digit' }) });
}

function fmtBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function senderLabel(m: MsgRow | FullMsg): string {
  if (m.direction === 'out') return 'Io';
  return m.from_name || m.from_addr || '—';
}

// Hash any string to a stable HSL color used as the avatar background.
function avatarColor(seed: string): string {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 65%, 55%)`;
}
function initialsOf(name: string | null | undefined, fallback: string | null | undefined): string {
  const src = (name || fallback || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return '?';
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('').slice(0, 2);
}
function senderSeed(m: MsgRow | FullMsg): string {
  return m.from_addr || m.from_name || senderLabel(m);
}

// Group rows into date-bucketed sections used as list section headers.
function dateBucket(ts: string): 'oggi' | 'ieri' | 'settimana' | 'mese' | 'piuvecchio' {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'oggi';
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'ieri';
  const diff = (now.getTime() - d.getTime()) / 86_400_000;
  if (diff < 7) return 'settimana';
  if (diff < 30) return 'mese';
  return 'piuvecchio';
}
const BUCKET_LABEL: Record<ReturnType<typeof dateBucket>, string> = {
  oggi: 'Oggi',
  ieri: 'Ieri',
  settimana: 'Ultimi 7 giorni',
  mese: 'Ultimi 30 giorni',
  piuvecchio: 'Più vecchi',
};

// Tiny MD5 (RFC 1321) — needed to build Gravatar URLs without pulling crypto-js.
function md5(str: string): string {
  function rl(n: number, c: number) { return (n << c) | (n >>> (32 - c)); }
  function add(a: number, b: number) { const l = (a & 0xffff) + (b & 0xffff); return (((a >> 16) + (b >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, (b & c) | ((~b) & d)), add(x, t)), s), b); }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, (b & d) | (c & (~d))), add(x, t)), s), b); }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, b ^ c ^ d), add(x, t)), s), b); }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return add(rl(add(add(a, c ^ (b | (~d))), add(x, t)), s), b); }
  function cv(s: string) {
    const n = s.length;
    const out: number[] = new Array(((n + 8) >> 6) * 16 + 16).fill(0);
    for (let i = 0; i < n; i++) out[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    out[n >> 2] |= 0x80 << ((n % 4) * 8);
    out[((n + 8) >> 6) * 16 + 14] = n * 8;
    return out;
  }
  function hex(n: number) { let s = ''; for (let i = 0; i < 4; i++) s += ('0' + ((n >> (i * 8)) & 0xff).toString(16)).slice(-2); return s; }
  const x = cv(unescape(encodeURIComponent(str)));
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a,b,c,d,x[i+0],7,-680876936); d = ff(d,a,b,c,x[i+1],12,-389564586); c = ff(c,d,a,b,x[i+2],17,606105819); b = ff(b,c,d,a,x[i+3],22,-1044525330);
    a = ff(a,b,c,d,x[i+4],7,-176418897); d = ff(d,a,b,c,x[i+5],12,1200080426); c = ff(c,d,a,b,x[i+6],17,-1473231341); b = ff(b,c,d,a,x[i+7],22,-45705983);
    a = ff(a,b,c,d,x[i+8],7,1770035416); d = ff(d,a,b,c,x[i+9],12,-1958414417); c = ff(c,d,a,b,x[i+10],17,-42063); b = ff(b,c,d,a,x[i+11],22,-1990404162);
    a = ff(a,b,c,d,x[i+12],7,1804603682); d = ff(d,a,b,c,x[i+13],12,-40341101); c = ff(c,d,a,b,x[i+14],17,-1502002290); b = ff(b,c,d,a,x[i+15],22,1236535329);
    a = gg(a,b,c,d,x[i+1],5,-165796510); d = gg(d,a,b,c,x[i+6],9,-1069501632); c = gg(c,d,a,b,x[i+11],14,643717713); b = gg(b,c,d,a,x[i+0],20,-373897302);
    a = gg(a,b,c,d,x[i+5],5,-701558691); d = gg(d,a,b,c,x[i+10],9,38016083); c = gg(c,d,a,b,x[i+15],14,-660478335); b = gg(b,c,d,a,x[i+4],20,-405537848);
    a = gg(a,b,c,d,x[i+9],5,568446438); d = gg(d,a,b,c,x[i+14],9,-1019803690); c = gg(c,d,a,b,x[i+3],14,-187363961); b = gg(b,c,d,a,x[i+8],20,1163531501);
    a = gg(a,b,c,d,x[i+13],5,-1444681467); d = gg(d,a,b,c,x[i+2],9,-51403784); c = gg(c,d,a,b,x[i+7],14,1735328473); b = gg(b,c,d,a,x[i+12],20,-1926607734);
    a = hh(a,b,c,d,x[i+5],4,-378558); d = hh(d,a,b,c,x[i+8],11,-2022574463); c = hh(c,d,a,b,x[i+11],16,1839030562); b = hh(b,c,d,a,x[i+14],23,-35309556);
    a = hh(a,b,c,d,x[i+1],4,-1530992060); d = hh(d,a,b,c,x[i+4],11,1272893353); c = hh(c,d,a,b,x[i+7],16,-155497632); b = hh(b,c,d,a,x[i+10],23,-1094730640);
    a = hh(a,b,c,d,x[i+13],4,681279174); d = hh(d,a,b,c,x[i+0],11,-358537222); c = hh(c,d,a,b,x[i+3],16,-722521979); b = hh(b,c,d,a,x[i+6],23,76029189);
    a = hh(a,b,c,d,x[i+9],4,-640364487); d = hh(d,a,b,c,x[i+12],11,-421815835); c = hh(c,d,a,b,x[i+15],16,530742520); b = hh(b,c,d,a,x[i+2],23,-995338651);
    a = ii(a,b,c,d,x[i+0],6,-198630844); d = ii(d,a,b,c,x[i+7],10,1126891415); c = ii(c,d,a,b,x[i+14],15,-1416354905); b = ii(b,c,d,a,x[i+5],21,-57434055);
    a = ii(a,b,c,d,x[i+12],6,1700485571); d = ii(d,a,b,c,x[i+3],10,-1894986606); c = ii(c,d,a,b,x[i+10],15,-1051523); b = ii(b,c,d,a,x[i+1],21,-2054922799);
    a = ii(a,b,c,d,x[i+8],6,1873313359); d = ii(d,a,b,c,x[i+15],10,-30611744); c = ii(c,d,a,b,x[i+6],15,-1560198380); b = ii(b,c,d,a,x[i+13],21,1309151649);
    a = ii(a,b,c,d,x[i+4],6,-145523070); d = ii(d,a,b,c,x[i+11],10,-1120210379); c = ii(c,d,a,b,x[i+2],15,718787259); b = ii(b,c,d,a,x[i+9],21,-343485551);
    a = add(a,oa); b = add(b,ob); c = add(c,oc); d = add(d,od);
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

// Build the Gravatar URL for an email. `d=404` returns a real 404 when no
// Gravatar exists for the address, so the <img> onError handler can fall
// back to our initials avatar instead of showing the default mystery-person.
function gravatarUrl(email: string): string | null {
  if (!email || !email.includes('@')) return null;
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=80&d=404`;
}

// Avatar — tries Gravatar first, falls back to colored initials on 404.
function Avatar({ seed, label }: { seed: string; label: string }) {
  const url = gravatarUrl(seed);
  const [failed, setFailed] = useState(false);
  if (url && !failed) {
    return (
      <img
        src={url}
        onError={() => setFailed(true)}
        alt={label}
        title={seed}
        className="h-9 w-9 rounded-full shrink-0 object-cover ring-1 ring-black/10 bg-muted"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div
      className="h-9 w-9 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-white shadow-inner ring-1 ring-black/10"
      style={{ background: avatarColor(seed) }}
      title={seed}
    >
      {label}
    </div>
  );
}

export default function MailPage() {
  const dlg = useDialog();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [imapFolders, setImapFolders] = useState<{ name: string; label: string; kind: string }[]>([]);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [accountsDiag, setAccountsDiag] = useState<any>(null);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [folder, setFolder] = useState<Folder>('INBOX');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<MsgRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [full, setFull] = useState<FullMsg | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [composer, setComposer] = useState<ComposerState | null>(null);

  // Load accounts once
  useEffect(() => {
    api.mailAccounts().then((r: any) => {
      setAccounts(r.accounts);
      setAccountsDiag(r.diag ?? null);
      if (r.accounts.length && !account) setAccount(r.accounts[0].label);
    }).catch(() => {});
  }, []);

  // Pagination. Backend orders DESC by ts so first page = newest.
  const PAGE_SIZE = 50;
  const [loadingMore, setLoadingMore] = useState(false);

  const buildListOpts = (offset: number) => {
    const o: any = { account, limit: PAGE_SIZE, offset };
    if (folder === 'unread') { o.unread = true; o.folder = 'INBOX'; }
    else if (folder === 'starred') { /* client-side filter below */ }
    else if (folder === 'trash') { o.folder = 'trash'; }
    else { o.folder = folder; }
    if (q) o.q = q;
    return o;
  };

  // `silent` = no loading spinner; used by 30s poll, WS pushes, focus refresh.
  // The initial filter-change fetch still shows the spinner so the user gets
  // immediate visual feedback when switching folders / typing in search.
  const fetchList = useMemo(() => async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.mailList(buildListOpts(0));
      let rs = r.rows as MsgRow[];
      if (folder === 'starred') rs = rs.filter((x) => x.starred);
      setRows(rs);
      setTotal(r.total);
    } catch (e) { console.error(e); }
    finally { if (!silent) setLoading(false); }
  }, [account, folder, q]);

  async function loadMore() {
    if (loadingMore || loading) return;
    setLoadingMore(true);
    try {
      const r = await api.mailList(buildListOpts(rows.length));
      let next = r.rows as MsgRow[];
      if (folder === 'starred') next = next.filter((x) => x.starred);
      // Dedup by id in case server returned overlap
      const ids = new Set(rows.map((x) => x.id));
      setRows([...rows, ...next.filter((x) => !ids.has(x.id))]);
      setTotal(r.total);
    } catch (e) { console.error(e); }
    finally { setLoadingMore(false); }
  }

  useEffect(() => { if (account) fetchList(); }, [account, folder, q, fetchList]);

  // Discover IMAP folders for the selected account.
  // We hide only kinds that have a fixed slot already (inbox/sent/trash).
  // Everything else — Drafts, Spam, Archive, All Mail, Important, Starred,
  // [Gmail]/Categories, user labels — is shown.
  useEffect(() => {
    if (!account) { setImapFolders([]); setFoldersError(null); return; }
    const cleanErr = (raw: string) => {
      // Express returns raw HTML on 404 → strip tags and pick "Cannot GET ..." line.
      const m = raw.match(/Cannot (GET|POST|PUT|DELETE) [^\s<]+/);
      if (m) return `${m[0]} — backend non aggiornato? Riavvia.`;
      return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    };
    api.mailFolders(account).then((r) => {
      if (r.ok) {
        setImapFolders(r.folders.filter((f) => !['inbox', 'sent', 'trash'].includes(f.kind)));
        setFoldersError(null);
      } else {
        setImapFolders([]);
        setFoldersError(cleanErr(r.error ?? 'errore nel caricamento'));
      }
    }).catch((e) => { setImapFolders([]); setFoldersError(cleanErr(String(e?.message ?? e))); });
  }, [account]);

  // WS push: new mail / seen change → silent refresh
  useWS((m) => {
    if ((m?.type === 'mail:new' || m?.type === 'mail:flags') && account) fetchList(true);
  });

  // 30s silent safety-net poll. Skipped while a sync or full-blocking load
  // is already running so we never clobber state mid-fetch.
  useEffect(() => {
    if (!account) return;
    const iv = setInterval(() => {
      if (loading || syncing) return;
      fetchList(true);
    }, 30_000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, folder, q]);

  // Focus / visibility return: at most once every 60s we ask the backend for
  // an incremental IMAP pull, then silent refresh. Throttle prevents the
  // earlier "every 4–5s flash" caused by both events firing in sequence.
  const lastFocusSyncRef = useRef(0);
  useEffect(() => {
    if (!account) return;
    const FOCUS_THROTTLE_MS = 60_000;
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastFocusSyncRef.current < FOCUS_THROTTLE_MS) return;
      lastFocusSyncRef.current = now;
      if (syncing) return;
      api.mailSync(account, 50).then(() => fetchList(true)).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // Load the full thread when a row is selected. We render every message in
  // the same thread_key stacked chronologically (Spark/Gmail conversation).
  // Older messages collapse to a header; only the latest expands by default.
  const [threadMsgs, setThreadMsgs] = useState<FullMsg[] | null>(null);
  useEffect(() => {
    if (!selected) { setFull(null); setThreadMsgs(null); return; }
    setRows((rs) => rs.map((x) => x.id === selected && !x.seen ? { ...x, seen: true } : x));
    // First fetch the single message to know thread_key, then fetch the full thread
    api.mailGet(selected).then(async (m) => {
      setFull({ ...m, seen: true });
      const key = m.thread_key || `id:${m.id}`;
      try {
        const r = await api.mailThread(key);
        setThreadMsgs(r.messages as FullMsg[]);
      } catch { setThreadMsgs([m as FullMsg]); }
    }).catch(() => { setFull(null); setThreadMsgs(null); });
  }, [selected]);

  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [bonifying, setBonifying] = useState(false);
  const [bonifyingOne, setBonifyingOne] = useState(false);

  async function bonifyAll() {
    if (!account || bonifying) return;
    setBonifying(true); setSyncResult(null);
    try {
      const r = await api.mailBonify({ account, limit: 1000 });
      setSyncResult(r.ok
        ? `Bonifica: +${r.processed} nel brain · ${r.skipped} già fatte · ${r.errors} errori`
        : `Bonifica fallita: ${r.error ?? 'sconosciuto'}`);
      setTimeout(() => setSyncResult(null), 6000);
      fetchList();
    } catch (e: any) { setSyncResult(`Errore: ${String(e.message ?? e)}`); }
    finally { setBonifying(false); }
  }

  async function bonifyCurrent() {
    if (!full || bonifyingOne) return;
    setBonifyingOne(true);
    try {
      const r = await api.mailBonifyOne(full.id, true);
      if (r.ok) {
        setSyncResult(r.skipped ? 'Già bonificata' : `Bonificata: ${r.subj ?? ''}`);
        setTimeout(() => setSyncResult(null), 4000);
      } else {
        setSyncResult(`Errore: ${r.error ?? 'sconosciuto'}`);
      }
    } catch (e: any) { setSyncResult(`Errore: ${String(e.message ?? e)}`); }
    finally { setBonifyingOne(false); }
  }
  async function sync() {
    if (!account) return;
    setSyncing(true); setSyncResult(null);
    try {
      const r = await api.mailSync(account, 1000);
      if (r.ok) {
        const fetched = r.fetched ?? 0;
        const skipped = r.skipped ?? 0;
        const d = r.diag ?? {};
        const tag = fetched === 0 && skipped === 0
          ? `Niente da scaricare · stored ${d.storedCount ?? '?'} / ${d.totalMsgs ?? '?'} · uidNext ${d.uidNext ?? '?'} · ranges [${(d.ranges ?? []).join(', ') || '—'}]`
          : `+${fetched} nuove${skipped ? ` · ${skipped} già presenti` : ''}`;
        setSyncResult(tag);
        setTimeout(() => setSyncResult(null), 8000);
        fetchList();
      } else {
        setSyncResult(`Errore: ${r.error ?? 'sconosciuto'}`);
      }
    } catch (e: any) { setSyncResult(`Errore: ${String(e.message ?? e)}`); }
    finally { setSyncing(false); }
  }

  async function trash(id: number) {
    const ok = await dlg.confirm('La email verrà spostata nel cestino. Procedere?', {
      title: 'Sposta nel cestino',
      tone: 'danger',
      confirmLabel: 'Sposta nel cestino',
      cancelLabel: 'Annulla',
    });
    if (!ok) return;
    await api.mailTrash(id).catch(() => {});
    setRows((rs) => rs.filter((x) => x.id !== id));
    if (selected === id) setSelected(null);
  }

  async function toggleStar(id: number, val: boolean) {
    await api.mailMark(id, { starred: val }).catch(() => {});
    setRows((rs) => rs.map((x) => x.id === id ? { ...x, starred: val } : x));
    if (full?.id === id) setFull({ ...full, starred: val });
  }

  async function toggleSeen(id: number, val: boolean) {
    await api.mailMark(id, { seen: val }).catch(() => {});
    setRows((rs) => rs.map((x) => x.id === id ? { ...x, seen: val } : x));
    if (full?.id === id) setFull({ ...full, seen: val });
  }

  async function markAllSeen() {
    const targets = rows.filter((x) => !x.seen);
    if (!targets.length) return;
    await Promise.all(targets.map((m) => api.mailMark(m.id, { seen: true }).catch(() => {})));
    setRows((rs) => rs.map((x) => ({ ...x, seen: true })));
  }

  function openComposer(initial: Partial<ComposerState>) {
    if (!account) return;
    setComposer({
      account, to: '', cc: '', bcc: '', subject: '', body: '',
      showCc: false, showBcc: false, attachments: [], inReplyTo: undefined, references: [],
      ...initial,
    });
  }

  function startReply(m: FullMsg, all = false) {
    const fromAddr = m.from_addr ?? '';
    const subj = m.subject ?? '';
    const subjPrefixed = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
    const toList = m.direction === 'out' ? m.to_addrs.join(', ') : fromAddr;
    const ccList = all
      ? [...m.to_addrs, ...m.cc_addrs].filter((a) => a && a !== fromAddr && a !== m.account_label).join(', ')
      : '';
    const refs = [...(m.refs ?? []), m.message_id ?? ''].filter(Boolean);
    const quoted = quoteOriginal(m);
    openComposer({
      to: toList, cc: ccList, subject: subjPrefixed, body: `\n\n${quoted}`,
      showCc: !!ccList, inReplyTo: m.message_id ?? undefined, references: refs,
    });
  }

  function startForward(m: FullMsg) {
    const subj = m.subject ?? '';
    const subjPrefixed = /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`;
    openComposer({
      to: '', subject: subjPrefixed,
      body: `\n\n${quoteOriginal(m)}`,
      inReplyTo: undefined, references: [],
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left rail: accounts + folders */}
        <aside className="w-56 shrink-0 border-r border-border bg-background/40 flex flex-col">
          <div className="p-3 border-b border-border space-y-2">
            <Select value={account ?? ''} onValueChange={(v) => { setAccount(v); setSelected(null); }}>
              <SelectTrigger className="w-full h-9 text-xs"><SelectValue placeholder="Account" /></SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.label} value={a.label}>
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">{a.label}</span>
                      <span className="text-[10px] text-muted-foreground">{a.address}</span>
                    </div>
                  </SelectItem>
                ))}
                {!accounts.length && (
                  <div className="p-2 text-xs text-muted-foreground space-y-1">
                    <div>Nessun account valido.</div>
                    {accountsDiag && (
                      <pre className="text-[10px] font-mono bg-surface2 p-1 rounded leading-snug">
{`row IMAP: ${accountsDiag.connectorRow ? 'sì' : 'NO'}
enabled: ${String(accountsDiag.enabled)}
rawCount: ${accountsDiag.rawCount}
firstMissing: ${(accountsDiag.firstMissing ?? []).join(', ') || '—'}`}
                      </pre>
                    )}
                    <div>Apri /connectors → IMAP e verifica.</div>
                  </div>
                )}
              </SelectContent>
            </Select>
            <Button size="sm" className="w-full" onClick={() => openComposer({})} disabled={!account}>
              <Sparkles size={14} /> Nuova email
            </Button>
          </div>
          <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {FIXED_FOLDERS.map((f) => {
              const I = f.icon;
              const active = folder === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => { setFolder(f.key); setSelected(null); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition ${active ? 'bg-accent/15 text-accent font-medium' : 'text-foreground/80 hover:bg-surface2'}`}
                >
                  <I size={14} className={active ? 'text-accent' : 'text-muted-foreground'} />
                  {f.label}
                </button>
              );
            })}
            {(imapFolders.length > 0 || foldersError) && (
              <div className="mt-3 mb-1 px-3 text-[10px] uppercase tracking-wider text-muted-foreground/60">Cartelle & etichette</div>
            )}
            {foldersError && (
              <div className="px-3 py-2 text-[10px] text-destructive break-words">
                {foldersError}
              </div>
            )}
            {imapFolders.length > 0 && (
              <>
                {imapFolders.map((f) => {
                  const I = f.kind === 'drafts' ? FileEdit
                    : f.kind === 'junk' ? ShieldAlert
                    : f.kind === 'archive' ? Archive
                    : f.kind === 'all' ? Tag
                    : FolderIcon;
                  const active = folder === f.name;
                  return (
                    <button
                      key={f.name}
                      onClick={() => { setFolder(f.name); setSelected(null); }}
                      title={f.name}
                      className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition ${active ? 'bg-accent/15 text-accent font-medium' : 'text-foreground/80 hover:bg-surface2'}`}
                    >
                      <I size={14} className={active ? 'text-accent' : 'text-muted-foreground'} />
                      <span className="truncate">{f.label}</span>
                    </button>
                  );
                })}
              </>
            )}
          </nav>
        </aside>

        {/* Middle: message list */}
        <section className="w-96 shrink-0 min-h-0 border-r border-border flex flex-col bg-background/20">
          <div className="p-3 border-b border-border space-y-2 relative">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Cerca…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 h-8 text-xs" disabled={syncing} />
              </div>
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant={syncing ? 'default' : 'ghost'}
                      onClick={sync}
                      disabled={syncing || !account}
                      className="h-8 w-8 shrink-0"
                      aria-busy={syncing}
                      aria-label={syncing ? 'Sync in corso' : 'Sync ora'}
                    >
                      {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{syncing ? 'Sync in corso…' : 'Sync ora'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant={bonifying ? 'default' : 'ghost'}
                      onClick={bonifyAll}
                      disabled={bonifying || !account}
                      className="h-8 w-8 shrink-0"
                      aria-busy={bonifying}
                      aria-label={bonifying ? 'Bonifica in corso' : 'Bonifica nel brain'}
                    >
                      {bonifying ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{bonifying ? 'Bonifica in corso…' : 'Bonifica nel brain (link a persone)'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={markAllSeen}
                      disabled={!account || !rows.some((x) => !x.seen)}
                      className="h-8 w-8 shrink-0"
                      aria-label="Segna tutte come lette"
                    >
                      <CheckCheck size={14} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Segna tutte come lette</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>{rows.length} di {total} · {(FIXED_FOLDERS.find((f) => f.key === folder)?.label ?? imapFolders.find((f) => f.name === folder)?.label ?? folder)}</span>
              {syncing && (
                <span className="inline-flex items-center gap-1 text-accent normal-case tracking-normal">
                  <Loader2 size={11} className="animate-spin" /> sync…
                </span>
              )}
              {!syncing && syncResult && (
                <span className={`normal-case tracking-normal ${syncResult.startsWith('Errore') ? 'text-destructive' : 'text-[hsl(var(--success))]'}`}>
                  {syncResult}
                </span>
              )}
            </div>
            {/* Indeterminate top progress strip while syncing */}
            {syncing && (
              <div className="absolute left-0 right-0 -bottom-px h-0.5 overflow-hidden">
                <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-accent to-transparent animate-mail-sync" />
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {loading && <div className="p-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Caricamento…</div>}
            {!loading && !rows.length && (
              <div className="p-8 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
                <Inbox size={28} className="opacity-40" />
                <div>Nessuna email in questa cartella.</div>
                <div className="text-[10px] text-muted-foreground/70">Il sync della casella scarica tutte le cartelle.</div>
                {account && <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
                  {syncing ? <><Loader2 size={13} className="animate-spin" /> Sync…</> : <><RefreshCw size={13} /> Sincronizza casella</>}
                </Button>}
              </div>
            )}
            {/* List rendering — date sections + thread grouping */}
            {(() => {
              // Group by thread_key keeping the most recent message as the
              // representative. Aggregate count + has-unread + has-attach.
              type Thread = { rep: MsgRow; count: number; hasUnread: boolean; hasAttach: boolean; isDraft: boolean };
              const byThread = new Map<string, Thread>();
              for (const m of rows) {
                const key = m.thread_key || `id:${m.id}`;
                const t = byThread.get(key);
                if (!t) {
                  byThread.set(key, {
                    rep: m, count: 1, hasUnread: !m.seen,
                    hasAttach: (m.attach_count ?? 0) > 0,
                    isDraft: m.folder?.toLowerCase().includes('draft') || m.folder?.toLowerCase().includes('bozz'),
                  });
                } else {
                  t.count++;
                  if (!m.seen) t.hasUnread = true;
                  if ((m.attach_count ?? 0) > 0) t.hasAttach = true;
                }
              }
              const threads = [...byThread.values()];
              // Bucket threads by date
              const sections = new Map<ReturnType<typeof dateBucket>, Thread[]>();
              for (const t of threads) {
                const b = dateBucket(t.rep.ts);
                if (!sections.has(b)) sections.set(b, []);
                sections.get(b)!.push(t);
              }
              const order: Array<ReturnType<typeof dateBucket>> = ['oggi', 'ieri', 'settimana', 'mese', 'piuvecchio'];
              return order.filter((b) => sections.has(b)).map((b) => (
                <div key={b}>
                  <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60 sticky top-0 bg-background/85 backdrop-blur-sm z-10">{BUCKET_LABEL[b]}</div>
                  {sections.get(b)!.map((t) => {
                    const m = t.rep;
                    const active = selected === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => setSelected(m.id)}
                        className={`w-full text-left px-3 py-2.5 border-b border-border/30 transition flex items-start gap-3 ${active ? 'bg-accent/10 border-l-2 border-l-accent' : 'hover:bg-surface2/40'}`}
                      >
                        <Avatar seed={senderSeed(m)} label={initialsOf(m.from_name, m.from_addr)} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {t.isDraft && <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold shrink-0">Bozza</span>}
                              <span className={`text-sm truncate ${t.hasUnread ? 'font-semibold text-foreground' : 'text-foreground/80'}`}>{senderLabel(m)}</span>
                              {t.count > 1 && (
                                <span className="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground shrink-0">{t.count}</span>
                              )}
                            </div>
                            <span className={`text-[10px] tabular-nums shrink-0 ${t.hasUnread ? 'text-accent font-semibold' : 'text-muted-foreground'}`}>{fmtDate(m.ts)}</span>
                          </div>
                          <div className={`text-[13px] truncate mt-0.5 ${t.hasUnread ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                            {m.subject || '(senza oggetto)'}
                          </div>
                          <div className="text-[11px] text-muted-foreground/80 line-clamp-1 mt-0.5">{m.preview ?? ''}</div>
                          <div className="flex items-center gap-1.5 mt-1">
                            {m.starred && <Star size={11} className="text-amber-400 fill-amber-400" />}
                            {t.hasAttach && <Paperclip size={11} className="text-muted-foreground" />}
                            {t.hasUnread && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent ml-auto" />}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ));
            })()}
            {/* Load more */}
            {rows.length > 0 && rows.length < total && (
              <div className="p-3 flex justify-center">
                <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? <><Loader2 size={13} className="animate-spin" /> Caricamento…</> : <><ChevronDown size={13} /> Carica altre ({total - rows.length})</>}
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* Right: viewer */}
        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-background/10">
          {!full ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm flex-col gap-2">
              <MailIcon size={36} className="opacity-30" />
              <div>Seleziona un messaggio</div>
            </div>
          ) : (
            <>
              <div className="border-b border-border p-4 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-lg font-semibold flex-1">{full.subject || '(senza oggetto)'}</h2>
                  <div className="flex items-center gap-1">
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={bonifyCurrent}
                            disabled={bonifyingOne}
                            aria-busy={bonifyingOne}
                          >
                            {bonifyingOne ? <Loader2 size={15} className="animate-spin text-accent" /> : <Wand2 size={15} className={(full as any).bonified_at ? 'text-accent' : 'text-muted-foreground'} />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{(full as any).bonified_at ? 'Già bonificata · ri-bonifica' : 'Bonifica nel brain'}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleSeen(full.id, !full.seen)}>
                            {full.seen ? <MailIcon size={15} className="text-muted-foreground" /> : <MailOpen size={15} className="text-accent" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">{full.seen ? 'Segna come non letta' : 'Segna come letta'}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => toggleStar(full.id, !full.starred)}>
                      <Star size={15} className={full.starred ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground'} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => trash(full.id)}>
                      <Trash2 size={15} className="text-muted-foreground" />
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div><span className="text-foreground font-medium">{full.from_name || full.from_addr}</span>{full.from_name && full.from_addr ? <span> &lt;{full.from_addr}&gt;</span> : null}</div>
                  <div>A: {full.to_addrs.join(', ') || '—'}</div>
                  {full.cc_addrs.length > 0 && <div>Cc: {full.cc_addrs.join(', ')}</div>}
                  <div>{new Date(full.ts).toLocaleString('it-IT')} · {full.account_label}</div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => startReply(full, false)}><Reply size={13} /> Rispondi</Button>
                  <Button size="sm" variant="outline" onClick={() => startReply(full, true)}><ReplyAll size={13} /> Rispondi a tutti</Button>
                  <Button size="sm" variant="outline" onClick={() => startForward(full)}><Forward size={13} /> Inoltra</Button>
                  <Button size="sm" variant="outline" onClick={async () => {
                    const r = await api.mailSuggest(full.id).catch((e) => ({ ok: false, error: String(e.message ?? e) }));
                    if (r.ok && r.draft) startReply(full, false);
                    if (r.ok && r.draft && composer) setComposer({ ...composer, body: r.draft });
                    if (r.ok && r.draft) {
                      // delayed: composer just opened
                      setTimeout(() => setComposer((c) => c ? { ...c, body: r.draft } : c), 50);
                    }
                  }}>
                    <Sparkles size={13} /> Bozza AI
                  </Button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
                {/* Conversation view: stack every message in the thread.
                    Latest expands by default; older ones collapse to a header
                    that the user can click to open. */}
                {(threadMsgs ?? [full]).map((tm, idx, arr) => (
                  <ThreadMessage key={tm.id} msg={tm} defaultOpen={idx === arr.length - 1} />
                ))}
              </div>
            </>
          )}
        </main>
      </div>
      {composer && (
        <Composer
          state={composer}
          setState={setComposer}
          onSent={() => { setComposer(null); fetchList(); }}
          onSuggest={full ? async () => {
            try {
              const r = await api.mailSuggest(full.id);
              return r.ok ? (r.draft ?? null) : null;
            } catch { return null; }
          } : undefined}
        />
      )}
    </div>
  );
}

// Render raw email HTML inside an isolated iframe so the sender's <style>
// rules, body { ... } selectors, and inline scripts can NEVER leak into the
// app shell. Auto-resizes height to the content. Theme-aware: injects a
// minimal CSS reset so dark-mode keeps things readable, while leaving the
// sender's design intact for senders that ship light-on-light content.
function MailBodyFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(400);

  // Build self-contained HTML document. `srcdoc` keeps origin null so no
  // cookies/localStorage leak from the parent. Links open in a new tab.
  // The iframe is isolated so we KEEP the sender's original styling intact —
  // email designs assume a white canvas, so we give them one regardless of
  // the app theme. The frame itself sits on the app's dark background; the
  // white card-like canvas inside reads like a real mail client.
  const srcdoc = useMemo(() => {
    // overflow:hidden on the iframe document so it never grows its own
    // scrollbar — the outer viewer pane owns scrolling. We size the iframe
    // tall enough to fit content via JS below.
    const baseCss = `
      html, body { margin: 0; padding: 16px; background: #ffffff; color: #1f2937; overflow: hidden; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
      img { max-width: 100%; height: auto; }
    `;
    return `<!doctype html>
<html><head><meta charset="utf-8"><base target="_blank">
<style>${baseCss}</style>
</head><body>${html}</body></html>`;
  }, [html]);

  function adjustHeight() {
    const iframe = ref.current;
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;
    const body = doc.body;
    const docEl = doc.documentElement;
    if (!body) return;
    const h = Math.max(body.scrollHeight, body.offsetHeight, docEl?.scrollHeight ?? 0, docEl?.offsetHeight ?? 0, 200);
    setHeight(h + 4); // tiny pad for descender clipping
  }

  // Re-measure on dynamic content changes (image loads, layout shifts).
  useEffect(() => {
    const iframe = ref.current;
    if (!iframe?.contentDocument) return;
    const doc = iframe.contentDocument;
    if (!doc.body) return;
    let ro: ResizeObserver | null = null;
    if ('ResizeObserver' in window) {
      ro = new ResizeObserver(() => adjustHeight());
      ro.observe(doc.body);
    }
    // Also re-measure when images finish loading
    const imgs = Array.from(doc.images ?? []);
    const onImg = () => adjustHeight();
    imgs.forEach((img) => { if (!img.complete) img.addEventListener('load', onImg, { once: true }); });
    return () => { ro?.disconnect(); imgs.forEach((img) => img.removeEventListener('load', onImg)); };
  }, [srcdoc]);

  return (
    <iframe
      ref={ref}
      srcDoc={srcdoc}
      onLoad={adjustHeight}
      scrolling="no"
      sandbox="allow-same-origin allow-popups"
      style={{ width: '100%', height, border: 'none', borderRadius: 8, background: '#ffffff', display: 'block' }}
      title="email body"
    />
  );
}

// One message inside a conversation. Header always visible; body collapses.
function ThreadMessage({ msg, defaultOpen }: { msg: FullMsg; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const isMine = msg.direction === 'out';
  return (
    <div className={`rounded-lg border ${open ? 'border-border bg-card/40' : 'border-border/60'} overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 p-3 hover:bg-surface2/40 text-left transition"
      >
        <Avatar seed={senderSeed(msg)} label={initialsOf(msg.from_name, msg.from_addr)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
              {isMine ? 'Io' : (msg.from_name || msg.from_addr || '—')}
              {!isMine && msg.from_name && msg.from_addr && (
                <span className="font-normal text-muted-foreground"> &lt;{msg.from_addr}&gt;</span>
              )}
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">{new Date(msg.ts).toLocaleString('it-IT')}</span>
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            A: {msg.to_addrs?.join(', ') || '—'}
            {msg.cc_addrs?.length > 0 && <> · Cc: {msg.cc_addrs.join(', ')}</>}
          </div>
          {!open && (
            <div className="text-[12px] text-muted-foreground/80 line-clamp-2 mt-1">{msg.preview ?? ''}</div>
          )}
        </div>
        {(msg.attachments?.length ?? 0) > 0 && <Paperclip size={13} className="text-muted-foreground mt-1" />}
      </button>
      {open && (
        <div className="px-3 pb-3">
          {msg.body_html ? (
            <MailBodyFrame html={msg.body_html} />
          ) : (
            <pre className="text-sm whitespace-pre-wrap font-sans text-foreground p-2">{msg.body_text}</pre>
          )}
          {msg.attachments?.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Paperclip size={12} /> Allegati ({msg.attachments.length})</div>
              <div className="flex flex-wrap gap-2">
                {msg.attachments.map((a) => (
                  <a key={a.id} href={api.mailAttachmentUrl(a.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:bg-surface2 text-xs">
                    <Paperclip size={12} className="text-accent" />
                    <span className="font-medium">{a.filename}</span>
                    <span className="text-muted-foreground">{fmtBytes(a.size_bytes)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function quoteOriginal(m: FullMsg): string {
  const body = (m.body_text ?? '').slice(0, 4000);
  const head = `Il ${new Date(m.ts).toLocaleString('it-IT')}, ${m.from_name || m.from_addr} ha scritto:`;
  const quoted = body.split('\n').map((l) => `> ${l}`).join('\n');
  return `${head}\n${quoted}`;
}

type ComposerState = {
  account: string;
  to: string; cc: string; bcc: string; subject: string; body: string;
  showCc: boolean; showBcc: boolean;
  attachments: File[];
  inReplyTo?: string;
  references: string[];
};

function Composer({ state, setState, onSent, onSuggest }: { state: ComposerState; setState: (s: ComposerState | null) => void; onSent: () => void; onSuggest?: () => Promise<string | null> }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Initialize the contenteditable HTML once from `state.body`. Subsequent
  // edits sync via onInput. Avoid React rewriting innerHTML mid-edit
  // (would lose caret position).
  useEffect(() => {
    if (bodyRef.current && bodyRef.current.innerHTML !== state.body) {
      bodyRef.current.innerHTML = state.body || '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send() {
    setSending(true); setError(null);
    try {
      const bodyHtml = bodyRef.current?.innerHTML ?? state.body;
      const bodyText = bodyRef.current?.innerText ?? state.body;
      await api.mailSend({
        account: state.account, to: state.to, cc: state.cc, bcc: state.bcc,
        subject: state.subject, body: bodyText, html: bodyHtml,
        inReplyTo: state.inReplyTo, references: state.references, attachments: state.attachments,
      });
      onSent();
    } catch (e: any) { setError(String(e.message ?? e)); }
    finally { setSending(false); }
  }

  async function generateAI() {
    if (!onSuggest) return;
    setAiBusy(true);
    try {
      const draft = await onSuggest();
      if (draft && bodyRef.current) {
        // Replace body with the AI draft, preserving HTML line breaks
        const html = draft.split('\n').map((l) => `<div>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>'}</div>`).join('');
        bodyRef.current.innerHTML = html + bodyRef.current.innerHTML;
        setState({ ...state, body: bodyRef.current.innerHTML });
      }
    } finally { setAiBusy(false); }
  }

  function exec(cmd: string, value?: string) {
    document.execCommand(cmd, false, value);
    bodyRef.current?.focus();
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    setState({ ...state, attachments: [...state.attachments, ...Array.from(files)] });
  }

  // Pills for chip-style recipients
  function parsePills(s: string): string[] {
    return s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-end p-4">
      <Card className="w-full max-w-3xl h-[88vh] flex flex-col shadow-2xl border-border rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/60">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold">{state.inReplyTo ? 'Rispondi' : 'Nuovo messaggio'}</span>
            {state.subject && <span className="text-sm text-muted-foreground truncate max-w-[260px]">· {state.subject}</span>}
          </div>
          <Button variant="ghost" size="icon" onClick={() => setState(null)} className="h-8 w-8"><X size={15} /></Button>
        </div>

        {/* Headers */}
        <div className="px-4 pt-3 pb-2 space-y-2 border-b border-border/50">
          <RecipientField label="A" value={state.to} onChange={(v) => setState({ ...state, to: v })} pills={parsePills(state.to)} onRemovePill={(p) => setState({ ...state, to: parsePills(state.to).filter((x) => x !== p).join(', ') })} />
          {state.showCc && (
            <RecipientField label="Cc" value={state.cc} onChange={(v) => setState({ ...state, cc: v })} pills={parsePills(state.cc)} onRemovePill={(p) => setState({ ...state, cc: parsePills(state.cc).filter((x) => x !== p).join(', ') })} />
          )}
          {state.showBcc && (
            <RecipientField label="Ccn" value={state.bcc} onChange={(v) => setState({ ...state, bcc: v })} pills={parsePills(state.bcc)} onRemovePill={(p) => setState({ ...state, bcc: parsePills(state.bcc).filter((x) => x !== p).join(', ') })} />
          )}
          <div className="flex items-center gap-3 text-[11px]">
            {!state.showCc && <button onClick={() => setState({ ...state, showCc: true })} className="text-muted-foreground hover:text-accent">+ Cc</button>}
            {!state.showBcc && <button onClick={() => setState({ ...state, showBcc: true })} className="text-muted-foreground hover:text-accent">+ Ccn</button>}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-12 shrink-0">Oggetto</span>
            <input
              value={state.subject}
              onChange={(e) => setState({ ...state, subject: e.target.value })}
              placeholder="Oggetto…"
              className="flex-1 bg-transparent border-0 outline-none text-sm font-medium placeholder:text-muted-foreground/60"
            />
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 bg-card/30 text-muted-foreground">
          <button onClick={() => exec('bold')} className="px-2 py-1 hover:bg-surface2 rounded font-bold text-sm" title="Grassetto">B</button>
          <button onClick={() => exec('italic')} className="px-2 py-1 hover:bg-surface2 rounded italic text-sm" title="Corsivo">I</button>
          <button onClick={() => exec('underline')} className="px-2 py-1 hover:bg-surface2 rounded underline text-sm" title="Sottolineato">U</button>
          <button onClick={() => exec('insertUnorderedList')} className="px-2 py-1 hover:bg-surface2 rounded text-sm" title="Elenco">•</button>
          <button onClick={() => { const u = prompt('URL link:'); if (u) exec('createLink', u); }} className="px-2 py-1 hover:bg-surface2 rounded text-sm" title="Link">🔗</button>
          <div className="flex-1" />
        </div>

        {/* Body editor */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            onInput={(e) => setState({ ...state, body: (e.target as HTMLDivElement).innerHTML })}
            className="min-h-[280px] outline-none text-sm text-foreground leading-relaxed prose prose-sm prose-invert max-w-none [&_a]:text-accent"
          />
          {state.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-3 mt-3 border-t border-border/40">
              {state.attachments.map((f, i) => (
                <div key={i} className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-card/40 text-[11px]">
                  <Paperclip size={11} className="text-accent" />
                  <span>{f.name}</span>
                  <span className="text-muted-foreground">{fmtBytes(f.size)}</span>
                  <button onClick={() => setState({ ...state, attachments: state.attachments.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive">
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2 mt-3">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* AI pill — prominent generate-reply CTA, like Spark */}
        {onSuggest && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={generateAI}
              disabled={aiBusy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))] text-primary-foreground text-sm font-medium shadow-sm hover:opacity-90 disabled:opacity-60"
            >
              {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {aiBusy ? 'Generazione…' : 'Genera una risposta'}
            </button>
          </div>
        )}
        <div className="flex items-center justify-between p-3 border-t border-border">
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip size={13} /> Allega
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setState(null)}>Annulla</Button>
            <Button size="sm" onClick={send} disabled={sending || !state.to || !state.subject}>
              {sending ? <><Loader2 size={13} className="animate-spin" /> Invio…</> : <><Send size={13} /> Invia</>}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Inline chip field: typed addresses display as pills + free input at the end.
function RecipientField({ label, value, onChange, pills, onRemovePill }: { label: string; value: string; onChange: (v: string) => void; pills: string[]; onRemovePill: (p: string) => void }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-12 pt-1.5 shrink-0">{label}</span>
      <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 py-1">
        {pills.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-accent/10 border border-accent/30 text-[12px]">
            <span className="text-foreground">{p}</span>
            <button onClick={() => onRemovePill(p)} className="text-muted-foreground hover:text-destructive">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={pills.length ? '' : 'dest@x.it, …'}
          className="flex-1 min-w-[140px] bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60"
        />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 pt-2">{label}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
