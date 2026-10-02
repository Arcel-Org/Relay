/**
 * Ghost contacts — relayIds added in "ephemeral" mode never touch disk.
 *
 * This is a plain in-memory Set, not a store: that's the point. Nothing here
 * is ever written to IndexedDB or localStorage, so the registry (and every
 * contact/message associated with it) evaporates the moment the tab closes
 * or the page reloads — there's no wipe to perform because nothing was saved.
 *
 * Every write path that would otherwise persist a contact's public key or
 * message history (saveContactPublicKey, persistMessage call sites, contact
 * rename) must check `isEphemeralContact()` first and skip the disk write
 * when true.
 */

const ephemeralRelayIds = new Set<string>();

export function markEphemeralContact(relayId: string): void {
  ephemeralRelayIds.add(relayId);
}

export function isEphemeralContact(relayId: string | undefined | null): boolean {
  if (!relayId) return false;
  return ephemeralRelayIds.has(relayId);
}

export function unmarkEphemeralContact(relayId: string): void {
  ephemeralRelayIds.delete(relayId);
}

/** Called on logout so a ghost contact from one identity can't bleed into the next login in the same tab. */
export function clearEphemeralContacts(): void {
  ephemeralRelayIds.clear();
}
