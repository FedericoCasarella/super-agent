import { useState } from 'react';
import { api } from '../api';
import { Button, Chip, Field, Input, useToast } from './ui';

export type Account = {
  label: string;
  host: string;
  port?: number;
  user: string;
  pass: string;
  mailbox?: string;
  initialBacklog?: number;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFromName?: string;
  signature?: string;            // HTML signature appended to every outbound message
};

type Props = { value: Account[]; onChange: (next: Account[]) => void };

const blank: Account = { label: '', host: 'imap.gmail.com', port: 993, user: '', pass: '', mailbox: 'INBOX', initialBacklog: 0, smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false, smtpFromName: '' };

export default function AccountsEditor({ value, onChange }: Props) {
  const accounts = value ?? [];
  const [open, setOpen] = useState<number | null>(accounts.length === 0 ? -1 : null);
  const [testing, setTesting] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string }>>({});
  const [sendingTest, setSendingTest] = useState<number | null>(null);
  const toast = useToast();

  function update(i: number, patch: Partial<Account>) {
    onChange(accounts.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  }
  function remove(i: number) {
    const removed = accounts[i];
    onChange(accounts.filter((_, idx) => idx !== i));
    toast.push(`Removed ${removed?.label || 'account'}`, 'warn');
  }
  function add() {
    onChange([...accounts, { ...blank }]);
    setOpen(accounts.length);
    toast.push('Account added — fill credentials then Test', 'on');
  }

  async function test(i: number) {
    const a = accounts[i];
    setTesting(i);
    setTestResult((p) => ({ ...p, [i]: { ok: false, msg: 'testing…' } }));
    try {
      const r = await api.testImapAccount(a);
      if (r.ok) {
        setTestResult((p) => ({ ...p, [i]: { ok: true, msg: `OK · ${r.messages} msgs in ${r.mailbox}` } }));
        toast.push(`Connection OK · ${a.label || a.user} (${r.messages} messages)`, 'on');
      } else {
        setTestResult((p) => ({ ...p, [i]: { ok: false, msg: r.error } }));
        toast.push(`Connection failed: ${r.error}`, 'err');
      }
    } catch (e: any) {
      setTestResult((p) => ({ ...p, [i]: { ok: false, msg: String(e?.message ?? e) } }));
      toast.push(`Test failed: ${e?.message ?? e}`, 'err');
    } finally { setTesting(null); }
  }

  async function sendTestEmail(i: number) {
    const a = accounts[i];
    if (!a.label) { toast.push('Label richiesta', 'err'); return; }
    setSendingTest(i);
    try {
      const r = await api.emailTest(a.label);
      if (r.ok) toast.push(`Test inviato a ${r.to}`, 'on');
      else toast.push(`Errore: ${String(r.error ?? 'sconosciuto').slice(0, 200)}`, 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setSendingTest(null); }
  }

  return (
    <div className="space-y-3">
      {accounts.map((a, i) => (
        <div key={i} className="border border-border rounded-xl bg-surface2/40">
          <div className="flex items-center justify-between px-4 py-3">
            <button className="text-left flex-1" onClick={() => setOpen(open === i ? null : i)}>
              <div className="font-medium">{a.label || '(no label)'} <span className="text-muted-foreground text-xs ml-2">{a.user}</span></div>
              <div className="text-xs text-muted-foreground">{a.host}:{a.port ?? 993} · {a.mailbox || 'INBOX'}</div>
            </button>
            <Button variant="danger" size="sm" onClick={() => remove(i)}>Remove</Button>
          </div>
          {open === i && (
            <div className="px-4 pb-4 grid grid-cols-2 gap-3">
              <Field label="Label"><Input value={a.label} onChange={(e) => update(i, { label: e.target.value.replace(/[^a-z0-9_-]/gi, '-') })} placeholder="work" /></Field>
              <Field label="Mailbox"><Input value={a.mailbox ?? ''} onChange={(e) => update(i, { mailbox: e.target.value })} placeholder="INBOX" /></Field>
              <Field label="Host"><Input value={a.host} onChange={(e) => update(i, { host: e.target.value })} /></Field>
              <Field label="Port"><Input type="number" value={a.port ?? 993} onChange={(e) => update(i, { port: Number(e.target.value) })} /></Field>
              <Field label="User"><Input value={a.user} onChange={(e) => update(i, { user: e.target.value })} placeholder="you@gmail.com" /></Field>
              <Field label="Password (app password)"><Input type="password" value={a.pass} onChange={(e) => update(i, { pass: e.target.value })} /></Field>
              <div className="col-span-2"><Field label="Initial backlog (0 = only new)"><Input type="number" value={a.initialBacklog ?? 0} onChange={(e) => update(i, { initialBacklog: Number(e.target.value) })} /></Field></div>

              <div className="col-span-2 border-t border-border pt-3 mt-2">
                <div className="text-xs uppercase tracking-wider text-accent2 mb-2 font-semibold">SMTP (invio risposte)</div>
              </div>
              <Field label="SMTP host"><Input value={a.smtpHost ?? ''} onChange={(e) => update(i, { smtpHost: e.target.value })} placeholder="smtp.gmail.com" /></Field>
              <Field label="SMTP port"><Input type="number" value={a.smtpPort ?? 587} onChange={(e) => update(i, { smtpPort: Number(e.target.value) })} placeholder="587" /></Field>
              <Field label="SSL">
                <input type="checkbox" checked={!!a.smtpSecure} onChange={(e) => update(i, { smtpSecure: e.target.checked })} className="w-4 h-4 rounded border-border bg-surface2 accent-accent" />
              </Field>
              <Field label="From name (opz.)"><Input value={a.smtpFromName ?? ''} onChange={(e) => update(i, { smtpFromName: e.target.value })} placeholder="Federico Casarella" /></Field>
              <div className="col-span-2 text-[11px] text-muted-foreground">SMTP user/pass = IMAP user/pass. Lascia vuoti se uguali.</div>
              <Field label="SMTP user (override)"><Input value={a.smtpUser ?? ''} onChange={(e) => update(i, { smtpUser: e.target.value })} placeholder="(usa IMAP user)" /></Field>
              <Field label="SMTP pass (override)"><Input type="password" value={a.smtpPass ?? ''} onChange={(e) => update(i, { smtpPass: e.target.value })} placeholder="(usa IMAP pass)" /></Field>

              <div className="col-span-2 mt-3">
                <div className="text-xs uppercase tracking-wider text-accent2 mb-2 font-semibold">Firma HTML</div>
                <textarea
                  value={a.signature ?? ''}
                  onChange={(e) => update(i, { signature: e.target.value })}
                  placeholder='<p style="color:#444">— Federico Casarella<br>+39 ...</p>'
                  rows={6}
                  className="w-full bg-surface2 border border-border rounded-md p-2 text-xs font-mono outline-none focus:border-accent resize-y"
                />
                <div className="text-[10px] text-muted-foreground mt-1">Appesa al fondo di ogni email in HTML inviata da questo account.</div>
              </div>

              <div className="col-span-2 flex items-center justify-between gap-3 flex-wrap pt-2">
                <div>{testResult[i] && <Chip tone={testResult[i].ok ? 'on' : 'err'}>{testResult[i].msg}</Chip>}</div>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => test(i)} disabled={testing === i || !a.host || !a.user || !a.pass}>
                    {testing === i ? 'Testing…' : 'Test IMAP'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => sendTestEmail(i)} disabled={sendingTest === i || !a.label}>
                    {sendingTest === i ? 'Inviando…' : '📧 Invia test SMTP'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      <Button variant="ghost" className="w-full" onClick={add}>+ Add account</Button>
    </div>
  );
}
