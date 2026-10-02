/**
 * Server-side public groups directory (plaintext metadata for discovery only).
 * Actual membership/messaging still goes through the encrypted invite flow.
 * Backed by libSQL — see sqlite-client.ts.
 */
import { getDb, runWriteTransaction } from './sqlite-client';
import type { Row } from '@libsql/client';

export interface PublicGroupRecord {
  groupId: string;
  publicHandle: string;
  name: string;
  description?: string;
  avatarEmoji?: string;
  avatarColor?: string;
  memberCount: number;
  ownerRelayId: string;
  joinPolicy: 'open' | 'request';
  pendingMembers?: string[]; // relayIds who joined via open
  pendingRequests?: string[]; // relayIds who requested to join
  updatedAt: number;
}

function rowToGroup(row: Row): PublicGroupRecord {
  return {
    groupId: row.groupId as string,
    publicHandle: row.publicHandle as string,
    name: row.name as string,
    description: (row.description as string) || undefined,
    avatarEmoji: (row.avatarEmoji as string) || undefined,
    avatarColor: (row.avatarColor as string) || undefined,
    memberCount: Number(row.memberCount),
    ownerRelayId: row.ownerRelayId as string,
    joinPolicy: row.joinPolicy as 'open' | 'request',
    pendingMembers: JSON.parse((row.pendingMembers as string) || '[]'),
    pendingRequests: JSON.parse((row.pendingRequests as string) || '[]'),
    updatedAt: Number(row.updatedAt),
  };
}

export async function loadPublicGroups(): Promise<PublicGroupRecord[]> {
  const db = await getDb();
  const result = await db.execute('SELECT * FROM public_groups');
  return result.rows.map(rowToGroup);
}

/**
 * Bounded candidate fetch for group search (app/api/groups/search) — capped
 * at `cap` regardless of total group count, mirroring
 * getUsernameSearchCandidates in relay-server-db.ts. Matches on either
 * publicHandle or name (substring), plus a small flat-capped fallback batch
 * for typo-tolerant (edit-distance) matching that can't be expressed in SQL.
 */
export async function getPublicGroupSearchCandidates(
  substringQuery: string,
  cap: number
): Promise<PublicGroupRecord[]> {
  const db = await getDb();
  const [substringResult, fuzzyFallbackResult] = await Promise.all([
    db.execute({
      sql: `
        SELECT * FROM public_groups
        WHERE lower(publicHandle) LIKE '%' || lower(?) || '%'
           OR lower(name) LIKE '%' || lower(?) || '%'
        LIMIT ?
      `,
      args: [substringQuery, substringQuery, cap],
    }),
    db.execute({ sql: 'SELECT * FROM public_groups LIMIT ?', args: [cap] }),
  ]);

  const candidates = new Map<string, PublicGroupRecord>();
  for (const row of substringResult.rows) {
    const group = rowToGroup(row);
    candidates.set(group.groupId, group);
  }
  for (const row of fuzzyFallbackResult.rows) {
    const group = rowToGroup(row);
    if (!candidates.has(group.groupId)) candidates.set(group.groupId, group);
  }
  return Array.from(candidates.values());
}

export async function upsertPublicGroup(record: Omit<PublicGroupRecord, 'updatedAt'>): Promise<PublicGroupRecord> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const existingResult = await tx.execute({
      sql: 'SELECT pendingMembers, pendingRequests FROM public_groups WHERE groupId = ?',
      args: [record.groupId],
    });
    const existingPendingMembers = existingResult.rows.length
      ? (existingResult.rows[0].pendingMembers as string)
      : '[]';
    const existingPendingRequests = existingResult.rows.length
      ? (existingResult.rows[0].pendingRequests as string)
      : '[]';
    const updatedAt = Date.now();

    await tx.execute({
      sql: `
        INSERT INTO public_groups (
          groupId, publicHandle, name, description, avatarEmoji, avatarColor,
          memberCount, ownerRelayId, joinPolicy, pendingMembers, pendingRequests, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(groupId) DO UPDATE SET
          publicHandle = excluded.publicHandle,
          name = excluded.name,
          description = excluded.description,
          avatarEmoji = excluded.avatarEmoji,
          avatarColor = excluded.avatarColor,
          memberCount = excluded.memberCount,
          ownerRelayId = excluded.ownerRelayId,
          joinPolicy = excluded.joinPolicy,
          updatedAt = excluded.updatedAt
      `,
      args: [
        record.groupId,
        record.publicHandle,
        record.name,
        record.description ?? null,
        record.avatarEmoji ?? null,
        record.avatarColor ?? null,
        record.memberCount,
        record.ownerRelayId,
        record.joinPolicy,
        existingPendingMembers,
        existingPendingRequests,
        updatedAt,
      ],
    });
    await tx.commit();
    return {
      ...record,
      pendingMembers: JSON.parse(existingPendingMembers),
      pendingRequests: JSON.parse(existingPendingRequests),
      updatedAt,
    };
  });
}

export async function removePublicGroup(groupId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM public_groups WHERE groupId = ?', args: [groupId] });
}

const MAX_PENDING_PER_GROUP = 500;

/**
 * Atomically add joinerRelayId to a group's pending list.
 * Returns null if the group is not found, 'full' if the pending list is at capacity,
 * or the join policy ('open' | 'request') on success.
 */
export async function joinGroup(
  groupRef: { groupId?: string; publicHandle?: string },
  joinerRelayId: string,
): Promise<PublicGroupRecord | null | 'full'> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const normalizedHandle = groupRef.publicHandle?.trim().replace(/^@/, '').toLowerCase();
    const result = groupRef.groupId
      ? await tx.execute({ sql: 'SELECT * FROM public_groups WHERE groupId = ?', args: [groupRef.groupId] })
      : await tx.execute({
          sql: 'SELECT * FROM public_groups WHERE lower(publicHandle) = ?',
          args: [normalizedHandle ?? ''],
        });
    if (!result.rows.length) {
      await tx.commit();
      return null;
    }
    const record = rowToGroup(result.rows[0]);

    if (record.joinPolicy === 'open') {
      const next = Array.from(new Set([...(record.pendingMembers || []), joinerRelayId]));
      if (next.length > MAX_PENDING_PER_GROUP) {
        await tx.commit();
        return 'full';
      }
      record.pendingMembers = next;
    } else {
      const next = Array.from(new Set([...(record.pendingRequests || []), joinerRelayId]));
      if (next.length > MAX_PENDING_PER_GROUP) {
        await tx.commit();
        return 'full';
      }
      record.pendingRequests = next;
    }
    record.updatedAt = Date.now();

    await tx.execute({
      sql: 'UPDATE public_groups SET pendingMembers = ?, pendingRequests = ?, updatedAt = ? WHERE groupId = ?',
      args: [
        JSON.stringify(record.pendingMembers),
        JSON.stringify(record.pendingRequests),
        record.updatedAt,
        record.groupId,
      ],
    });
    await tx.commit();
    return record;
  });
}

/**
 * Remove a relayId from a group's pending lists (whichever it's in) —
 * called once the owner has approved or denied a join. Approval doesn't
 * touch real membership here: this table is discovery metadata only (see
 * the file header), so the actual encrypted group invite is a separate,
 * purely client-side step (addGroupMembers) the caller performs after this
 * resolves. Idempotent — resolving an already-resolved/unknown relayId is a
 * harmless no-op, not an error, since a slow owner UI and a since-departed
 * joiner are both plausible races.
 */
export async function resolvePendingJoin(groupId: string, relayId: string): Promise<PublicGroupRecord | null> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const result = await tx.execute({ sql: 'SELECT * FROM public_groups WHERE groupId = ?', args: [groupId] });
    if (!result.rows.length) {
      await tx.commit();
      return null;
    }
    const record = rowToGroup(result.rows[0]);
    record.pendingMembers = (record.pendingMembers || []).filter((id) => id !== relayId);
    record.pendingRequests = (record.pendingRequests || []).filter((id) => id !== relayId);
    record.updatedAt = Date.now();

    await tx.execute({
      sql: 'UPDATE public_groups SET pendingMembers = ?, pendingRequests = ?, updatedAt = ? WHERE groupId = ?',
      args: [
        JSON.stringify(record.pendingMembers),
        JSON.stringify(record.pendingRequests),
        record.updatedAt,
        groupId,
      ],
    });
    await tx.commit();
    return record;
  });
}

/**
 * Sync the directory's ownerRelayId after a real (E2E) ownership transfer —
 * transferGroupOwnership (use-group-messaging.ts) only ever mutated the
 * group's own local/E2E state; this table's ownerRelayId column was never
 * updated to match, permanently locking the new owner out of every
 * owner-gated directory action (leave-directory, pending-join resolution,
 * directory republish) while a departed old owner kept sole control.
 * No-op (returns null) if the group isn't in the directory at all — a
 * private group has nothing here to sync.
 */
export async function updateGroupOwner(groupId: string, newOwnerRelayId: string): Promise<PublicGroupRecord | null> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const result = await tx.execute({ sql: 'SELECT * FROM public_groups WHERE groupId = ?', args: [groupId] });
    if (!result.rows.length) {
      await tx.commit();
      return null;
    }
    const updatedAt = Date.now();
    await tx.execute({
      sql: 'UPDATE public_groups SET ownerRelayId = ?, updatedAt = ? WHERE groupId = ?',
      args: [newOwnerRelayId, updatedAt, groupId],
    });
    await tx.commit();
    return { ...rowToGroup(result.rows[0]), ownerRelayId: newOwnerRelayId, updatedAt };
  });
}

export async function findByGroupId(groupId: string): Promise<PublicGroupRecord | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM public_groups WHERE groupId = ?', args: [groupId] });
  return result.rows.length ? rowToGroup(result.rows[0]) : null;
}

export async function findByHandle(handle: string): Promise<PublicGroupRecord | null> {
  const db = await getDb();
  const normalized = handle.toLowerCase().replace(/^@/, '');
  const result = await db.execute({
    sql: 'SELECT * FROM public_groups WHERE lower(publicHandle) = ?',
    args: [normalized],
  });
  return result.rows.length ? rowToGroup(result.rows[0]) : null;
}
