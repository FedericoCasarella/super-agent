import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useWS } from '../ws';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Mail as MailIcon, Inbox, Send, Star, Trash2, RefreshCw, Reply, ReplyAll, Forward, Sparkles, Paperclip, X, Search, AlertCircle, Loader2, Wand2, MailOpen, CheckCheck, ChevronDown, FileEdit, Archive, ShieldAlert, Tag, FolderIcon, Bold as BoldIcon, Italic as ItalicIcon, Underline as UnderlineIcon, List as ListIcon, Link2 as LinkIcon, MoreHorizontal, User as UserIcon, UserPlus, Strikethrough as StrikeIcon, Heading1 as H1Icon, ListOrdered as OrderedListIcon, Quote as QuoteIcon, IndentIncrease as IndentInIcon, IndentDecrease as IndentOutIcon } from 'lucide-react';

type Account = { label: string; address: string; host: string; mailbox: string };
type MsgRow = {
  id: number; account_label: string; uid: number | null; message_id: string | null;
  from_addr: string | null; from_name: string | null; to_addrs: string[]; cc_addrs: string[];
  subject: string | null; preview: string | null; ts: string; seen: boolean; flagged: boolean; starred: boolean;
  direction: 'in' | 'out'; folder: string; attach_count?: number;
  thread_key?: string | null;
  from_person_slug?: string | null;
  from_person_name?: string | null;
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
  // Real IMAP folder names per account — used to map the virtual "INBOX" /
  // "Sent" sidebar entries to the actual DB folder column when filtering.
  const [inboxName, setInboxName] = useState<string>('INBOX');
  const [sentName, setSentName] = useState<string>('Sent');
  // Per-account auto-sync toggle + live "running" indicator triggered by WS
  const [autoSync, setAutoSync] = useState(false);
  const [autoSyncBusy, setAutoSyncBusy] = useState<{ mailId?: number; ts: number } | null>(null);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [foldersLoading, setFoldersLoading] = useState(false);
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
    if (folder === 'unread') { o.unread = true; o.folder = inboxName; }
    else if (folder === 'starred') { /* client-side filter below */ }
    else if (folder === 'trash') { o.folder = 'trash'; }
    else if (folder === 'INBOX') { o.folder = inboxName; }
    else if (folder === 'Sent') { o.folder = sentName; }
    else { o.folder = folder; }
    if (q) o.q = q;
    return o;
  };

  // `silent` = no loading spinner; used by 30s poll, WS pushes, focus refresh.
  // The initial filter-change fetch still shows the spinner so the user gets
  // immediate visual feedback when switching folders / typing in search.
  const [listDiag, setListDiag] = useState<any>(null);
  const fetchList = useMemo(() => async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r: any = await api.mailList(buildListOpts(0));
      let rs = r.rows as MsgRow[];
      if (folder === 'starred') rs = rs.filter((x) => x.starred);
      setRows(rs);
      setTotal(r.total);
      setListDiag(r.diag ?? null);
      // Auto-fallback: if the user lands on "In arrivo" and it's empty BUT
      // there are saved emails in another folder, jump there. Spares the
      // user the "perché non vedo nulla" confusion.
      if (
        folder === 'INBOX'
        && rs.length === 0
        && r.diag?.accountTotal > 0
        && Array.isArray(r.diag.folders)
        && r.diag.folders.length > 0
      ) {
        // Pick the folder with the most rows. If it's already the resolved
        // inbox name (which we just queried via folder=inboxName), don't loop.
        const top = r.diag.folders[0];
        if (top?.folder && top.folder !== inboxName) {
          setFolder(top.folder);
          return;
        }
      }
    } catch (e) { console.error(e); }
    finally { if (!silent) setLoading(false); }
  }, [account, folder, q, inboxName]);

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

  // Load the per-account auto-sync flag whenever the account changes.
  useEffect(() => {
    if (!account) { setAutoSync(false); return; }
    api.mailAutoSyncGet(account).then((r) => setAutoSync(!!r.enabled)).catch(() => setAutoSync(false));
  }, [account]);

  // Discover IMAP folders for the selected account.
  // We hide only kinds that have a fixed slot already (inbox/sent/trash).
  // Everything else — Drafts, Spam, Archive, All Mail, Important, Starred,
  // [Gmail]/Categories, user labels — is shown.
  useEffect(() => {
    if (!account) { setImapFolders([]); setFoldersError(null); setFoldersLoading(false); return; }
    setFoldersLoading(true);
    const cleanErr = (raw: string) => {
      const m = raw.match(/Cannot (GET|POST|PUT|DELETE) [^\s<]+/);
      if (m) return `${m[0]} — backend non aggiornato? Riavvia.`;
      return raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    };
    api.mailFolders(account).then((r) => {
      if (r.ok) {
        setImapFolders(r.folders.filter((f) => !['inbox', 'sent', 'trash'].includes(f.kind)));
        // Track the REAL inbox folder name for this account so the virtual
        // "In arrivo" filter actually matches stored rows.
        const inbox = r.folders.find((f) => f.kind === 'inbox');
        setInboxName(inbox?.name ?? 'INBOX');
        const sent = r.folders.find((f) => f.kind === 'sent');
        setSentName(sent?.name ?? 'Sent');
        setFoldersError(null);
      } else {
        setImapFolders([]);
        setFoldersError(cleanErr(r.error ?? 'errore nel caricamento'));
      }
    }).catch((e) => { setImapFolders([]); setFoldersError(cleanErr(String(e?.message ?? e))); })
    .finally(() => setFoldersLoading(false));
  }, [account]);

  // WS push: new mail / seen change → silent refresh.
  // mail:autosync drives the "Sincronizzazione…" chip near the account select.
  useWS((m) => {
    if ((m?.type === 'mail:new' || m?.type === 'mail:flags') && account) fetchList(true);
    if (m?.type === 'mail:autosync' && m.payload?.account === account) {
      const p = m.payload;
      if (p.phase === 'started') setAutoSyncBusy({ mailId: p.mailId, ts: Date.now() });
      else setAutoSyncBusy(null);
    }
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
      quoted: undefined,
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
    openComposer({
      to: toList, cc: ccList, subject: subjPrefixed, body: '',
      quoted: quoteOriginal(m),
      quotedHtml: buildQuotedHtml(m, 'reply'),
      showCc: !!ccList, inReplyTo: m.message_id ?? undefined, references: refs,
    });
  }

  function startForward(m: FullMsg) {
    const subj = m.subject ?? '';
    const subjPrefixed = /^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`;
    openComposer({
      to: '', subject: subjPrefixed,
      body: '',
      quoted: quoteOriginal(m),
      quotedHtml: buildQuotedHtml(m, 'forward'),
      inReplyTo: undefined, references: [],
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left rail: accounts + folders */}
        <aside className="w-56 shrink-0 border-r border-border bg-background/40 flex flex-col">
          <div className="p-3 border-b border-border space-y-2">
            <Select value={account ?? ''} onValueChange={(v) => {
              setAccount(v);
              setSelected(null);
              // Reset folder to the canonical INBOX of the freshly-picked
              // account; the imapFolders effect will refine it to the real
              // inbox path (e.g. "[Gmail]/Inbox") once labels load.
              setFolder('INBOX');
              setQ('');
            }}>
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
            {account && (
              <>
                <div className="flex items-center justify-between gap-2 px-1 pt-1">
                  <span className="text-[11px] text-muted-foreground">Auto-sync brain</span>
                  <div className="flex items-center gap-2">
                    {autoSyncBusy && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-accent px-1.5 py-0.5 rounded-full bg-accent/10 border border-accent/30">
                        <Loader2 size={10} className="animate-spin" /> sync…
                      </span>
                    )}
                    <Toggle
                      checked={autoSync}
                      onChange={(v) => {
                        setAutoSync(v);
                        api.mailAutoSyncSet(account, v).catch((e) => console.warn('[mail] autoSync save failed', e));
                      }}
                    />
                  </div>
                </div>
              </>
            )}
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
            {(imapFolders.length > 0 || foldersError || foldersLoading) && (
              <div className="mt-3 mb-1 px-3 text-[10px] uppercase tracking-wider text-muted-foreground/60 flex items-center gap-1.5">
                Cartelle & etichette
                {foldersLoading && <Loader2 size={10} className="animate-spin text-muted-foreground/60" />}
              </div>
            )}
            {foldersLoading && (
              <div className="space-y-1 px-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2 px-1 py-2">
                    <div className="h-3.5 w-3.5 rounded bg-muted/60 animate-pulse shrink-0" />
                    <div
                      className="h-3 rounded bg-muted/60 animate-pulse"
                      style={{ width: `${50 + (i * 11) % 40}%`, animationDelay: `${i * 80}ms` }}
                    />
                  </div>
                ))}
              </div>
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
              <div className="p-6 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
                <Inbox size={28} className="opacity-40" />
                <div>Nessuna email in questa cartella.</div>
                <div className="text-[10px] text-muted-foreground/70">Il sync della casella scarica tutte le cartelle.</div>
                {account && <Button size="sm" variant="outline" onClick={sync} disabled={syncing}>
                  {syncing ? <><Loader2 size={13} className="animate-spin" /> Sync…</> : <><RefreshCw size={13} /> Sincronizza casella</>}
                </Button>}
                {listDiag && listDiag.accountTotal > 0 && (listDiag.folders ?? []).length > 0 && (
                  <div className="mt-2 w-full">
                    <div className="text-[11px] text-muted-foreground mb-1.5">
                      Trovate <span className="text-foreground font-semibold">{listDiag.accountTotal}</span> email in altre cartelle:
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {listDiag.folders.map((f: any) => (
                        <button
                          key={f.folder}
                          onClick={() => { setFolder(f.folder); setSelected(null); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent/15 border border-accent/40 hover:bg-accent/25 transition text-xs font-medium text-accent"
                        >
                          <FolderIcon size={12} />
                          <span>{f.folder}</span>
                          <span className="text-accent/70 text-[10px]">{f.cnt}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {listDiag && listDiag.accountTotal === 0 && (
                  <div className="mt-2 text-[11px] text-amber-400/80">Questo account non ha ancora email scaricate. Premi Sync.</div>
                )}
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
                            {m.from_person_slug && (
                              <span
                                title={`Cablato a ${m.from_person_name ?? m.from_person_slug}`}
                                className="inline-flex items-center justify-center h-3.5 w-3.5 rounded-full bg-accent/15 border border-accent/40"
                              >
                                <UserIcon size={9} className="text-accent" />
                              </span>
                            )}
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
  const [linkedPerson, setLinkedPerson] = useState<{ slug: string; name: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isMine = msg.direction === 'out';
  const fromAddr = (msg.from_addr ?? '').toLowerCase();

  useEffect(() => {
    if (!fromAddr || isMine) { setLinkedPerson(null); return; }
    let cancelled = false;
    api.peopleByEmail(fromAddr).then((r) => {
      if (cancelled) return;
      setLinkedPerson(r.person ? { slug: r.person.slug, name: r.person.name } : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [fromAddr, isMine]);

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
            <span className="text-sm font-semibold text-foreground truncate flex items-center gap-1.5">
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
      {pickerOpen && (
        <PersonPickerDialog
          email={fromAddr}
          fromName={msg.from_name ?? ''}
          onClose={() => setPickerOpen(false)}
          onBound={(slug, name) => { setLinkedPerson({ slug, name }); setPickerOpen(false); }}
        />
      )}
      {open && (
        <div className="px-3 pb-3">
          {/* Action bar: link sender → person */}
          {!isMine && fromAddr && (
            <div className="flex items-center gap-2 pb-2 mb-2 border-b border-border/40">
              <span className="text-[11px] text-muted-foreground">Mittente:</span>
              {linkedPerson ? (
                <a
                  href={`/people?slug=${encodeURIComponent(linkedPerson.slug)}`}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-accent/15 border border-accent/30 text-xs text-accent hover:bg-accent/25 transition"
                  title={`Collegato a ${linkedPerson.name} — apri scheda`}
                >
                  <UserIcon size={12} /> {linkedPerson.name}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/10 border border-accent/30 text-xs text-accent hover:bg-accent/20 transition font-medium"
                >
                  <UserPlus size={12} /> Collega a una persona
                </button>
              )}
              {linkedPerson && (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  title="Cambia collegamento"
                >Cambia</button>
              )}
            </div>
          )}
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

// Picker dialog for binding a mail sender to a person in the brain. Lists
// existing people (live-search) + offers "crea nuova persona" with the email
// pre-filled. Posts to /people/:slug/bind-email and informs the caller.
function PersonPickerDialog({ email, fromName, onClose, onBound }: { email: string; fromName: string; onClose: () => void; onBound: (slug: string, name: string) => void }) {
  const [q, setQ] = useState(fromName || '');
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api.people({ q, limit: 12 })
      .then((r) => { if (!cancelled) setRows(r.rows); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [q]);

  async function bind(slug: string, name: string) {
    setError(null);
    try {
      await api.peopleBindEmail(slug, email);
      onBound(slug, name);
    } catch (e: any) { setError(String(e.message ?? e)); }
  }

  async function createNew() {
    setError(null);
    try {
      // Use upsertPerson via /tools/people_upsert (existing connector tool)
      // Simpler: use people list and create via a quick MCP call. Fallback to
      // the same bind endpoint after creating the row.
      const name = q.trim() || email.split('@')[0];
      const r: any = await api.callTool('mcp__super_agent__people_upsert', { name, emails: [email], note: 'Creato da Mail UI' });
      const slug = r?.slug ?? r?.person?.slug;
      if (!slug) throw new Error('upsert non ha ritornato uno slug');
      onBound(slug, name);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-md flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-sm font-semibold">Collega <span className="text-accent font-mono">{email}</span> a una persona</div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={15} /></button>
        </div>
        <div className="p-3 border-b border-border">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cerca persona…"
            className="w-full bg-transparent border border-border rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent"
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {busy && <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Caricamento…</div>}
          {!busy && rows.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground text-center">Nessun risultato.</div>}
          {rows.map((p) => (
            <button
              key={p.id}
              onClick={() => bind(p.slug, p.name)}
              className="w-full text-left px-3 py-2 rounded-md hover:bg-surface2/40 transition flex items-center gap-2"
            >
              <Avatar seed={p.emails?.[0] ?? p.slug} label={initialsOf(p.name, p.slug)} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {(p.emails ?? []).slice(0, 2).join(' · ') || p.slug}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="p-3 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={createNew}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-surface2"
          >
            <UserPlus size={12} /> Crea nuova persona &quot;{q || email.split('@')[0]}&quot;
          </button>
          {error && <div className="text-[11px] text-destructive truncate">{error}</div>}
        </div>
      </div>
    </div>
  );
}

// Build the HTML quoted-original block we splice into outbound forwards/replies.
// For forwards we always include the full ORIGINAL `body_html` verbatim so the
// recipient sees the message exactly as it was (markup, inline images, etc.).
// For replies we use the same fidelity strategy when HTML is available; if
// only text is present we fall back to escaped lines.
function buildQuotedHtml(m: FullMsg, kind: 'reply' | 'forward'): string {
  const when = new Date(m.ts).toLocaleString('it-IT');
  const fromTxt = (m.from_name || m.from_addr || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fromAddr = (m.from_addr ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const toAddrs = (m.to_addrs ?? []).join(', ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const subject = (m.subject ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const innerHtml = m.body_html
    ? String(m.body_html)
    : (m.body_text ?? '')
        .split('\n')
        .map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>')
        .join('<br>');

  if (kind === 'forward') {
    // Gmail-style "---------- Forwarded message ----------" header + verbatim body
    const head = `
<div style="margin:1em 0;border-top:1px solid #e5e7eb;padding-top:1em;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#555;">
  <div style="font-weight:bold;color:#222;margin-bottom:8px;">---------- Messaggio inoltrato ----------</div>
  <div><b>Da:</b> ${fromTxt}${fromAddr ? ` &lt;${fromAddr}&gt;` : ''}</div>
  <div><b>Data:</b> ${when}</div>
  <div><b>Oggetto:</b> ${subject}</div>
  <div><b>A:</b> ${toAddrs}</div>
</div>`;
    return `${head}<div>${innerHtml}</div>`;
  }

  // Reply: blockquote-wrap so most mail clients render an indent + sidebar
  const head = `<div style="margin-top:1em;color:#555;font-size:13px;">Il ${when}, ${fromTxt} ha scritto:</div>`;
  return `${head}<blockquote style="border-left:3px solid #ccc;margin:0.5em 0 1em 0;padding:0 1em;color:#666;">${innerHtml}</blockquote>`;
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
  // Pre-quoted original message — text for the collapsed "•••" preview chip,
  // and an optional HTML version that we splice into the outbound `html`
  // payload verbatim so forwards preserve the original markup, images, etc.
  quoted?: string;
  quotedHtml?: string;
  showCc: boolean; showBcc: boolean;
  attachments: File[];
  inReplyTo?: string;
  references: string[];
};

function Composer({ state, setState, onSent, onSuggest }: { state: ComposerState; setState: (s: ComposerState | null) => void; onSent: () => void; onSuggest?: () => Promise<string | null> }) {
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Initialize the contenteditable HTML once from `state.body`. Append the
  // account's saved HTML signature at the bottom so the user sees it
  // rendered while writing. The send-path picks up whatever the user left
  // in the editor (signature included → goes out as part of `html`).
  useEffect(() => {
    if (!bodyRef.current) return;
    let mounted = true;
    (async () => {
      let sigHtml = '';
      try {
        const r = await api.mailSignatureGet(state.account);
        sigHtml = (r.html ?? '').trim();
      } catch {}
      if (!mounted || !bodyRef.current) return;
      const baseBody = state.body || '<div><br></div>';
      const sigBlock = sigHtml
        ? `<div class="mail-signature" data-signature="1" style="margin-top:24px;color:#444;font-size:13px;">${sigHtml}</div>`
        : '';
      bodyRef.current.innerHTML = baseBody + sigBlock;
      // Move caret to the beginning so the user types ABOVE the signature.
      try {
        const range = document.createRange();
        range.setStart(bodyRef.current, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      } catch {}
    })();
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quoted-original toggle. Collapsed by default like Spark — three-dots chip.
  const [quotedOpen, setQuotedOpen] = useState(false);
  // Drag-and-drop overlay for attachments. Counter handles nested dragenter
  // events firing on child elements (which would otherwise flicker the hint).
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  function onDragEnter(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    dragDepth.current++;
    setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      setState({ ...state, attachments: [...state.attachments, ...Array.from(files)] });
    }
  }
  // Focus tracking for the "A" field — drives inline +Cc / +Ccn visibility.
  const [toFocused, setToFocused] = useState(false);

  async function send() {
    setError(null);
    // Force-commit any pending recipient text still in the input buffer.
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise((r) => setTimeout(r, 30));
    const to = state.to?.trim();
    if (!to) { setError('Specifica almeno un destinatario.'); return; }

    // Snapshot the payload now — we close the composer before the network
    // request finishes so the user gets instant feedback. State is gone by
    // the time the await resolves.
    const editableHtml = bodyRef.current?.innerHTML ?? state.body;
    const editableText = bodyRef.current?.innerText ?? state.body;
    const quotedText = state.quoted ?? '';
    // Prefer the rich HTML quote (set by startReply/startForward) so
    // forwarded emails preserve their original markup. Fall back to the
    // escaped-text blockquote only when no HTML version exists.
    const quotedHtml = state.quotedHtml
      ? state.quotedHtml
      : quotedText
        ? '<br><blockquote style="border-left:3px solid #ccc;margin:1em 0;padding:0 1em;color:#666;">'
          + quotedText.split('\n').map((l) => l.replace(/^>\s?/, '')).map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '<br>').join('<br>')
          + '</blockquote>'
        : '';
    const finalText = editableText + (quotedText ? '\n\n' + quotedText : '');
    const finalHtml = editableHtml + quotedHtml;
    const payload = {
      account: state.account, to, cc: state.cc, bcc: state.bcc,
      subject: state.subject, body: finalText, html: finalHtml,
      inReplyTo: state.inReplyTo, references: state.references, attachments: state.attachments,
    };
    const summary = state.subject || '(senza oggetto)';

    // Optimistic close + toast. The actual SMTP work continues in the
    // background; user sees the failure (if any) via a destructive toast.
    toast.push(`Invio in corso · ${summary}`, 'on');
    onSent();
    (async () => {
      try {
        const sendPromise = api.mailSend(payload);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout 60s — server SMTP non risponde')), 60_000),
        );
        const r: any = await Promise.race([sendPromise, timeout]);
        if (r && r.ok === false) throw new Error(r.error || 'Errore invio');
        toast.push(`Email inviata · ${summary}`, 'on');
      } catch (e: any) {
        console.error('[mail:send] failed', e);
        toast.push(`Invio fallito · ${String(e.message ?? e)}`, 'err');
      }
    })();
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

  // Restore the editor's selection before running the command. When the
  // floating toolbar is portal-rendered to <body>, clicking a button can
  // momentarily move the active range out of the editor — execCommand then
  // becomes a no-op (formatBlock / lists / etc.). We snapshot the range on
  // every selectionchange that targets the editor and rehydrate it here.
  const savedRangeRef = useRef<Range | null>(null);
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const r = sel.getRangeAt(0);
      const editor = bodyRef.current;
      if (!editor) return;
      const node = r.commonAncestorContainer;
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (el && editor.contains(el)) savedRangeRef.current = r.cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  function exec(cmd: string, value?: string) {
    const editor = bodyRef.current;
    if (!editor) return;
    // ALWAYS reinstate the user's last in-editor range. We don't call
    // editor.focus() first because that collapses the selection to the end
    // of the editor — which is why list / H1 / blockquote felt like no-ops:
    // they wrapped an empty cursor position instead of the highlighted text.
    const sel = window.getSelection();
    if (savedRangeRef.current) {
      try {
        sel?.removeAllRanges();
        sel?.addRange(savedRangeRef.current);
      } catch {}
    }
    // formatBlock needs the tag wrapped in angle brackets on most browsers.
    let v = value;
    if (cmd === 'formatBlock' && v && !/^<.*>$/.test(v)) v = `<${v}>`;
    try { document.execCommand(cmd, false, v); } catch (e) { console.warn('[exec]', cmd, e); }
    // Refresh saved range to point at the post-mutation selection so back-to-back
    // commands work.
    const after = window.getSelection();
    if (after && after.rangeCount > 0) {
      const r = after.getRangeAt(0);
      if (editor.contains(r.commonAncestorContainer as Node) || r.commonAncestorContainer === editor) {
        savedRangeRef.current = r.cloneRange();
      }
    }
    setState({ ...state, body: editor.innerHTML });
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
      <Card
        className={`relative w-full max-w-2xl h-[640px] max-h-[88vh] flex flex-col shadow-2xl border-border rounded-2xl overflow-hidden transition-all ${dragOver ? 'ring-2 ring-accent ring-offset-2 ring-offset-background' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 z-40 bg-accent/15 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="flex flex-col items-center gap-3 px-8 py-6 rounded-2xl border-2 border-dashed border-accent bg-card/80 shadow-xl">
              <Paperclip size={32} className="text-accent" />
              <div className="text-base font-semibold text-foreground">Rilascia per allegare</div>
              <div className="text-xs text-muted-foreground">i file verranno aggiunti al messaggio</div>
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 px-4 py-3 bg-card/60">
          <input
            value={state.subject}
            onChange={(e) => setState({ ...state, subject: e.target.value })}
            placeholder="Oggetto"
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-base font-semibold placeholder:text-muted-foreground/50"
            autoComplete="off"
          />
          <Button variant="ghost" size="icon" onClick={() => setState(null)} className="h-8 w-8 shrink-0"><X size={15} /></Button>
        </div>

        {/* Headers */}
        <div className="px-4 pt-1 pb-2 space-y-1.5">
          <RecipientField
            label=""
            placeholder="A, Cc, Ccn"
            value={state.to}
            onChange={(v) => setState({ ...state, to: v })}
            pills={parsePills(state.to)}
            onRemovePill={(p) => setState({ ...state, to: parsePills(state.to).filter((x) => x !== p).join(', ') })}
            onFocus={() => setToFocused(true)}
            onBlur={() => {
              // ⚠️ Do NOT call setState here. The RecipientField's own
              // commit() runs INSIDE its blur and already pushes the pending
              // text into `state.to`. A second setState({...state,...}) here
              // would clobber it with the pre-blur snapshot (closure capture)
              // and the just-typed email would silently disappear.
              setToFocused(false);
            }}
            trailing={
              toFocused && (
                <div className="flex items-center gap-2 text-[11px] shrink-0">
                  {!state.showCc && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); setState({ ...state, showCc: true }); }}
                      className="text-muted-foreground hover:text-accent"
                    >Cc</button>
                  )}
                  {!state.showBcc && (
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); setState({ ...state, showBcc: true }); }}
                      className="text-muted-foreground hover:text-accent"
                    >Ccn</button>
                  )}
                </div>
              )
            }
          />
          {state.showCc && (
            <RecipientField
              label="Cc"
              value={state.cc}
              onChange={(v) => setState({ ...state, cc: v })}
              pills={parsePills(state.cc)}
              onRemovePill={(p) => setState({ ...state, cc: parsePills(state.cc).filter((x) => x !== p).join(', ') })}
              onBlur={() => {
                if (parsePills(state.cc).length === 0) setState({ ...state, showCc: false });
              }}
            />
          )}
          {state.showBcc && (
            <RecipientField
              label="Ccn"
              value={state.bcc}
              onChange={(v) => setState({ ...state, bcc: v })}
              pills={parsePills(state.bcc)}
              onRemovePill={(p) => setState({ ...state, bcc: parsePills(state.bcc).filter((x) => x !== p).join(', ') })}
              onBlur={() => {
                if (parsePills(state.bcc).length === 0) setState({ ...state, showBcc: false });
              }}
            />
          )}
        </div>

        {/* Body editor — formatting toolbar appears only on text selection
            (see FloatingFormatBar below). Quoted original sits as a "•••" chip. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 relative">
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            data-placeholder="Inserisci testo"
            onInput={(e) => setState({ ...state, body: (e.target as HTMLDivElement).innerHTML })}
            className="mail-composer-body min-h-[120px] outline-none text-sm text-foreground leading-relaxed prose prose-sm prose-invert max-w-none [&_a]:text-accent"
          />
          <FloatingFormatBar bodyRef={bodyRef} exec={exec} />
          {state.quoted && (
            <div className="mt-3">
              {!quotedOpen ? (
                <button
                  type="button"
                  onClick={() => setQuotedOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface2 hover:bg-surface2/80 text-muted-foreground border border-border"
                  title="Mostra messaggio precedente"
                  aria-label="Mostra messaggio precedente"
                >
                  <MoreHorizontal size={14} />
                </button>
              ) : (
                <div className="relative border-l-2 border-border pl-3 mt-2">
                  <button
                    type="button"
                    onClick={() => setQuotedOpen(false)}
                    className="absolute -left-1 -top-2 h-5 w-5 rounded-full bg-surface2 border border-border flex items-center justify-center text-muted-foreground hover:text-foreground"
                    title="Nascondi messaggio precedente"
                    aria-label="Nascondi messaggio precedente"
                  >
                    <X size={11} />
                  </button>
                  <pre className="text-[12px] whitespace-pre-wrap font-sans text-muted-foreground/80 m-0">{state.quoted}</pre>
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2 mt-3">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Attachments tray — pinned above the footer so it never eats the
            scroll body. Hidden until at least one file is queued. */}
        {state.attachments.length > 0 && (
          <div className="px-3 py-2 border-t border-border/40 bg-card/30 flex flex-wrap gap-2">
            {state.attachments.map((f, i) => (
              <div key={i} className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-border bg-card/40 text-[11px]">
                <Paperclip size={11} className="text-accent" />
                <span className="max-w-[200px] truncate">{f.name}</span>
                <span className="text-muted-foreground">{fmtBytes(f.size)}</span>
                <button onClick={() => setState({ ...state, attachments: state.attachments.filter((_, j) => j !== i) })} className="text-muted-foreground hover:text-destructive">
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between p-3 border-t border-border bg-card/40 gap-2">
          <div className="flex items-center gap-1">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => addFiles(e.target.files)} />
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => fileRef.current?.click()}>
                    <Paperclip size={15} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Allega file</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {onSuggest && (
              <button
                type="button"
                onClick={generateAI}
                disabled={aiBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))] text-primary-foreground text-xs font-medium shadow-sm hover:opacity-90 disabled:opacity-60 ml-1"
              >
                {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {aiBusy ? 'Generazione…' : 'Genera risposta'}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setState(null)}>Annulla</Button>
            <Button size="sm" onClick={send} disabled={!state.to || !state.subject} className="gap-1.5">
              <Send size={13} />
              Invia
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// Floating selection toolbar — appears above the current text selection
// inside the contenteditable body. Hidden when selection is collapsed or
// happens outside the editor. Spark-style mini chip.
function FloatingFormatBar({ bodyRef, exec }: { bodyRef: React.RefObject<HTMLDivElement>; exec: (cmd: string, value?: string) => void }) {
  // We position the bar with `position: fixed` so it can overflow the modal
  // Card. To stick *visually* to the selection, anchor with the bar's own
  // bottom edge (transform translateY(-100%)) — that way we don't need to
  // guess the bar height, and the gap stays 0/MARGIN regardless of icon size.
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'above' | 'below' } | null>(null);

  useEffect(() => {
    function update() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) { setPos(null); return; }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const editor = bodyRef.current;
      if (!editor) { setPos(null); return; }
      const editorNode = node.nodeType === 1 ? node as Element : node.parentElement;
      if (!editorNode || !editor.contains(editorNode)) { setPos(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { setPos(null); return; }
      const MARGIN = 2;
      // Above unless too close to viewport top
      const placement: 'above' | 'below' = rect.top < 60 ? 'below' : 'above';
      // For 'above': anchor at the line top minus MARGIN; bar's own height
      // is removed via CSS transform.
      // For 'below': anchor at line bottom + MARGIN, no transform needed.
      const top = placement === 'above' ? rect.top - MARGIN : rect.bottom + MARGIN;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2, 100),
        window.innerWidth - 100,
      );
      setPos({ top, left, placement });
    }
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, [bodyRef]);

  if (!pos) return null;
  const transform = pos.placement === 'above'
    ? 'translate(-50%, -100%)'  // anchor bar bottom at pos.top
    : 'translate(-50%, 0)';     // anchor bar top at pos.top
  // Render via portal so the bar escapes the modal Card's backdrop-blur /
  // overflow-hidden context — without this `position: fixed` is anchored to
  // the nearest filtered ancestor, not the viewport.
  return createPortal(
    <div
      style={{ position: 'fixed', top: pos.top, left: pos.left, transform, zIndex: 999 }}
      className="flex items-center gap-0.5 px-1 py-1 rounded-lg shadow-xl border border-border bg-popover text-foreground"
      onMouseDown={(e) => e.preventDefault()}
    >
      <ToolbarBtn onClick={() => exec('bold')} title="Grassetto"><BoldIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('italic')} title="Corsivo"><ItalicIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('underline')} title="Sottolineato"><UnderlineIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('strikeThrough')} title="Barrato"><StrikeIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => { const u = prompt('URL link:'); if (u) exec('createLink', u); }} title="Link"><LinkIcon size={14} /></ToolbarBtn>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <ToolbarBtn onClick={() => exec('formatBlock', 'H1')} title="Titolo H1"><H1Icon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('formatBlock', 'BLOCKQUOTE')} title="Citazione"><QuoteIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('insertUnorderedList')} title="Elenco puntato"><ListIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('insertOrderedList')} title="Elenco numerato"><OrderedListIcon size={14} /></ToolbarBtn>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <ToolbarBtn onClick={() => exec('outdent')} title="Riduci rientro"><IndentOutIcon size={14} /></ToolbarBtn>
      <ToolbarBtn onClick={() => exec('indent')} title="Aumenta rientro"><IndentInIcon size={14} /></ToolbarBtn>
    </div>,
    document.body,
  );
}

function ToolbarBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-surface2 text-muted-foreground hover:text-foreground transition"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

// Inline chip field: typed addresses display as pills + free input at the end.
// Recipient field with chip-on-space/enter, focus tracking, and an optional
// trailing slot for inline "+Cc / +Ccn" toggles (shown only while focused).
function RecipientField({
  label, value, onChange, pills, onRemovePill, onFocus, onBlur, trailing, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  pills: string[];
  onRemovePill: (p: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  trailing?: React.ReactNode;
  placeholder?: string;
}) {
  const [pending, setPending] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Commit pending text as a new pill (appends to comma-list `value`).
  function commit() {
    const v = pending.trim().replace(/[,;]+$/, '');
    if (!v) return false;
    const next = pills.includes(v) ? pills : [...pills, v];
    onChange(next.join(', '));
    setPending('');
    return true;
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || e.key === ' ') {
      // Only commit if there's something email-like in the pending buffer.
      if (pending.trim().length > 0) {
        e.preventDefault();
        commit();
      }
    } else if (e.key === 'Backspace' && pending === '' && pills.length > 0) {
      // Backspace at empty input removes the last pill — standard mail UX.
      const last = pills[pills.length - 1];
      onRemovePill(last);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!/[,;\s]/.test(text)) return; // single token → let default handle
    e.preventDefault();
    const tokens = text.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length) return;
    const merged = [...pills];
    for (const t of tokens) if (!merged.includes(t)) merged.push(t);
    onChange(merged.join(', '));
  }

  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-7 shrink-0">{label}</span>}
      <div
        className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 py-0.5"
        onClick={() => inputRef.current?.focus()}
      >
        {pills.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-accent/10 border border-accent/30 text-[12px]">
            <span className="text-foreground">{p}</span>
            <button onClick={(e) => { e.stopPropagation(); onRemovePill(p); }} className="text-muted-foreground hover:text-destructive">
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={pending}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={handleKey}
          onPaste={handlePaste}
          onFocus={onFocus}
          onBlur={() => { commit(); onBlur?.(); }}
          placeholder={pills.length ? '' : (placeholder ?? 'dest@x.it')}
          className="flex-1 min-w-[60px] bg-transparent border-0 outline-none text-sm placeholder:text-muted-foreground/60"
          autoComplete="off"
        />
      </div>
      {trailing}
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
