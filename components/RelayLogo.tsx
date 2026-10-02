'use client';

import { memo } from 'react';
import { motion } from 'framer-motion';

interface RelayLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl' | number;
  animated?: boolean;
  className?: string;
  /** When true, renders the glyph only (no tile background) in currentColor. */
  mark?: boolean;
}

const sizeMap = {
  sm: 28,
  md: 40,
  lg: 64,
  xl: 128,
};

/**
 * Arcel Relay mark — a confident geometric tile in the theme's accent color.
 * The glyph reads as "N" with a corner dot / faint ring acting as both a "9"
 * and a transmitting-signal indicator — a legacy nod that the shape no
 * longer maps to the current brand name and is due a redesign, not
 * something to invent here.
 *
 * Adapts to every theme because it uses the `--relay-accent` and
 * `--relay-accent-foreground` CSS variables.
 */
export const RelayLogo = memo(function RelayLogo({
  size = 'md',
  animated = false,
  className = '',
  mark = false,
}: RelayLogoProps) {
  const dimension = typeof size === 'number' ? size : sizeMap[size];

  const fg = mark ? 'currentColor' : 'var(--relay-accent-foreground)';
  const bg = 'var(--relay-accent)';
  const bgAlpha = 'var(--relay-accent-foreground)';

  const svg = (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`block ${className}`}
      aria-label="Arcel Relay"
      role="img"
    >
      {!mark && (
        <rect x="0" y="0" width="48" height="48" rx="11" fill={bg} />
      )}
      {/* N stroke — three-segment diagonal */}
      <path
        d="M13.5 34.5 V13.5 L32 32 V15.5"
        stroke={fg}
        strokeWidth="3.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Signal dot (the "9" + transmit indicator) */}
      <circle cx="35.5" cy="12.5" r="3" fill={fg} />
      {/* Faint outer ring — doubles as pulse anchor for the animated variant */}
      <circle
        cx="35.5"
        cy="12.5"
        r="5.75"
        stroke={fg}
        strokeOpacity={mark ? 0.35 : 0.45}
        strokeWidth="1"
        fill="none"
      />
    </svg>
  );

  if (!animated) {
    return svg;
  }

  return (
    <motion.div
      className="inline-block"
      animate={{ opacity: [1, 0.88, 1] }}
      transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
    >
      {svg}
    </motion.div>
  );
});
