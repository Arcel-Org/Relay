/**
 * Relay theme system — 9 palettes.
 * Palettes are defined in app/globals.css via [data-theme="<id>"].
 */

export type ThemeId =
  | 'crimson'
  | 'ocean'
  | 'forest'
  | 'golden'
  | 'violet'
  | 'arctic'
  | 'rose'
  | 'solar'
  | 'zen';

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  swatch: { bg: string; surface: string; accent: string };
}

export const THEMES: ThemeMeta[] = [
  { id: 'crimson', name: 'Crimson', swatch: { bg: '#0a0a0b', surface: '#141416', accent: '#e11d1d' } },
  { id: 'ocean',   name: 'Ocean',   swatch: { bg: '#090d16', surface: '#111827', accent: '#60a5fa' } },
  { id: 'forest',  name: 'Forest',  swatch: { bg: '#090e0c', surface: '#111a15', accent: '#10b981' } },
  { id: 'golden',  name: 'Golden',  swatch: { bg: '#0d0b08', surface: '#18140d', accent: '#d9964b' } },
  { id: 'violet',  name: 'Violet',  swatch: { bg: '#0b0a12', surface: '#151420', accent: '#8b5cf6' } },
  { id: 'arctic',  name: 'Arctic',  swatch: { bg: '#fafafa', surface: '#ffffff', accent: '#18181b' } },
  { id: 'rose',    name: 'Rose',    swatch: { bg: '#0f0a0c', surface: '#1a1216', accent: '#db809c' } },
  { id: 'solar',   name: 'Solar',   swatch: { bg: '#0c0906', surface: '#16110c', accent: '#d97757' } },
  { id: 'zen',     name: 'Zen',     swatch: { bg: '#0a0a0a', surface: '#171717', accent: '#e4e4e7' } },
];

const STORAGE_KEY = 'relay:theme';
const DEFAULT: ThemeId = 'crimson';

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

export function getSavedTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT;
  const v = window.localStorage.getItem(STORAGE_KEY);
  return isThemeId(v) ? v : DEFAULT;
}

export function applyTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', id);
  // Keep the `dark` class in sync so Tailwind `dark:` variants resolve
  // correctly for every non-light theme.
  const root = document.documentElement;
  if (id === 'arctic') root.classList.remove('dark');
  else root.classList.add('dark');
}

export function setTheme(id: ThemeId): void {
  applyTheme(id);
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, id);
  }
}
