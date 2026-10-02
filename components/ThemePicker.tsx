'use client';

import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { THEMES, ThemeId, getSavedTheme, setTheme } from '@/lib/settings/theme';

export function ThemePicker() {
  const [active, setActive] = useState<ThemeId>('crimson');

  useEffect(() => {
    setActive(getSavedTheme());
  }, []);

  const choose = (id: ThemeId) => {
    setTheme(id);
    setActive(id);
  };

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {THEMES.map((t) => {
        const selected = active === t.id;
        const isLight = t.id === 'arctic';
        return (
          <button
            key={t.id}
            onClick={() => choose(t.id)}
            className={`relative text-left rounded-xl border transition-all overflow-hidden ${
              selected
                ? 'border-relay-accent ring-2 ring-relay-accent/30'
                : 'border-relay-border hover:border-relay-border-light'
            }`}
            style={{ background: t.swatch.bg }}
          >
            {/* Preview surface band */}
            <div
              className="h-14 flex items-center justify-between px-3"
              style={{ background: t.swatch.surface }}
            >
              <span
                className="h-2 w-16 rounded-full opacity-40"
                style={{ background: isLight ? '#52525b' : '#a1a1aa' }}
              />
              <span
                className="h-6 w-6 rounded-full"
                style={{ background: t.swatch.accent }}
              />
            </div>

            {/* Label */}
            <div className="px-3 py-2.5 flex items-center justify-between">
              <span
                className="text-sm font-medium"
                style={{ color: isLight ? '#18181b' : '#f4f4f5' }}
              >
                {t.name}
              </span>
              {selected && (
                <Check
                  size={14}
                  style={{ color: t.swatch.accent }}
                />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
