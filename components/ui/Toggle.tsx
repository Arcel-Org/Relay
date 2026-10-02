'use client';

import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

/**
 * Accessible sliding toggle switch.
 *
 * Track: 40x24 (w-10 h-6)
 * Knob:  20x20 (w-5 h-5) inset 2px (top/left-0.5)
 * Off:  translate-x-0   (knob at left-0.5)
 * On:   translate-x-4   (+16px; math: 40 - 20 - 2 - 2 = 16)
 */
export function Toggle({ checked, onChange, disabled, ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-relay-accent/60 ${
        checked
          ? 'bg-relay-accent'
          : 'bg-relay-surface-hover border border-relay-border'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        aria-hidden
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}
