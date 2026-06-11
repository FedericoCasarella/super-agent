import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, Toggle, useToast } from '../components/ui';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useDialog } from '../components/dialog';
import { useWS } from '../ws';
import { useQuotaLock } from '../quota';
import { Users, MessageCircle, RefreshCw, Sparkles, UserCog, Wand2, Send, X, MoreHorizontal, ImageIcon, GitMerge, Trash2, Pencil, Brain, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import BrainLoading from '../components/BrainLoading';

type Chat = {
  chat_jid: string;
  sender_name: string | null;
  sender_phone: string | null;
  person_slug: string | null;
  is_group: boolean;
  text: string;
  ts: string;
  total_count: number;
  bonified_count: number;
  pending_count: number;
  auto_bonify?: boolean;
  profile_pic_url?: string | null;
  linked_person_slug?: string | null;
  display_name_override?: string | null;
  display_phone_override?: string | null;
};

type Msg = {
  id: number; msg_id: string; chat_jid: string; sender_jid: string;
  sender_phone: string | null; sender_name: string | null; person_slug: string | null;
  is_group: boolean; group_jid: string | null;
  from_me: boolean; text: string; ts: string;
  source?: 'user' | 'ai' | null;
  sender_pic_url?: string | null;
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

function fmtAgo(ts: string): string {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}g`;
}

// Palette aligned to app theme (accent violet → accent2 cyan + supporting brand tints)
const AVATAR_PALETTE = [
  'linear-gradient(135deg,#c084fc,#a78bfa)', // violet
  'linear-gradient(135deg,#22d3ee,#67e8f9)', // cyan
  'linear-gradient(135deg,#f0abfc,#c084fc)', // fuchsia → violet
  'linear-gradient(135deg,#a78bfa,#22d3ee)', // violet → cyan
  'linear-gradient(135deg,#34d399,#22d3ee)', // emerald → cyan
  'linear-gradient(135deg,#fbbf24,#f0abfc)', // amber → fuchsia
];
// Dropdown menu grouping secondary toolbar actions. Closes on outside click
// and Escape so it doesn't sit visually open.
function WaToolbarMenu({
  sync, syncing, refreshContacts, refreshingContacts, onAfterAction,
}: {
  sync: () => Promise<void>; syncing: boolean;
  refreshContacts: () => Promise<void>; refreshingContacts: boolean;
  onAfterAction?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  const dlg = useDialog();
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function runDedupe() {
    setBusy('dedupe');
    try {
      // First pass: signal-based dedupe (fast, deterministic).
      const r: any = await api.waDedupe();
      const cm = Number(r?.chats_merged ?? 0);
      const dm = Number(r?.msg_dups_removed ?? 0);
      if (cm > 0 || dm > 0) toast.push(`Unite ${cm} chat · ${dm} msg duplicati rimossi`, 'on');
      else toast.push('Nessun duplicato evidente', 'warn');
      onAfterAction?.();
    } catch (e: any) { toast.push(e?.message ?? 'Errore dedupe', 'err'); }
    finally { setBusy(null); setOpen(false); }
  }
  async function runAiDedupe() {
    setBusy('ai-dedupe');
    setOpen(false);
    toast.push('AI sta analizzando le chat… (può richiedere 1-2 min)', 'on');
    try {
      const r: any = await api.waAiDedupe();
      if (!r?.ok) { toast.push(r?.error ?? 'AI dedupe fallito', 'err'); return; }
      if ((r.merged ?? 0) === 0) toast.push('AI: nessun duplicato identificato', 'warn');
      else toast.push(`AI ha unito ${r.merged} chat · ${r.touched} messaggi spostati`, 'on');
      onAfterAction?.();
    } catch (e: any) { toast.push(e?.message ?? 'Errore AI dedupe', 'err'); }
    finally { setBusy(null); }
  }
  async function runRefreshPics() {
    setBusy('pics');
    try {
      const r: any = await api.waRefreshPics();
      toast.push(`${r?.queued ?? 0} avatar in coda`, 'on');
      onAfterAction?.();
    } catch (e: any) { toast.push(e?.message ?? 'Errore avatar', 'err'); }
    finally { setBusy(null); setOpen(false); }
  }

  const items: { id: string; icon: any; label: string; onClick: () => void | Promise<void>; running?: boolean; danger?: boolean }[] = [
    { id: 'sync',     icon: RefreshCw, label: 'Sincronizza chat',      onClick: sync, running: syncing },
    { id: 'contacts', icon: UserCog,   label: 'Aggiorna contatti',     onClick: refreshContacts, running: refreshingContacts },
    { id: 'pics',     icon: ImageIcon, label: 'Aggiorna avatar',       onClick: runRefreshPics, running: busy === 'pics' },
    { id: 'dedupe',    icon: GitMerge, label: 'Unisci duplicati (rapido)',     onClick: runDedupe,   running: busy === 'dedupe' },
    { id: 'ai-dedupe', icon: Sparkles, label: 'Unisci duplicati con AI (brain)', onClick: runAiDedupe, running: busy === 'ai-dedupe' },
    { id: 'wipe',      icon: Trash2,   label: 'Cancella TUTTE le chat',         onClick: runWipe,     running: busy === 'wipe', danger: true },
    { id: 'rescan',    icon: RefreshCw,label: 'Reset sessione (re-QR + history)', onClick: runRescan,  running: busy === 'rescan', danger: true },
  ];

  async function runRescan() {
    setOpen(false);
    const ok = await dlg.confirm(
      'Disconnettere WhatsApp + cancellare creds locali?\n\nDovrai scansionare nuovamente il QR dalla pagina Connettori. Dopo lo scan, Baileys re-importerà l\'intera cronologia chat (sync iniziale).\n\nQuesta è l\'unica via per riavere il backlog completo se Sincronizza chat scarica solo poche conversazioni.',
      { tone: 'danger', confirmLabel: 'Disconnetti + reset' },
    );
    if (!ok) return;
    setBusy('rescan');
    try {
      await api.waLogout();
      toast.push('Sessione resettata. Vai in Connettori → WhatsApp → scansiona il QR.', 'on');
      onAfterAction?.();
    } catch (e: any) { toast.push(e?.message ?? 'Errore reset', 'err'); }
    finally { setBusy(null); }
  }

  async function runWipe() {
    setOpen(false);
    const ok = await dlg.confirm(
      'Cancellare TUTTE le chat WhatsApp dal database?\n\nVerranno rimossi messaggi + contatti locali. La sessione WA resta collegata: alla prossima Sync rebuilderà da zero senza duplicati.\n\nIrreversibile.',
      { tone: 'danger', confirmLabel: 'Cancella tutto' },
    );
    if (!ok) return;
    setBusy('wipe');
    try {
      const r: any = await api.waWipe();
      toast.push(`Cancellati ${r?.deleted_messages ?? 0} msg + ${r?.deleted_contacts ?? 0} contatti. Premi Sincronizza chat.`, 'on');
      onAfterAction?.();
    } catch (e: any) { toast.push(e?.message ?? 'Errore wipe', 'err'); }
    finally { setBusy(null); }
  }

  return (
    <div className="relative" ref={ref}>
      <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} title="Altre azioni">
        <MoreHorizontal size={16} />
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[240px] rounded-xl border border-border bg-surface shadow-2xl overflow-hidden">
          {items.map((it) => {
            const Icon = it.icon;
            const danger = (it as any).danger;
            return (
              <button
                key={it.id}
                onClick={it.onClick}
                disabled={!!it.running}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition border-b border-border/60 last:border-b-0 ${
                  it.running
                    ? (danger ? 'bg-red-500/10 cursor-wait' : 'bg-accent/10 cursor-wait')
                    : danger
                      ? 'hover:bg-red-500/10 text-red-300 border-t border-red-500/20'
                      : 'hover:bg-surface2/60'
                }`}
              >
                <Icon size={14} className={`shrink-0 ${danger ? 'text-red-400' : 'text-accent'}`} />
                <span className="flex-1">{it.label}</span>
                {it.running && (
                  <span className={`inline-flex items-center gap-0.5 ${danger ? 'text-red-400' : 'text-accent'}`}>
                    <span className={`w-1 h-1 rounded-full ${danger ? 'bg-red-400' : 'bg-accent'} animate-pulse`} />
                    <span className={`w-1 h-1 rounded-full ${danger ? 'bg-red-400' : 'bg-accent'} animate-pulse [animation-delay:120ms]`} />
                    <span className={`w-1 h-1 rounded-full ${danger ? 'bg-red-400' : 'bg-accent'} animate-pulse [animation-delay:240ms]`} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Render the WhatsApp profile picture when available; fall back to initials
// inside a colored circle. <img> onError swaps back to initials if the URL
// expired (WA rotates signed URLs).
function Avatar({ name, url, size = 40, isGroup = false }: { name: string; url?: string | null; size?: number; isGroup?: boolean }) {
  const [broken, setBroken] = useState(false);
  const px = `${size}px`;
  const fontSize = size >= 36 ? 12 : 10;
  if (url && !broken) {
    return (
      <img
        src={url}
        alt={name}
        onError={() => setBroken(true)}
        style={{ width: px, height: px }}
        className="rounded-full object-cover shrink-0 ring-1 ring-white/10"
      />
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center font-semibold text-white shrink-0"
      style={{ width: px, height: px, fontSize, background: avatarColor(name) }}
    >
      {isGroup ? <Users size={Math.round(size * 0.4)} /> : initials(name)}
    </div>
  );
}

function avatarColor(s: string): string {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase();
}

const WAVE_BARS = [4, 8, 14, 18, 22, 16, 12, 20, 24, 18, 14, 8, 4, 10, 16, 12, 6];
function AudioWave({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const h = size === 'sm' ? 14 : 22;
  const w = size === 'sm' ? 2 : 3;
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span className="inline-flex items-center justify-center rounded-full bg-accent2/15 text-accent2 w-6 h-6 shrink-0">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
      </span>
      <span className="inline-flex items-end gap-[2px]" aria-label="audio">
        {WAVE_BARS.map((b, i) => (
          <span
            key={i}
            className="inline-block rounded-full bg-accent2/70"
            style={{ width: w, height: (b / 24) * h + 2 }}
          />
        ))}
      </span>
      <span className={`text-[10px] text-muted-foreground ${size === 'sm' ? '' : 'text-xs'}`}>vocale</span>
    </span>
  );
}

function isAudio(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^\[audio\]/i.test(text.trim());
}
function audioCaption(text: string): string {
  return text.replace(/^\[audio\]\s*/i, '').trim();
}

export default function WhatsApp() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pending, setPending] = useState<number>(0);
  // Manual chat merge — when auto-dedupe can't link two chats via signals,
  // the user picks the canonical and dup explicitly.
  const [mergeFor, setMergeFor] = useState<string | null>(null);
  const [mergeQuery, setMergeQuery] = useState('');
  const [merging, setMerging] = useState(false);
  // Manual brain-link: user explicitly bind a WA chat to a Person.
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState('');
  const [linkPeople, setLinkPeople] = useState<Array<{ slug: string; name: string; avatar_url?: string | null; emails?: string[]; phones?: string[]; aliases?: string[] }>>([]);
  const [linking, setLinking] = useState(false);
  // Per-chat display override dialog (custom name + phone).
  const [editFor, setEditFor] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  // First-load flag for the chat list — distinguishes "still loading" from
  // "loaded but truly empty" so we don't flash "0 chat" on initial mount.
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chatMenuOpen) return;
    const fn = (e: MouseEvent) => { if (chatMenuRef.current && !chatMenuRef.current.contains(e.target as Node)) setChatMenuOpen(false); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [chatMenuOpen]);
  const [bonifying, setBonifying] = useState(false);
  const [bonifyProgress, setBonifyProgress] = useState<{ total: number; toolCalls: number; onlyChat: string | null; startedAt: number } | null>(null);
  // AI dedupe progress — phase + rolling log lines streamed from backend.
  type AiPair = { canon: string; dup: string; reason: string };
  const [aiDedupeProgress, setAiDedupeProgress] = useState<{
    phase: string; startedAt: number; lines: string[]; pairs: AiPair[]; merged: number; touched: number;
  } | null>(null);
  // Per-chat busy set — chat-jid currently being bonified (auto-sync or manual). Drives spinner on sidebar row.
  const [busyChats, setBusyChats] = useState<Set<string>>(new Set());
  const [elapsed, setElapsed] = useState(0);
  const [suggesting, setSuggesting] = useState(false);
  const [draftReply, setDraftReply] = useState<string>('');
  const [composeText, setComposeText] = useState<string>('');
  const [composeFromAi, setComposeFromAi] = useState(false);
  const [sending, setSending] = useState(false);
  const [syncingChat, setSyncingChat] = useState(false);
  async function syncChat() {
    if (!selected) return;
    setSyncingChat(true);
    try {
      const r = await api.waSyncChat(selected, 3);
      if (r.ok) toast.push(`Sync chiesto: ${r.requested} batch`, 'on');
      else toast.push(`Errore: ${String(r.error ?? '').slice(0, 200)}`, 'err');
      setTimeout(() => { if (selected) loadMessages(selected); loadChats(); }, 2000);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSyncingChat(false); }
  }

  async function suggest() {
    if (!selected) return;
    setSuggesting(true);
    setDraftReply('');
    try {
      const r = await api.waSuggestReply(selected);
      if (r.ok) setDraftReply(r.draft);
      else toast.push(`Errore: ${String(r.error ?? '').slice(0, 200)}`, 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSuggesting(false); }
  }
  async function sendReply() {
    if (!selected || !draftReply.trim()) return;
    setSending(true);
    try {
      const r = await api.waSendMessage(selected, draftReply.trim(), 'ai');
      if (r.ok) { toast.push('Inviato (AI)', 'on'); setDraftReply(''); }
      else toast.push(`Errore: ${String(r.error ?? '').slice(0, 200)}`, 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSending(false); }
  }
  // Send from the always-visible compose box. Tracks whether the text was originally
  // populated by the AI suggestion so we can mark `source='ai'` even if user edited it.
  async function sendCompose() {
    if (!selected || !composeText.trim()) return;
    setSending(true);
    const source: 'user' | 'ai' = composeFromAi ? 'ai' : 'user';
    const text = composeText.trim();
    const optimisticId = `optim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Optimistic append: msg shows instantly on the right side, replaced by
    // the WS echo (matched by chat_jid + text + from_me). Without this the UI
    // froze for ~1-2s per send while Baileys ACK'd, and rapid sends stacked
    // in the wrong order.
    const optim: Msg = {
      id: optimisticId as any, msg_id: optimisticId, chat_jid: selected,
      sender_jid: '', sender_phone: null, sender_name: 'TU', person_slug: null,
      is_group: false, group_jid: null, from_me: true, text,
      ts: new Date().toISOString(), source,
    };
    setMessages((prev) => [...prev, optim]);
    setComposeText(''); setComposeFromAi(false);
    try {
      const r = await api.waSendMessage(selected, text, source);
      if (!r.ok) {
        // Roll back optimistic + restore text so user can retry.
        setMessages((prev) => prev.filter((m) => m.msg_id !== optimisticId));
        setComposeText(text);
        toast.push(`Errore: ${String(r.error ?? '').slice(0, 200)}`, 'err');
      }
    } catch (e: any) {
      setMessages((prev) => prev.filter((m) => m.msg_id !== optimisticId));
      setComposeText(text);
      toast.push(e.message, 'err');
    }
    finally { setSending(false); }
  }
  function acceptSuggestion() {
    if (!draftReply) return;
    setComposeText(draftReply);
    setComposeFromAi(true);
    setDraftReply('');
  }

  // Reset state when chat changes
  useEffect(() => { setDraftReply(''); setSuggesting(false); setSending(false); setComposeText(''); setComposeFromAi(false); }, [selected]);
  const streamRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { locked: quotaLocked, lockProps } = useQuotaLock();
  const dlg = useDialog();

  async function loadPending() { try { const r = await api.waPending(); setPending(r.count ?? 0); } catch {} }
  async function bonify(onlyChat?: string) {
    const label = onlyChat ? `questa chat` : `${Math.min(pending, 100)} messaggi`;
    if (!await dlg.confirm(`Lanciare bonifica su ${label}? L'agente classificherà + aggiornerà People + Brain.`, { title: 'Bonifica', tone: 'danger', confirmLabel: 'Lancia' })) return;
    setBonifying(true);
    try {
      await api.waBonify(onlyChat ? 5000 : 100, onlyChat);
      toast.push(onlyChat ? 'Bonifica chat lanciata' : 'Bonifica lanciata in background', 'on');
      setTimeout(loadPending, 5000);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBonifying(false); }
  }

  const [refreshingContacts, setRefreshingContacts] = useState(false);
  async function mergeAllByName() {
    let totalTouched = 0;
    for (let pass = 0; pass < 5; pass++) {
      const fresh: Chat[] = await api.waChats();
      const groups = new Map<string, Chat[]>();
      for (const c of fresh) {
        if (c.is_group) continue;
        const raw = (c.sender_name || '').toLowerCase().trim();
        if (!raw || raw.startsWith('+')) continue;
        const key = raw.split(/\s+/)[0];
        if (!key) continue;
        const arr = groups.get(key) ?? [];
        arr.push(c);
        groups.set(key, arr);
      }
      console.log(`[wa] mergeAllByName pass ${pass} found ${fresh.length} chats, ${[...groups.entries()].filter(([_, v]) => v.length > 1).length} dup groups`);
      let pairsThisPass = 0;
      for (const [k, arr] of groups) {
        if (arr.length < 2) continue;
        arr.sort((a, b) => Number(a.chat_jid.endsWith('@lid')) - Number(b.chat_jid.endsWith('@lid')) || a.chat_jid.localeCompare(b.chat_jid));
        const canon = arr[0].chat_jid;
        const dups = arr.slice(1).map((c) => c.chat_jid).filter((j) => j !== canon);
        console.log(`[wa] merge group=${k} canon=${canon} dups=${dups.join(',')}`);
        if (!dups.length) continue;
        try {
          const r = await api.waMergeChats(canon, dups);
          console.log(`[wa] merge result`, r);
          if (r.ok) { pairsThisPass += dups.length; totalTouched += dups.length; }
        } catch (e) { console.error('[wa] merge err', e); }
      }
      if (pairsThisPass === 0) break;
    }
    return totalTouched;
  }

  async function refreshContacts() {
    setRefreshingContacts(true);
    try {
      const r = await api.waRefreshContacts();
      if (r.ok) {
        // Wait for chat list refresh then run client-side first-token merge
        await loadChats();
        const extra = await mergeAllByName();
        toast.push(`Aggiornati ${r.groups} gruppi + contatti${r.merged ? ` · ${r.merged} unite via contatti` : ''}${extra ? ` · ${extra} unite via nome` : ''}`, 'on');
      } else toast.push(`Errore: ${r.error?.slice(0, 200) ?? '?'}`, 'err');
      loadChats();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setRefreshingContacts(false); }
  }
  async function sync() {
    setSyncing(true);
    try {
      const r = await api.waSync();
      if (r.ok) {
        if (r.hint) toast.push(r.hint, 'warn');
        else toast.push(`Sync richiesto su ${r.requested}/${r.chats} chat`, 'on');
      } else toast.push(`Errore: ${r.error?.slice(0, 200) ?? 'sconosciuto'}`, 'err');
      loadChats();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSyncing(false); }
  }

  async function loadChats() {
    try { setChats(await api.waChats()); }
    catch {}
    finally { setChatsLoaded(true); }
  }
  async function loadMessages(jid: string) {
    setLoading(true);
    try { setMessages(await api.waChatMessages(jid)); } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => { loadChats(); loadPending(); const id = setInterval(loadPending, 30000); return () => clearInterval(id); }, []);
  useEffect(() => {
    if (!bonifyProgress) { setElapsed(0); return; }
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - bonifyProgress.startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [bonifyProgress]);
  useEffect(() => { if (selected) loadMessages(selected); }, [selected]);

  useWS((msg) => {
    if (msg.type === 'wa:synced') {
      toast.push(`Sync completata: ${msg.payload.count} messaggi`, 'on');
      loadChats();
      if (selected) loadMessages(selected);
      return;
    }
    if (msg.type === 'wa:ai_dedupe') {
      const p = msg.payload;
      const phase = p.phase as string;
      setAiDedupeProgress((cur) => {
        const base = cur ?? { phase, startedAt: Date.now(), lines: [], pairs: [], merged: 0, touched: 0 };
        const next = { ...base, phase };
        const label = ({
          start:        `Analizzo ${p.total} chat…`,
          manifest:     `Manifest costruito (${p.chats} chat)`,
          asking_ai:    `Mando manifest a Claude (${Math.round((p.prompt_chars ?? 0) / 1000)}K caratteri)…`,
          parsing:      `Risposta ricevuta — parso (cost $${Number(p.cost ?? 0).toFixed(4)})`,
          proposed:     `${(p.pairs ?? []).length} coppie identificate`,
          merging:      `Unisco ${p.canon?.slice(-12) ?? '?'} ← ${(p.dups ?? []).length} dup`,
          merged:       `✓ Unite ${(p.dups ?? []).length} chat in ${p.canon?.slice(-12) ?? '?'} (${p.touched ?? 0} msg)`,
          merge_error:  `✗ Errore merge: ${String(p.error ?? '').slice(0, 100)}`,
          done:         `Completato: ${p.merged} chat unite · ${p.touched} msg spostati · ${Math.round((p.durationMs ?? 0) / 1000)}s`,
          error:        `Errore: ${String(p.error ?? '').slice(0, 200)}`,
        } as Record<string, string>)[phase] ?? phase;
        next.lines = [...base.lines, `[${new Date().toLocaleTimeString('it-IT')}] ${label}`].slice(-30);
        if (phase === 'proposed') next.pairs = p.pairs ?? [];
        if (phase === 'merged') next.merged += (p.dups ?? []).length;
        if (phase === 'done') { next.merged = p.merged ?? next.merged; next.touched = p.touched ?? next.touched; }
        return next;
      });
      if (phase === 'done' || phase === 'error') {
        // Keep card visible 6s after completion so user can read summary.
        setTimeout(() => setAiDedupeProgress(null), 6000);
        loadChats();
      }
      return;
    }
    if (msg.type === 'wa:bonify') {
      const p = msg.payload;
      if (p.kind === 'start') {
        setBonifyProgress({ total: p.total, toolCalls: 0, onlyChat: p.onlyChat, startedAt: Date.now() });
        if (p.onlyChat) setBusyChats((prev) => { const n = new Set(prev); n.add(p.onlyChat); return n; });
      } else if (p.kind === 'done') {
        setBonifyProgress(null);
        if (p.onlyChat) setBusyChats((prev) => { const n = new Set(prev); n.delete(p.onlyChat); return n; });
        toast.push(`Bonifica completata: ${p.processed} msg · $${Number(p.cost ?? 0).toFixed(4)} · ${Math.round((p.durationMs ?? 0) / 1000)}s`, 'on');
        loadPending(); loadChats();
      } else if (p.kind === 'error') {
        setBonifyProgress(null);
        if (p.onlyChat) setBusyChats((prev) => { const n = new Set(prev); n.delete(p.onlyChat); return n; });
        toast.push(`Bonifica fallita: ${String(p.error ?? '').slice(0, 200)}`, 'err');
      }
      return;
    }
    if (msg.type === 'tool:use') {
      // Increment counter if bonify run in progress
      setBonifyProgress((prev) => prev ? { ...prev, toolCalls: prev.toolCalls + 1 } : prev);
      return;
    }
    if (msg.type !== 'wa:message') return;
    const m: Msg = msg.payload.msg;
    console.log('[wa] WS msg', m.chat_jid, m.text?.slice(0, 40));
    // Refresh chat list from API (proper name resolution via JOIN)
    loadChats();
    if (selectedRef.current === m.chat_jid) {
      setMessages((prev) => {
        if (prev.some((x) => x.msg_id === m.msg_id)) return prev;
        // Replace optimistic clone if present (match text + from_me + recent ts).
        const idx = prev.findIndex((x) =>
          x.msg_id?.startsWith('optim-') && x.from_me === m.from_me &&
          x.text === m.text && Math.abs(new Date(x.ts).getTime() - new Date(m.ts).getTime()) < 60_000,
        );
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = m;
          return next;
        }
        return [...prev, m];
      });
    }
  });

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="h-full flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-semibold text-gradient">WhatsApp</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone="on">live</Chip>
          {pending > 0 && <Chip tone="warn">{pending} da bonificare</Chip>}
          <Button size="sm" onClick={() => bonify()} disabled={bonifying || pending === 0}>
            <Sparkles size={14} className="inline mr-1.5 -mt-0.5" />
            {bonifying ? 'Lancio…' : `Bonifica (${Math.min(pending, 100)})`}
          </Button>
          <WaToolbarMenu
            sync={sync} syncing={syncing}
            refreshContacts={refreshContacts} refreshingContacts={refreshingContacts}
            onAfterAction={() => { loadChats(); loadPending(); }}
          />
        </div>
      </div>

      {aiDedupeProgress && (
        <Card className="border-accent2/40 bg-gradient-to-br from-accent/5 to-accent2/5 p-3">
          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="flex items-center gap-2 text-sm">
              <Sparkles size={16} className="animate-pulse text-accent2" />
              <span className="font-semibold">AI dedupe in corso</span>
              <Chip>{aiDedupeProgress.phase}</Chip>
              {aiDedupeProgress.pairs.length > 0 && <Chip tone="accent">{aiDedupeProgress.pairs.length} coppie</Chip>}
              {aiDedupeProgress.merged > 0 && <Chip tone="on">{aiDedupeProgress.merged} unite</Chip>}
            </div>
            <span className="text-[10px] text-muted-foreground font-mono">{Math.floor((Date.now() - aiDedupeProgress.startedAt) / 1000)}s</span>
          </div>
          <div className="bg-bg/60 border border-border rounded-lg p-2 max-h-40 overflow-y-auto font-mono text-[11px] space-y-0.5">
            {aiDedupeProgress.lines.map((ln, i) => (
              <div key={i} className="text-muted-foreground">{ln}</div>
            ))}
          </div>
          {aiDedupeProgress.pairs.length > 0 && (
            <div className="mt-2 text-[11px] space-y-1">
              <div className="text-muted-foreground uppercase tracking-wider font-semibold text-[9px]">Proposte AI</div>
              {aiDedupeProgress.pairs.slice(0, 8).map((p, i) => {
                const canonName = chats.find((c) => c.chat_jid === p.canon)?.sender_name ?? p.canon;
                const dupName = chats.find((c) => c.chat_jid === p.dup)?.sender_name ?? p.dup;
                return (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 rounded-md bg-surface2/40">
                    <span className="font-medium text-accent">{canonName}</span>
                    <span className="text-muted-foreground">←</span>
                    <span className="text-muted-foreground line-through">{dupName}</span>
                    {p.reason && <span className="text-[10px] text-muted-foreground ml-auto italic truncate">{p.reason}</span>}
                  </div>
                );
              })}
              {aiDedupeProgress.pairs.length > 8 && <div className="text-muted-foreground">+{aiDedupeProgress.pairs.length - 8} altri</div>}
            </div>
          )}
        </Card>
      )}

      {bonifyProgress && (
        <Card className="border-accent/40 bg-accent/5 flex items-center gap-4 flex-wrap p-3">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={16} className="animate-pulse text-accent" />
            <span className="font-semibold">Bonifica in corso</span>
            {bonifyProgress.onlyChat && <Chip>{chats.find((c) => c.chat_jid === bonifyProgress.onlyChat)?.sender_name ?? bonifyProgress.onlyChat}</Chip>}
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="h-2 rounded-full bg-surface2/60 overflow-hidden relative">
              <div
                className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-accent via-accent2 to-accent"
                style={{ animation: 'indeterminate 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite' }}
              />
              <style>{`@keyframes indeterminate { 0% { left: -33%; } 100% { left: 100%; } }`}</style>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
            <span>{bonifyProgress.total} msg</span>
            <span>{bonifyProgress.toolCalls} tool calls</span>
            <span>{elapsed}s</span>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0 h-[78vh] max-h-[78vh]">
        {/* Chats sidebar */}
        <Card className="col-span-12 md:col-span-4 lg:col-span-3 p-0 overflow-hidden flex flex-col h-full max-h-[78vh]">
          <div className="p-3 border-b border-border text-xs uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-2">
            <MessageCircle size={14} />
            {chatsLoaded ? (
              selectedChats.size > 0 ? (
                <span className="flex items-center gap-2 flex-1">
                  <span className="text-accent">{selectedChats.size} selezionate</span>
                  <Button
                    size="sm" variant="ghost"
                    onClick={async () => {
                      const ok = await dlg.confirm(`Elimina ${selectedChats.size} chat dal DB locale?\n\nVerranno rimossi messaggi + contatti. La sessione WA resta attiva, prossima Sync re-importa.`, { tone: 'danger', confirmLabel: 'Elimina' });
                      if (!ok) return;
                      try {
                        const r = await api.waDeleteChats(Array.from(selectedChats));
                        toast.push(`Eliminate ${selectedChats.size} chat (${r.deleted_messages} msg)`, 'on');
                        setSelectedChats(new Set());
                        if (selected && selectedChats.has(selected)) setSelected(null);
                        loadChats();
                      } catch (e: any) { toast.push(e.message, 'err'); }
                    }}
                    className="text-red-400 hover:text-red-300"
                  ><Trash2 size={12} className="inline mr-1 -mt-0.5" />Elimina</Button>
                  <button onClick={() => setSelectedChats(new Set())} className="ml-auto text-muted-foreground hover:text-text"><X size={12} /></button>
                </span>
              ) : `${chats.length} chat`
            ) : (
              <span className="inline-flex items-center gap-1.5"><RefreshCw size={11} className="animate-spin" /> caricamento…</span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {!chatsLoaded && (
              <div className="divide-y divide-border/60 animate-pulse">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div key={i} className="px-3 py-2.5 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-surface2" />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="h-3 rounded bg-surface2" style={{ width: `${40 + ((i * 7) % 40)}%` }} />
                      <div className="h-2.5 rounded bg-surface2/60" style={{ width: `${55 + ((i * 11) % 35)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {chatsLoaded && chats.length === 0 && <div className="p-4 text-muted-foreground text-sm">Nessun messaggio ancora. Configura WhatsApp in Connettori.</div>}
            {(() => {
              // Visual dedupe: if multiple rows share the SAME displayed
              // identity (phone OR resolved name OR linked person), collapse
              // them into one row and merge selection. Click selects all.
              const groups = new Map<string, Chat[]>();
              for (const c of chats) {
                const key = c.linked_person_slug
                  ? `link:${c.linked_person_slug}`
                  : (c.sender_phone ? `ph:${c.sender_phone.replace(/\D/g, '')}`
                    : (c.sender_name ? `nm:${c.sender_name.toLowerCase().trim()}` : `jid:${c.chat_jid}`));
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(c);
              }
              return Array.from(groups.values())
                .map((group) => group.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()))
                .sort((a, b) => new Date(b[0].ts).getTime() - new Date(a[0].ts).getTime())
                .map((group) => ({ rep: group[0], group }));
            })().map(({ rep: c, group }) => {
              const name = c.sender_name || c.sender_phone || c.chat_jid;
              const groupJids = group.map((g) => g.chat_jid);
              const active = groupJids.includes(selected ?? '');
              const isChecked = groupJids.some((j) => selectedChats.has(j));
              const multiMode = selectedChats.size > 0;
              const toggleGroupSelection = () => {
                setSelectedChats((prev) => {
                  const next = new Set(prev);
                  if (isChecked) groupJids.forEach((j) => next.delete(j));
                  else groupJids.forEach((j) => next.add(j));
                  return next;
                });
              };
              return (
                <button
                  key={c.chat_jid}
                  onClick={(e) => {
                    if (multiMode || e.shiftKey || (e as any).metaKey || (e as any).ctrlKey) {
                      toggleGroupSelection();
                    } else {
                      setSelected(c.chat_jid);
                    }
                  }}
                  className={`group w-full text-left px-3 py-2.5 flex items-center gap-3 border-b border-border/60 transition ${isChecked ? 'bg-accent/15 border-accent/30' : active ? 'bg-accent/10' : 'hover:bg-surface2/40'}`}
                >
                  <div
                    onClick={(e) => { e.stopPropagation(); toggleGroupSelection(); }}
                    className={`shrink-0 w-4 h-4 rounded border transition flex items-center justify-center cursor-pointer ${isChecked ? 'bg-accent border-accent' : 'border-border opacity-0 group-hover:opacity-100'}`}
                    title="Seleziona"
                  >
                    {isChecked && <span className="text-white text-[10px] leading-none">✓</span>}
                  </div>
                  <Avatar name={name} url={c.profile_pic_url} size={40} isGroup={c.is_group} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate text-sm flex items-center gap-1.5">
                        {name}
                        {group.length > 1 && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent2/15 text-accent2 border border-accent2/40 uppercase tracking-wider font-semibold"
                            title={`${group.length} chat unite visivamente:\n${group.map((g) => g.chat_jid).join('\n')}`}
                          >
                            ×{group.length}
                          </span>
                        )}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
                        {fmtTime(c.ts)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                      <span className="truncate flex-1">
                        {isAudio(c.text) ? <AudioWave /> : (c.text || '…')}
                      </span>
                      {c.total_count > 0 && c.pending_count === 0 && (
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">✓ bonificata</span>
                      )}
                      {c.pending_count > 0 && c.bonified_count > 0 && (
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-400/30">{c.bonified_count}/{c.total_count}</span>
                      )}
                      {c.auto_bonify && !busyChats.has(c.chat_jid) && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/40 font-semibold uppercase tracking-wider" title="Auto-sync attivo">
                          <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                          auto-sync
                        </span>
                      )}
                      {busyChats.has(c.chat_jid) && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-accent2/15 text-accent2 border border-accent2/40 font-semibold uppercase tracking-wider" title="Bonifica in corso">
                          <RefreshCw size={9} className="animate-spin" />
                          sync…
                        </span>
                      )}
                      {(c.display_name_override || c.display_phone_override) && (
                        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/40 font-semibold" title="Nome/numero personalizzati">
                          <Pencil size={10} /> custom
                        </span>
                      )}
                      {c.linked_person_slug && (
                        <Link
                          to={`/people?slug=${encodeURIComponent(c.linked_person_slug)}`}
                          onClick={(e) => e.stopPropagation()}
                          title={`Apri dossier di ${c.linked_person_slug}`}
                          className="shrink-0 inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent2/15 text-accent2 border border-accent2/40 font-semibold hover:bg-accent2/25 transition"
                        >
                          <Brain size={10} /> brain
                        </Link>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Chat view */}
        <div className="col-span-12 md:col-span-8 lg:col-span-9 rounded-xl border overflow-hidden flex flex-col h-full max-h-[78vh] relative chat-pattern">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {chatsLoaded
                ? (chats.length === 0
                    ? 'Nessuna chat ancora. Configura WhatsApp in Connettori.'
                    : 'Seleziona una chat per visualizzare i messaggi.')
                : (
                  <span className="inline-flex items-center gap-2">
                    <RefreshCw size={14} className="animate-spin" /> caricamento chat…
                  </span>
                )}
            </div>
          ) : (
            <>
              {(() => {
                const c = chats.find((x) => x.chat_jid === selected);
                const name = c?.sender_name || c?.sender_phone || selected;
                return (
                  <div className="px-4 py-2.5 border-b border-border bg-surface/60 backdrop-blur-sm flex items-center gap-3">
                    {/* Identity */}
                    <Avatar name={name} url={c?.profile_pic_url} size={40} isGroup={!!c?.is_group} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold truncate text-[15px]">{name}</span>
                        {c?.linked_person_slug && (
                          <Link
                            to={`/people?slug=${encodeURIComponent(c.linked_person_slug)}`}
                            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-accent2 border border-accent2/40 rounded-full px-2 py-px hover:bg-accent2/10 transition"
                            title={`Apri dossier di ${c.linked_person_slug}`}
                          >
                            <Brain size={10} /> {c.linked_person_slug}
                            <ExternalLink size={9} />
                          </Link>
                        )}
                        {(c?.display_name_override || c?.display_phone_override) && (
                          <span className="text-[9px] uppercase tracking-wider text-accent2 border border-accent2/40 rounded-full px-1.5 py-px" title="Nome/numero personalizzati">custom</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono truncate">{c?.sender_phone || selected}</span>
                        {c && c.total_count > 0 && c.pending_count === 0 && <span className="text-on">●&nbsp;bonificata</span>}
                        {c && c.pending_count > 0 && c.bonified_count > 0 && <span className="text-warn">●&nbsp;{c.bonified_count}/{c.total_count}</span>}
                        {c && c.pending_count > 0 && c.bonified_count === 0 && <span className="text-muted-foreground">●&nbsp;nuova</span>}
                      </div>
                    </div>

                    {/* Auto-sync inline pill */}
                    <button
                      onClick={() => {
                        const v = !c?.auto_bonify;
                        setChats((prev) => prev.map((x) => x.chat_jid === selected ? { ...x, auto_bonify: v } : x));
                        api.waSetChatAutoBonify(selected!, v)
                          .then(() => toast.push(v ? '✓ Auto-sync attivo' : 'Auto-sync off', v ? 'on' : 'warn'))
                          .catch((err: any) => {
                            setChats((prev) => prev.map((x) => x.chat_jid === selected ? { ...x, auto_bonify: !v } : x));
                            toast.push(err.message, 'err');
                          });
                      }}
                      className={`group inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border transition ${c?.auto_bonify ? 'bg-on/15 border-on/40 text-on' : 'bg-surface2 border-border text-muted-foreground hover:text-text'}`}
                      title="Auto-bonifica i nuovi messaggi pending ogni 5 minuti"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${c?.auto_bonify ? 'bg-on' : 'bg-muted'}`} />
                      Auto-sync
                    </button>

                    {/* Sync chat — icon-only */}
                    <button
                      onClick={syncChat}
                      disabled={syncingChat}
                      title="Sincronizza storia di questa chat"
                      className="p-1.5 rounded-lg border border-border bg-surface2 hover:text-accent disabled:opacity-50 transition"
                    >
                      <RefreshCw size={14} className={syncingChat ? 'animate-spin' : ''} />
                    </button>

                    {/* Bonifica — secondary */}
                    <Button size="sm" variant="ghost" disabled={bonifying || quotaLocked} title={lockProps.title} onClick={() => bonify(selected)}>
                      <Sparkles size={13} className="inline mr-1 -mt-0.5" />Bonifica
                    </Button>

                    {/* Suggerisci — primary CTA */}
                    <Button size="sm" disabled={suggesting || quotaLocked} title={lockProps.title} onClick={suggest}>
                      <Wand2 size={13} className={`inline mr-1 -mt-0.5 ${suggesting ? 'animate-pulse' : ''}`} />
                      {suggesting ? 'Penso…' : 'Suggerisci'}
                    </Button>

                    {/* Kebab — contact-level actions */}
                    <div className="relative" ref={chatMenuRef}>
                      <button
                        onClick={() => setChatMenuOpen((v) => !v)}
                        className="p-1.5 rounded-lg border border-border bg-surface2 hover:text-accent transition"
                        title="Azioni contatto"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                      {chatMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 z-50 min-w-[220px] rounded-xl border border-border bg-surface shadow-2xl overflow-hidden">
                          <button
                            onClick={() => {
                              setChatMenuOpen(false);
                              setEditFor(selected!);
                              setEditName(c?.display_name_override ?? c?.sender_name ?? '');
                              setEditPhone(c?.display_phone_override ?? c?.sender_phone ?? '');
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-surface2 flex items-center gap-2"
                          >
                            <Pencil size={13} className={(c?.display_name_override || c?.display_phone_override) ? 'text-accent' : 'text-muted-foreground'} />
                            <div className="flex-1">Modifica nome/numero</div>
                            {(c?.display_name_override || c?.display_phone_override) && <span className="text-[9px] text-accent">attivo</span>}
                          </button>
                          <button
                            onClick={() => { setChatMenuOpen(false); setLinkFor(selected!); setLinkQuery(''); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-surface2 flex items-center gap-2"
                          >
                            <UserCog size={13} className={c?.linked_person_slug ? 'text-accent' : 'text-muted-foreground'} />
                            <div className="flex-1">Cabla a persona del brain</div>
                            {c?.linked_person_slug && <span className="text-[9px] text-accent truncate max-w-[80px]">{c.linked_person_slug}</span>}
                          </button>
                          <button
                            onClick={() => { setChatMenuOpen(false); setMergeFor(selected!); setMergeQuery(''); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-surface2 flex items-center gap-2"
                          >
                            <GitMerge size={13} className="text-muted-foreground" />
                            <div className="flex-1">Unisci con altra chat</div>
                          </button>
                          <div className="border-t border-border" />
                          <button
                            onClick={async () => {
                              setChatMenuOpen(false);
                              const target = chats.find((x) => x.chat_jid === selected);
                              const name = target?.sender_name || target?.sender_phone || selected;
                              const ok = await dlg.confirm(
                                `Eliminare la chat "${name}" dal DB locale?\n\nVerranno rimossi tutti i messaggi e il contatto. La sessione WA resta attiva, prossima Sync re-importa eventuali nuovi messaggi.`,
                                { tone: 'danger', confirmLabel: 'Elimina' },
                              );
                              if (!ok) return;
                              try {
                                const r = await api.waDeleteChats([selected!]);
                                toast.push(`Eliminata chat (${r.deleted_messages} msg)`, 'on');
                                setSelected(null);
                                loadChats();
                              } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-red-500/10 text-red-400 flex items-center gap-2"
                          >
                            <Trash2 size={13} />
                            <div className="flex-1">Elimina questa chat</div>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
              <div ref={streamRef} className="flex-1 overflow-y-auto p-4 space-y-2">
                {loading && messages.length === 0 && (
                  <div className="space-y-3 animate-pulse">
                    {[
                      { side: 'left', w: 'w-2/5' },
                      { side: 'right', w: 'w-1/2' },
                      { side: 'left', w: 'w-1/3' },
                      { side: 'left', w: 'w-3/5' },
                      { side: 'right', w: 'w-2/5' },
                      { side: 'right', w: 'w-1/3' },
                      { side: 'left', w: 'w-1/2' },
                      { side: 'left', w: 'w-2/5' },
                    ].map((s, i) => (
                      <div key={i} className={`flex ${s.side === 'right' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`${s.w} max-w-[70%]`}>
                          <div className={`h-9 rounded-2xl ${s.side === 'right' ? 'bg-accent/20 rounded-br-md' : 'bg-surface2 border border-border rounded-bl-md'}`} />
                          <div className={`mt-1 h-2 w-10 rounded bg-muted/15 ${s.side === 'right' ? 'ml-auto' : ''}`} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {messages.map((m) => {
                  const isAi = m.from_me && m.source === 'ai';
                  return (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm ${
                      isAi
                        ? 'bg-gradient-to-br from-accent2/35 to-accent/25 border border-accent2/50 rounded-br-md'
                        : m.from_me
                        ? 'bg-accent/45 border border-accent/55 rounded-br-md text-white'
                        : 'bg-surface2 border border-border rounded-bl-md'
                    }`}>
                      {m.is_group && !m.from_me && m.sender_name && (
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <Avatar name={m.sender_name} url={m.sender_pic_url} size={16} />
                          <span className="text-[10px] font-semibold text-accent2 truncate">{m.sender_name}</span>
                        </div>
                      )}
                      {isAi && (
                        <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-accent2 font-semibold mb-1">
                          <Wand2 size={9} /> AI suggested
                        </div>
                      )}
                      {isAi && (
                        <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-accent2 font-semibold mb-1">
                          <Wand2 size={9} /> AI suggested
                        </div>
                      )}
                      {isAudio(m.text) ? (
                        <div>
                          <AudioWave size="md" />
                          {audioCaption(m.text) && <div className="text-xs text-muted-foreground mt-1.5">{audioCaption(m.text)}</div>}
                        </div>
                      ) : (
                        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.text || <span className="text-muted-foreground italic">(empty)</span>}</div>
                      )}
                      <div className="text-[9px] text-muted-foreground mt-1 text-right">{fmtAgo(m.ts)} fa</div>
                    </div>
                  </div>
                );})}
              </div>

              {/* Always-visible compose bar */}
              <div className="border-t border-border bg-surface2/40 p-3 flex items-stretch gap-2">
                <div className={`flex-1 flex items-stretch rounded-2xl bg-surface border ${composeFromAi ? 'border-accent2/50' : 'border-border'} focus-within:border-accent transition overflow-hidden relative`}>
                  {composeFromAi && (
                    <div className="absolute -top-5 left-1 inline-flex items-center gap-1 text-[9px] uppercase tracking-wider text-accent2 font-semibold">
                      <Wand2 size={9} /> bozza AI
                      <button onClick={() => setComposeFromAi(false)} className="text-muted-foreground hover:text-text ml-1" title="Marca come user">×</button>
                    </div>
                  )}
                  {/* AI button prepended inside the input */}
                  <button
                    onClick={suggest}
                    disabled={suggesting || quotaLocked}
                    title={lockProps.title ?? 'Suggerisci risposta AI'}
                    className="shrink-0 flex items-center justify-center w-10 self-stretch bg-gradient-to-br from-accent2 to-accent text-white hover:opacity-90 disabled:opacity-60 transition"
                  >
                    <Sparkles size={16} className={suggesting ? 'animate-pulse' : ''} />
                  </button>
                  <Textarea
                    value={composeText}
                    onChange={(e) => { setComposeText(e.target.value); if (composeFromAi && e.target.value === '') setComposeFromAi(false); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCompose(); } }}
                    placeholder="Scrivi un messaggio… (Enter per inviare, Shift+Enter nuova riga)"
                    rows={1}
                    className="flex-1 bg-transparent px-3 py-2 text-sm resize-none outline-none min-h-[40px] max-h-32"
                  />
                </div>
                <Button onClick={sendCompose} disabled={sending || !composeText.trim() || quotaLocked} title={lockProps.title} className="self-stretch px-4 flex items-center">
                  <Send size={14} className="inline mr-1.5 -mt-0.5" />
                  {sending ? '…' : 'Invia'}
                </Button>
              </div>
            </>
          )}

          {/* Floating reply drawer — iOS glass style, animates between loading and ready */}
          {(suggesting || draftReply) && (
            <div
              className="absolute bottom-4 right-4 z-30 w-80 max-w-[calc(100%-2rem)] rounded-2xl border border-white/15 shadow-2xl overflow-hidden"
              style={{
                background: 'linear-gradient(135deg, rgba(34,211,238,0.12), rgba(192,132,252,0.10))',
                backdropFilter: 'blur(24px) saturate(160%)',
                WebkitBackdropFilter: 'blur(24px) saturate(160%)',
                transition: 'all 0.45s cubic-bezier(0.16, 1, 0.3, 1)',
              }}
            >
              {/* Top bar */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent2 font-semibold">
                  <Wand2 size={11} />
                  {suggesting ? 'Formulando…' : 'Bozza pronta'}
                </div>
                <button onClick={() => { setDraftReply(''); setSuggesting(false); }} className="text-muted-foreground hover:text-text">
                  <X size={13} />
                </button>
              </div>

              {/* Content */}
              <div
                className="p-3"
                style={{ transition: 'all 0.5s cubic-bezier(0.16, 1, 0.3, 1)' }}
              >
                {suggesting && !draftReply ? (
                  <div className="flex items-center gap-3 py-2">
                    <BrainLoading size={48} inline />
                    <span className="text-sm text-muted-foreground animate-pulse">Formulando risposta…</span>
                  </div>
                ) : (
                  <>
                    <Textarea
                      value={draftReply}
                      onChange={(e) => setDraftReply(e.target.value)}
                      rows={4}
                      className="w-full rounded-xl bg-black/30 border border-white/10 px-3 py-2 text-sm text-text focus:outline-none focus:border-accent2 resize-y placeholder-muted"
                      style={{ animation: 'fade-in 0.4s ease both' }}
                    />
                    <div className="flex items-center justify-between gap-2 mt-2.5" style={{ animation: 'fade-in 0.55s ease both' }}>
                      <Button size="sm" variant="ghost" onClick={suggest} disabled={suggesting}>
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
        </div>
      </div>

      {/* Per-chat display override — set custom name + phone shown in UI. */}
      {editFor && (() => {
        const target = chats.find((x) => x.chat_jid === editFor);
        const hasOverride = !!(target?.display_name_override || target?.display_phone_override);
        async function save(clear = false) {
          setEditSaving(true);
          try {
            const payload = clear
              ? { display_name: null, display_phone: null }
              : { display_name: editName.trim() || null, display_phone: editPhone.trim() || null };
            await api.waSetChatDisplay(editFor!, payload);
            setChats((prev) => prev.map((x) => x.chat_jid === editFor
              ? { ...x, display_name_override: payload.display_name, display_phone_override: payload.display_phone,
                  sender_name: payload.display_name ?? x.sender_name,
                  sender_phone: payload.display_phone ?? x.sender_phone }
              : x));
            toast.push(clear ? 'Override rimosso' : 'Salvato', 'on');
            setEditFor(null);
          } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
          finally { setEditSaving(false); }
        }
        return (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setEditFor(null)}>
            <Card className="w-full max-w-md">
              <div className="p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
                <div>
                  <div className="text-xs text-muted-foreground">Modifica chat</div>
                  <div className="font-medium truncate text-sm">{target?.sender_name ?? editFor}</div>
                  <div className="text-[10px] text-muted-foreground truncate">{editFor}</div>
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">Nome visualizzato</label>
                  <Input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Es. Mario Rossi"
                   
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">Numero visualizzato</label>
                  <Input
                    value={editPhone}
                    onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="Es. +39 333 1234567"
                   
                  />
                </div>
                <div className="text-[10px] text-muted-foreground">Override locale — sopravvive a ogni sync. Lascia vuoto per usare il valore di WhatsApp.</div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  {hasOverride
                    ? <Button size="sm" variant="ghost" onClick={() => save(true)} disabled={editSaving}>Rimuovi override</Button>
                    : <span />}
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditFor(null)} disabled={editSaving}>Annulla</Button>
                    <Button size="sm" onClick={() => save(false)} disabled={editSaving}>Salva</Button>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        );
      })()}

      {/* Manual brain-link picker — bind a WA chat to an existing Person. */}
      {linkFor && (() => {
        const target = chats.find((x) => x.chat_jid === linkFor);
        const targetName = target?.sender_name ?? target?.sender_phone ?? linkFor;
        async function loadPeople(q: string) {
          try {
            const r: any = await api.people({ q, limit: 30 });
            const rows = (r?.rows ?? []).map((p: any) => ({
              slug: p.slug, name: p.name, avatar_url: p.avatar_url ?? null,
              emails: p.emails ?? [], phones: p.phones ?? [], aliases: p.aliases ?? [],
            }));
            // Sort: richer record first (emails+phones+aliases count). Avoids
            // picking the wrong "Mattia Calastri" when 2 rows share name.
            rows.sort((a: any, b: any) =>
              (b.emails.length + b.phones.length + b.aliases.length) -
              (a.emails.length + a.phones.length + a.aliases.length),
            );
            setLinkPeople(rows);
          } catch {}
        }
        async function doLink(slug: string | null) {
          setLinking(true);
          console.log('[wa:link] sending slug=', slug, 'to chat=', linkFor);
          try {
            await api.waLinkChat(linkFor!, slug);
            toast.push(slug ? `Chat cablata a ${slug}` : 'Cablaggio rimosso', 'on');
            setLinkFor(null);
            // Re-fetch chats so the resolved name (JOIN people via linked_person_slug)
            // refreshes. Optimistic-only update kept the stale sender_name on screen.
            await loadChats();
          } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
          finally { setLinking(false); }
        }
        return (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setLinkFor(null)}>
            <Card className="w-full max-w-md">
              <div className="p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
                <div>
                  <div className="text-xs text-muted-foreground">Cabla chat a persona del brain</div>
                  <div className="font-medium truncate text-sm">{targetName}</div>
                  {target?.linked_person_slug && (
                    <div className="text-[11px] text-accent mt-1">Già cablata a <code>{target.linked_person_slug}</code></div>
                  )}
                </div>
                <Input
                  autoFocus
                  placeholder="Cerca persona…"
                  value={linkQuery}
                  onChange={(e) => { setLinkQuery(e.target.value); loadPeople(e.target.value); }}
                  onFocus={() => loadPeople(linkQuery)}
                 
                />
                <div className="max-h-72 overflow-y-auto space-y-1">
                  {linkPeople.length === 0 && <div className="text-xs text-muted-foreground py-2">Nessun risultato. Digita per cercare.</div>}
                  {linkPeople.map((p) => {
                    const rich = (p.emails?.length ?? 0) + (p.phones?.length ?? 0);
                    return (
                      <button
                        key={p.slug}
                        onClick={() => doLink(p.slug)}
                        disabled={linking}
                        className={`w-full text-left px-2 py-1.5 rounded hover:bg-surface flex items-center gap-2 disabled:opacity-50 border ${rich > 0 ? 'border-accent2/30' : 'border-transparent'}`}
                      >
                        {p.avatar_url
                          ? <img src={p.avatar_url} className="w-6 h-6 rounded-full object-cover" />
                          : <div className="w-6 h-6 rounded-full bg-surface border border-border" />}
                        <div className="min-w-0 flex-1">
                          <div className="text-sm truncate flex items-center gap-1.5">
                            <span className="truncate">{p.name}</span>
                            {rich > 0 && <span className="shrink-0 text-[8px] uppercase tracking-wider text-accent2 border border-accent2/40 rounded-full px-1 py-px">contatti</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate font-mono">{p.slug}</div>
                          {(p.emails?.length || p.phones?.length) ? (
                            <div className="text-[10px] text-muted-foreground truncate flex gap-2">
                              {p.emails?.length ? <span>✉ {p.emails[0]}{p.emails.length > 1 ? ` +${p.emails.length - 1}` : ''}</span> : null}
                              {p.phones?.length ? <span>📞 {p.phones[0]}{p.phones.length > 1 ? ` +${p.phones.length - 1}` : ''}</span> : null}
                            </div>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-border">
                  {target?.linked_person_slug
                    ? <Button size="sm" variant="ghost" onClick={() => doLink(null)} disabled={linking}>Rimuovi cablaggio</Button>
                    : <span />}
                  <Button size="sm" variant="ghost" onClick={() => setLinkFor(null)} disabled={linking}>Chiudi</Button>
                </div>
              </div>
            </Card>
          </div>
        );
      })()}

      {/* Manual merge picker — user marks "mergeFor" as canonical, then picks
          the duplicate chat from the searchable list. */}
      {mergeFor && (() => {
        const canonChat = chats.find((x) => x.chat_jid === mergeFor);
        const canonName = canonChat?.sender_name ?? canonChat?.sender_phone ?? mergeFor;
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
        const canonTokens = new Set(norm(canonName).split(/\s+/).filter((t) => t.length >= 3));
        const canonPic = canonChat?.profile_pic_url ?? '';
        const canonPerson = canonChat?.person_slug ?? '';
        const canonPhone = canonChat?.sender_phone ?? '';
        const q = mergeQuery.toLowerCase().trim();
        // Score: same profile pic (huge), same person slug (huge), same phone
        // (huge), token overlap (medium).
        const candidates = chats
          .filter((c) => c.chat_jid !== mergeFor && !c.is_group)
          .map((c) => {
            const name = (c.sender_name ?? '').toLowerCase();
            const tokens = norm(name).split(/\s+/).filter((t) => t.length >= 3);
            let score = 0;
            // Same WhatsApp avatar URL ⇒ almost certainly same human.
            if (canonPic && c.profile_pic_url && canonPic === c.profile_pic_url) score += 10;
            if (canonPerson && c.person_slug && canonPerson === c.person_slug) score += 10;
            if (canonPhone && c.sender_phone && canonPhone === c.sender_phone) score += 8;
            for (const t of tokens) if (canonTokens.has(t)) score += 1;
            return { c, name, score };
          })
          .filter(({ c, name }) => {
            if (!q) return true;
            const p = (c.sender_phone ?? '').toLowerCase();
            return name.includes(q) || p.includes(q) || c.chat_jid.toLowerCase().includes(q);
          })
          .sort((a, b) => b.score - a.score)
          .map(({ c, score }) => ({ ...c, _score: score }))
          // No more 60 cap — let user scroll the full list. Search filters it.
          ;
        async function doMerge(dupJid: string) {
          if (merging) return;
          setMerging(true);
          try {
            const r: any = await api.waMergeChats(mergeFor!, [dupJid]);
            toast.push(`Unite. ${r?.touched ?? 0} messaggi spostati.`, 'on');
            setMergeFor(null);
            setMergeQuery('');
            await loadChats();
          } catch (e: any) { toast.push(e?.message ?? 'Errore unione', 'err'); }
          finally { setMerging(false); }
        }
        return (
          <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setMergeFor(null)}>
            <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
              <div className="p-4 border-b border-border">
                <div className="flex items-center gap-2 text-sm">
                  <GitMerge size={14} className="text-accent" />
                  <span className="font-semibold">Unisci chat duplicata</span>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Canonica: <span className="text-text font-medium">{canonName}</span>. Seleziona la chat duplicata da fondere qui dentro.
                </div>
                <Input
                  autoFocus
                  value={mergeQuery}
                  onChange={(e) => setMergeQuery(e.target.value)}
                  placeholder="Cerca per nome o numero…"
                  className="w-full mt-3 bg-surface2 border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </div>
              <div className="flex-1 overflow-y-auto">
                {candidates.length === 0 && <div className="text-xs text-muted-foreground text-center py-6">Nessuna chat trovata.</div>}
                {candidates.length > 0 && candidates[0]._score > 0 && !q && (
                  <div className="text-[9px] uppercase tracking-wider text-accent font-semibold px-4 pt-2 pb-1">Suggeriti — token in comune</div>
                )}
                {candidates.map((c, i) => {
                  const n = c.sender_name ?? c.sender_phone ?? c.chat_jid;
                  const suggested = c._score > 0;
                  // Separator between suggested + others when no query.
                  const showSep = !q && i > 0 && candidates[i - 1]._score > 0 && c._score === 0;
                  return (
                    <div key={c.chat_jid}>
                      {showSep && <div className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold px-4 pt-2 pb-1 border-t border-border/40">Altre chat</div>}
                      <button
                        onClick={() => doMerge(c.chat_jid)}
                        disabled={merging}
                        className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left border-b border-border/60 last:border-b-0 hover:bg-surface2/60 disabled:opacity-50 transition ${suggested ? 'bg-accent/5' : ''}`}
                      >
                        <Avatar name={n} url={c.profile_pic_url} size={32} />
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-medium flex items-center gap-1.5">
                            {n}
                            {suggested && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent border border-accent/30 uppercase tracking-wider">match</span>}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate font-mono">{c.chat_jid}</div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">{c.total_count} msg</span>
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="p-3 border-t border-border flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => setMergeFor(null)} disabled={merging}>Annulla</Button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
