'use client';

/**
 * Catches errors in the ROOT LAYOUT itself (app/layout.tsx) — error.tsx
 * only covers everything nested below it. Must render its own <html>/<body>
 * since it replaces the whole document when triggered (the normal layout,
 * and whatever CSS/theme it would have applied, is gone at that point) —
 * so this deliberately uses inline styles only, nothing that depends on
 * globals.css or the theme-setting bootstrap scripts having run.
 *
 * No logger/Sentry import here on purpose: if the root layout itself threw,
 * staying maximally dependency-light gives this the best chance of still
 * rendering successfully.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0a0a0a', color: '#e5e5e5', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '1rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem' }}>Something went wrong</h1>
          <p style={{ color: '#a3a3a3', maxWidth: '28rem', marginBottom: '1.5rem', lineHeight: 1.6 }}>
            The app failed to load. Your messages are still safe — nothing was lost server-side.
          </p>
          <button
            onClick={() => reset()}
            style={{ padding: '0.625rem 1.25rem', background: '#dc2626', color: 'white', fontWeight: 600, borderRadius: '0.5rem', border: 'none', cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
