'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Clock,
  Coffee,
  Flag,
  Hand,
  Heart,
  Leaf,
  Lightbulb,
  Plane,
  Search,
  Smile,
  Sparkles,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import {
  CATEGORY_META,
  EmojiCategoryKey,
  EmojiEntry,
  SKIN_TONES,
  SkinTone,
  addRecent,
  applySkinTone,
  getAllSections,
  getPreferredTone,
  getRecents,
  searchEmoji,
  setPreferredTone,
  supportsSkinTone,
} from '@/lib/emoji-data';

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Clock,
  Smile,
  Heart,
  Hand,
  Users,
  Leaf,
  Coffee,
  Trophy,
  Plane,
  Lightbulb,
  Sparkles,
  Flag,
};

const TONE_SWATCH: Record<SkinTone, string> = {
  default: '#f5c98c',
  light: '#fadcbc',
  'medium-light': '#e0b088',
  medium: '#c68863',
  'medium-dark': '#8d5524',
  dark: '#4a2d1a',
};

interface EmojiPickerPanelProps {
  onSelect: (emoji: string) => void;
  onClose?: () => void;
}

export function EmojiPickerPanel({ onSelect, onClose }: EmojiPickerPanelProps) {
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [tone, setTone] = useState<SkinTone>('default');
  const [activeKey, setActiveKey] = useState<EmojiCategoryKey>('smileys');
  const [toneMenuOpen, setToneMenuOpen] = useState(false);
  const [variantFor, setVariantFor] = useState<EmojiEntry | null>(null);

  // Both callers pass onClose but neither this panel nor any wrapper around
  // it ever invoked it — there was no way to dismiss the picker except by
  // picking an emoji. Escape matches GroupDiscoveryModal's existing pattern;
  // the skin-tone variant popover, if open, takes priority (closes that
  // first, same as a second Escape press would for a normal nested menu).
  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (variantFor) { setVariantFor(null); return; }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, variantFor]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<EmojiCategoryKey, HTMLDivElement | null>>(new Map());
  const tabRefs = useRef<Map<EmojiCategoryKey, HTMLButtonElement | null>>(new Map());

  // Initial load.
  useEffect(() => {
    setRecents(getRecents());
    setTone(getPreferredTone());
  }, []);

  const sections = useMemo(() => getAllSections(recents), [recents]);

  const searchResults = useMemo(() => {
    const q = query.trim();
    return q ? searchEmoji(q) : [];
  }, [query]);

  // IntersectionObserver to sync active tab to the section nearest the top.
  useEffect(() => {
    if (query.trim()) return; // disabled in search mode
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Pick the entry closest to the top of the scroll container that is intersecting.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const key = visible[0].target.getAttribute('data-cat') as EmojiCategoryKey | null;
          if (key) setActiveKey(key);
        }
      },
      { root, rootMargin: '-8px 0px -70% 0px', threshold: 0 },
    );
    sectionRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [sections, query]);

  // Keep the tab strip scrolled so the active tab is visible.
  useLayoutEffect(() => {
    const btn = tabRefs.current.get(activeKey);
    btn?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [activeKey]);

  const scrollToCategory = (key: EmojiCategoryKey) => {
    const el = sectionRefs.current.get(key);
    if (el && scrollRef.current) {
      scrollRef.current.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' });
      setActiveKey(key);
    }
  };

  const commit = (emoji: string) => {
    const final = supportsSkinTone(emoji) ? applySkinTone(emoji, tone) : emoji;
    const updated = addRecent(final);
    setRecents(updated);
    onSelect(final);
  };

  const openVariants = (e: React.MouseEvent, entry: EmojiEntry) => {
    e.preventDefault();
    if (entry.skinToneSupport) setVariantFor(entry);
  };

  const handleVariantPick = (variant: string) => {
    const updated = addRecent(variant);
    setRecents(updated);
    setVariantFor(null);
    onSelect(variant);
  };

  const pickTone = (t: SkinTone) => {
    setTone(t);
    setPreferredTone(t);
    setToneMenuOpen(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="bg-relay-surface rounded-xl border border-relay-border shadow-xl w-[340px] h-[440px] flex flex-col overflow-hidden relative"
    >
      {/* Search + tone */}
      <div className="p-2 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-relay-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all emoji…"
            className="relay-input w-full pl-8 pr-8"
            autoFocus
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-relay-text-muted hover:text-relay-text-primary"
              title="Clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* Skin-tone picker button */}
        <div className="relative">
          <button
            onClick={() => setToneMenuOpen((v) => !v)}
            className="w-8 h-8 rounded-md border border-relay-border hover:bg-relay-surface-hover transition-colors flex items-center justify-center"
            title="Skin tone"
          >
            <span
              className="w-4 h-4 rounded-full border border-relay-border"
              style={{ background: TONE_SWATCH[tone] }}
            />
          </button>
          {toneMenuOpen && (
            <div className="absolute right-0 top-9 z-10 bg-relay-surface border border-relay-border rounded-lg shadow-xl p-1 flex gap-0.5">
              {SKIN_TONES.map((t) => (
                <button
                  key={t}
                  onClick={() => pickTone(t)}
                  title={t}
                  className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                    tone === t ? 'bg-relay-surface-hover' : 'hover:bg-relay-surface-hover'
                  }`}
                >
                  <span
                    className="w-4 h-4 rounded-full border border-relay-border"
                    style={{ background: TONE_SWATCH[t] }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Category tabs (hidden while searching) */}
      {!query.trim() && (
        <div className="px-1.5 pb-1.5 flex gap-0.5 overflow-x-auto border-b border-relay-border">
          {CATEGORY_META.filter((c) => c.key !== 'recent' || recents.length > 0).map((c) => {
            const Icon = ICON_MAP[c.icon] ?? Smile;
            const active = activeKey === c.key;
            return (
              <button
                key={c.key}
                ref={(el) => { tabRefs.current.set(c.key, el); }}
                type="button"
                onClick={() => scrollToCategory(c.key)}
                title={c.label}
                className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors flex-shrink-0 relative ${
                  active
                    ? 'text-relay-accent'
                    : 'text-relay-text-muted hover:bg-relay-surface-hover hover:text-relay-text-primary'
                }`}
              >
                <Icon className="w-4 h-4" />
                {active && (
                  <motion.span
                    layoutId="emoji-tab-indicator"
                    className="absolute left-1.5 right-1.5 bottom-0.5 h-0.5 rounded-full bg-relay-accent"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Scroll area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {query.trim() ? (
          searchResults.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-relay-text-muted">
              <Search className="w-6 h-6 opacity-40" />
              <p className="text-sm">No emoji match &ldquo;{query.trim()}&rdquo;</p>
            </div>
          ) : (
            <div className="p-2">
              <p className="px-1 pb-2 text-[11px] uppercase tracking-[0.08em] text-relay-text-muted font-medium">
                {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
              </p>
              <EmojiGrid
                entries={searchResults}
                onPick={commit}
                onContextMenu={openVariants}
                tone={tone}
              />
            </div>
          )
        ) : (
          sections.map((s) => (
            <div
              key={s.key}
              ref={(el) => { sectionRefs.current.set(s.key, el); }}
              data-cat={s.key}
              className="px-2 pb-3"
            >
              <div className="sticky top-0 z-[1] -mx-2 px-3 py-1.5 bg-relay-surface/95 backdrop-blur-sm text-[11px] uppercase tracking-[0.08em] text-relay-text-muted font-medium">
                {s.label}
              </div>
              <EmojiGrid
                entries={s.emojis}
                onPick={commit}
                onContextMenu={openVariants}
                tone={tone}
              />
            </div>
          ))
        )}
      </div>

      {/* Skin-tone variant popover */}
      {variantFor && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setVariantFor(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setVariantFor(null);
            }}
          />
          <div className="absolute z-30 left-1/2 -translate-x-1/2 top-1/3 bg-relay-surface border border-relay-border rounded-xl shadow-2xl p-2 flex gap-1">
            {SKIN_TONES.map((t) => {
              const variant = applySkinTone(variantFor.char, t);
              return (
                <button
                  key={t}
                  onClick={() => handleVariantPick(variant)}
                  title={t}
                  className="w-10 h-10 rounded-md hover:bg-relay-surface-hover transition-colors flex items-center justify-center text-2xl"
                >
                  {variant}
                </button>
              );
            })}
          </div>
        </>
      )}
    </motion.div>
  );
}

function EmojiGrid({
  entries,
  onPick,
  onContextMenu,
  tone,
}: {
  entries: EmojiEntry[];
  onPick: (emoji: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: EmojiEntry) => void;
  tone: SkinTone;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {entries.map((entry, idx) => {
        const render = entry.skinToneSupport ? applySkinTone(entry.char, tone) : entry.char;
        return (
          <button
            key={`${entry.char}-${idx}`}
            type="button"
            onClick={() => onPick(entry.char)}
            onContextMenu={(e) => onContextMenu(e, entry)}
            title={entry.skinToneSupport ? `${entry.name} — right-click for tones` : entry.name}
            aria-label={entry.name}
            className="w-9 h-9 rounded-md hover:bg-relay-surface-hover transition-colors flex items-center justify-center text-2xl relative"
          >
            {render}
            {entry.skinToneSupport && (
              <span className="absolute bottom-0.5 right-0.5 w-1 h-1 rounded-full bg-relay-accent/70" />
            )}
          </button>
        );
      })}
    </div>
  );
}
