/**
 * Find a contact by relayId or an alternative identifier — used by
 * AddContactModal to check whether a resolved relayId is already a contact
 * before adding a duplicate.
 */

import type { Contact } from '@/lib/mock-data';

export function findContactByIdentifier(
  contacts: Contact[],
  identifier: string,
): Contact | undefined {
  // Exact relayId match
  let contact = contacts.find((c) => c.relayId === identifier);
  if (contact) return contact;

  // Fallback to regular id
  contact = contacts.find((c) => c.id === identifier);
  if (contact) return contact;

  // Try case-insensitive name match (for display names)
  const lowerIdent = identifier.toLowerCase();
  contact = contacts.find((c) => c.name?.toLowerCase() === lowerIdent);
  if (contact) return contact;

  return undefined;
}
