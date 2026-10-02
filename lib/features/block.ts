/**
 * Feature: Block Contact
 *
 * Stores a `blocked` flag on each contact via relay-store, same pattern as
 * archive.ts's `archived` flag. Blocking is local and unilateral — no wire
 * message is ever sent to the blocked party, so they see no signal at all
 * (their traffic is just silently dropped, indistinguishable from the
 * recipient being offline). See the block-check call sites in receive.ts,
 * key-exchange.ts, connection.ts, use-typing-indicators.ts, burn.ts, and
 * app/app/page.tsx's isKnownCaller for the enforcement points.
 *
 * Known scope limit: this only stops direct 1:1 traffic. A blocked user who
 * shares a group with you can still message/react/call within that group —
 * blocking does not remove group membership or filter group traffic, since
 * that's a materially different (and separately consequential) action. If
 * you need to stop a shared group member entirely, remove them from the
 * group or leave it.
 */

import { getContact, upsertContact, type StoredContact } from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

export type BlockableStoredContact = StoredContact & { blocked?: boolean };

async function setBlocked(relayId: string, blocked: boolean): Promise<void> {
  const existing = (await getContact(relayId)) as BlockableStoredContact | null;
  if (!existing) {
    log.warn(`[block] Contact ${relayId} not found`);
    return;
  }
  // upsertContact performs a field merge and preserves the key.
  await upsertContact(relayId, { ...existing, blocked } as Partial<StoredContact>);
}

export async function blockContact(relayId: string): Promise<void> {
  await setBlocked(relayId, true);
}

export async function unblockContact(relayId: string): Promise<void> {
  await setBlocked(relayId, false);
}

export async function isBlockedContact(relayId: string): Promise<boolean> {
  try {
    const existing = (await getContact(relayId)) as BlockableStoredContact | null;
    return !!existing?.blocked;
  } catch (err) {
    log.debug('[block] isBlockedContact check failed:', err);
    return false;
  }
}
