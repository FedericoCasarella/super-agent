import { DotLottieReact } from '@lottiefiles/dotlottie-react';

type Props = {
  size?: number;          // px, square
  label?: string | null;  // optional caption under
  className?: string;
  inline?: boolean;       // render inline-flex instead of full-width center
};

export default function BrainLoading({ size = 80, label = null, className = '', inline = false }: Props) {
  const wrap = inline
    ? `inline-flex items-center gap-2 ${className}`
    : `flex flex-col items-center justify-center gap-2 ${className}`;
  return (
    <div className={wrap}>
      <DotLottieReact
        src="/brain-loading.lottie"
        loop
        autoplay
        style={{ width: size, height: size }}
      />
      {label != null && <span className="text-xs text-muted">{label}</span>}
    </div>
  );
}
