/**
 * The 6 always-visible quick-react emoji shown in ReactionBar. Split out of
 * emoji-data.ts (deliberately zero dependencies here) because ReactionBar
 * renders these unconditionally on every message — pulling in the rest of
 * emoji-data.ts for just this fixed list would drag its two
 * unicode-emoji-json datasets (the full emoji picker's data, ~800KB) into a
 * chunk that loads far more often than the picker itself actually opens.
 */
export const QUICK_REACTIONS: string[] = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
