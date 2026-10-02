'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { log } from '@/lib/platform/logger';

/**
 * Next.js App Router error boundary — automatically wraps every route
 * segment under app/ (everything except the root layout itself; see
 * global-error.tsx for that). Before this file existed, there was no error
 * boundary anywhere in the app at all: an uncaught render-time exception in
 * ANY component (a malformed message, an edge case in key-exchange UI,
 * etc.) would unmount the entire React tree with nothing to catch it,
 * surfacing as Next's generic white-screen error page and losing whatever
 * was in memory (an unsent compose draft, scroll position, open modals).
 *
 * Deliberately does NOT report to Sentry — this app's crash reporting is
 * server-side only, by design (see lib/platform/error-monitoring.ts): end
 * users' browsers must never phone home to a third party.
 */
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();

  useEffect(() => {
    log.error('[ErrorBoundary] Uncaught render error:', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-relay-bg flex flex-col items-center justify-center p-4">
      <div className="text-center space-y-6 max-w-md">
        <h1 className="text-2xl font-bold text-relay-text-primary">Something went wrong</h1>
        <p className="text-relay-text-secondary leading-relaxed">
          An unexpected error occurred. Your messages are still safe — nothing was lost server-side. Try again, or reload if the problem persists.
        </p>
        <div className="flex gap-2 justify-center flex-wrap">
          <button
            onClick={() => reset()}
            className="px-4 py-2.5 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground font-semibold rounded-lg transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => router.push('/app')}
            className="px-4 py-2.5 bg-relay-surface hover:bg-relay-surface-hover border border-relay-border rounded-lg text-relay-text-primary transition-colors"
          >
            Back to Messenger
          </button>
        </div>
      </div>
    </div>
  );
}
