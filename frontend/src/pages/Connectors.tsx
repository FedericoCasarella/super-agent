import { useEffect, useState } from 'react';
import { api } from '../api';
import AccountsEditor from '../components/AccountsEditor';
import { Button, Card, Chip, Field, Input, Toggle, useToast } from '../components/ui';

export default function Connectors() {
  const [items, setItems] = useState<any[]>([]);
  const [externals, setExternals] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});

  const toast = useToast();

  async function load() {
    const [conns, exts] = await Promise.all([api.connectors(), api.externalMcps().catch(() => [])]);
    setItems(conns); setExternals(exts);
  }
  useEffect(() => { load(); }, []);
  async function refreshExt() { setExternals(await api.externalMcps(true)); toast.push('External MCPs refreshed', 'on'); }

  async function toggle(name: string, enabled: boolean) {
    await api.updateConnector(name, { enabled });
    toast.push(`${name} ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'on' : 'warn');
    load();
  }
  async function save(name: string) {
    await api.updateConnector(name, { config: draft });
    setEditing(null);
    toast.push(`${name} config saved`, 'on');
    load();
  }
  async function run(name: string) {
    await api.runConnector(name);
    toast.push(`${name} tick started`, 'info');
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Connectors</h1>
      <p className="text-muted text-sm">Native plugins (super-agent built-in). Drop a folder in <code className="font-mono text-text">backend/src/connectors/builtin/</code> to add more.</p>
      <h2 className="text-sm uppercase text-muted tracking-wider mt-2">Native</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((c) => (
          <Card key={c.manifest.name}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{c.manifest.title}</h3>
                  <Chip>{c.manifest.name}</Chip>
                </div>
                <p className="text-sm text-muted mt-1">{c.manifest.description}</p>
                {c.manifest.schedule && <div className="text-xs text-muted mt-2">schedule: <span className="font-mono">{c.manifest.schedule}</span></div>}
              </div>
              <Toggle checked={c.enabled} onChange={(v) => toggle(c.manifest.name, v)} />
            </div>

            {editing === c.manifest.name ? (
              <div className="mt-4 space-y-3">
                {c.manifest.configSchema.map((f: any) => (
                  <Field key={f.key} label={f.label}>
                    {f.type === 'accounts' ? (
                      <AccountsEditor value={draft[f.key] ?? []} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                    ) : (
                      <Input
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        placeholder={f.placeholder}
                        value={draft[f.key] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  <Button onClick={() => save(c.manifest.name)}>Save</Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex gap-2">
                {c.manifest.configSchema.length > 0 && (
                  <Button variant="ghost" onClick={() => { setEditing(c.manifest.name); setDraft(c.config ?? {}); }}>Configure</Button>
                )}
                <Button variant="ghost" onClick={() => run(c.manifest.name)}>Run now</Button>
              </div>
            )}
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between mt-8">
        <div>
          <h2 className="text-sm uppercase text-muted tracking-wider">Claude Code MCP (external)</h2>
          <p className="text-xs text-muted">Servers configured globally in Claude Code. Managed via <code className="font-mono text-text">claude mcp</code> CLI.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={refreshExt}>Refresh</Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {externals.length === 0 && <Card><div className="text-muted text-sm">None detected.</div></Card>}
        {externals.map((e) => (
          <Card key={e.serverName}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{e.rawName}</div>
                <div className="text-xs text-muted font-mono truncate max-w-[26rem]">{e.url}</div>
              </div>
              <Chip tone={e.status === 'connected' ? 'on' : e.status === 'needs_auth' ? 'warn' : 'err'}>
                {e.status === 'connected' ? 'connected' : e.status === 'needs_auth' ? 'needs auth' : 'error'}
              </Chip>
            </div>
            <div className="text-xs text-muted mt-2 font-mono">mcp__{e.serverName}__*</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
