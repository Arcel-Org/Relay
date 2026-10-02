/**
 * Feature: Archive Conversations
 *
 * Stores an `archived` flag on each contact/conversation via relay-store.
 * The sidebar filters on this flag so archived conversations only appear when
 * the user explicitly switches to the "Archived" tab. Incoming-message handlers
 * can call `autoUnarchive` to surface archived chats when activity resumes.
 */

import { getContact, upsertContact, type StoredContact } from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

export type ArchivableStoredContact = StoredContact & { archived?: boolean };

async function setArchived(relayId: string, archived: boolean): Promise<void> {
  const existing = (await getContact(relayId)) as ArchivableStoredContact | null;
  if (!existing) {
    log.warn(`[archive] Contact ${relayId} not found`);
    return;
  }
  // upsertContact performs a field merge and preserves the key.
  await upsertContact(relayId, { ...existing, archived } as Partial<StoredContact>);
}

export async function archiveContact(relayId: string): Promise<void> {
  await setArchived(relayId, true);
}

export async function unarchiveContact(relayId: string): Promise<void> {
  await setArchived(relayId, false);
}

/**
 * Best-effort auto-unarchive on new incoming activity. Safe to call from
 * any inbound-message handler; no-ops if the contact isn't archived.
 */
export async function autoUnarchive(relayId: string): Promise<void> {
  try {
    const existing = (await getContact(relayId)) as ArchivableStoredContact | null;
    if (existing?.archived) {
      await setArchived(relayId, false);
    }
  } catch (err) {
    log.debug('[archive] autoUnarchive failed:', err);
  }
}
