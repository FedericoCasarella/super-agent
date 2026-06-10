import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1400px' } },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        // Legacy aliases — kept so unmigrated pages still compile while we
        // roll out shadcn migration. New code: use semantic tokens above.
        bg: 'hsl(var(--background))',
        surface: 'hsl(var(--card))',
        surface2: 'hsl(var(--muted))',
        text: 'hsl(var(--foreground))',
        accent2: 'hsl(var(--accent-2))',
        ok: 'hsl(var(--success))',
        warn: 'hsl(var(--warning))',
        err: 'hsl(var(--destructive))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl2: '1.25rem',
        xl3: '1.75rem',
        '4xl': '2.5rem',
      },
      fontFamily: {
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['GeistMono', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, hsl(var(--primary)) 0%, hsl(var(--accent-2)) 100%)',
        'gradient-primary-soft': 'linear-gradient(135deg, hsl(var(--primary) / 0.15) 0%, hsl(var(--accent-2) / 0.15) 100%)',
      },
      keyframes: {
        'fade-in':         { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'slide-up':        { '0%': { opacity: '0', transform: 'translateY(16px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'soft-pulse':      { '0%,100%': { opacity: '0.7', transform: 'scale(1)' }, '50%': { opacity: '1', transform: 'scale(1.06)' } },
        'spin-slow':       { '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } },
        'shimmer':         { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        'accordion-down':  { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up':    { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'mail-sync':       { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(300%)' } },
      },
      animation: {
        'fade-in':         'fade-in 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up':        'slide-up 0.45s cubic-bezier(0.16, 1, 0.3, 1) both',
        'soft-pulse':      'soft-pulse 3.5s ease-in-out infinite',
        'spin-slow':       'spin-slow 22s linear infinite',
        'shimmer':         'shimmer 2.4s linear infinite',
        'accordion-down':  'accordion-down 0.2s ease-out',
        'accordion-up':    'accordion-up 0.2s ease-out',
        'mail-sync':       'mail-sync 1.1s linear infinite',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
