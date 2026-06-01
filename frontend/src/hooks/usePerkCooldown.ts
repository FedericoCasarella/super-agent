import { useEffect, useState, useCallback } from 'react';

// Shared cooldown for perk (internal-agent) runs.
// Stored in localStorage so the lock persists across navigation (Agents <-> AgentDetail) and reloads.
const STORAGE_KEY = 'perk_cooldowns_v1';
const DEFAULT_SECONDS = 60;
const STORAGE_EVENT = 'perk_cooldowns_changed';

type Map = Record<string, number>; // name -> expiry timestamp (ms)

function read(): Map {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Map; }
  catch { return {}; }
}

function write(map: Map) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch {}
  // Notify same-tab subscribers (storage event only fires across tabs)
  try { window.dispatchEvent(new CustomEvent(STORAGE_EVENT)); } catch {}
}

export function usePerkCooldown(seconds = DEFAULT_SECONDS) {
  const [map, setMap] = useState<Map>(() => read());

  // Tick every second + listen for cross-component writes
  useEffect(() => {
    const tick = setInterval(() => {
      setMap((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Map = {};
        for (const [k, ts] of Object.entries(prev)) {
          if (ts > now) next[k] = ts;
          else changed = true;
        }
        if (changed) write(next);
        return changed ? next : prev;
      });
    }, 1000);
    const onChange = () => setMap(read());
    window.addEventListener(STORAGE_EVENT, onChange);
    window.addEventListener('storage', onChange);
    return () => { clearInterval(tick); window.removeEventListener(STORAGE_EVENT, onChange); window.removeEventListener('storage', onChange); };
  }, []);

  const left = useCallback((name: string): number => {
    const ts = map[name];
    if (!ts) return 0;
    return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  }, [map]);

  const start = useCallback((name: string, secs = seconds) => {
    const next = { ...read(), [name]: Date.now() + secs * 1000 };
    write(next);
    setMap(next);
  }, [seconds]);

  const clear = useCallback((name: string) => {
    const cur = read();
    if (!(name in cur)) return;
    delete cur[name];
    write(cur);
    setMap(cur);
  }, []);

  return { left, start, clear };
}
