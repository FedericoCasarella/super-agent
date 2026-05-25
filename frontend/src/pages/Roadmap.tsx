import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip } from '../components/ui';
import MarkdownView from '../components/MarkdownView';
import { useI18n } from '../i18n';

export default function Roadmap() {
  const { t } = useI18n();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.callTool('agent_roadmap_get');
      setContent(r.result?.content ?? '');
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const total = (content.match(/^\s*-\s\[.\]/gm) ?? []).length;
  const done = (content.match(/^\s*-\s\[x\]/gm) ?? []).length;
  const wip = (content.match(/^\s*-\s\[~\]/gm) ?? []).length;
  const pending = (content.match(/^\s*-\s\[ \]/gm) ?? []).length;
  const blocked = (content.match(/^\s*-\s\[!\]/gm) ?? []).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-gradient">{t('roadmap.title')}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip>{total} {t('roadmap.items')}</Chip>
          <Chip tone="on">{done} {t('roadmap.done')}</Chip>
          <Chip tone="warn">{wip} {t('roadmap.wip')}</Chip>
          <Chip>{pending} {t('roadmap.pending')}</Chip>
          {blocked > 0 && <Chip tone="err">{blocked} {t('roadmap.blocked')}</Chip>}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>{loading ? '…' : t('roadmap.refresh')}</Button>
        </div>
      </div>

      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-2 bg-surface2 rounded-full overflow-hidden">
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-sm text-muted font-mono">{pct}%</div>
        </div>
        {content ? <MarkdownView content={content} /> : <div className="text-muted text-sm">{t('roadmap.empty2')}</div>}
      </Card>

      <p className="text-xs text-muted">{t('roadmap.footer')}</p>
    </div>
  );
}
