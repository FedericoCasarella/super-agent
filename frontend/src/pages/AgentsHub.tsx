import { useSearchParams } from 'react-router-dom';
import { Button } from '../components/ui';
import { Zap, Bot } from 'lucide-react';
import { LiveAgentsPanel } from './LiveAgents';
import { CustomAgentsPanel } from './CustomAgents';

export default function AgentsHub() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') === 'custom' ? 'custom' : 'live') as 'live' | 'custom';
  const setTab = (v: 'live' | 'custom') => { const n = new URLSearchParams(sp); n.set('tab', v); setSp(n, { replace: true }); };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-gradient">Agents</h1>
      <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1 w-fit">
        <Button size="sm" variant={tab === 'live' ? 'primary' : 'ghost'} onClick={() => setTab('live')}>Live</Button>
        <Button size="sm" variant={tab === 'custom' ? 'primary' : 'ghost'} onClick={() => setTab('custom')}>Custom</Button>
      </div>
      {tab === 'live' && <LiveAgentsPanel />}
      {tab === 'custom' && <CustomAgentsPanel />}
    </div>
  );
}
