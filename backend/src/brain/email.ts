import { convert } from 'html-to-text';
import type { ParsedMail, AddressObject } from 'mailparser';
import { writeNote } from './vault.js';
import { upsertPerson } from '../connectors/builtin/people/index.js';

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: 100,
    selectors: [
      { selector: 'a', options: { ignoreHref: false, hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'tracking-pixel', format: 'skip' },
    ],
  }).replace(/\n{3,}/g, '\n\n').trim();
}

export function emailBodyText(parsed: ParsedMail): string {
  if (parsed.text && parsed.text.trim().length > 40) return parsed.text.trim();
  if (parsed.html) return htmlToText(parsed.html);
  return parsed.text ?? '';
}

function flattenAddresses(a: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  const out: { name: string; address: string }[] = [];
  for (const obj of arr) {
    for (const v of obj.value ?? []) {
      if (!v.address) continue;
      out.push({ name: v.name || v.address.split('@')[0], address: v.address.toLowerCase() });
    }
  }
  return out;
}

export type EmailIngestInput = {
  userId: number;
  accountLabel: string;
  uid: number;
  parsed: ParsedMail;
};

export async function ingestEmail({ userId, accountLabel, uid, parsed }: EmailIngestInput) {
  const subj = parsed.subject ?? '(no subject)';
  const date = (parsed.date ?? new Date()).toISOString();
  const from = flattenAddresses(parsed.from);
  const to = flattenAddresses(parsed.to);
  const cc = flattenAddresses(parsed.cc);
  const all = [...from, ...to, ...cc];

  const personLinks: string[] = [];
  for (const p of all) {
    try {
      const { slug } = await upsertPerson(userId, {
        name: p.name,
        emails: [p.address],
        note: `Seen in email "${subj}" on ${date.slice(0, 10)} (${accountLabel})`,
      });
      personLinks.push(`[[people/${slug}]]`);
    } catch {}
  }

  const body = emailBodyText(parsed).slice(0, 8000);
  const fromStr = from.map((f) => `${f.name} <${f.address}>`).join(', ') || 'unknown';
  const toStr = to.map((f) => `${f.name} <${f.address}>`).join(', ');
  const slug = `${date.slice(0,10)}-${subj.replace(/[^a-z0-9]+/gi,'-').slice(0,40)}-${uid}`;

  const md =
    `# ${subj}\n\n` +
    `**Account:** ${accountLabel}\n` +
    `**From:** ${fromStr}\n` +
    (toStr ? `**To:** ${toStr}\n` : '') +
    `**Date:** ${date}\n\n` +
    (personLinks.length ? `**People:** ${[...new Set(personLinks)].join(' ')}\n\n` : '') +
    `---\n\n${body}\n`;

  await writeNote(
    userId,
    `inbox/email/${accountLabel}/${slug}.md`,
    {
      kind: 'email',
      title: subj,
      account: accountLabel,
      uid,
      from: from.map((f) => f.address),
      to: to.map((f) => f.address),
      cc: cc.map((f) => f.address),
      date,
      tags: ['email', `account/${accountLabel}`],
    },
    md
  );

  return { subj, from: fromStr, date, people: personLinks };
}
