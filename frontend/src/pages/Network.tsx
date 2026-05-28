import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, Input, useToast } from '../components/ui';

type Person = {
  id: number;
  email: string;
  name: string | null;
  role: string | null;
  company: string | null;
  what: string | null;
  connection_status: 'none' | 'pending' | 'accepted' | 'blocked';
  connection_initiator: number | null;
};

function initials(p: { name: string | null; email: string }): string {
  const base = (p.name || p.email).trim();
  const parts = base.split(/\s+|@/).filter(Boolean);
  return (parts[0]?.[0] ?? '?').toUpperCase() + (parts[1]?.[0] ?? '').toUpperCase();
}
function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

type Tab = 'discover' | 'requests' | 'connected';

export default function Network() {
  const [tab, setTab] = useState<Tab>('discover');
  const [people, setPeople] = useState<Person[]>([]);
  const [peers, setPeers] = useState<any[]>([]);
  const [incomingShare, setIncomingShare] = useState<any[]>([]);
  const [outgoingShare, setOutgoingShare] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [picks, setPicks] = useState<Record<number, Set<string>>>({});
  const [reviewing, setReviewing] = useState<Set<number>>(new Set());
  const toast = useToast();

  async function load() {
    const [d, p, inc, out] = await Promise.all([
      api.netDiscover(),
      api.netPeers(),
      api.netIncoming(),
      api.netOutgoing(),
    ]);
    setPeople(d as Person[]);
    setPeers(p);
    setIncomingShare(inc);
    setOutgoingShare(out);
  }
  useEffect(() => { load(); const t = setInterval(load, 12000); return () => clearInterval(t); }, []);

  async function connect(email: string) {
    try { await api.netConnect(email); toast.push('Richiesta inviata', 'on'); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function respond(id: number, accept: boolean) {
    try { await api.netRespondConnection(id, accept); toast.push(accept ? 'Collegamento creato' : 'Rifiutato', accept ? 'on' : 'warn'); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  function togglePick(reqId: number, p: string) {
    setPicks((s) => {
      const next = new Set(s[reqId] ?? []);
      if (next.has(p)) next.delete(p); else next.add(p);
      return { ...s, [reqId]: next };
    });
  }
  function pickAll(reqId: number, paths: string[]) {
    setPicks((s) => ({ ...s, [reqId]: new Set(paths) }));
  }
  function pickSafeOnly(reqId: number, cands: any[]) {
    setPicks((s) => ({ ...s, [reqId]: new Set(cands.filter((c) => c.sensitivity !== 'high').map((c) => c.path)) }));
  }
  function clearPicks(reqId: number) {
    setPicks((s) => ({ ...s, [reqId]: new Set() }));
  }
  async function approveShare(reqId: number) {
    const paths = Array.from(picks[reqId] ?? []);
    if (!paths.length) { toast.push('Seleziona almeno 1 nota', 'warn'); return; }
    try { await api.netApproveShare(reqId, paths); toast.push(`Condivise ${paths.length} note`, 'on'); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function reviewShare(reqId: number) {
    setReviewing((s) => new Set(s).add(reqId));
    try {
      await api.netReviewShare(reqId);
      toast.push('Agente in esecuzione. La review apparirà tra qualche secondo.', 'info');
      // Poll faster than the normal 12s refresh
      setTimeout(load, 5000);
      setTimeout(load, 15000);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally {
      setTimeout(() => setReviewing((s) => { const n = new Set(s); n.delete(reqId); return n; }), 20000);
    }
  }
  async function denyShare(reqId: number) {
    const reason = prompt('Motivo (opzionale)') ?? undefined;
    try { await api.netDenyShare(reqId, reason); toast.push('Rifiutata', 'warn'); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return people;
    return people.filter((p) =>
      (p.name || '').toLowerCase().includes(s) ||
      p.email.toLowerCase().includes(s) ||
      (p.role || '').toLowerCase().includes(s) ||
      (p.company || '').toLowerCase().includes(s) ||
      (p.what || '').toLowerCase().includes(s)
    );
  }, [people, search]);

  const incomingConn = peers.filter((p) => p.status === 'pending' && p.direction === 'incoming');
  const outgoingConn = peers.filter((p) => p.status === 'pending' && p.direction === 'outgoing');
  const accepted = peers.filter((p) => p.status === 'accepted');
  const pendingShareIn = incomingShare.filter((r) => ['pending', 'reviewed'].includes(r.status));
  const requestsCount = incomingConn.length + outgoingConn.length + pendingShareIn.length;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-gradient">Network</h1>
        <p className="text-sm text-muted mt-1">Cervelli collegati. Per chiedere info al cervello di qualcuno, scrivi al tuo agente su Telegram — lui invierà la query.</p>
      </div>

      <div className="flex gap-1 bg-surface2/70 border border-border rounded-full p-1 w-fit">
        <Button size="sm" variant={tab === 'discover' ? 'primary' : 'ghost'} onClick={() => setTab('discover')}>Scopri</Button>
        <Button size="sm" variant={tab === 'requests' ? 'primary' : 'ghost'} onClick={() => setTab('requests')}>
          Richieste {requestsCount > 0 && <Chip tone="warn">{requestsCount}</Chip>}
        </Button>
        <Button size="sm" variant={tab === 'connected' ? 'primary' : 'ghost'} onClick={() => setTab('connected')}>
          Collegamenti {accepted.length > 0 && <Chip tone="on">{accepted.length}</Chip>}
        </Button>
      </div>

      {tab === 'discover' && (
        <>
          <Input placeholder="Cerca per nome, ruolo, azienda…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.length === 0 && <Card><div className="text-muted text-sm">Nessun altro cervello disponibile.</div></Card>}
            {filtered.map((p) => <PersonCard key={p.id} p={p} onConnect={() => connect(p.email)} />)}
          </div>
        </>
      )}

      {tab === 'requests' && (
        <div className="space-y-8">
          {/* Brain query requests — top priority */}
          <section>
            <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Richieste brain (peer chiedono al tuo cervello)</h2>
            {pendingShareIn.length === 0 && <Card><div className="text-muted text-sm">Nessuna richiesta brain pendente.</div></Card>}
            <ul className="space-y-3">
              {pendingShareIn.map((r) => {
                const cands: any[] = r.agent_review?.candidates ?? [];
                const summary = r.agent_review?.summary;
                return (
                  <li key={r.id} className="border border-border rounded-2xl p-4 bg-surface2/40">
                    <div className="flex items-start gap-3 mb-3">
                      <Avatar seed={r.requester?.email ?? ''} label={initials(r.requester ?? { name: null, email: '?' })} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm"><b>{r.requester?.name || r.requester?.email}</b> ti chiede:</div>
                        <div className="italic text-sm text-text/90 mt-1">"{r.query_text}"</div>
                      </div>
                      <Chip>{r.status}</Chip>
                    </div>
                    {r.status === 'pending' && (
                      <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
                        <div className="text-muted text-xs">
                          {reviewing.has(r.id)
                            ? 'Il tuo agente sta esaminando il vault… (può richiedere 30s–2min)'
                            : 'Premi qui per far esaminare al tuo agente quali note potrebbero rispondere.'}
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="danger" onClick={() => denyShare(r.id)}>Rifiuta subito</Button>
                          <Button size="sm" onClick={() => reviewShare(r.id)} disabled={reviewing.has(r.id)}>
                            {reviewing.has(r.id) ? 'In corso…' : '🤖 Esamina con agente'}
                          </Button>
                        </div>
                      </div>
                    )}
                    {r.status === 'reviewed' && (
                      <>
                        {summary && <div className="text-sm mb-3"><span className="text-muted">Sintesi del tuo agente: </span>{summary}</div>}
                        {cands.length === 0 ? (
                          <div className="text-muted text-sm">Niente di rilevante trovato nel tuo vault.</div>
                        ) : (() => {
                          const allPaths = cands.map((c: any) => c.path);
                          const hasHigh = cands.some((c: any) => c.sensitivity === 'high');
                          const selectedCount = (picks[r.id] ?? new Set()).size;
                          const selectedHigh = cands.filter((c: any) => c.sensitivity === 'high' && (picks[r.id] ?? new Set()).has(c.path)).length;
                          return (
                            <>
                              <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                                <div className="text-xs text-muted">{selectedCount}/{cands.length} selezionate</div>
                                <div className="flex gap-1 flex-wrap">
                                  <Button size="sm" variant="ghost" onClick={() => pickAll(r.id, allPaths)}>Tutte</Button>
                                  {hasHigh && <Button size="sm" variant="ghost" onClick={() => pickSafeOnly(r.id, cands)}>Solo non sensibili</Button>}
                                  <Button size="sm" variant="ghost" onClick={() => clearPicks(r.id)}>Nessuna</Button>
                                </div>
                              </div>
                              <ul className="space-y-1 mb-3">
                                {cands.map((c: any) => {
                                  const sens = c.sensitivity ?? 'low';
                                  const sensTone: any = sens === 'high' ? 'err' : sens === 'medium' ? 'warn' : 'on';
                                  const sensIcon = sens === 'high' ? '⚠️' : sens === 'medium' ? '🟡' : '🟢';
                                  return (
                                    <li key={c.path}>
                                      <label className={`flex items-start gap-2 p-2 rounded-xl border cursor-pointer transition ${
                                        sens === 'high' ? 'border-err/30 bg-err/5 hover:border-err/60' :
                                        sens === 'medium' ? 'border-warn/30 bg-warn/5 hover:border-warn/60' :
                                        'border-border/60 hover:border-accent/40'
                                      }`}>
                                        <input
                                          type="checkbox"
                                          className="mt-1"
                                          checked={(picks[r.id] ?? new Set()).has(c.path)}
                                          onChange={() => togglePick(r.id, c.path)}
                                        />
                                        <div className="flex-1 min-w-0">
                                          <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-sm font-medium truncate">{c.title || c.path}</span>
                                            <Chip tone={sensTone}>{sensIcon} {sens === 'high' ? 'sensibile' : sens === 'medium' ? 'attenzione' : 'sicura'}</Chip>
                                          </div>
                                          <div className="text-xs text-muted font-mono truncate">{c.path}</div>
                                          {c.snippet && <div className="text-xs text-muted mt-1 line-clamp-2">{c.snippet}</div>}
                                          {c.why && <div className="text-xs text-accent2 mt-1">↳ {c.why}</div>}
                                          {c.sensitivity_reason && sens !== 'low' && (
                                            <div className={`text-xs mt-1 ${sens === 'high' ? 'text-err' : 'text-warn'}`}>{sensIcon} {c.sensitivity_reason}</div>
                                          )}
                                        </div>
                                      </label>
                                    </li>
                                  );
                                })}
                              </ul>
                              {selectedHigh > 0 && (
                                <div className="text-xs text-err mb-2 px-2">⚠️ Stai per condividere {selectedHigh} nota/e marcata/e come sensibile. Verifica bene.</div>
                              )}
                            </>
                          );
                        })()}
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" variant="danger" onClick={() => denyShare(r.id)}>Rifiuta</Button>
                          <Button size="sm" onClick={() => approveShare(r.id)} disabled={!(picks[r.id]?.size)}>Approva selezione</Button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Collegamenti — in arrivo</h2>
            {incomingConn.length === 0 && <Card><div className="text-muted text-sm">Nessuna richiesta di collegamento.</div></Card>}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {incomingConn.map((p) => (
                <RequestCard key={p.connection_id} peer={p.peer} kind="incoming" onAccept={() => respond(p.connection_id, true)} onBlock={() => respond(p.connection_id, false)} />
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Collegamenti — in uscita</h2>
            {outgoingConn.length === 0 && <Card><div className="text-muted text-sm">Nessuna richiesta in uscita.</div></Card>}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {outgoingConn.map((p) => <RequestCard key={p.connection_id} peer={p.peer} kind="outgoing" />)}
            </div>
          </section>

          {/* Mie query in uscita (storico) */}
          {outgoingShare.length > 0 && (
            <section>
              <h2 className="text-sm uppercase tracking-wider text-muted mb-3">Mie query brain (storico)</h2>
              <ul className="space-y-2">
                {outgoingShare.map((r) => (
                  <li key={r.id} className="border border-border rounded-2xl p-3 bg-surface2/40 text-sm">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="font-medium">{r.target?.name || r.target?.email}</span>
                      <Chip tone={r.status === 'delivered' ? 'on' : r.status === 'denied' ? 'err' : 'default'}>{r.status}</Chip>
                    </div>
                    <div className="italic text-muted">"{r.query_text}"</div>
                    {r.reason && <div className="text-xs text-err mt-1">{r.reason}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      {tab === 'connected' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {accepted.length === 0 && <Card><div className="text-muted text-sm">Nessun collegamento ancora.</div></Card>}
          {accepted.map((p) => <ConnectedCard key={p.connection_id} peer={p.peer} />)}
        </div>
      )}
    </div>
  );
}

function Avatar({ seed, label, size = 56 }: { seed: string; label: string; size?: number }) {
  const h = hueFor(seed);
  const bg = `linear-gradient(135deg, hsl(${h}, 70%, 55%), hsl(${(h + 40) % 360}, 70%, 45%))`;
  return (
    <div
      className="rounded-2xl flex items-center justify-center text-white font-semibold shrink-0 ring-1 ring-white/15 shadow-lg"
      style={{ width: size, height: size, background: bg, fontSize: size * 0.4 }}
    >
      {label}
    </div>
  );
}

function PersonCard({ p, onConnect }: { p: Person; onConnect: () => void }) {
  const status = p.connection_status;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Avatar seed={p.email} label={initials(p)} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{p.name || p.email.split('@')[0]}</div>
          <div className="text-xs text-muted truncate">{p.email}</div>
          {(p.role || p.company) && (
            <div className="text-xs text-accent2 mt-1 truncate">{[p.role, p.company].filter(Boolean).join(' · ')}</div>
          )}
        </div>
      </div>
      {p.what && <p className="text-sm text-muted mt-3 line-clamp-3">{p.what}</p>}
      <div className="mt-4">
        {status === 'accepted' && <Chip tone="on">✓ Collegato</Chip>}
        {status === 'pending' && <Chip tone="warn">In attesa</Chip>}
        {status === 'blocked' && <Chip tone="err">Bloccato</Chip>}
        {status === 'none' && (
          <Button size="sm" className="w-full" onClick={onConnect}>+ Richiedi collegamento</Button>
        )}
      </div>
    </Card>
  );
}

function RequestCard({ peer, kind, onAccept, onBlock }: { peer: any; kind: 'incoming' | 'outgoing'; onAccept?: () => void; onBlock?: () => void }) {
  if (!peer) return null;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Avatar seed={peer.email} label={initials(peer)} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{peer.name || peer.email.split('@')[0]}</div>
          <div className="text-xs text-muted truncate">{peer.email}</div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        {kind === 'incoming' ? (
          <>
            <Button size="sm" onClick={onAccept}>Accetta</Button>
            <Button size="sm" variant="ghost" onClick={onBlock}>Ignora</Button>
          </>
        ) : (
          <Chip tone="warn">In attesa di risposta</Chip>
        )}
      </div>
    </Card>
  );
}

function ConnectedCard({ peer }: { peer: any }) {
  if (!peer) return null;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <Avatar seed={peer.email} label={initials(peer)} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{peer.name || peer.email.split('@')[0]}</div>
          <div className="text-xs text-muted truncate">{peer.email}</div>
          <div className="mt-2"><Chip tone="on">✓ Collegato</Chip></div>
        </div>
      </div>
      <div className="text-xs text-muted mt-3">
        Per chiedere al suo cervello, scrivi al tuo agente su Telegram (es. "chiedi a {peer.name || peer.email} info su X").
      </div>
    </Card>
  );
}
