/**
 * Relay Display Utilities
 *
 * Resolves relayIds to user-friendly display names.
 * Priority: @username > displayName > short hash
 */

import { isValidRelayId } from '@/lib/crypto/relay-id';

export interface Contact {
  relayId?: string;
  displayName?: string;
  username?: string;
  [key: string]: any;
}

/**
 * Resolve a relayId to a display name
 * Priority: @username > displayName > name > short hash fallback
 */
export function resolveDisplayName(relayId: string | undefined, contacts: Contact[]): string {
  if (!relayId) return 'Unknown';

  const contact = contacts.find(c => c.relayId === relayId || c.id === relayId);

  if (!contact) {
    return getShortHash(relayId);
  }

  // Prefer username if claimed (guard against a field that's actually just
  // the relayId itself, not a real claimed value)
  if (contact.username && !isValidRelayId(contact.username)) {
    return '@' + contact.username;
  }

  // Use displayName if it's not just the relayId
  if (contact.displayName && !isValidRelayId(contact.displayName)) {
    return contact.displayName;
  }

  // Use name field if it's not just the relayId
  if (contact.name && !isValidRelayId(contact.name)) {
    return contact.name;
  }

  // Fallback to short hash
  return getShortHash(relayId);
}

/**
 * Truncated display form of a Relay ID. The current format (8 dash-separated
 * hex groups, 39 chars) is too long to show in full in a chat bubble sender
 * label or contact-list fallback — unlike the previous, much shorter
 * `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx` format, this one genuinely needs truncating again.
 */
export function getShortHash(relayId: string): string {
  return formatRelayId(relayId, 9);
}

/** Truncate a Relay ID to `maxLength` characters (of the id itself, before the "…"). */
export function formatRelayId(relayId: string, maxLength: number = 9): string {
  return relayId.length > maxLength ? `${relayId.slice(0, maxLength)}…` : relayId;
}

/**
 * Check if a contact is "new" (no display name set)
 * Used to show onboarding prompts
 */
export function isNewContact(contact: Contact | null): boolean {
  if (!contact) return false;
  return !contact.displayName || contact.displayName === contact.relayId;
}
