'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus } from 'lucide-react';
import { QUICK_REACTIONS } from '@/lib/quick-reactions';

// Deferred: EmojiPickerPanel pulls in emoji-data.ts's two unicode-emoji-json
// datasets (~800KB) — ReactionBar itself renders on every message's hover
// menu, so a static import here would ship the full picker dataset to every
// viewer regardless of whether they ever open it. Only actually fetched once
// pickerOpen flips true below.
const EmojiPickerPanel = dynamic(
  () => import('./EmojiPickerPanel').then((m) => m.EmojiPickerPanel),
  { ssr: false }
);

interface ReactionBarProps {
  onEmojiSelect: (emoji: string) => void;
}

export function ReactionBar({ onEmojiSelect }: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="flex flex-col items-start gap-2">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        transition={{ duration: 0.15 }}
        className="bg-relay-surface rounded-full border border-relay-border shadow-lg p-1.5 gap-1 flex items-center"
        style={{ width: 260 }}
      >
        {QUICK_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onEmojiSelect(emoji)}
            aria-label={`React with ${emoji}`}
            className="w-9 h-9 rounded-full hover:bg-relay-surface-hover transition-colors flex items-center justify-center text-lg"
          >
            {emoji}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="w-9 h-9 rounded-full hover:bg-relay-surface-hover transition-colors flex items-center justify-center text-relay-text-secondary"
          aria-label="More emoji"
        >
          <Plus className="w-4 h-4" />
        </button>
      </motion.div>

      <AnimatePresence>
        {pickerOpen && (
          <EmojiPickerPanel
            onSelect={(emoji) => {
              setPickerOpen(false);
              onEmojiSelect(emoji);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
