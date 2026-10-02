/**
 * Regression coverage for the actual security property Phase B exists for:
 * "a member removed from a group cannot decrypt content sent after their
 * removal" — proven at the orchestration level (removeGroupMember actually
 * rotates the epoch key and splits its fan-out so only remaining members
 * receive it), not just at the underlying AEAD-primitive level (already
 * covered by group-crypto.test.ts).
 *
 * useCallback/useRef/useEffect mocked to plain-object/passthrough
 * equivalents — same technique as use-group-messaging-governance.test.ts —
 * so the hook can be invoked directly with no component tree.
 *
 * sessionData.session.encryptAsync is an identity function (returns the
 * plaintext unchanged) rather than a real Session — this test is about
 * WHICH payload gets sent to WHOM, not about the outer pairwise-session
 * encryption itself (already exercised elsewhere, e.g. relay-crypto.test.ts).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initStorage, clearAllStorage } from '../db/relay-store';

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
import { getActiveGroupKey, setActiveGroupKey } from '../messaging/group-key-cache';
import { decryptWithGroupKey, buildGroupAad, generateGroupKey } from '../crypto/group-crypto';
import { fromHex, toHex } from '../crypto/hex-utils';
import type { GroupConversation } from '../hooks/messaging-types';

const OWNER_ID = 'relay:owner';
const MEMBER_A_ID = 'relay:member-a';
const MEMBER_TO_REMOVE_ID = 'relay:member-to-remove';

beforeEach(async () => {
  await initStorage(new Uint8Array(32).fill(3));
  await clearAllStorage();
});
const GROUP_ID = 'grp-rotation-test';

function ref<T>(current: T) {
  return { current };
}

function makeFakeSession() {
  return {
    // Identity "encryption" — returns the plaintext bytes unchanged, so the
    // test can decode exactly what payload was intended for each recipient
    // straight off ws.sendMessage's captured blob.
    encryptAsync: vi.fn(async (bytes: Uint8Array) => bytes),
    serialize: vi.fn(() => ({})),
  };
}

function decodeSentPayload(hexBlob: string): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(fromHex(hexBlob)));
}

function makeHarness() {
  const group: GroupConversation = {
    id: GROUP_ID,
    name: 'Rotation Test Group',
    memberIds: [OWNER_ID, MEMBER_A_ID, MEMBER_TO_REMOVE_ID],
    ownerId: OWNER_ID,
    adminIds: [OWNER_ID],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  let groups = [group];

  const sendMessage = vi.fn();
  const shared = {
    wsRef: ref<any>({ isReady: () => true, sendMessage }),
    sessionsRef: ref(new Map([
      [MEMBER_A_ID, { relayId: MEMBER_A_ID, session: makeFakeSession(), publicKeyHex: 'aa' }],
      [MEMBER_TO_REMOVE_ID, { relayId: MEMBER_TO_REMOVE_ID, session: makeFakeSession(), publicKeyHex: 'bb' }],
    ])),
    identityRef: ref<any>({ relayId: OWNER_ID }),
    groupsRef: ref([group]),
  };

  const state = {
    contacts: [] as any[],
    get groups() { return groups; },
    setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
  };

  const hook = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });
  return { ...hook, sendMessage, getGroups: () => groups };
}

describe('removeGroupMember — epoch key rotation and split fan-out', () => {
  it('rotates to a new epoch, retains the old one as previousEpochKeyHex, and sends the NEW key only to remaining members', async () => {
    const oldKeyHex = toHex(generateGroupKey());
    setActiveGroupKey(GROUP_ID, { epoch: 1, keyHex: oldKeyHex });

    const { removeGroupMember, sendMessage } = makeHarness();
    await removeGroupMember(GROUP_ID, MEMBER_TO_REMOVE_ID);

    const rotated = getActiveGroupKey(GROUP_ID);
    expect(rotated?.epoch).toBe(2);
    expect(rotated?.keyHex).not.toBe(oldKeyHex);
    expect(rotated?.previousEpochKeyHex).toBe(oldKeyHex);

    // Exactly one send to the remaining member (with the new key) and one
    // to the removed member (notice only, per the split fan-out) — the
    // owner is excluded from both since fanoutEncryptedGroupEnvelope never
    // sends to the caller's own relayId.
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const toMemberA = sendMessage.mock.calls.find((c) => c[0] === MEMBER_A_ID);
    const toRemovedMember = sendMessage.mock.calls.find((c) => c[0] === MEMBER_TO_REMOVE_ID);
    expect(toMemberA).toBeTruthy();
    expect(toRemovedMember).toBeTruthy();

    const payloadToMemberA = decodeSentPayload(toMemberA![1]);
    const payloadToRemoved = decodeSentPayload(toRemovedMember![1]);

    expect(payloadToMemberA.action).toBe('remove_member');
    expect(payloadToMemberA.epoch).toBe(2);
    expect(payloadToMemberA.groupKeyHex).toBe(rotated?.keyHex);

    expect(payloadToRemoved.action).toBe('remove_member');
    expect(payloadToRemoved.epoch).toBeUndefined();
    expect(payloadToRemoved.groupKeyHex).toBeUndefined();
  });

  it('proves the actual security property: a message encrypted under the new epoch is not decryptable with only the pre-removal key', async () => {
    const oldKeyBytes = generateGroupKey();
    setActiveGroupKey(GROUP_ID, { epoch: 1, keyHex: toHex(oldKeyBytes) });

    const { removeGroupMember, sendGroupMessage, sendMessage } = makeHarness();
    await removeGroupMember(GROUP_ID, MEMBER_TO_REMOVE_ID);
    sendMessage.mockClear();

    // A message sent AFTER removal, from a remaining member's perspective.
    await sendGroupMessage(GROUP_ID, 'this must stay hidden from the removed member');

    const toMemberA = sendMessage.mock.calls.find((c) => c[0] === MEMBER_A_ID);
    expect(toMemberA).toBeTruthy();
    const payload = decodeSentPayload(toMemberA![1]);
    expect(payload.type).toBe('group_message');
    expect(payload.epoch).toBe(2);

    // The removed member holds only the pre-removal (epoch 1) key —
    // decrypting the new (epoch 2) ciphertext with it must fail.
    const aad = buildGroupAad(GROUP_ID, payload.epoch, OWNER_ID);
    expect(() => decryptWithGroupKey(oldKeyBytes, fromHex(payload.ciphertext), aad)).toThrow();

    // Sanity check the test harness itself: a remaining member holding the
    // real new-epoch key CAN decrypt it, so the failure above is meaningful.
    const newKeyRecord = getActiveGroupKey(GROUP_ID)!;
    const decrypted = decryptWithGroupKey(fromHex(newKeyRecord.keyHex), fromHex(payload.ciphertext), aad);
    expect(JSON.parse(new TextDecoder().decode(decrypted)).text).toBe('this must stay hidden from the removed member');
  });
});

describe('createGroup / addGroupMembers — key bootstrap and distribution', () => {
  it('createGroup bootstraps epoch 1 and includes it in the add_members bootstrap event', async () => {
    const sendMessage = vi.fn();
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage }),
      sessionsRef: ref(new Map([[MEMBER_A_ID, { relayId: MEMBER_A_ID, session: makeFakeSession(), publicKeyHex: 'aa' }]])),
      identityRef: ref<any>({ relayId: OWNER_ID }),
      groupsRef: ref([]),
    };
    let groups: GroupConversation[] = [];
    const state = {
      contacts: [] as any[],
      get groups() { return groups; },
      setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
    };
    const { createGroup } = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });

    const group = createGroup('New Group', [MEMBER_A_ID]);
    // createGroup itself is synchronous — the bootstrap fan-out is fire-
    // and-forget (async encrypt+send in the background) — give it a tick.
    await new Promise((r) => setTimeout(r, 0));

    const created = getActiveGroupKey(group.id);
    expect(created?.epoch).toBe(1);

    const sent = sendMessage.mock.calls.find((c) => c[0] === MEMBER_A_ID);
    expect(sent).toBeTruthy();
    const payload = decodeSentPayload(sent![1]);
    expect(payload.action).toBe('add_members');
    expect(payload.epoch).toBe(1);
    expect(payload.groupKeyHex).toBe(created?.keyHex);
  });

  it('addGroupMembers distributes the CURRENT epoch key to a newly-added member, without rotating for existing members', async () => {
    const NEW_MEMBER_ID = 'relay:new-member';
    setActiveGroupKey(GROUP_ID, { epoch: 5, keyHex: toHex(generateGroupKey()) });
    const preAddKey = getActiveGroupKey(GROUP_ID)!;

    const group: GroupConversation = {
      id: GROUP_ID,
      name: 'Existing Group',
      memberIds: [OWNER_ID, MEMBER_A_ID],
      ownerId: OWNER_ID,
      adminIds: [OWNER_ID],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    let groups = [group];
    const sendMessage = vi.fn();
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage }),
      sessionsRef: ref(new Map([
        [MEMBER_A_ID, { relayId: MEMBER_A_ID, session: makeFakeSession(), publicKeyHex: 'aa' }],
        [NEW_MEMBER_ID, { relayId: NEW_MEMBER_ID, session: makeFakeSession(), publicKeyHex: 'cc' }],
      ])),
      identityRef: ref<any>({ relayId: OWNER_ID }),
      groupsRef: ref([group]),
    };
    const state = {
      contacts: [] as any[],
      get groups() { return groups; },
      setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
    };
    const { addGroupMembers } = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });

    await addGroupMembers(GROUP_ID, [NEW_MEMBER_ID]);

    // No rotation on add — a new member never receives history anyway, so
    // there's nothing an unrotated key would expose to them.
    expect(getActiveGroupKey(GROUP_ID)).toEqual(preAddKey);

    const toNewMember = sendMessage.mock.calls.find((c) => c[0] === NEW_MEMBER_ID);
    expect(toNewMember).toBeTruthy();
    const payload = decodeSentPayload(toNewMember![1]);
    expect(payload.epoch).toBe(preAddKey.epoch);
    expect(payload.groupKeyHex).toBe(preAddKey.keyHex);
  });
});
