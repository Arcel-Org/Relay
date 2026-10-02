/**
 * Arcel wordmark used on marketing surfaces. Pure text, no image. The
 * previous wordmark had an accent-colored digit treatment that doesn't
 * carry over to "arcel" — this renders plain text for now; a proper
 * wordmark/logo treatment for the new name is a design decision for
 * whoever owns the Arcel brand, not something to invent here.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`mk-logo text-lg ${className}`}>
      arcel
    </span>
  );
}
