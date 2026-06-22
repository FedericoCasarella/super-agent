import { useEffect, useRef, useState } from 'react';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';

// Letter-scroll (scramble) reveal: on text change every glyph spins through
// random characters, settling left→right into the final phrase. Spaces stay
// fixed so word shape is preserved during the roll.
function ScrambleText({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = useState(text);
  const rafRef = useRef<number>(0);
  useEffect(() => {
    const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789àèéìòù';
    const DURATION = 26; // frames (~0.9s @ ~30 effective steps)
    let f = 0;
    const run = () => {
      f++;
      const revealed = (f / DURATION) * text.length;
      let out = '';
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ' ' || i < revealed) out += ch;
        else out += pool[(Math.random() * pool.length) | 0];
      }
      setDisplay(out);
      if (f < DURATION) rafRef.current = requestAnimationFrame(run);
      else setDisplay(text);
    };
    rafRef.current = requestAnimationFrame(run);
    return () => cancelAnimationFrame(rafRef.current);
  }, [text]);
  return <span className={className}>{display}</span>;
}

type Props = {
  size?: number;          // px, square
  label?: string | null;  // optional caption under
  className?: string;
  inline?: boolean;       // render inline-flex instead of full-width center
  messages?: string[];    // if set, cycle through these every 8s (bigger text)
};

export default function BrainLoading({ size = 80, label = null, className = '', inline = false, messages }: Props) {
  const wrap = inline
    ? `inline-flex items-center gap-2 ${className}`
    : `flex flex-col items-center justify-center gap-3 ${className}`;
  const rotate = !!messages && messages.length > 0;
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!rotate || messages!.length <= 1) return;
    const iv = setInterval(() => setIdx((i) => (i + 1) % messages!.length), 8000);
    return () => clearInterval(iv);
  }, [rotate, messages]);
  const caption = rotate ? messages![idx] : label;
  return (
    <div className={wrap}>
      <DotLottieReact
        src="/Loading.lottie"
        loop
        autoplay
        style={{ width: size, height: size }}
      />
      {caption != null && (
        rotate
          ? <ScrambleText text={caption} className="text-lg sm:text-xl font-medium text-foreground/90 text-center" />
          : <span className="text-xs text-muted-foreground">{caption}</span>
      )}
    </div>
  );
}
