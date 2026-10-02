'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronsRight } from 'lucide-react';

const STORAGE_KEY = 'relay:sidebar-width';
const MIN_WIDTH = 220;
const MAX_WIDTH = 520;
const COLLAPSE_THRESHOLD = 180;
const COLLAPSED_WIDTH = 56;
const DEFAULT_WIDTH = 320;

type StoredValue = number | 'collapsed';

function readStored(): StoredValue {
  if (typeof window === 'undefined') return DEFAULT_WIDTH;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'collapsed') return 'collapsed';
    if (!raw) return DEFAULT_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_WIDTH;
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n));
  } catch {
    return DEFAULT_WIDTH;
  }
}

function writeStored(v: StoredValue) {
  try {
    localStorage.setItem(STORAGE_KEY, v === 'collapsed' ? 'collapsed' : String(v));
  } catch { /* ignore */ }
}

export interface ResizableSidebarProps {
  children: (args: { collapsed: boolean; width: number }) => React.ReactNode;
  /** Optional compact rail rendered when collapsed. If omitted, children still render at 56px. */
  collapsedRail?: React.ReactNode;
}

/**
 * Drag-to-resize sidebar with collapse-to-rail behavior.
 * Persists to localStorage key `relay:sidebar-width`.
 */
export function ResizableSidebar({ children, collapsedRail }: ResizableSidebarProps) {
  const [stored, setStored] = useState<StoredValue>(DEFAULT_WIDTH);
  const [hydrated, setHydrated] = useState(false);
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef<number>(DEFAULT_WIDTH);

  useEffect(() => {
    setStored(readStored());
    setHydrated(true);
  }, []);

  const collapsed = stored === 'collapsed';
  const width = collapsed ? COLLAPSED_WIDTH : (typeof stored === 'number' ? stored : DEFAULT_WIDTH);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const current = collapsed ? COLLAPSED_WIDTH : width;
    startXRef.current = e.clientX;
    startWidthRef.current = current;
    setDragging(true);
    try {
      handleRef.current?.setPointerCapture(e.pointerId);
    } catch { /* noop */ }
  }, [collapsed, width]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startXRef.current;
      const next = startWidthRef.current + delta;
      if (next < COLLAPSE_THRESHOLD) {
        setStored('collapsed');
        return;
      }
      const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
      setStored(clamped);
    };
    const onUp = () => {
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!hydrated) return;
    writeStored(stored);
  }, [stored, hydrated]);

  const expand = useCallback(() => {
    setStored(DEFAULT_WIDTH);
  }, []);

  const onHandleClick = useCallback(() => {
    if (collapsed && !dragging) expand();
  }, [collapsed, dragging, expand]);

  // Keyboard equivalent of the pointer-drag/click behavior above, per the
  // ARIA APG separator pattern: Enter/Space toggles collapsed <-> default
  // width, and the arrow keys step-resize by a fixed increment — previously
  // this whole handle was unreachable without a pointer.
  //
  // Deliberately collapses at MIN_WIDTH, not COLLAPSE_THRESHOLD (dragging's
  // lower trigger point): onMove recomputes `next` from the drag's original
  // start position every event, so it sails straight through the 40px gap
  // between the two constants in one continuous motion. Stepping by a fixed
  // 20px off the current (already-clamped-to-MIN_WIDTH) width would instead
  // get permanently stuck oscillating in that gap — decrementing from
  // MIN_WIDTH lands above COLLAPSE_THRESHOLD and gets clamped straight back
  // up to MIN_WIDTH, never actually crossing it. Discrete keyboard steps
  // don't need the drag path's hysteresis buffer anyway, so MIN_WIDTH is
  // just treated as the keyboard floor directly.
  const RESIZE_STEP = 20;
  const onHandleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (collapsed) expand();
      else setStored('collapsed');
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (collapsed) return;
      setStored(width <= MIN_WIDTH ? 'collapsed' : Math.max(MIN_WIDTH, width - RESIZE_STEP));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (collapsed) { expand(); return; }
      setStored(Math.min(MAX_WIDTH, width + RESIZE_STEP));
    }
  }, [collapsed, width, expand]);

  return (
    <motion.div
      className="relative flex-shrink-0 h-full flex bg-relay-surface border-r border-relay-border-light"
      initial={false}
      animate={{ width }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{ width }}
    >
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {collapsed && collapsedRail ? collapsedRail : children({ collapsed, width })}
      </div>

      {/* Drag / expand handle */}
      <div
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={collapsed ? 'Expand sidebar' : 'Resize sidebar'}
        aria-valuenow={width}
        aria-valuemin={COLLAPSED_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onClick={onHandleClick}
        onKeyDown={onHandleKeyDown}
        className={`absolute top-0 right-0 h-full z-20 flex items-center justify-center group focus:outline-none focus-visible:ring-2 focus-visible:ring-relay-accent ${
          collapsed ? 'cursor-pointer' : 'cursor-col-resize'
        }`}
        style={{ width: 4 }}
      >
        <div
          className={`h-full transition-all duration-150 ${
            dragging
              ? 'w-[6px] bg-relay-accent/40'
              : 'w-[4px] bg-transparent group-hover:w-[6px] group-hover:bg-relay-accent/20'
          }`}
        />
        {collapsed && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); expand(); }}
            className="absolute -right-3 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-relay-surface border border-relay-border text-relay-text-secondary hover:text-relay-accent hover:border-relay-accent/40 flex items-center justify-center shadow-sm"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="w-3 h-3" />
          </button>
        )}
      </div>
    </motion.div>
  );
}
