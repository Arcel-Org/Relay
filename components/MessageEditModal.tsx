'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check } from 'lucide-react';

interface MessageEditModalProps {
  isOpen: boolean;
  messageText: string;
  messageId: string;
  onSave: (newText: string) => Promise<void>;
  onCancel: () => void;
}

export const MessageEditModal = ({
  isOpen,
  messageText,
  messageId,
  onSave,
  onCancel,
}: MessageEditModalProps) => {
  const [editedText, setEditedText] = useState(messageText);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync from the message on every open — without this, closing without
  // saving (or reopening for the same still-mounted bubble after the
  // underlying text changed) left stale draft text and a stale error behind.
  useEffect(() => {
    if (isOpen) {
      setEditedText(messageText);
      setError(null);
    }
  }, [isOpen, messageText]);

  // Close on Escape, matching every other modal in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, isLoading, onCancel]);

  const handleSave = async () => {
    if (editedText.trim() === messageText.trim()) {
      onCancel();
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      await onSave(editedText);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to edit message');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={onCancel}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-message-title"
            className="w-full max-w-md bg-relay-surface border border-relay-border/60 rounded-xl shadow-black/50"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-relay-border/40">
              <h2 id="edit-message-title" className="text-lg font-semibold text-relay-text-primary">Edit Message</h2>
              <button
                onClick={onCancel}
                disabled={isLoading}
                aria-label="Close"
                className="p-1 hover:bg-relay-surface-hover/50 rounded-lg transition-colors text-relay-text-secondary hover:text-relay-text-primary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <textarea
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                autoFocus
                aria-label="Edit message text"
                className="w-full p-3 bg-relay-surface-hover/70 border border-relay-border-light/60 rounded-lg text-sm text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:border-relay-accent/60 focus:ring-1 focus:ring-relay-accent/30 resize-none max-h-32"
                rows={3}
              />

              {error && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs text-rose-600 dark:text-rose-400"
                >
                  {error}
                </motion.p>
              )}

              <p className="text-xs text-relay-text-muted">
                {editedText.length} characters
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2 p-4 border-t border-relay-border/40">
              <button
                onClick={onCancel}
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-relay-surface-hover/50 hover:bg-relay-surface-hover border border-relay-border-light rounded-lg text-sm font-medium text-relay-text-primary transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <motion.button
                onClick={handleSave}
                disabled={isLoading || editedText.trim() === messageText.trim()}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className="flex-1 px-4 py-2 bg-relay-surface rounded-lg text-sm font-bold text-white transition-all duration-300 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity }}
                    className="w-4 h-4 border-2 border-white border-t-transparent rounded-full"
                  />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                Save
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
