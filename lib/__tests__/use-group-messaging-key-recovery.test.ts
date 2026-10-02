/**
 * @vitest-environment node
 *
 * Regression coverage for a real gap found via a fresh adversarial review
 * of the same-session group-key-rotation feature (see
 * use-group-messaging-key-rotation.test.ts): removeGroupMember's key
 * distribution only retries session establishment for ~18s
 * (fanoutEncryptedGroupEnvelope) before giving up silently — a member
 * offline/slow during that window never received the new epoch key at all,
 * with no error shown and no way to recover (getKeyHexForEpoch only
 * tolerates the current epoch or one behind), permanently locking them out
 * of the group until some future rotation happened to include them again.
 *
 * Fix: when a group_message/group_file arrives under an epoch we don't
 * recognize, ask the sender (already validated against OUR local roster —
 * a legitimate current member) to resend the current key directly
 * (key_request/key_share group_events), rather than just dropping forever.
 *
 * node environment: message content here is encrypted via
 * lib/crypto/group-crypto.ts's chacha20poly1305 — no jsdom Uint8Array-realm
 * concerns apply to that primitive (relay-crypto.test.ts runs fine under
 * jsdom for the same cipher), but this file also needs fake-indexeddb
 * (below) for group-key-cache's persistence layer, which is simplest under
 * node — matches this session's convention of picking node whenever a test
 * touches persistence directly rather than through component rendering.
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
import { encryptWithGroupKey, buildGroupAad, generateGroupKey } from '../crypto/group-crypto';
import { fromHex, toHex } from '../crypto/hex-utils';
import type { GroupConversation } from '../hooks/messaging-types';

const OWNER_ID = 'relay:owner';
const MEMBER_A_ID = 'relay:member-a';
const OUTSIDER_ID = 'relay:outsider';

function ref<T>(current: T) {
  return { current };
}

function makeFakeSession() {
  return {
    encryptAsync: vi.fn(async (bytes: Uint8Array) => bytes),
    serialize: vi.fn(() => ({})),
  };
}

function decodeSentPayload(hexBlob: string): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(fromHex(hexBlob)));
}

beforeEach(async () => {
  await initStorage(new Uint8Array(32).fill(5));
  await clearAllStorage();
});

describe('receiving a group_message under an unrecognized epoch', () => {
  function makeHarness(groupId: string, ownIdentity: string, memberIds: string[]) {
    const group: GroupConversation = {
      id: groupId, name: 'G', memberIds, ownerId: OWNER_ID, adminIds: [OWNER_ID],
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    let groups = [group];
    const sendMessage = vi.fn();
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage }),
      sessionsRef: ref(new Map(memberIds.filter((id) => id !== ownIdentity).map((id) => [id, { relayId: id, session: makeFakeSession(), publicKeyHex: id }]))),
      identityRef: ref<any>({ relayId: ownIdentity }),
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

  function makeUnrecognizedEpochMessage(groupId: string, epoch: number, senderId: string) {
    const someKey = generateGroupKey();
    const cipherBytes = encryptWithGroupKey(someKey, new TextEncoder().encode(JSON.stringify({ text: 'hi' })), buildGroupAad(groupId, epoch, senderId));
    return { type: 'group_message', groupId, groupMessageId: 'm1', epoch, ciphertext: toHex(cipherBytes), timestamp: new Date().toISOString() };
  }

  it('requests the current key from the sender, when the sender is a validated fellow member', async () => {
    const groupId = 'grp-recovery-1';
    const { handleGroupMessage, sendMessage } = makeHarness(groupId, MEMBER_A_ID, [OWNER_ID, MEMBER_A_ID]);

    const handled = handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 7, OWNER_ID), OWNER_ID, 'msg1', new Uint8Array());
    expect(handled).toBe(true);
    // requestMissingGroupKey's fan-out is fire-and-forget (async encrypt+send) — give it a tick.
    await new Promise((r) => setTimeout(r, 0));

    const sent = sendMessage.mock.calls.find((c) => c[0] === OWNER_ID);
    expect(sent).toBeTruthy();
    const payload = decodeSentPayload(sent![1]);
    expect(payload.type).toBe('group_event');
    expect(payload.action).toBe('key_request');
    expect(payload.epoch).toBe(7);
  });

  it('does NOT request a key from a sender who is not actually a member of our local group roster', () => {
    const groupId = 'grp-recovery-2';
    // OUTSIDER_ID is deliberately not in memberIds.
    const { handleGroupMessage, sendMessage } = makeHarness(groupId, MEMBER_A_ID, [OWNER_ID, MEMBER_A_ID]);

    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 3, OUTSIDER_ID), OUTSIDER_ID, 'msg1', new Uint8Array());

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rate-limits repeated requests for the same still-missing epoch', async () => {
    const groupId = 'grp-recovery-3';
    const { handleGroupMessage, sendMessage } = makeHarness(groupId, MEMBER_A_ID, [OWNER_ID, MEMBER_A_ID]);

    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 4, OWNER_ID), OWNER_ID, 'm1', new Uint8Array());
    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 4, OWNER_ID), OWNER_ID, 'm2', new Uint8Array());
    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rate-limits repeated requests from the same sender even when they claim a DIFFERENT epoch each time', async () => {
    // Regression: the rate limit used to be keyed by groupId+epoch, and
    // epoch comes straight from the (attacker-controlled) incoming message
    // — a malicious member could bypass the throttle entirely by simply
    // incrementing the claimed epoch on every message. Keyed by
    // groupId+sender now, so this must stay throttled regardless of epoch.
    const groupId = 'grp-recovery-7';
    const { handleGroupMessage, sendMessage } = makeHarness(groupId, MEMBER_A_ID, [OWNER_ID, MEMBER_A_ID]);

    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 100, OWNER_ID), OWNER_ID, 'm1', new Uint8Array());
    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 101, OWNER_ID), OWNER_ID, 'm2', new Uint8Array());
    handleGroupMessage(makeUnrecognizedEpochMessage(groupId, 102, OWNER_ID), OWNER_ID, 'm3', new Uint8Array());
    await new Promise((r) => setTimeout(r, 0));

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('responding to an incoming key_request', () => {
  it('replies with our current epoch key when the requester is a validated fellow member', async () => {
    const groupId = 'grp-recovery-4';
    const group: GroupConversation = {
      id: groupId, name: 'G', memberIds: [OWNER_ID, MEMBER_A_ID], ownerId: OWNER_ID, adminIds: [OWNER_ID],
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    let groups = [group];
    const sendMessage = vi.fn();
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage }),
      sessionsRef: ref(new Map([[MEMBER_A_ID, { relayId: MEMBER_A_ID, session: makeFakeSession(), publicKeyHex: 'aa' }]])),
      identityRef: ref<any>({ relayId: OWNER_ID }),
      groupsRef: ref([group]),
    };
    const state = {
      contacts: [] as any[],
      get groups() { return groups; },
      setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
    };
    const activeKeyHex = toHex(generateGroupKey());
    setActiveGroupKey(groupId, { epoch: 9, keyHex: activeKeyHex });

    const { handleGroupMessage } = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });

    const handled = handleGroupMessage(
      { type: 'group_event', action: 'key_request', groupId, actorId: MEMBER_A_ID, epoch: 5, timestamp: new Date().toISOString() },
      MEMBER_A_ID, 'evt1', new Uint8Array()
    );
    expect(handled).toBe(true);
    await new Promise((r) => setTimeout(r, 0));

    const sent = sendMessage.mock.calls.find((c) => c[0] === MEMBER_A_ID);
    expect(sent).toBeTruthy();
    const payload = decodeSentPayload(sent![1]);
    expect(payload.action).toBe('key_share');
    expect(payload.epoch).toBe(9);
    expect(payload.groupKeyHex).toBe(activeKeyHex);
  });

  it('does not reply when the requester is not a member of our local roster', () => {
    const groupId = 'grp-recovery-5';
    const group: GroupConversation = {
      id: groupId, name: 'G', memberIds: [OWNER_ID], ownerId: OWNER_ID, adminIds: [OWNER_ID],
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    let groups = [group];
    const sendMessage = vi.fn();
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage }),
      sessionsRef: ref(new Map()),
      identityRef: ref<any>({ relayId: OWNER_ID }),
      groupsRef: ref([group]),
    };
    const state = {
      contacts: [] as any[],
      get groups() { return groups; },
      setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
    };
    setActiveGroupKey(groupId, { epoch: 1, keyHex: toHex(generateGroupKey()) });
    const { handleGroupMessage } = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });

    handleGroupMessage(
      { type: 'group_event', action: 'key_request', groupId, actorId: OUTSIDER_ID, epoch: 1, timestamp: new Date().toISOString() },
      OUTSIDER_ID, 'evt1', new Uint8Array()
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('receiving a key_share', () => {
  it('updates the local epoch key cache without appending a visible system message', () => {
    const groupId = 'grp-recovery-6';
    const group: GroupConversation = {
      id: groupId, name: 'G', memberIds: [OWNER_ID, MEMBER_A_ID], ownerId: OWNER_ID, adminIds: [OWNER_ID],
      createdAt: Date.now(), updatedAt: Date.now(), messages: [],
    };
    let groups = [group];
    const shared = {
      wsRef: ref<any>({ isReady: () => true, sendMessage: vi.fn() }),
      sessionsRef: ref(new Map()),
      identityRef: ref<any>({ relayId: MEMBER_A_ID }),
      groupsRef: ref([group]),
    };
    const state = {
      contacts: [] as any[],
      get groups() { return groups; },
      setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
    };
    const { handleGroupMessage, getGroups } = { ...useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() }), getGroups: () => groups };
    const sharedKeyHex = toHex(generateGroupKey());

    handleGroupMessage(
      { type: 'group_event', action: 'key_share', groupId, actorId: OWNER_ID, epoch: 12, groupKeyHex: sharedKeyHex, timestamp: new Date().toISOString() },
      OWNER_ID, 'evt1', new Uint8Array()
    );

    expect(getActiveGroupKey(groupId)).toEqual({ epoch: 12, keyHex: sharedKeyHex });
    expect(getGroups().find((g) => g.id === groupId)?.messages).toHaveLength(0);
  });
});
