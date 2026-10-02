'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, PhoneOff, Video, Maximize2 } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';

interface IncomingCallBannerProps {
  peerDisplayName: string;
  peerAvatarEmoji?: string;
  peerAvatarColor?: string;
  isVideo: boolean;
  /** Seconds before auto-escalating to the full-screen overlay. Default 8. */
  escalateAfterSec?: number;
  onAccept: () => void;
  onDecline: () => void;
  onExpand: () => void;
}

/**
 * Slide-in banner shown at the top of the screen on incoming calls.
 * Auto-escalates to the full-screen overlay after `escalateAfterSec` seconds.
 */
export function IncomingCallBanner({
  peerDisplayName,
  peerAvatarEmoji,
  peerAvatarColor,
  isVideo,
  escalateAfterSec = 8,
  onAccept,
  onDecline,
  onExpand,
}: IncomingCallBannerProps) {
  const [secondsLeft, setSecondsLeft] = useState(escalateAfterSec);

  useEffect(() => {
    if (secondsLeft <= 0) { onExpand(); return; }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft, onExpand]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: -120, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -120, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 28, duration: 0.15 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] w-full max-w-md px-4"
      >
        <div className="flex items-center gap-3 p-3 rounded-2xl border border-relay-border bg-relay-surface/95 backdrop-blur-md shadow-xl">
          {/* Avatar with pulse */}
          <div className="relative flex-shrink-0">
            <motion.div
              className="absolute inset-0 rounded-full bg-relay-accent/25"
              animate={{ scale: [1, 1.5], opacity: [0.5, 0] }}
              transition={{ duration: 1.2, repeat: Infinity }}
            />
            <UserAvatar emoji={peerAvatarEmoji} color={peerAvatarColor} size={44} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-relay-text-primary truncate">{peerDisplayName}</p>
            <p className="text-xs text-relay-text-secondary">
              Incoming {isVideo ? 'video' : 'voice'} call
            </p>
          </div>

          <button
            onClick={onExpand}
            className="p-2 rounded-xl text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover transition-colors"
            title="Expand"
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          {/* Decline */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={onDecline}
            className="w-11 h-11 rounded-full bg-relay-danger text-relay-accent-foreground flex items-center justify-center shadow-md transition-colors"
            title="Decline"
          >
            <PhoneOff className="w-5 h-5" />
          </motion.button>

          {/* Accept */}
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 1, repeat: Infinity }}
            onClick={onAccept}
            className="w-11 h-11 rounded-full bg-relay-accent text-relay-accent-foreground flex items-center justify-center shadow-md"
            title="Accept"
          >
            {isVideo ? <Video className="w-5 h-5" /> : <Phone className="w-5 h-5" />}
          </motion.button>
        </div>

        {/* Escalation progress */}
        <div className="mt-1.5 h-0.5 bg-relay-surface-hover rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-relay-accent rounded-full"
            initial={{ width: '100%' }}
            animate={{ width: '0%' }}
            transition={{ duration: escalateAfterSec, ease: 'linear' }}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
