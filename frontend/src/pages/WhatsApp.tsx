import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useWS } from '../ws';
import { Users, MessageCircle, RefreshCw, Sparkles, UserCog } from 'lucide-react';

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
};

type Msg = {
  id: number; msg_id: string; chat_jid: string; sender_jid: string;
  sender_phone: string | null; sender_name: string | null; person_slug: string | null;
  is_group: boolean; group_jid: string | null;
  from_me: boolean; text: string; ts: string;
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

function avatarColor(s: string): string {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360}, 60%, 55%)`;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase();
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
  const [bonifying, setBonifying] = useState(false);
  const [bonifyProgress, setBonifyProgress] = useState<{ total: number; toolCalls: number; onlyChat: string | null; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const streamRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  async function loadPending() { try { const r = await api.waPending(); setPending(r.count ?? 0); } catch {} }
  async function bonify(onlyChat?: string) {
    const label = onlyChat ? `questa chat` : `${Math.min(pending, 100)} messaggi`;
    if (!confirm(`Lanciare bonifica su ${label}? L'agente classificherà + aggiornerà People + Brain.`)) return;
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

  async function loadChats() { try { setChats(await api.waChats()); } catch {} }
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
    if (msg.type === 'wa:bonify') {
      const p = msg.payload;
      if (p.kind === 'start') {
        setBonifyProgress({ total: p.total, toolCalls: 0, onlyChat: p.onlyChat, startedAt: Date.now() });
      } else if (p.kind === 'done') {
        setBonifyProgress(null);
        toast.push(`Bonifica completata: ${p.processed} msg · $${Number(p.cost ?? 0).toFixed(4)} · ${Math.round((p.durationMs ?? 0) / 1000)}s`, 'on');
        loadPending(); loadChats();
      } else if (p.kind === 'error') {
        setBonifyProgress(null);
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
          <Chip tone="on"><span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 animate-pulse" />live</Chip>
          {pending > 0 && <Chip tone="warn">{pending} da bonificare</Chip>}
          <Button size="sm" variant="ghost" onClick={refreshContacts} disabled={refreshingContacts}>
            <UserCog size={14} className={`inline mr-1.5 -mt-0.5 ${refreshingContacts ? 'animate-spin' : ''}`} />
            {refreshingContacts ? 'Contatti…' : 'Aggiorna contatti'}
          </Button>
          <Button size="sm" variant="ghost" onClick={sync} disabled={syncing}>
            <RefreshCw size={14} className={`inline mr-1.5 -mt-0.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Sincronizzo…' : 'Sincronizza chat'}
          </Button>
          <Button size="sm" onClick={() => bonify()} disabled={bonifying || pending === 0}>
            <Sparkles size={14} className="inline mr-1.5 -mt-0.5" />
            {bonifying ? 'Lancio…' : `Bonifica (${Math.min(pending, 100)})`}
          </Button>
        </div>
      </div>

      {bonifyProgress && (
        <Card className="border-accent/40 bg-accent/5 flex items-center gap-4 flex-wrap p-3">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles size={16} className="animate-pulse text-accent" />
            <span className="font-semibold">Bonifica in corso</span>
            {bonifyProgress.onlyChat && <Chip>{chats.find((c) => c.chat_jid === bonifyProgress.onlyChat)?.sender_name ?? bonifyProgress.onlyChat}</Chip>}
          </div>
          <div className="flex-1 min-w-[200px]">
            <div className="h-2 rounded-full bg-surface2/60 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-accent to-accent2 animate-pulse" style={{ width: '100%' }} />
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-muted">
            <span>{bonifyProgress.total} msg</span>
            <span>{bonifyProgress.toolCalls} tool calls</span>
            <span>{elapsed}s</span>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0 h-[78vh] max-h-[78vh]">
        {/* Chats sidebar */}
        <Card className="col-span-12 md:col-span-4 lg:col-span-3 p-0 overflow-hidden flex flex-col h-full max-h-[78vh]">
          <div className="p-3 border-b border-border text-xs uppercase tracking-wider text-muted font-semibold flex items-center gap-2">
            <MessageCircle size={14} /> {chats.length} chat
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats.length === 0 && <div className="p-4 text-muted text-sm">Nessun messaggio ancora. Configura WhatsApp in Connettori.</div>}
            {chats.map((c) => {
              const name = c.sender_name || c.sender_phone || c.chat_jid;
              const active = selected === c.chat_jid;
              return (
                <button
                  key={c.chat_jid}
                  onClick={() => setSelected(c.chat_jid)}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-3 border-b border-border/60 transition ${active ? 'bg-accent/10' : 'hover:bg-surface2/40'}`}
                >
                  <div className="w-10 h-10 rounded-full flex items-center justify-center font-semibold text-xs text-white shrink-0" style={{ background: avatarColor(name) }}>
                    {c.is_group ? <Users size={16} /> : initials(name)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate text-sm">{name}</span>
                      <span className="text-[10px] text-muted shrink-0">{fmtTime(c.ts)}</span>
                    </div>
                    <div className="text-xs text-muted truncate flex items-center gap-1.5">
                      <span className="truncate flex-1">{c.text || '…'}</span>
                      {c.total_count > 0 && c.pending_count === 0 && (
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">✓ bonificata</span>
                      )}
                      {c.pending_count > 0 && c.bonified_count > 0 && (
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-400/30">{c.bonified_count}/{c.total_count}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        {/* Chat view */}
        <Card className="col-span-12 md:col-span-8 lg:col-span-9 p-0 overflow-hidden flex flex-col h-full max-h-[78vh]">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-muted text-sm">
              Seleziona una chat per visualizzare i messaggi.
            </div>
          ) : (
            <>
              {(() => {
                const c = chats.find((x) => x.chat_jid === selected);
                const name = c?.sender_name || c?.sender_phone || selected;
                return (
                  <div className="p-3 border-b border-border flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center font-semibold text-xs text-white" style={{ background: avatarColor(name) }}>
                      {c?.is_group ? <Users size={14} /> : initials(name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{name}</div>
                      <div className="text-[10px] text-muted font-mono truncate">{selected}</div>
                    </div>
                    {c?.person_slug && <Chip tone="accent">{c.person_slug}</Chip>}
                    {c && c.total_count > 0 && c.pending_count === 0 && <Chip tone="on">✓ bonificata</Chip>}
                    {c && c.pending_count > 0 && c.bonified_count > 0 && <Chip tone="warn">{c.bonified_count}/{c.total_count}</Chip>}
                    {c && c.pending_count > 0 && c.bonified_count === 0 && <Chip>nuova</Chip>}
                    <Button size="sm" variant="ghost" disabled={bonifying} onClick={() => bonify(selected)}>
                      <Sparkles size={13} className="inline mr-1 -mt-0.5" />Bonifica chat
                    </Button>
                  </div>
                );
              })()}
              <div ref={streamRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-gradient-to-b from-surface2/20 to-transparent">
                {loading && <div className="text-muted text-sm text-center">Caricamento…</div>}
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.from_me ? 'bg-accent/20 border border-accent/30 rounded-br-md' : 'bg-surface2 border border-border rounded-bl-md'}`}>
                      {m.is_group && !m.from_me && m.sender_name && (
                        <div className="text-[10px] font-semibold text-accent2 mb-0.5">{m.sender_name}</div>
                      )}
                      <div className="whitespace-pre-wrap">{m.text || <span className="text-muted italic">(empty)</span>}</div>
                      <div className="text-[9px] text-muted mt-1 text-right">{fmtAgo(m.ts)} fa</div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
