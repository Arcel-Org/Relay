/**
 * Regression coverage for the group-storage cross-tab race: a background
 * tab's React state goes stale the moment ANOTHER tab writes a change to
 * the shared `relay_groups_<relayId>` localStorage key — the relay only allows
 * one live WS connection per identity, but that doesn't stop the background
 * tab's own debounced persist effect from later firing and silently
 * overwriting the foreground tab's newer write with its own stale copy.
 *
 * Fixed by listening for the browser's `storage` event (fires in every
 * OTHER tab whenever the value actually changes, never the tab that wrote
 * it) and re-hydrating from the fresh value. This file simulates two tabs
 * as two separate hook instances sharing the same jsdom `window`/
 * `localStorage`, and manually dispatches the StorageEvent a real second
 * tab's write would trigger (jsdom doesn't simulate real cross-window
 * storage propagation on its own).
 *
 * useCallback/useRef/useEffect are mocked to plain-object/passthrough
 * equivalents (same technique as use-group-messaging-governance.test.ts) so
 * the hook can be invoked directly, no component tree required — critically,
 * the mocked useEffect still calls the real window.addEventListener, so the
 * 'storage' listener this fix relies on is genuinely installed.
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

function makeTabInstance(relayId: string) {
  let groups: GroupConversation[] = [];
  const shared = {
    wsRef: ref<any>(null),
    sessionsRef: ref(new Map()),
    identityRef: ref<any>({ relayId }),
    groupsRef: ref<GroupConversation[]>([]),
  };
  const state = {
    contacts: [] as any[],
    get groups() { return groups; },
    setGroups: (updater: any) => { groups = typeof updater === 'function' ? updater(groups) : updater; },
  };
  const hook = useGroupMessaging({ shared: shared as any, state: state as any, initiateKeyExchange: vi.fn() });
  return { ...hook, getGroups: () => groups };
}

const STORAGE_KEY = 'relay_groups_relay:shared-user';

beforeEach(() => {
  localStorage.clear();
});

describe('cross-tab group sync via the storage event', () => {
  it("a background tab's in-memory groups refresh when another tab writes a change to the shared key", () => {
    // Represents the OTHER (background) tab, sharing the same identity's
    // storage key. A real browser only delivers the `storage` event to
    // tabs other than the one that wrote — jsdom has a single shared
    // `window`, so this test dispatches the event directly rather than
    // modeling a genuine second writing tab (which would also receive its
    // own dispatch here, unlike in a real browser).
    const tabB = makeTabInstance('relay:shared-user');

    // Simulate another tab's debounced persist effect having already
    // written a rename to localStorage.
    const updatedGroups: GroupConversation[] = [{
      id: 'grp1', name: 'Renamed in the other tab', memberIds: ['relay:shared-user'], ownerId: 'relay:shared-user',
      adminIds: ['relay:shared-user'], createdAt: 1, updatedAt: 2, messages: [],
    }];
    const newValue = JSON.stringify(updatedGroups);
    localStorage.setItem(STORAGE_KEY, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue, storageArea: localStorage }));

    expect(tabB.getGroups()).toHaveLength(1);
    expect(tabB.getGroups()[0].name).toBe('Renamed in the other tab');
  });

  it('ignores storage events for unrelated keys', () => {
    const tabB = makeTabInstance('relay:shared-user');
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'some-unrelated-key',
      newValue: JSON.stringify([{ id: 'x' }]),
      storageArea: localStorage,
    }));
    expect(tabB.getGroups()).toHaveLength(0);
  });

  it('ignores storage events for a different identity\'s groups key', () => {
    const tabB = makeTabInstance('relay:shared-user');
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'relay_groups_relay:someone-else',
      newValue: JSON.stringify([{ id: 'x' }]),
      storageArea: localStorage,
    }));
    expect(tabB.getGroups()).toHaveLength(0);
  });
});
