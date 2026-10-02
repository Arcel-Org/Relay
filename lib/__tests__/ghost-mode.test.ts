/**
 * Direct coverage for lib/messaging/ghost-mode.ts — auto-expiring-message
 * (per-conversation TTL) logic. Previously zero test coverage despite being
 * a real data-loss mechanism (messages get permanently deleted) with a
 * non-obvious guard: computeExpiresAt only stamps an expiry when the user
 * is ACTIVELY viewing the ghost thread, not just because an interval is
 * configured — get that wrong and either nothing ever expires, or normal
 * messages get silently deleted.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/db/relay-store', () => ({
  getAllMessagesForConversation: vi.fn(),
  deleteMessage: vi.fn(),
}));

import {
  getGhostSeconds,
  setGhostSeconds,
  formatGhostLabel,
  computeExpiresAt,
  getGhostModeActive,
  setGhostModeActive,
  filterExpired,
  sweepExpired,
  GHOST_PRESETS,
} from '../messaging/ghost-mode';
import { getAllMessagesForConversation, deleteMessage } from '@/lib/db/relay-store';

const CONVO = 'convo-1';

// activeViews (ghost-thread-is-currently-being-looked-at state) is a plain
// module-level Map, not localStorage-backed — unlike getGhostSeconds'
// persisted setting, it has no per-test isolation of its own. Explicitly
// deactivate every conversationId used anywhere in this file so one test's
// setGhostModeActive(..., true) can't leak into a later, unrelated test.
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  for (const id of [CONVO, 'convo-a', 'convo-b', 'other-convo']) {
    setGhostModeActive(id, false);
  }
});

describe('getGhostSeconds / setGhostSeconds', () => {
  it('defaults to 0 (off) when nothing is set', () => {
    expect(getGhostSeconds(CONVO)).toBe(0);
  });

  it('round-trips a positive value', () => {
    setGhostSeconds(CONVO, 300);
    expect(getGhostSeconds(CONVO)).toBe(300);
  });

  it('setting to 0 clears the stored value rather than persisting "0"', () => {
    setGhostSeconds(CONVO, 300);
    setGhostSeconds(CONVO, 0);
    expect(getGhostSeconds(CONVO)).toBe(0);
    expect(localStorage.getItem('relay:ghost:' + CONVO)).toBeNull();
  });

  it('ignores corrupted stored data rather than throwing', () => {
    localStorage.setItem('relay:ghost:' + CONVO, 'not-a-number');
    expect(getGhostSeconds(CONVO)).toBe(0);
  });

  it('is per-conversation, not global', () => {
    setGhostSeconds('convo-a', 60);
    setGhostSeconds('convo-b', 3600);
    expect(getGhostSeconds('convo-a')).toBe(60);
    expect(getGhostSeconds('convo-b')).toBe(3600);
  });
});

describe('formatGhostLabel', () => {
  it('uses the preset label when the value matches exactly', () => {
    expect(formatGhostLabel(GHOST_PRESETS.FIVE_MINUTES)).toBe('5 minutes');
  });

  it('falls back to a computed unit for non-preset values', () => {
    expect(formatGhostLabel(45)).toBe('45s');
    expect(formatGhostLabel(120)).toBe('2m');
    expect(formatGhostLabel(7200)).toBe('2h');
    expect(formatGhostLabel(172800)).toBe('2d');
  });
});

describe('computeExpiresAt — the active-thread guard', () => {
  it('returns undefined when ghost mode is off, even if the thread is active', () => {
    setGhostModeActive(CONVO, true);
    expect(computeExpiresAt(CONVO)).toBeUndefined();
  });

  it('returns undefined when ghost mode is on but the user is NOT viewing the ghost thread', () => {
    setGhostSeconds(CONVO, 60);
    setGhostModeActive(CONVO, false);
    expect(computeExpiresAt(CONVO)).toBeUndefined();
  });

  it('THE GUARD: only stamps an expiry when BOTH an interval is set AND the thread is actively being viewed', () => {
    setGhostSeconds(CONVO, 60);
    setGhostModeActive(CONVO, true);
    const before = Date.now();
    const expiresAt = computeExpiresAt(CONVO);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThan(before + 61_000);
  });

  it('is scoped per conversation — being active in one thread does not leak an expiry into another', () => {
    setGhostSeconds(CONVO, 60);
    setGhostSeconds('other-convo', 60);
    setGhostModeActive(CONVO, true);
    // never activated for 'other-convo'
    expect(computeExpiresAt(CONVO)).toBeDefined();
    expect(computeExpiresAt('other-convo')).toBeUndefined();
  });
});

describe('getGhostModeActive / setGhostModeActive', () => {
  it('defaults to inactive and toggles independently per conversation', () => {
    expect(getGhostModeActive(CONVO)).toBe(false);
    setGhostModeActive(CONVO, true);
    expect(getGhostModeActive(CONVO)).toBe(true);
    expect(getGhostModeActive('other-convo')).toBe(false);
    setGhostModeActive(CONVO, false);
    expect(getGhostModeActive(CONVO)).toBe(false);
  });
});

describe('filterExpired', () => {
  it('keeps messages with no expiresAt', () => {
    const items: { id: number; expiresAt?: number }[] = [{ id: 1 }, { id: 2 }];
    expect(filterExpired(items, 1000)).toEqual(items);
  });

  it('keeps messages whose expiresAt is still in the future', () => {
    const items = [{ id: 1, expiresAt: 2000 }];
    expect(filterExpired(items, 1000)).toEqual(items);
  });

  it('drops messages whose expiresAt has passed', () => {
    const items = [{ id: 1, expiresAt: 500 }, { id: 2, expiresAt: 2000 }];
    expect(filterExpired(items, 1000)).toEqual([{ id: 2, expiresAt: 2000 }]);
  });

  it('drops a message whose expiresAt is exactly now (inclusive boundary)', () => {
    expect(filterExpired([{ id: 1, expiresAt: 1000 }], 1000)).toEqual([]);
  });
});

describe('sweepExpired', () => {
  it('deletes only messages whose expiresAt has passed, across multiple conversations', async () => {
    const now = Date.now();
    vi.mocked(getAllMessagesForConversation).mockImplementation(async (cid: string) => {
      if (cid === 'convo-a') {
        return [
          { id: 'm1', expiresAt: now - 1000 } as any, // expired
          { id: 'm2', expiresAt: now + 60_000 } as any, // not yet
          { id: 'm3' } as any, // no expiry at all
        ];
      }
      return [{ id: 'm4', expiresAt: now - 5000 } as any]; // expired
    });
    vi.mocked(deleteMessage).mockResolvedValue(undefined);

    const onDeleted = vi.fn();
    const count = await sweepExpired(['convo-a', 'convo-b'], onDeleted);

    expect(count).toBe(2);
    expect(deleteMessage).toHaveBeenCalledWith('m1');
    expect(deleteMessage).toHaveBeenCalledWith('m4');
    expect(deleteMessage).not.toHaveBeenCalledWith('m2');
    expect(deleteMessage).not.toHaveBeenCalledWith('m3');
    expect(onDeleted).toHaveBeenCalledWith('convo-a', 'm1');
    expect(onDeleted).toHaveBeenCalledWith('convo-b', 'm4');
  });

  it('a delete failure for one message does not stop the sweep for the rest', async () => {
    const now = Date.now();
    vi.mocked(getAllMessagesForConversation).mockResolvedValue([
      { id: 'm1', expiresAt: now - 1000 } as any,
      { id: 'm2', expiresAt: now - 1000 } as any,
    ]);
    vi.mocked(deleteMessage).mockImplementation(async (id: string) => {
      if (id === 'm1') throw new Error('delete failed');
    });

    const count = await sweepExpired(['convo-a']);
    expect(count).toBe(1); // only m2 counted
  });

  it('a conversation whose message lookup throws does not stop the sweep for other conversations', async () => {
    const now = Date.now();
    vi.mocked(getAllMessagesForConversation).mockImplementation(async (cid: string) => {
      if (cid === 'broken') throw new Error('lookup failed');
      return [{ id: 'm1', expiresAt: now - 1000 } as any];
    });
    vi.mocked(deleteMessage).mockResolvedValue(undefined);

    const count = await sweepExpired(['broken', 'fine']);
    expect(count).toBe(1);
  });

  it('returns 0 with no side effects when nothing is expired', async () => {
    const now = Date.now();
    vi.mocked(getAllMessagesForConversation).mockResolvedValue([{ id: 'm1', expiresAt: now + 60_000 } as any]);

    expect(await sweepExpired(['convo-a'])).toBe(0);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
