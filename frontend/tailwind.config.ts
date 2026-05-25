import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0c',
        surface: '#13131a',
        surface2: '#1b1b25',
        border: '#272733',
        muted: '#7a7a8c',
        text: '#e8e8f0',
        accent: '#c084fc',
        accent2: '#22d3ee',
        ok: '#34d399',
        warn: '#fbbf24',
        err: '#f87171',
      },
      borderRadius: {
        xl2: '1.25rem',
        xl3: '1.75rem',
        '4xl': '2.5rem',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'fade-in':    { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'slide-up':   { '0%': { opacity: '0', transform: 'translateY(16px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'soft-pulse': { '0%,100%': { opacity: '0.7', transform: 'scale(1)' }, '50%': { opacity: '1', transform: 'scale(1.06)' } },
        'spin-slow':  { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
        'glow':       { '0%,100%': { boxShadow: '0 0 0 0 rgba(192,132,252,0.15)' }, '50%': { boxShadow: '0 0 24px 4px rgba(192,132,252,0.35)' } },
        'shimmer':    { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
      },
      animation: {
        'fade-in':    'fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up':   'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        'soft-pulse': 'soft-pulse 3.5s ease-in-out infinite',
        'spin-slow':  'spin-slow 22s linear infinite',
        'glow':       'glow 4s ease-in-out infinite',
        'shimmer':    'shimmer 2.4s linear infinite',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
} satisfies Config;
