// =====================================================================
// Quota lock — when Claude session usage >= 95%, freeze all mutating
// operations (chat replies, bonifica, AI suggestion, agent runs, sticker
// sends, etc.) so the user doesn't burn the last 5% on partial work that
// would corrupt the brain.
//
// Single source of truth is `usageCache` populated by GET /usage. Whichever
// endpoint hits first writes it; every other endpoint reads via
// `isQuotaLocked()`. UI also reads via /usage so the badge + banner stay in
// sync.
// =====================================================================

const LOCK_THRESHOLD_PCT = 95;

// Mutable state — owned by /usage handler, queried from everywhere else.
let lastUsage: { ts: number; sessionPct: number; weekPct?: number } | null = null;

export function recordUsage(sessionPct: number, weekPct?: number): void {
  lastUsage = { ts: Date.now(), sessionPct, weekPct };
}

export function getLastUsage(): { ts: number; sessionPct: number; weekPct?: number } | null {
  return lastUsage;
}

export function isQuotaLocked(): boolean {
  if (!lastUsage) return false;
  return lastUsage.sessionPct >= LOCK_THRESHOLD_PCT;
}

// Standard error response object — frontend matches `code === 'quota_locked'`
// to show the persistent red banner.
export const QUOTA_LOCK_ERROR = {
  code: 'quota_locked',
  error: 'Hai raggiunto il limite del tuo piano Claude. Per evitare perdite di dati o risposte incomplete il sistema è in stato di fermo fino al rinnovo del piano.',
} as const;

// Express-style guard for any route that triggers Claude calls or expensive
// writes. Usage: `router.post('/foo', quotaGuard, async (req, res) => {…})`.
export function quotaGuard(_req: any, res: any, next: any) {
  if (isQuotaLocked()) {
    return res.status(423).json(QUOTA_LOCK_ERROR);
  }
  next();
}
