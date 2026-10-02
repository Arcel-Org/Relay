import type { Config } from "tailwindcss"

const config = {
  darkMode: "class",
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Arcel Relay — themeable via CSS variables (see globals.css)
        // Tokens used with Tailwind opacity modifiers (e.g. bg-relay-accent/30)
        // are stored as "R G B" triplets in CSS vars; others are raw color values.
        'relay-bg': 'rgb(var(--relay-bg) / <alpha-value>)',
        'relay-surface': 'rgb(var(--relay-surface) / <alpha-value>)',
        'relay-surface-hover': 'var(--relay-surface-hover)',
        'relay-elevated': 'var(--relay-elevated)',
        'relay-border': 'var(--relay-border)',
        'relay-border-light': 'var(--relay-border-light)',
        'relay-accent': 'rgb(var(--relay-accent) / <alpha-value>)',
        'relay-accent-foreground': 'var(--relay-accent-foreground)',
        'relay-accent-muted': 'rgb(var(--relay-accent-muted) / <alpha-value>)',
        'relay-success': 'var(--relay-success)',
        'relay-danger': 'rgb(var(--relay-danger) / <alpha-value>)',
        'relay-text-primary': 'var(--relay-text-primary)',
        'relay-text-secondary': 'var(--relay-text-secondary)',
        'relay-text-muted': 'rgb(var(--relay-text-muted) / <alpha-value>)',
      },
      fontFamily: {
        'geist-sans': ['var(--font-geist-sans)', 'system-ui', 'sans-serif'],
        'geist-mono': ['var(--font-geist-mono)', 'monospace'],
      },
      borderRadius: {
        'relay-card': '12px',
        'relay-bubble': '18px',
        'relay-bubble-received': '18px 18px 18px 4px',
        'relay-bubble-sent': '18px 18px 4px 18px',
        'relay-sm': '8px',
      },
      animation: {
        'pulse-green': 'pulse-green 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'shake': 'shake 0.5s cubic-bezier(0.36, 0, 0.66, -0.56) both',
        'fade-up': 'fade-up 0.15s ease-out forwards',
        'scale-in': 'scale-in 0.15s ease-out forwards',
        'pulse-dot': 'pulse-dot 2s ease-in-out infinite',
      },
      keyframes: {
        'pulse-green': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '10%, 30%, 50%, 70%, 90%': { transform: 'translateX(-10px)' },
          '20%, 40%, 60%, 80%': { transform: 'translateX(10px)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.5)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.6', transform: 'scale(0.8)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config

export default config
