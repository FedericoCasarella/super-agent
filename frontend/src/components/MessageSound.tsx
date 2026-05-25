import { useEffect, useRef } from 'react';
import { api } from '../api';
import { useWS } from '../ws';

// Mounts a hidden audio element and plays a chime each time a Telegram
// message comes IN (direction === 'in'). Respects the per-user setting
// `sound_on_message` (default true).
export default function MessageSound() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const enabledRef = useRef(true);

  useEffect(() => {
    let mounted = true;
    api.settings()
      .then((s) => { if (mounted) enabledRef.current = s?.sound_on_message !== false; })
      .catch(() => {});
    // Refresh every 30s in case user toggles it on another tab
    const t = setInterval(() => {
      api.settings()
        .then((s) => { enabledRef.current = s?.sound_on_message !== false; })
        .catch(() => {});
    }, 30000);
    return () => { mounted = false; clearInterval(t); };
  }, []);

  useWS((msg) => {
    if (msg.type !== 'message') return;
    if (msg.payload?.direction !== 'in') return;
    if (!enabledRef.current) return;
    const el = audioRef.current;
    if (!el) return;
    try {
      el.currentTime = 0;
      el.volume = 0.6;
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
  });

  return (
    <audio
      ref={audioRef}
      preload="auto"
      src="/sounds/universfield-system-notification-02-352442.mp3"
    />
  );
}
