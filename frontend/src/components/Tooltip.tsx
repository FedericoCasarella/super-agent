import { useState, useRef, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
};

export default function Tooltip({ content, children, side = 'top', delay = 250, className = '' }: Props) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; placement: 'top' | 'bottom' | 'left' | 'right' }>({ x: 0, y: 0, placement: side });

  function compute() {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let placement = side;
    let x = r.left + r.width / 2;
    let y = r.top - pad;
    if (side === 'bottom') { y = r.bottom + pad; }
    else if (side === 'left') { x = r.left - pad; y = r.top + r.height / 2; }
    else if (side === 'right') { x = r.right + pad; y = r.top + r.height / 2; }
    // Flip if outside viewport
    if (placement === 'top' && y < 16) { placement = 'bottom'; y = r.bottom + pad; }
    setPos({ x, y, placement });
  }
  function open() {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { compute(); setShow(true); }, delay);
  }
  function close() {
    if (timer.current) window.clearTimeout(timer.current);
    setShow(false);
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const transform =
    pos.placement === 'top' ? 'translate(-50%, -100%)' :
    pos.placement === 'bottom' ? 'translate(-50%, 0)' :
    pos.placement === 'left' ? 'translate(-100%, -50%)' :
    'translate(0, -50%)';

  return (
    <>
      <span ref={ref} className={`inline-flex ${className}`} onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}>
        {children}
      </span>
      {show && createPortal(
        <div
          role="tooltip"
          className="fixed z-[200] pointer-events-none"
          style={{ left: pos.x, top: pos.y, transform }}
        >
          <div className="max-w-xs rounded-lg border border-border bg-bg/95 backdrop-blur px-2.5 py-1.5 text-xs text-text shadow-xl ring-1 ring-white/5">
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
