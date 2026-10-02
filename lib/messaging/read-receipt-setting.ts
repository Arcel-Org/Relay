/**
 * User-controlled read-receipt toggle.
 * Key: `relay:read-receipts`; default: true (on).
 * If disabled, the client will NOT emit `sendReadReceipt` when a message
 * is marked as read locally. Purely a sender-side decision.
 */

const STORAGE_KEY = 'relay:read-receipts';

export function getReadReceiptsEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === null) return true; // default on
  return raw === 'true';
}

export function setReadReceiptsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}
