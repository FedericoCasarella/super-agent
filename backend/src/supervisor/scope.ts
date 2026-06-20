// Quali task entrano nel supervisore (digest + nudge). Solo lavoro attivo:
// niente clienti chiusi (🔴) né liste interne del team. Tiene 🟢/🟠 e Task|Marco.
import type { ClickUpTask } from '../clickup/client.js';

const EXCLUDE_LIST = [/Team Shopify Dev/i];

export function isSupervised(t: ClickUpTask): boolean {
  const n = t.list?.name ?? '';
  if (n.startsWith('🔴')) return false;            // clienti chiusi / ex (accesso revocato)
  if (EXCLUDE_LIST.some((re) => re.test(n))) return false;
  return true;
}

export function supervised(tasks: ClickUpTask[]): ClickUpTask[] {
  return tasks.filter(isSupervised);
}
