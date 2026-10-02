'use client';

import { memo } from 'react';

interface UserAvatarProps {
  emoji?: string;
  color?: string;
  size?: number;
  className?: string;
  online?: boolean;
  selected?: boolean;
}

/**
 * Renders a user's permanently-assigned emoji+color avatar.
 * Falls back to a neutral circle if the fields are missing (legacy accounts).
 */
export const UserAvatar = memo(function UserAvatar({
  emoji,
  color,
  size = 40,
  className = '',
  online = false,
  selected = false,
}: UserAvatarProps) {
  const fontSize = Math.round(size * 0.52);
  // Sleeker status dot: 10px @ 40px avatar → 25% of size, 2px ring
  const indicatorSize = Math.max(8, Math.round(size * 0.25));
  const indicatorOffset = 0;
  const borderWidth = 2;

  const hasAvatar = emoji && color;

  return (
    <div
      className={`relative flex-shrink-0 rounded-full ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Circle — overflow-hidden clips the emoji to the circle shape.
          Desaturate random bright avatar colors so they feel grown-up. */}
      <div
        className={`w-full h-full rounded-full overflow-hidden flex items-center justify-center select-none
          ${selected ? 'ring-2 ring-relay-accent' : ''}
          ${!hasAvatar ? 'bg-relay-surface-hover' : ''}
        `}
        style={
          hasAvatar
            ? { backgroundColor: color, filter: 'saturate(0.6) brightness(0.9)' }
            : undefined
        }
      >
        {hasAvatar ? (
          <span
            style={{ fontSize, lineHeight: 1, display: 'block' }}
            role="img"
            aria-label="avatar"
          >
            {emoji}
          </span>
        ) : (
          <span
            className="text-relay-text-secondary font-semibold select-none"
            style={{ fontSize: Math.round(size * 0.38) }}
          >
            ?
          </span>
        )}
      </div>

      {/* Online status indicator — recessed using surface-tone ring.
          Color alone (green vs gray) isn't distinguishable for colorblind
          users, so online is a solid filled dot while offline is a hollow
          ring (border only, transparent center) — a shape difference, not
          just a color one — plus an sr-only label for screen readers. */}
      <div
        className="absolute rounded-full bg-relay-surface"
        style={{
          width: indicatorSize,
          height: indicatorSize,
          bottom: indicatorOffset,
          right: indicatorOffset,
          padding: borderWidth,
          transition: 'background-color 0.2s',
        }}
      >
        <div
          className="w-full h-full rounded-full"
          style={
            online
              ? { backgroundColor: '#10b981', transition: 'background-color 0.2s, border-color 0.2s' }
              : { backgroundColor: 'transparent', border: '1.5px solid #52525b', transition: 'background-color 0.2s, border-color 0.2s' }
          }
        />
        <span className="sr-only">{online ? 'Online' : 'Offline'}</span>
      </div>
    </div>
  );
});
