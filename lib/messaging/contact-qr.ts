/**
 * QR-code payload parsing for adding a contact — extracted from the legacy
 * lib/features/contact-sharing.ts (deleted; its pending-contact-request
 * queue was never wired to anything real — adding a contact in this app is
 * unilateral/local, not a request/accept flow). This was the only piece of
 * that file actually used by the app.
 */

export function parseContactQRData(qrData: string): string | null {
  if (qrData.startsWith('relay:')) {
    return qrData.slice(6); // Remove "relay:" prefix (6 chars)
  }
  return null;
}
