/**
 * @vitest-environment node
 *
 * Coverage for public-groups-db.ts's two round-2/3 audit fixes, against a
 * real throwaway on-disk SQLite DB (same pattern as
 * relay-server-db-shortcode.test.ts):
 *
 * 1. resolvePendingJoin — the read/resolve half of the join flow that was
 *    previously write-only (joinGroup appended to pendingMembers/
 *    pendingRequests, but nothing ever consumed them).
 * 2. updateGroupOwner — syncing the directory's ownerRelayId after a real
 *    E2E ownership transfer, which previously left the directory pointing
 *    at the departed owner forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-public-groups-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeGroup(overrides: Partial<{
  groupId: string;
  publicHandle: string;
  ownerRelayId: string;
  joinPolicy: 'open' | 'request';
}> = {}) {
  return {
    groupId: overrides.groupId ?? 'grp_1',
    publicHandle: overrides.publicHandle ?? 'test-group',
    name: 'Test Group',
    memberCount: 3,
    ownerRelayId: overrides.ownerRelayId ?? 'owner-relay-id',
    joinPolicy: overrides.joinPolicy ?? 'open' as const,
  };
}

describe('resolvePendingJoin', () => {
  it('removes a relayId from pendingMembers after an open-policy join', async () => {
    const { upsertPublicGroup, joinGroup, resolvePendingJoin, findByGroupId } = await import('../db/public-groups-db');
    await upsertPublicGroup(makeGroup({ joinPolicy: 'open' }));
    await joinGroup({ groupId: 'grp_1' }, 'joiner-1');

    let record = await findByGroupId('grp_1');
    expect(record?.pendingMembers).toEqual(['joiner-1']);

    await resolvePendingJoin('grp_1', 'joiner-1');
    record = await findByGroupId('grp_1');
    expect(record?.pendingMembers).toEqual([]);
  });

  it('removes a relayId from pendingRequests after a request-policy join', async () => {
    const { upsertPublicGroup, joinGroup, resolvePendingJoin, findByGroupId } = await import('../db/public-groups-db');
    await upsertPublicGroup(makeGroup({ joinPolicy: 'request' }));
    await joinGroup({ groupId: 'grp_1' }, 'requester-1');

    let record = await findByGroupId('grp_1');
    expect(record?.pendingRequests).toEqual(['requester-1']);

    await resolvePendingJoin('grp_1', 'requester-1');
    record = await findByGroupId('grp_1');
    expect(record?.pendingRequests).toEqual([]);
  });

  it('only removes the resolved relayId, leaving other pending entries untouched', async () => {
    const { upsertPublicGroup, joinGroup, resolvePendingJoin, findByGroupId } = await import('../db/public-groups-db');
    await upsertPublicGroup(makeGroup({ joinPolicy: 'request' }));
    await joinGroup({ groupId: 'grp_1' }, 'requester-1');
    await joinGroup({ groupId: 'grp_1' }, 'requester-2');

    await resolvePendingJoin('grp_1', 'requester-1');
    const record = await findByGroupId('grp_1');
    expect(record?.pendingRequests).toEqual(['requester-2']);
  });

  it('is idempotent — resolving an already-resolved or unknown relayId is a harmless no-op', async () => {
    const { upsertPublicGroup, joinGroup, resolvePendingJoin, findByGroupId } = await import('../db/public-groups-db');
    await upsertPublicGroup(makeGroup({ joinPolicy: 'request' }));
    await joinGroup({ groupId: 'grp_1' }, 'requester-1');

    await resolvePendingJoin('grp_1', 'requester-1');
    await expect(resolvePendingJoin('grp_1', 'requester-1')).resolves.not.toBeNull();
    await expect(resolvePendingJoin('grp_1', 'never-joined')).resolves.not.toBeNull();

    const record = await findByGroupId('grp_1');
    expect(record?.pendingRequests).toEqual([]);
  });

  it('returns null for an unknown groupId', async () => {
    const { resolvePendingJoin } = await import('../db/public-groups-db');
    expect(await resolvePendingJoin('no-such-group', 'anyone')).toBeNull();
  });
});

describe('updateGroupOwner', () => {
  it('updates ownerRelayId and bumps updatedAt', async () => {
    const { upsertPublicGroup, updateGroupOwner, findByGroupId } = await import('../db/public-groups-db');
    const created = await upsertPublicGroup(makeGroup({ ownerRelayId: 'old-owner' }));

    const updated = await updateGroupOwner('grp_1', 'new-owner');
    expect(updated?.ownerRelayId).toBe('new-owner');
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    const record = await findByGroupId('grp_1');
    expect(record?.ownerRelayId).toBe('new-owner');
  });

  it('does not touch pendingMembers/pendingRequests', async () => {
    const { upsertPublicGroup, joinGroup, updateGroupOwner, findByGroupId } = await import('../db/public-groups-db');
    await upsertPublicGroup(makeGroup({ joinPolicy: 'open', ownerRelayId: 'old-owner' }));
    await joinGroup({ groupId: 'grp_1' }, 'joiner-1');

    await updateGroupOwner('grp_1', 'new-owner');
    const record = await findByGroupId('grp_1');
    expect(record?.pendingMembers).toEqual(['joiner-1']);
    expect(record?.ownerRelayId).toBe('new-owner');
  });

  it('returns null and does nothing for an unknown groupId (private groups have no directory row to sync)', async () => {
    const { updateGroupOwner, findByGroupId } = await import('../db/public-groups-db');
    expect(await updateGroupOwner('no-such-group', 'new-owner')).toBeNull();
    expect(await findByGroupId('no-such-group')).toBeNull();
  });
});
