import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useWS, useLiveData } from '../ws';
import { Button, Card, Chip, Field, Input, Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Camera as IgIcon, MessageCircle, RefreshCw, Sparkles, Send, LogOut, Lock, ShieldAlert, X, Image as ImageIcon, Film, Headphones, Link as LinkIcon, AlertCircle, Music, Sticker, Wand2 } from 'lucide-react';
import BrainLoading from '../components/BrainLoading';

// =====================================================================
// Media placeholders — render visual chips instead of raw "[xxx]" tags
// =====================================================================
const WAVE = [4, 8, 14, 18, 22, 16, 12, 20, 24, 18, 14, 8, 4, 10, 16, 12, 6];

function MediaChip({ icon: Icon, label, color, children }: { icon: any; label: string; color: string; children?: any }) {
  return (
    <span className="inline-flex items-center gap-2 px-2 py-1 rounded-lg" style={{ background: color + '22', border: `1px solid ${color}55` }}>
      <Icon size={14} style={{ color }} />
      <span className="text-xs font-medium" style={{ color }}>{label}</span>
      {children}
    </span>
  );
}

function VoicePlaceholder() {
  return (
    <span className="inline-flex items-center gap-2 px-2 py-1.5 rounded-lg bg-purple-500/15 border border-purple-400/40">
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-500/40">
        <Headphones size={11} className="text-purple-100" />
      </span>
      <span className="inline-flex items-end gap-[2px]">
        {WAVE.map((b, i) => (
          <span key={i} className="inline-block rounded-full bg-purple-300/80" style={{ width: 2, height: (b / 24) * 14 + 2 }} />
        ))}
      </span>
      <span className="text-[10px] text-purple-200">vocale</span>
    </span>
  );
}

function MediaPreview({ text, itemType }: { text: string; itemType: string }) {
  // Detect bracketed placeholder; render chip. Fallback to plain text.
  const t = (text || '').trim();
  if (itemType === 'voice_media' || /^\[voice message\]/i.test(t)) return <VoicePlaceholder />;
  if (itemType === 'media' || /^\[image\/video\]/i.test(t)) return <MediaChip icon={ImageIcon} label="Foto/Video" color="#22d3ee" />;
  if (itemType === 'media_share' || /^\[media share\]/i.test(t)) {
    const cap = t.replace(/^\[media share\]\s*/i, '').trim();
    return (
      <span className="flex flex-col gap-1">
        <MediaChip icon={ImageIcon} label="Post condiviso" color="#f0abfc" />
        {cap && <span className="text-xs text-muted italic line-clamp-2">"{cap}"</span>}
      </span>
    );
  }
  if (itemType === 'story_share' || /^\[story share\]/i.test(t)) {
    const cap = t.replace(/^\[story share\]\s*/i, '').trim();
    return (
      <span className="flex flex-col gap-1">
        <MediaChip icon={Film} label="Storia" color="#fbbf24" />
        {cap && <span className="text-xs text-muted italic line-clamp-2">"{cap}"</span>}
      </span>
    );
  }
  if (itemType === 'reel_share' || /^\[reel share\]/i.test(t) || /^\[clip\]/i.test(t)) {
    const cap = t.replace(/^\[(reel share|clip)\]\s*/i, '').trim();
    return (
      <span className="flex flex-col gap-1">
        <MediaChip icon={Film} label="Reel" color="#a78bfa" />
        {cap && <span className="text-xs text-muted italic line-clamp-2">"{cap}"</span>}
      </span>
    );
  }
  if (itemType === 'link' || /^\[link\]/i.test(t)) {
    const cleaned = t.replace(/^\[link\]\s*/i, '').trim();
    const url = cleaned.match(/https?:\/\/\S+/)?.[0];
    return (
      <span className="flex flex-col gap-1">
        <MediaChip icon={LinkIcon} label="Link" color="#34d399" />
        {url && <a href={url} target="_blank" rel="noopener" className="text-xs text-emerald-300 hover:underline break-all">{url}</a>}
      </span>
    );
  }
  if (itemType === 'animated_media' || /^\[gif\]/i.test(t)) return <MediaChip icon={Sticker} label="GIF" color="#f472b6" />;
  if (itemType === 'action_log' || /^\[action_log\]/i.test(t)) {
    return <span className="text-xs text-muted italic">— evento di sistema —</span>;
  }
  if (/^\[/.test(t) && /\]/.test(t)) {
    // Unknown placeholder, show generic
    const label = t.match(/^\[(.+?)\]/)?.[1] ?? 'media';
    return <MediaChip icon={AlertCircle} label={label} color="#94a3b8" />;
  }
  return <span className="whitespace-pre-wrap break-words">{t}</span>;
}

function previewSummary(text: string, itemType: string): { icon: any; label: string } | null {
  const t = (text || '').trim();
  if (itemType === 'voice_media' || /^\[voice message\]/i.test(t)) return { icon: Headphones, label: 'Messaggio vocale' };
  if (itemType === 'media' || /^\[image\/video\]/i.test(t)) return { icon: ImageIcon, label: 'Foto/Video' };
  if (itemType === 'media_share' || /^\[media share\]/i.test(t)) return { icon: ImageIcon, label: 'Post condiviso' };
  if (itemType === 'story_share' || /^\[story share\]/i.test(t)) return { icon: Film, label: 'Storia' };
  if (itemType === 'reel_share' || /^\[reel share\]/i.test(t) || /^\[clip\]/i.test(t)) return { icon: Film, label: 'Reel' };
  if (itemType === 'link' || /^\[link\]/i.test(t)) return { icon: LinkIcon, label: 'Link' };
  if (itemType === 'animated_media' || /^\[gif\]/i.test(t)) return { icon: Sticker, label: 'GIF' };
  if (itemType === 'action_log') return { icon: AlertCircle, label: 'Evento' };
  return null;
}

type Status = { status: 'idle' | 'starting' | '2fa' | 'checkpoint' | 'connected' | 'closed'; me?: { pk: string; username: string; full_name?: string }; error?: string };

type Thread = {
  thread_id: string; title: string; is_group: boolean;
  participants: { pk: string; username: string; full_name?: string; profile_pic_url?: string; is_verified?: boolean }[];
  last_text?: string; last_ts?: string; last_from_me?: boolean;
  total_count: number; bonified_count: number; pending_count: number;
  auto_bonify: boolean;
  auto_responder?: boolean; auto_responder_goal?: string | null;
};

type Msg = { id: number; msg_id: string; thread_id: string; sender_ig_id: string; sender_username?: string; sender_name?: string; person_slug?: string | null; from_me: boolean; text: string; item_type: string; ts: string; source?: 'user' | 'ai' };

function fmtTime(ts: string): string {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

function avatarColor(s: string): string {
  let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360},65%,45%)`;
}
function initials(name: string): string {
  return (name || '?').split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
}

export default function InstagramPage() {
  const [status, setStatus] = useState<Status>({ status: 'idle' });
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.igStatus()); } catch {}
  }, []);

  // Pure WS — no HTTP polling. Initial fetch once on mount, then only on
  // backend ig:status events.
  useLiveData(refreshStatus, { refreshOn: ['ig:status'], fallbackMs: 0 });

  // Gate: setup required first
  if (status.status !== 'connected') {
    return <SetupPanel status={status} onChange={refreshStatus} loading={loading} setLoading={setLoading} />;
  }

  return <InboxView me={status.me!} onLogout={async () => { await api.igLogout(); refreshStatus(); }} />;
}

// =====================================================================
// Setup panel: login / 2FA / checkpoint
// =====================================================================
function SetupPanel({ status, onChange, loading, setLoading }: { status: Status; onChange: () => void; loading: boolean; setLoading: (b: boolean) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const toast = useToast();

  const needs2fa = status.status === '2fa';
  const checkpoint = status.status === 'checkpoint';

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) { toast.push('Username + password', 'err'); return; }
    setLoading(true);
    try {
      const r = await api.igStart(username.trim(), password);
      if (r.ok) { toast.push('Login OK', 'on'); onChange(); }
      else if (r.needs2fa) toast.push('Codice 2FA richiesto', 'on');
      else if (r.needsCheckpoint) toast.push('Approva login dall\'app Instagram, poi riprova', 'err');
      else toast.push(r.error || 'Login fallito', 'err');
      onChange();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }

  async function do2fa(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    try {
      const r = await api.ig2fa(code.trim());
      if (r.ok) { toast.push('2FA OK', 'on'); onChange(); }
      else toast.push(r.error || '2FA fallito', 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }

  async function doCheckpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    try {
      const r = await api.igCheckpoint(code.trim());
      if (r.ok) { toast.push('Sbloccato', 'on'); setCode(''); }
      else toast.push(r.error || 'Codice non valido', 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); onChange(); }
  }

  // Step machine: 1 = login, 2 = 2fa, 3 = checkpoint code
  const step = checkpoint ? 3 : needs2fa ? 2 : 1;
  const stepMeta = [
    { n: 1, label: 'Login' },
    { n: 2, label: 'Verifica' },
    { n: 3, label: 'Sblocca' },
  ];

  return (
    <div className="max-w-md mx-auto py-8">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-pink-500 via-purple-500 to-orange-400 flex items-center justify-center shadow-lg shadow-pink-500/30">
          <IgIcon size={24} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-gradient">Instagram DM</h1>
          <div className="text-xs text-muted">Connetti il tuo account per leggere e rispondere ai DM</div>
        </div>
      </div>

      <Card>
        {/* Progress strip */}
        <div className="flex items-center gap-1.5 mb-4">
          {stepMeta.map((s, i) => (
            <div key={s.n} className="flex items-center gap-1.5 flex-1">
              <div className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center transition ${
                step === s.n ? 'bg-accent text-bg' : step > s.n ? 'bg-emerald-500/30 text-emerald-300' : 'bg-surface2 text-muted'
              }`}>{step > s.n ? '✓' : s.n}</div>
              <div className={`text-[10px] uppercase tracking-wider font-semibold ${step === s.n ? 'text-text' : 'text-muted'}`}>{s.label}</div>
              {i < stepMeta.length - 1 && <div className={`flex-1 h-px ${step > s.n ? 'bg-emerald-500/30' : 'bg-border'}`} />}
            </div>
          ))}
        </div>

        {step === 1 && (
          <form onSubmit={doLogin} className="space-y-3">
            <div className="text-xs text-muted mb-2">
              Credenziali usate solo per autenticare. Salvate localmente come session token.
            </div>
            <Field label="Username">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="il_tuo_username" autoComplete="username" autoFocus />
            </Field>
            <Field label="Password">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            </Field>
            {status.error && <div className="text-xs text-red-300 bg-red-500/10 border border-red-400/20 rounded-lg p-2">{status.error}</div>}
            <Button type="submit" disabled={loading || !username || !password} className="w-full">{loading ? 'Login…' : 'Connetti'}</Button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={do2fa} className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Lock size={14} className="text-accent" />
              <span className="font-medium">Codice 2FA</span>
            </div>
            <div className="text-xs text-muted">Codice inviato da Instagram via SMS o app authenticator.</div>
            <Field label="Codice"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoFocus inputMode="numeric" maxLength={8} /></Field>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={async () => { setCode(''); await api.igLogout(); onChange(); }}>Annulla</Button>
              <Button type="submit" disabled={loading || !code} className="flex-1">{loading ? '…' : 'Conferma'}</Button>
            </div>
          </form>
        )}

        {step === 3 && (
          <form onSubmit={doCheckpoint} className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <ShieldAlert size={14} className="text-amber-300" />
              <span className="font-medium text-amber-300">Verifica sicurezza Instagram</span>
            </div>
            <div className="text-xs text-muted">
              {status.error || 'Instagram ti ha inviato un codice via email o SMS. Inseriscilo per sbloccare.'}
            </div>
            <Field label="Codice (6 cifre)"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoFocus inputMode="numeric" maxLength={8} /></Field>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={async () => { setCode(''); await api.igLogout(); onChange(); }}>Annulla</Button>
              <Button type="submit" disabled={loading || !code} className="flex-1">{loading ? '…' : 'Sblocca'}</Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

// =====================================================================
// Inbox: thread list + conversation
// =====================================================================
function InboxView({ me, onLogout }: { me: { pk: string; username: string; full_name?: string }; onLogout: () => void }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [bonifying, setBonifying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingThread, setSyncingThread] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  // Floating drawer state — mirrors WhatsApp page so the suggestion sits in
  // its own card instead of overwriting the compose textarea immediately.
  const [draftReply, setDraftReply] = useState('');
  // Live activity from auto-responder pipeline ({kind, label} for selected thread)
  const [activity, setActivity] = useState<{ kind: string; label: string; ts: string } | null>(null);
  // Optimistic pending queue — messages we've sent but not yet seen echoed by
  // IG. Rendered after real messages with a spinner. Auto-pruned when echo
  // arrives or 30s timeout hits.
  type Pending = { tid: string; tempId: string; text: string; source: 'user' | 'ai'; status: 'queued' | 'sending' | 'error'; ts: number; error?: string };
  const [pendingMsgs, setPendingMsgs] = useState<Pending[]>([]);
  const [pending, setPending] = useState(0);
  const [filter, setFilter] = useState('');
  const dlg = useDialog();
  const toast = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try { setThreads(await api.igThreads()); } catch (e: any) { toast.push(e.message, 'err'); }
  }, [toast]);

  const loadMessages = useCallback(async (tid: string) => {
    try {
      const m = await api.igThreadMessages(tid);
      setMessages(m);
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 60);
    } catch (e: any) { toast.push(e.message, 'err'); }
  }, [toast]);

  const loadPending = useCallback(async () => {
    try { const r = await api.igPending(); setPending(r.pending ?? 0); } catch {}
  }, []);

  // Pure WS — single mount fetch, then only react to backend events.
  // No HTTP polling at all.
  useLiveData(loadThreads, { refreshOn: ['ig:message', 'ig:sync'], fallbackMs: 0 });
  useLiveData(loadPending, { refreshOn: ['ig:message', 'ig:bonify'], fallbackMs: 0 });
  useEffect(() => { if (selected) loadMessages(selected); }, [selected, loadMessages]);
  useWS((m) => {
    if (m?.type === 'ig:message' && selected && m.payload?.msg?.thread_id === selected) {
      loadMessages(selected);
    }
    if (m?.type === 'ig:activity' && selected && m.payload?.threadId === selected) {
      setActivity({ kind: m.payload.kind, label: m.payload.label, ts: m.payload.ts });
      // Auto-clear terminal states after 6s so drawer doesn't linger.
      if (['sent', 'error', 'waiting'].includes(m.payload.kind)) {
        setTimeout(() => setActivity((cur) => (cur?.ts === m.payload.ts ? null : cur)), 6_000);
      }
    }
  });
  // Reset activity when switching threads
  useEffect(() => { setActivity(null); }, [selected]);

  const selectedThread = useMemo(() => threads.find(t => t.thread_id === selected) ?? null, [threads, selected]);
  const filteredThreads = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return threads;
    return threads.filter(t => (t.title || '').toLowerCase().includes(f) || t.participants.some(p => (p.username || '').toLowerCase().includes(f) || (p.full_name || '').toLowerCase().includes(f)));
  }, [threads, filter]);

  async function send(source: 'user' | 'ai' = 'user') {
    if (!selected || !text.trim()) return;
    const toSend = text.trim();
    const tid = selected;
    const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Optimistic: push into queue immediately + clear input so user can queue another.
    setPendingMsgs((p) => [...p, { tid, tempId, text: toSend, source, status: 'queued', ts: Date.now() }]);
    setText(''); setAiDraft(null);
    setTimeout(() => setPendingMsgs((p) => p.map((m) => m.tempId === tempId ? { ...m, status: 'sending' } : m)), 50);
    try {
      const r = await api.igSendMessage(tid, toSend, source);
      if (!r.ok) {
        setPendingMsgs((p) => p.map((m) => m.tempId === tempId ? { ...m, status: 'error', error: r.error || 'Invio fallito' } : m));
        toast.push(r.error || 'Invio fallito', 'err');
        return;
      }
    } catch (e: any) {
      setPendingMsgs((p) => p.map((m) => m.tempId === tempId ? { ...m, status: 'error', error: e.message } : m));
      toast.push(e.message, 'err');
    }
  }

  useEffect(() => {
    if (pendingMsgs.length === 0) return;
    setPendingMsgs((p) => p.filter((pm) => {
      if (pm.tid !== selected) return true;
      const matched = messages.find((m) => m.from_me && m.text === pm.text && new Date(m.ts).getTime() >= pm.ts - 2000);
      return !matched;
    }));
  }, [messages, selected]);
  useEffect(() => {
    const id = setInterval(() => {
      setPendingMsgs((p) => p.filter((pm) => pm.status === 'error' || Date.now() - pm.ts < 30_000));
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  const pendingForThread = useMemo(() => pendingMsgs.filter((p) => p.tid === selected), [pendingMsgs, selected]);
  const isSendingAny = pendingForThread.some((p) => p.status !== 'error');

  async function suggestAi() {
    if (!selected) return;
    setSuggesting(true);
    setDraftReply('');
    try {
      const r = await api.igSuggestReply(selected);
      if (r.ok && r.draft) {
        setDraftReply(r.draft);
      } else {
        toast.push(r.error || 'AI non ha prodotto bozza', 'err');
      }
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSuggesting(false); }
  }

  function acceptSuggestion() {
    if (!draftReply.trim()) return;
    setText(draftReply);
    setAiDraft(draftReply);
    setDraftReply('');
  }

  async function syncAll() {
    setSyncing(true);
    try {
      const r = await api.igSync(3);
      if (r.ok) toast.push(`Sync OK: ${r.threads} chat, ${r.items} messaggi`, 'on');
      else toast.push(r.error || 'Sync fallito', 'err');
      await loadThreads(); await loadPending();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSyncing(false); }
  }

  async function syncThread() {
    if (!selected) return;
    setSyncingThread(true);
    try {
      const r = await api.igSyncThread(selected, 5);
      if (r.ok) toast.push(`${r.items} messaggi sincronizzati`, 'on');
      else toast.push(r.error || 'Sync fallito', 'err');
      await loadMessages(selected); await loadThreads();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSyncingThread(false); }
  }

  async function bonifyThread() {
    if (!selected) return;
    setBonifying(true);
    try {
      const r = await api.igBonify(500, selected);
      if (r.ok) toast.push(`Bonificati ${r.processed} messaggi`, 'on');
      else toast.push(r.error || 'Bonifica fallita', 'err');
      await loadThreads(); await loadPending();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBonifying(false); }
  }

  async function toggleAuto(t: Thread) {
    try { await api.igSetThreadAutoBonify(t.thread_id, !t.auto_bonify); loadThreads(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function toggleAutoResponder(t: Thread) {
    if (t.auto_responder) {
      // Disabling — quick confirm.
      if (!await dlg.confirm('Disattivare auto-responder per questa chat? L\'AI smetterà di rispondere automaticamente.', { tone: 'danger', confirmLabel: 'Disattiva' })) return;
      try { await api.igSetThreadAutoResponder(t.thread_id, false, null); loadThreads(); }
      catch (e: any) { toast.push(e.message, 'err'); }
      return;
    }
    // Enabling — confirm + prompt goal.
    const ok = await dlg.confirm(
      'Attivare auto-responder?\n\nL\'AI risponderà automaticamente a ogni messaggio in questa chat, guidando la conversazione verso un obiettivo che imposti tu. Lavora anche quando non sei online.',
      { confirmLabel: 'Continua' },
    );
    if (!ok) return;
    const goal = await dlg.prompt(
      'Qual è l\'obiettivo della conversazione? (es. fissare una call, qualificare il lead, vendere consulenza)',
      { placeholder: 'es. fissare una call', defaultValue: t.auto_responder_goal ?? '' },
    );
    if (!goal || !goal.trim()) { toast.push('Obiettivo richiesto', 'err'); return; }
    try { await api.igSetThreadAutoResponder(t.thread_id, true, goal.trim()); toast.push('Auto-responder attivo', 'on'); loadThreads(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function logout() {
    if (!await dlg.confirm('Disconnetti Instagram? La sessione locale verrà cancellata.', { tone: 'danger', confirmLabel: 'Disconnetti' })) return;
    onLogout();
  }

  return (
    <div className="h-[calc(100vh-110px)] flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-pink-500 via-purple-500 to-orange-400 flex items-center justify-center">
            <IgIcon size={18} className="text-white" />
          </div>
          <div>
            <div className="text-lg font-semibold">Instagram DM</div>
            <div className="text-xs text-muted">@{me.username}{me.full_name ? ` · ${me.full_name}` : ''}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={pending > 0 ? 'warn' : undefined}>{pending} pendenti</Chip>
          <Button size="sm" onClick={syncAll} disabled={syncing}>
            <RefreshCw size={13} className={`inline mr-1 -mt-0.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sync…' : 'Sincronizza'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { loadThreads(); loadPending(); }} title="Ricarica vista"><RefreshCw size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={logout}><LogOut size={13} className="inline mr-1 -mt-0.5" />Disconnetti</Button>
        </div>
      </div>

      {/* Body: list + conversation */}
      <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-3 flex-1 min-h-0">
        {/* Thread list */}
        <Card className="flex flex-col !p-0 overflow-hidden">
          <div className="p-2 border-b border-border">
            <Input placeholder="Cerca conversazioni…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredThreads.length === 0 && (
              <div className="text-xs text-muted text-center py-6 px-3">
                {threads.length === 0 ? <>Nessuna conversazione ancora. Il polling parte ogni 30s.<br/>Apri qualcosa o aspetta…</> : 'Nessun risultato'}
              </div>
            )}
            {filteredThreads.map((t) => {
              const summary = previewSummary(t.last_text ?? '', '');
              const subPrefix = t.last_from_me ? 'Tu: ' : '';
              const av = t.participants[0];
              return (
                <button
                  key={t.thread_id}
                  onClick={() => setSelected(t.thread_id)}
                  className={`w-full text-left p-2.5 flex items-start gap-2.5 border-b border-border/40 transition ${selected === t.thread_id ? 'bg-accent/10' : 'hover:bg-surface2/50'}`}
                >
                  {av?.profile_pic_url ? (
                    <img src={av.profile_pic_url} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0" style={{ background: avatarColor(t.title) }}>{initials(t.title)}</div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm truncate">{t.title}</div>
                      {t.last_ts && <div className="text-[10px] text-muted shrink-0 font-mono">{fmtTime(t.last_ts)}</div>}
                    </div>
                    <div className="text-xs text-muted truncate flex items-center gap-1">
                      {subPrefix && <span>{subPrefix}</span>}
                      {summary ? (
                        <span className="inline-flex items-center gap-1">
                          <summary.icon size={11} className="text-accent" />
                          <span className="italic">{summary.label}</span>
                        </span>
                      ) : (
                        <span className="truncate">{t.last_text || '—'}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {t.pending_count > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-400/30">{t.pending_count} nuovi</span>}
                      {t.auto_bonify && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">auto-sync</span>}
                      {t.is_group && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-400/30">gruppo</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Conversation */}
        <Card className="flex flex-col !p-0 overflow-hidden relative">
          {!selected || !selectedThread ? (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              <div className="text-center">
                <MessageCircle size={32} className="mx-auto mb-2 opacity-40" />
                Seleziona una conversazione
              </div>
            </div>
          ) : (
            <>
              <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  {selectedThread.participants[0]?.profile_pic_url ? (
                    <img src={selectedThread.participants[0].profile_pic_url} alt="" className="w-8 h-8 rounded-full object-cover" />
                  ) : (
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ background: avatarColor(selectedThread.title) }}>{initials(selectedThread.title)}</div>
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-sm truncate">{selectedThread.title}</div>
                    <div className="text-[10px] text-muted truncate">{selectedThread.participants.map(p => '@' + p.username).join(' · ')}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-muted">auto-sync</span>
                    <Toggle checked={selectedThread.auto_bonify} onChange={() => toggleAuto(selectedThread)} />
                  </div>
                  <div className="flex items-center gap-1.5" title={selectedThread.auto_responder_goal ? `Goal: ${selectedThread.auto_responder_goal}` : undefined}>
                    <span className="text-[10px] uppercase tracking-wider text-muted">auto-responder</span>
                    <Toggle checked={!!selectedThread.auto_responder} onChange={() => toggleAutoResponder(selectedThread)} />
                  </div>
                  <Button size="sm" variant="ghost" onClick={syncThread} disabled={syncingThread} title="Scarica messaggi storici">
                    <RefreshCw size={12} className={`inline mr-1 -mt-0.5 ${syncingThread ? 'animate-spin' : ''}`} />Sync
                  </Button>
                  <Button size="sm" variant="ghost" onClick={bonifyThread} disabled={bonifying || selectedThread.pending_count === 0} title="Classifica + salva nel brain">
                    <Sparkles size={12} className={`inline mr-1 -mt-0.5 ${bonifying ? 'animate-pulse' : ''}`} />Bonifica
                  </Button>
                </div>
              </div>

              <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1.5">
                {messages.length === 0 && <div className="text-xs text-muted text-center py-6">Nessun messaggio.</div>}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                      m.from_me
                        ? (m.source === 'ai' ? 'bg-purple-500/30 border border-purple-400/40' : 'bg-accent/40 border border-accent/50')
                        : 'bg-surface2/70 border border-border'
                    }`}>
                      {!m.from_me && selectedThread.is_group && <div className="text-[10px] text-muted mb-0.5">@{m.sender_username}</div>}
                      <div className="break-words"><MediaPreview text={m.text} itemType={m.item_type} /></div>
                      <div className="text-[9px] mt-1 opacity-60 font-mono flex items-center gap-1 justify-end">
                        {m.source === 'ai' && <span className="text-purple-200">AI</span>}
                        <span>{fmtTime(m.ts)}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {/* Optimistic pending messages — show after real ones with spinner/error state */}
                {pendingForThread.map((p) => (
                  <div key={p.tempId} className="flex justify-end">
                    <div className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm border ${
                      p.status === 'error'
                        ? 'bg-red-500/20 border-red-400/40'
                        : p.source === 'ai'
                          ? 'bg-purple-500/20 border-purple-400/30 opacity-70'
                          : 'bg-accent/20 border-accent/30 opacity-70'
                    }`}>
                      <div className="break-words whitespace-pre-wrap">{p.text}</div>
                      <div className="text-[9px] mt-1 font-mono flex items-center gap-1.5 justify-end">
                        {p.status === 'queued' && <><span className="w-1 h-1 rounded-full bg-muted animate-pulse" /><span className="text-muted uppercase tracking-wider">in coda</span></>}
                        {p.status === 'sending' && <><RefreshCw size={9} className="animate-spin" /><span className="text-muted uppercase tracking-wider">invio…</span></>}
                        {p.status === 'error' && (
                          <>
                            <span className="text-red-300 uppercase tracking-wider">errore</span>
                            <button onClick={() => setPendingMsgs((arr) => arr.filter((x) => x.tempId !== p.tempId))} className="text-red-300 hover:text-red-100">×</button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Compose bar — mirror WhatsApp page: AI prepended inside input,
                  Send button on the right at full-height. */}
              <div className="border-t border-border bg-surface2/40 p-3 flex items-stretch gap-2">
                <div className={`flex-1 flex items-stretch rounded-2xl bg-surface border ${aiDraft ? 'border-purple-400/60' : 'border-border'} focus-within:border-accent transition overflow-hidden relative`}>
                  {aiDraft && (
                    <div className="absolute -top-5 left-1 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider text-purple-300 font-semibold">
                      <Sparkles size={9} /> bozza AI
                      <button onClick={() => { setText(''); setAiDraft(null); }} className="text-muted hover:text-text ml-1" title="Scarta">×</button>
                    </div>
                  )}
                  <button
                    onClick={suggestAi}
                    disabled={suggesting}
                    title="Suggerisci risposta AI"
                    className="shrink-0 flex items-center justify-center w-10 self-stretch bg-gradient-to-br from-purple-500 to-pink-500 text-white hover:opacity-90 disabled:opacity-60 transition"
                  >
                    <Sparkles size={16} className={suggesting ? 'animate-pulse' : ''} />
                  </button>
                  <textarea
                    value={text}
                    onChange={(e) => { setText(e.target.value); if (aiDraft && e.target.value !== aiDraft) setAiDraft(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(aiDraft ? 'ai' : 'user'); } }}
                    placeholder="Scrivi un messaggio… (Invio = invia, Shift+Invio = a capo)"
                    rows={1}
                    className="flex-1 bg-transparent px-3 py-2 text-sm resize-none outline-none min-h-[40px] max-h-32"
                  />
                </div>
                <Button onClick={() => send(aiDraft ? 'ai' : 'user')} disabled={!text.trim()} className="self-stretch px-4 flex items-center">
                  <Send size={14} className="inline mr-1.5 -mt-0.5" />
                  {isSendingAny ? `Invia (${pendingForThread.length})` : 'Invia'}
                </Button>
              </div>

              {/* Floating reply drawer — same iOS glass card used in WhatsApp.
                  Also shows auto-responder activity (reading/thinking/sending) */}
              {(suggesting || draftReply || activity) && (
                <div
                  className="absolute bottom-4 right-4 z-30 w-80 max-w-[calc(100%-2rem)] rounded-2xl border border-white/15 shadow-2xl overflow-hidden"
                  style={{
                    background: 'linear-gradient(135deg, rgba(244,114,182,0.14), rgba(192,132,252,0.10))',
                    backdropFilter: 'blur(24px) saturate(160%)',
                    WebkitBackdropFilter: 'blur(24px) saturate(160%)',
                    transition: 'all 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-purple-200 font-semibold">
                      <Wand2 size={11} />
                      {activity ? 'Auto-responder' : suggesting ? 'Formulando…' : 'Bozza pronta'}
                    </div>
                    <button onClick={() => { setDraftReply(''); setSuggesting(false); setActivity(null); }} className="text-muted hover:text-text">
                      <X size={13} />
                    </button>
                  </div>
                  <div className="p-3">
                    {activity && !draftReply ? (
                      <div className="flex items-center gap-3 py-2">
                        {activity.kind === 'sent' ? (
                          <span className="text-xl">✓</span>
                        ) : activity.kind === 'error' ? (
                          <span className="text-xl text-red-300">⚠</span>
                        ) : activity.kind === 'waiting' ? (
                          <span className="text-xl">⏳</span>
                        ) : (
                          <BrainLoading size={36} inline />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm ${['sending', 'thinking', 'reading'].includes(activity.kind) ? 'animate-pulse' : ''}`}>{activity.label || activity.kind}</div>
                          <div className="text-[10px] text-muted uppercase tracking-wider mt-0.5">{activity.kind}</div>
                        </div>
                      </div>
                    ) : suggesting && !draftReply ? (
                      <div className="flex items-center gap-3 py-2">
                        <BrainLoading size={48} inline />
                        <span className="text-sm text-muted animate-pulse">Formulando risposta…</span>
                      </div>
                    ) : (
                      <>
                        <textarea
                          value={draftReply}
                          onChange={(e) => setDraftReply(e.target.value)}
                          rows={4}
                          className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-text focus:outline-none focus:border-purple-400 resize-y placeholder-muted"
                          style={{ animation: 'fade-in 0.4s ease both' }}
                        />
                        <div className="flex items-center justify-between gap-2 mt-2.5" style={{ animation: 'fade-in 0.55s ease both' }}>
                          <Button size="sm" variant="ghost" onClick={suggestAi} disabled={suggesting}>
                            <Wand2 size={12} className={`inline mr-1 -mt-0.5 ${suggesting ? 'animate-pulse' : ''}`} />
                            Rigenera
                          </Button>
                          <Button size="sm" onClick={acceptSuggestion} disabled={!draftReply.trim()}>
                            <Send size={12} className="inline mr-1 -mt-0.5" />
                            Usa bozza
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
