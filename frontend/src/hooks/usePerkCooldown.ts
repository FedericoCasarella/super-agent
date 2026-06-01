import { useEffect, useState, useCallback } from 'react';

// Shared cooldown for perk (internal-agent) runs.
// Stored in localStorage so the lock persists across navigation (Agents <-> AgentDetail), reloads, and tabs.
const STORAGE_KEY = 'perk_cooldowns_v1';
const DEFAULT_SECONDS = 60;
const STORAGE_EVENT = 'perk_cooldowns_changed';

type Map = Record<string, number>; // name -> expiry timestamp (ms)

function read(): Map {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    // Drop expired entries on read so callers never see stale data.
    const now = Date.now();
    const out: Map = {};
    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
      const ts = Number(v);
      if (Number.isFinite(ts) && ts > now) out[k] = ts;
    }
    return out;
  } catch { return {}; }
}

function write(map: Map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
  try { window.dispatchEvent(new CustomEvent(STORAGE_EVENT)); } catch {}
}

export function usePerkCooldown(seconds = DEFAULT_SECONDS) {
  // Force re-render every second to keep `left()` counters fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) | 0), 1000);
    const onChange = () => setTick((n) => (n + 1) | 0);
    window.addEventListener(STORAGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => { clearInterval(id); window.removeEventListener(STORAGE_EVENT, onChange); window.removeEventListener('storage', onChange); };
  }, []);

  // Always read fresh from localStorage — never trust stale state captured at mount.
  const left = useCallback((name: string): number => {
    const ts = read()[name];
    if (!ts) return 0;
    return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  }, []);

  const start = useCallback((name: string, secs = seconds) => {
    const cur = read();
    cur[name] = Date.now() + secs * 1000;
    write(cur);
    setTick((n) => (n + 1) | 0);
  }, [seconds]);

  const clear = useCallback((name: string) => {
    const cur = read();
    if (!(name in cur)) return;
    delete cur[name];
    write(cur);
    setTick((n) => (n + 1) | 0);
  }, []);

  return { left, start, clear };
}
