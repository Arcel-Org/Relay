'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

const STORAGE_KEY = 'relay:marketing-theme';
type Theme = 'dark' | 'light';

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-mk-theme', theme);
  document.querySelectorAll<HTMLElement>('.mk-marketing').forEach((el) => {
    el.setAttribute('data-mk-theme', theme);
  });
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as Theme | null;
    // Light is the default; respect the user's saved preference if set.
    const initial: Theme = saved === 'dark' ? 'dark' : 'light';
    setTheme(initial);
    apply(initial);
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore — private mode / disabled storage
    }
  };

  if (!mounted) {
    return (
      <button
        aria-label="Toggle theme"
        className="w-9 h-9 inline-flex items-center justify-center opacity-0"
      />
    );
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      className="w-9 h-9 inline-flex items-center justify-center transition-colors"
      style={{ color: 'var(--mk-text-2)' }}
    >
      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}
