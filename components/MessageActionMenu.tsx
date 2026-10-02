'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReactionBar } from './reactions/ReactionBar';
import { MessageActionSheet } from './reactions/MessageActionSheet';

export interface MenuAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  isDestructive?: boolean;
  isLoading?: boolean;
  group?: 'reaction' | 'interact' | 'manage' | 'delete';
}

interface MessageActionMenuProps {
  actions: MenuAction[];
  onClose: () => void;
  position: { x: number; y: number };
  onEmojiSelect?: (emoji: string) => Promise<void>;
}

/**
 * Orchestrator: stacks a floating ReactionBar above a MessageActionSheet,
 * portaled to document.body. Drop-in replacement for the old monolithic menu.
 */
export const MessageActionMenu = ({
  actions,
  onClose,
  position,
  onEmojiSelect,
}: MessageActionMenuProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number }>({
    left: position.x,
    top: position.y,
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Flip-to-fit viewport. Re-runs on position/mount/action changes AND on any
  // size change of the menu (e.g. when the emoji picker opens/closes inside it).
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const reflow = () => {
      const pad = 8;
      const rect = el.getBoundingClientRect();
      let left = position.x;
      let top = position.y;
      if (left + rect.width > window.innerWidth - pad) {
        left = window.innerWidth - rect.width - pad;
      }
      if (left < pad) left = pad;
      if (top + rect.height > window.innerHeight - pad) {
        top = Math.max(pad, window.innerHeight - rect.height - pad);
      }
      if (top < pad) top = pad;
      setCoords({ left, top });
    };

    reflow();

    const ro = new ResizeObserver(reflow);
    ro.observe(el);
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [position, mounted, actions.length]);

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Focus trap — this menu is portaled to document.body, so without this a
  // keyboard user tabbing through it would eventually tab OUT into whatever
  // else is on the page behind it, with no way to reach react/edit/delete
  // via keyboard alone in practice (nothing moves focus into the menu on
  // open, and Tab isn't contained once you're in it). Focuses the first
  // action on mount, restores focus to whatever had it before on close, and
  // wraps Tab/Shift+Tab at the menu's own boundaries.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const el = wrapperRef.current;
    const focusables = () =>
      el ? Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')) : [];

    // Defer to the next tick so the portal's children have actually mounted.
    const raf = requestAnimationFrame(() => {
      focusables()[0]?.focus();
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, []);

  const handleEmoji = async (emoji: string) => {
    if (onEmojiSelect) {
      try {
        await onEmojiSelect(emoji);
      } finally {
        onClose();
      }
    } else {
      onClose();
    }
  };

  if (!mounted) return null;

  return createPortal(
    <>
      {/* Outside-click catcher */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={wrapperRef}
        className="fixed z-50 flex flex-col gap-2"
        style={{ left: coords.left, top: coords.top }}
      >
        {onEmojiSelect && <ReactionBar onEmojiSelect={handleEmoji} />}
        <MessageActionSheet actions={actions} onClose={onClose} />
      </div>
    </>,
    document.body,
  );
};
