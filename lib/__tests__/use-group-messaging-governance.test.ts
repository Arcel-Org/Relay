/**
 * Regression/coverage for the group governance enforcement in
 * lib/hooks/use-group-messaging.ts's handleGroupMessage (the receive side of
 * every 'group_event': rename, add/remove member, set_admin,
 * transfer_ownership, set_disappear). This is the actual security boundary —
 * every member's client independently re-checks the ACTOR's permission
 * against its own local view of the group before applying anything, since a
 * malicious or compromised peer could send a forged group_event regardless
 * of what its own UI would allow. No test file exercised this before despite
 * it being exactly the kind of logic where a privilege-escalation bug (a
 * plain member forging an owner-only action, or an admin smuggling an
 * ownership takeover inside an otherwise-innocuous rename) would go
 * completely undetected.
 *
 * useCallback/useRef/useEffect are mocked to plain-object/passthrough
 * equivalents (same technique as receive-signature-verification.test.ts)
 * so the hook can be invoked directly, no component tree required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useRef: (init: unknown) => ({ current: init }),
    useEffect: (fn: () => void) => fn(),
  };
});

import { useGroupMessaging } from '../hooks/use-group-messaging';
import type { GroupConversation } from '../hooks/messaging-types';

function ref<T>(current: T) {
  return { current };
}

function makeGroup(overrides: Partial<GroupConversation> = {}): GroupConversation {
  return {
    id: 'grp1',
    name: 'Test Group',
    memberIds: ['relay:owner', 'relay:admin', 'relay:member'],
    ownerId: 'relay:owner',
    adminIds: ['relay:owner', 'relay:admin'],
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
    ...overrides,
  };
}

function makeHarness(initialGroups: GroupConversation[], currentId = 'relay:owner') {
  let groups = initialGroups;

  const shared = {
    wsRef: ref<any>(null),
    sessionsRef: ref(new Map()),
    identityRef: ref<any>({ relayId: currentId }),
    groupsRef: ref(initialGroups),
  };

  const state = {
    contacts: [] as any[],
    get groups() { return groups; },
    setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
  };

  const hook = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });
  return { ...hook, getGroups: () => groups };
}

/** Build a minimal, well-formed group_event envelope. */
function event(overrides: Record<string, any>) {
  return { type: 'group_event', groupId: 'grp1', ...overrides };
}

describe('handleGroupMessage: group_event actor/sender integrity', () => {
  it('rejects an event whose claimed actorId does not match who actually sent it', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    // relay:member sends the frame, but claims to be acting as the owner.
    handleGroupMessage(event({ action: 'rename', actorId: 'relay:owner', groupName: 'Hijacked' }), 'relay:member', 'm1', new Uint8Array());
    expect(getGroups()[0].name).toBe('Test Group');
  });
});

describe('handleGroupMessage: owner-or-admin actions (rename/add_members/remove_member/set_disappear)', () => {
  it('a plain member cannot rename the group', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(event({ action: 'rename', actorId: 'relay:member', groupName: 'Renamed by member' }), 'relay:member', 'm1', new Uint8Array());
    expect(getGroups()[0].name).toBe('Test Group');
  });

  it('an admin CAN rename the group', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(event({ action: 'rename', actorId: 'relay:admin', groupName: 'Renamed by admin' }), 'relay:admin', 'm1', new Uint8Array());
    expect(getGroups()[0].name).toBe('Renamed by admin');
  });

  it('a plain member cannot remove another member', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'remove_member', actorId: 'relay:member', removedMemberId: 'relay:admin' }),
      'relay:member', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].memberIds).toContain('relay:admin');
  });

  it('an admin CAN remove a plain member, but not the owner', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'remove_member', actorId: 'relay:admin', removedMemberId: 'relay:member' }),
      'relay:admin', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].memberIds).not.toContain('relay:member');

    handleGroupMessage(
      event({ action: 'remove_member', actorId: 'relay:admin', removedMemberId: 'relay:owner' }),
      'relay:admin', 'm2', new Uint8Array()
    );
    expect(getGroups()[0].memberIds).toContain('relay:owner');
  });

  it('a plain member cannot change the group disappearing-message timer', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(event({ action: 'set_disappear', actorId: 'relay:member', disappearAfter: 3600 }), 'relay:member', 'm1', new Uint8Array());
    expect(getGroups()[0].disappearAfter).toBeUndefined();
  });

  it('an admin CAN set the disappearing-message timer, bounded and type-checked', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(event({ action: 'set_disappear', actorId: 'relay:admin', disappearAfter: 3600 }), 'relay:admin', 'm1', new Uint8Array());
    expect(getGroups()[0].disappearAfter).toBe(3600);

    // An out-of-range / non-numeric value is never applied as-is — the
    // payload's numeric field is untrusted input. The current
    // implementation treats it as "turn disappearing messages off" rather
    // than "ignore and keep the existing timer"; either is safe (no
    // privilege boundary is crossed either way — the actor must already be
    // owner/admin to reach this code), but this locks in the actual
    // behavior so a future change here is a deliberate decision, not silent.
    handleGroupMessage(event({ action: 'set_disappear', actorId: 'relay:admin', disappearAfter: 999999999 }), 'relay:admin', 'm2', new Uint8Array());
    expect(getGroups()[0].disappearAfter).toBeUndefined();
  });
});

describe('handleGroupMessage: owner-only actions (set_admin/transfer_ownership)', () => {
  it('an admin (not owner) cannot promote another member to admin', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'set_admin', actorId: 'relay:admin', targetMemberId: 'relay:member', isAdmin: true }),
      'relay:admin', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].adminIds).not.toContain('relay:member');
  });

  it('the owner CAN promote a member to admin', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'set_admin', actorId: 'relay:owner', targetMemberId: 'relay:member', isAdmin: true }),
      'relay:owner', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].adminIds).toContain('relay:member');
  });

  it('an admin cannot transfer ownership to themselves', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'transfer_ownership', actorId: 'relay:admin', newOwnerId: 'relay:admin' }),
      'relay:admin', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].ownerId).toBe('relay:owner');
  });

  it('the owner CAN transfer ownership', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({ action: 'transfer_ownership', actorId: 'relay:owner', newOwnerId: 'relay:member' }),
      'relay:owner', 'm1', new Uint8Array()
    );
    expect(getGroups()[0].ownerId).toBe('relay:member');
    // The new owner is folded into adminIds too.
    expect(getGroups()[0].adminIds).toContain('relay:member');
  });
});

describe('handleGroupMessage: an admin cannot smuggle owner/adminIds changes inside an innocuous action', () => {
  it('a rename event from an admin cannot also overwrite ownerId/adminIds, even if the payload includes them', () => {
    const { handleGroupMessage, getGroups } = makeHarness([makeGroup()]);
    handleGroupMessage(
      event({
        action: 'rename',
        actorId: 'relay:admin',
        groupName: 'Innocuous rename',
        // Forged/extraneous fields a hostile client might attach — must be ignored.
        ownerId: 'relay:admin',
        adminIds: ['relay:admin'],
        memberIds: ['relay:admin'],
      }),
      'relay:admin', 'm1', new Uint8Array()
    );
    const g = getGroups()[0];
    expect(g.name).toBe('Innocuous rename');
    expect(g.ownerId).toBe('relay:owner');
    expect(g.adminIds).toEqual(['relay:owner', 'relay:admin']);
    expect(g.memberIds).toEqual(['relay:owner', 'relay:admin', 'relay:member']);
  });
});

describe('handleGroupMessage: bootstrapping a brand-new (locally unknown) group', () => {
  it('does not bootstrap a group from anything other than a properly-authorized add_members event', () => {
    const { handleGroupMessage, getGroups } = makeHarness([], 'relay:me');
    handleGroupMessage(
      event({ action: 'rename', actorId: 'relay:stranger', groupName: 'Fake Group' }),
      'relay:stranger', 'm1', new Uint8Array()
    );
    expect(getGroups()).toHaveLength(0);
  });

  it('does not bootstrap a group that does not actually include the current user as a member', () => {
    const { handleGroupMessage, getGroups } = makeHarness([], 'relay:me');
    handleGroupMessage(
      event({ action: 'add_members', actorId: 'relay:owner', ownerId: 'relay:owner', memberIds: ['relay:owner', 'relay:other'] }),
      'relay:owner', 'm1', new Uint8Array()
    );
    expect(getGroups()).toHaveLength(0);
  });

  it('bootstraps a group from a properly-authorized add_members event that includes the current user', () => {
    const { handleGroupMessage, getGroups } = makeHarness([], 'relay:me');
    handleGroupMessage(
      event({
        action: 'add_members',
        actorId: 'relay:owner',
        groupName: 'New Group',
        ownerId: 'relay:owner',
        adminIds: ['relay:owner'],
        memberIds: ['relay:owner', 'relay:me'],
      }),
      'relay:owner', 'm1', new Uint8Array()
    );
    expect(getGroups()).toHaveLength(1);
    expect(getGroups()[0].memberIds).toContain('relay:me');
    expect(getGroups()[0].ownerId).toBe('relay:owner');
  });
});
