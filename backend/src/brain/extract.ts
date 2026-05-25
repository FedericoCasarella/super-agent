// Telegram attachment ingestion.
// Strategy: do NOT parse binary docs server-side. Save raw file in the vault and
// hand Claude an absolute path — Claude Code's Read tool handles PDF and text
// natively. For text-ish files we also inline content into a markdown note.

import path from 'node:path';
import fs from 'node:fs/promises';
import { writeNote, getVaultRoot } from './vault.js';

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.yaml', '.yml', '.log', '.html', '.htm', '.xml', '.rtf',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.sh', '.sql', '.css', '.scss',
]);

export type ArchiveResult = {
  notePath: string;       // markdown note (relative to vault)
  rawPath: string;        // raw file (relative to vault)
  rawAbsPath: string;     // absolute path on disk
  kind: 'text' | 'pdf' | 'docx' | 'binary';
  bytes: number;
  inlineText?: string;    // included only when small text file
};

export async function archiveAttachment(
  userId: number,
  filename: string,
  buf: Buffer,
  mime: string | undefined,
): Promise<ArchiveResult> {
  const ext = path.extname(filename).toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = filename.replace(/[^a-z0-9.\-_]+/gi, '-').slice(0, 80);
  const slug = `${stamp}-${safe}`;
  const noteRel = `inbox/files/${slug}.md`;
  const rawRel = `inbox/files/raw/${slug}`;

  const root = await getVaultRoot(userId);
  if (!root) throw new Error('vault not configured');
  const rawAbs = path.join(root, rawRel);
  await fs.mkdir(path.dirname(rawAbs), { recursive: true });
  await fs.writeFile(rawAbs, buf);

  const isText = TEXT_EXT.has(ext) || (mime ?? '').startsWith('text/');
  const isPdf = ext === '.pdf' || mime === 'application/pdf';
  const isDocx = ext === '.docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const kind: ArchiveResult['kind'] = isText ? 'text' : isPdf ? 'pdf' : isDocx ? 'docx' : 'binary';

  let inlineText: string | undefined;
  if (isText) {
    inlineText = buf.toString('utf8');
  }

  const body =
    `# ${filename}\n\n` +
    `**Origine:** Telegram attachment\n` +
    `**Tipo:** ${kind}${mime ? ` (${mime})` : ''}\n` +
    `**Bytes:** ${buf.length}\n` +
    `**Raw path:** \`${rawAbs}\`\n\n` +
    `---\n\n` +
    (isText
      ? (inlineText ?? '').slice(0, 50000)
      : `_File binario. Usa lo strumento Read sull'absolute path qui sopra per analizzarlo (Claude Code supporta PDF nativamente)._`) +
    '\n';

  await writeNote(userId, noteRel, {
    kind: 'attachment',
    title: filename,
    source: 'telegram',
    file_kind: kind,
    bytes: buf.length,
    raw_path: rawRel,
    raw_abs_path: rawAbs,
    tags: ['attachment', `kind/${kind}`],
  }, body);

  return { notePath: noteRel, rawPath: rawRel, rawAbsPath: rawAbs, kind, bytes: buf.length, inlineText };
}
