/**
 * clearRatchetState() only deleted the in-memory ratchetStateCache entry —
 * never the persisted IndexedDB copy. Found during an adversarial design
 * review for a not-yet-built resync feature that would have depended on
 * this function (it had zero callers before that review, so the bug was
 * latent and unexercised). Without the persisted clear,
 * hydrateContactKeyCache() — called on every app start/reload — reads the
 * still-present stale ratchetState back off disk and resurrects it,
 * silently undoing the clear the moment the page reloads.
 *
 * Uses fake-indexeddb (a real IndexedDB implementation), matching
 * relay-store.test.ts's convention, so the actual persisted round-trip is
 * exercised for real rather than mocked.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { initStorage, addContact, clearAllStorage, type StoredContact } from '../db/relay-store';
import { saveRatchetState, loadRatchetState, clearRatchetState, hydrateContactKeyCache } from '../messaging/contact-key-cache';
import type { SerializedSession } from '../crypto/relay-crypto';

const PRIVATE_KEY = new Uint8Array(32).fill(9);
const RELAY_ID = 'relay:ratchetcleartest1';

function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    relayId: RELAY_ID,
    name: 'test-contact',
    publicKeyHex: 'ab'.repeat(32),
    addedAt: Date.now(),
    ...overrides,
  };
}

// enqueueContactWrite chains writes onto a per-contact promise (serialized
// read-modify-write against fake-indexeddb) — a single setTimeout(0) only
// yields one macrotask, which isn't reliably enough ticks for a chained
// write (or two, back-to-back) to actually land. A short real delay proved
// flaky (~1 in 5) under load; polling until the chain drains is exact.
async function flushContactWrites(): Promise<void> {
  const { __contactWriteChainsForTests } = await import('../messaging/contact-key-cache');
  for (let i = 0; i < 50; i++) {
    const pending = Array.from(__contactWriteChainsForTests.values());
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

function makeSession(counter: string): SerializedSession {
  return {
    v: 1,
    dictVersion: 1,
    sendChainKeyHex: 'cc'.repeat(32),
    counter,
    recvChainKeyHex: 'dd'.repeat(32),
    recvChainCounter: '0',
    skipped: [],
  };
}

beforeEach(async () => {
  await initStorage(PRIVATE_KEY);
  await clearAllStorage();
  await addContact(makeContact());
});

describe('clearRatchetState — durable clear, not just in-memory', () => {
  it('the in-memory cache no longer returns the state after clearing', async () => {
    saveRatchetState(RELAY_ID, makeSession('5'));
    await flushContactWrites(); // let the fire-and-forget write settle

    expect(loadRatchetState(RELAY_ID)).toEqual(makeSession('5'));
    clearRatchetState(RELAY_ID);
    expect(loadRatchetState(RELAY_ID)).toBeNull();
  });

  it('a stale persisted ratchet does NOT resurrect after a simulated reload (hydrate)', async () => {
    saveRatchetState(RELAY_ID, makeSession('5'));
    await flushContactWrites();

    clearRatchetState(RELAY_ID);
    await flushContactWrites(); // let the durable clear settle

    // Simulate a reload: the in-memory cache is gone entirely (it's a plain
    // module-level Map, wiped by re-importing in a real reload) — the only
    // way this test can prove the PERSISTED copy was actually cleared is by
    // re-hydrating from storage and confirming nothing comes back.
    await hydrateContactKeyCache();

    expect(loadRatchetState(RELAY_ID)).toBeNull();
  });

  it('regression guard: without the durable clear, hydrate WOULD have resurrected stale state', async () => {
    // Sanity-check the test harness itself: prove hydrate DOES restore a
    // genuinely-persisted (non-cleared) ratchet, so the previous test's
    // "stays null" result is meaningful and not just hydrate being a no-op.
    saveRatchetState(RELAY_ID, makeSession('7'));
    await flushContactWrites();

    await hydrateContactKeyCache();

    expect(loadRatchetState(RELAY_ID)).toEqual(makeSession('7'));
  });
});
