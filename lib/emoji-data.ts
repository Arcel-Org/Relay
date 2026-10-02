/**
 * Relay emoji data — full Unicode set via `unicode-emoji-json`.
 * Routed into finer-grained categories via slug/name matching so
 * the picker has "Hands" separate from "People", "Emotions" separate
 * from "Smileys", etc. Also exposes skin-tone variants for supported emoji.
 */

import groupData from 'unicode-emoji-json/data-by-group.json';
import emojiData from 'unicode-emoji-json/data-by-emoji.json';

type RawEmoji = {
  emoji: string;
  name: string;
  slug: string;
  skin_tone_support?: boolean;
};
type RawGroup = { name: string; slug: string; emojis: RawEmoji[] };

const GROUPS_ARRAY: RawGroup[] = Object.values(
  groupData as unknown as Record<string, RawGroup>,
);
const EMOJI_MAP: Record<string, RawEmoji> = emojiData as unknown as Record<string, RawEmoji>;

// --- Category keys, ordered as they appear in the picker.
export type EmojiCategoryKey =
  | 'recent'
  | 'smileys'
  | 'emotions'
  | 'gestures'
  | 'people'
  | 'nature'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols'
  | 'flags';

export interface EmojiEntry {
  char: string;
  name: string;
  keywords: string[];
  category: Exclude<EmojiCategoryKey, 'recent'>;
  /** True if this emoji supports the 5 Fitzpatrick skin-tone modifiers. */
  skinToneSupport: boolean;
}

// --- Category metadata. `icon` is a lucide-react component name.
export const CATEGORY_META: Array<{
  key: EmojiCategoryKey;
  label: string;
  icon: string;
}> = [
  { key: 'recent', label: 'Recent', icon: 'Clock' },
  { key: 'smileys', label: 'Smileys', icon: 'Smile' },
  { key: 'emotions', label: 'Emotions', icon: 'Heart' },
  { key: 'gestures', label: 'Gestures', icon: 'Hand' },
  { key: 'people', label: 'People', icon: 'Users' },
  { key: 'nature', label: 'Nature', icon: 'Leaf' },
  { key: 'food', label: 'Food', icon: 'Coffee' },
  { key: 'activities', label: 'Activities', icon: 'Trophy' },
  { key: 'travel', label: 'Travel', icon: 'Plane' },
  { key: 'objects', label: 'Objects', icon: 'Lightbulb' },
  { key: 'symbols', label: 'Symbols', icon: 'Sparkles' },
  { key: 'flags', label: 'Flags', icon: 'Flag' },
];

// --- Routing rules from Unicode group -> Relay category.

/** "Smileys & Emotion" splits into face-like `smileys` vs non-face `emotions`. */
function routeSmileysEmotion(slug: string, name: string): 'smileys' | 'emotions' {
  const s = slug.toLowerCase();
  const n = name.toLowerCase();
  // Hearts, kisses, and stylised emotion marks go to emotions.
  if (/heart|kiss_mark|cupid|love_letter|sparkling_heart/.test(s)) return 'emotions';
  // Non-face symbolic glyphs: speech/thought balloons, dashes, zzz, etc.
  if (/balloon|bubble|zzz|dash|hole|hundred_points|anger|boom|dizzy|sweat_droplets|droplet|fire$|sparkles|collision|left_speech|right_anger|eye_in_speech|thought_balloon/.test(s))
    return 'emotions';
  // Everything else in this Unicode group is a face → smileys.
  // Defensive fallback: if name has "face" → smileys.
  if (n.includes('face') || n.includes('cat')) return 'smileys';
  return 'smileys';
}

/** "People & Body" splits into hand/arm/body-part `gestures` vs full-person `people`. */
function routePeopleBody(slug: string): 'gestures' | 'people' {
  const s = slug.toLowerCase();
  // Hand gestures & arms.
  if (
    /(^|_)(hand|hands|fingers|fist|thumbs_up|thumbs_down|wave|wavy|clap|palm|pinch|point|ok_hand|victory|call_me|love_you|handshake|nail|selfie|muscle|flexed|writing)(_|$)/.test(
      s,
    )
  )
    return 'gestures';
  // Body parts (incl. senses, organs).
  if (
    /^(ear|nose|eye|mouth|tongue|tooth|bone|brain|lungs?|skeleton|anatomical|leg|foot|footprint|kick|mechanical_arm|mechanical_leg)/.test(
      s,
    )
  )
    return 'gestures';
  if (/_finger|_hand|pray|namaste|raised_back|raised_fist|raised_hand/.test(s))
    return 'gestures';
  return 'people';
}

function routeToCategory(groupName: string, e: RawEmoji): Exclude<EmojiCategoryKey, 'recent'> | null {
  switch (groupName) {
    case 'Smileys & Emotion':
      return routeSmileysEmotion(e.slug, e.name);
    case 'People & Body':
      return routePeopleBody(e.slug);
    case 'Animals & Nature':
      return 'nature';
    case 'Food & Drink':
      return 'food';
    case 'Travel & Places':
      return 'travel';
    case 'Activities':
      return 'activities';
    case 'Objects':
      return 'objects';
    case 'Symbols':
      return 'symbols';
    case 'Flags':
      return 'flags';
    default:
      return null;
  }
}

function slugTokens(slug: string): string[] {
  return slug.split(/[_\s-]+/).filter(Boolean);
}

// --- Build the flattened dataset + per-category buckets.

export const EMOJI_DATA: EmojiEntry[] = GROUPS_ARRAY.flatMap((g) =>
  g.emojis
    .map((e) => {
      const cat = routeToCategory(g.name, e);
      if (!cat) return null;
      return {
        char: e.emoji,
        name: e.name,
        keywords: Array.from(
          new Set([e.name.toLowerCase(), ...slugTokens(e.slug.toLowerCase())]),
        ),
        category: cat,
        skinToneSupport: !!e.skin_tone_support,
      } as EmojiEntry;
    })
    .filter((x): x is EmojiEntry => x !== null),
);

type CatBucket = Record<Exclude<EmojiCategoryKey, 'recent'>, EmojiEntry[]>;
const BY_CATEGORY: CatBucket = {
  smileys: [],
  emotions: [],
  gestures: [],
  people: [],
  nature: [],
  food: [],
  activities: [],
  travel: [],
  objects: [],
  symbols: [],
  flags: [],
};
for (const e of EMOJI_DATA) BY_CATEGORY[e.category].push(e);

export function emojisByCategory(
  key: Exclude<EmojiCategoryKey, 'recent'>,
): EmojiEntry[] {
  return (BY_CATEGORY as Record<string, EmojiEntry[]>)[key] ?? [];
}

/** All sections in display order, with recents pulled from localStorage at call time. */
export function getAllSections(
  recents: string[],
): Array<{ key: EmojiCategoryKey; label: string; emojis: EmojiEntry[] }> {
  const sections: Array<{ key: EmojiCategoryKey; label: string; emojis: EmojiEntry[] }> = [];
  if (recents.length > 0) {
    const entries: EmojiEntry[] = recents
      .map((char) => {
        const base = stripSkinTone(char);
        const entry = EMOJI_DATA.find((e) => e.char === base);
        if (entry) return { ...entry, char };
        // Fallback synthetic entry so the picker still renders unknowns.
        return { char, name: char, keywords: [], category: 'smileys' as const, skinToneSupport: false };
      });
    sections.push({ key: 'recent', label: 'Recent', emojis: entries });
  }
  for (const meta of CATEGORY_META) {
    if (meta.key === 'recent') continue;
    const list = emojisByCategory(meta.key as Exclude<EmojiCategoryKey, 'recent'>);
    if (list.length > 0) sections.push({ key: meta.key, label: meta.label, emojis: list });
  }
  return sections;
}

// --- Fuzzy-ish search: token-based AND match with score weighting.

export function searchEmoji(query: string): EmojiEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ e: EmojiEntry; score: number }> = [];
  for (const e of EMOJI_DATA) {
    let score = 0;
    let matchedAll = true;
    for (const t of terms) {
      if (e.name === t) score += 10;
      else if (e.name.startsWith(t)) score += 6;
      else if (e.name.includes(t)) score += 3;
      else if (e.keywords.some((k) => k.startsWith(t))) score += 2;
      else if (e.keywords.some((k) => k.includes(t))) score += 1;
      else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll && score > 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.e);
}

// --- Skin tone variants (Fitzpatrick scale).
//  For an emoji that supports skin tones, append the modifier codepoint.
//  Emoji sequences already containing ZWJ (like families) are NOT here — dataset's
//  `skin_tone_support` is only true for single-person glyphs.

export type SkinTone = 'default' | 'light' | 'medium-light' | 'medium' | 'medium-dark' | 'dark';

const TONE_MODIFIER: Record<SkinTone, string> = {
  default: '',
  light: '\u{1F3FB}',
  'medium-light': '\u{1F3FC}',
  medium: '\u{1F3FD}',
  'medium-dark': '\u{1F3FE}',
  dark: '\u{1F3FF}',
};

export const SKIN_TONES: SkinTone[] = [
  'default',
  'light',
  'medium-light',
  'medium',
  'medium-dark',
  'dark',
];

/** Strip any skin-tone modifier from an emoji, returning the base glyph. */
export function stripSkinTone(emoji: string): string {
  return emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** Apply a skin tone to a base emoji. Base must support skin tones. */
export function applySkinTone(baseEmoji: string, tone: SkinTone): string {
  const base = stripSkinTone(baseEmoji);
  if (tone === 'default') return base;
  return base + TONE_MODIFIER[tone];
}

/** Does this emoji (with or without a current tone) support skin tones? */
export function supportsSkinTone(emoji: string): boolean {
  const base = stripSkinTone(emoji);
  return !!EMOJI_MAP[base]?.skin_tone_support;
}

// --- Recents.

const RECENTS_KEY = 'relay:emoji-recents';
const TONE_KEY = 'relay:emoji-tone';
const RECENTS_MAX = 32;

export function getRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function addRecent(emoji: string): string[] {
  if (typeof window === 'undefined') return [];
  const current = getRecents().filter((e) => e !== emoji);
  const next = [emoji, ...current].slice(0, RECENTS_MAX);
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function getPreferredTone(): SkinTone {
  if (typeof window === 'undefined') return 'default';
  const t = window.localStorage.getItem(TONE_KEY) as SkinTone | null;
  return t && SKIN_TONES.includes(t) ? t : 'default';
}

export function setPreferredTone(tone: SkinTone): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TONE_KEY, tone);
  } catch {
    /* ignore */
  }
}

export function getEmojiName(emoji: string): string | undefined {
  return EMOJI_MAP[stripSkinTone(emoji)]?.name;
}
