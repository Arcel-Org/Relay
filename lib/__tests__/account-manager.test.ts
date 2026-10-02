/**
 * Coverage for lib/auth/account-manager.ts — previously zero direct unit
 * tests despite 19 exported functions (round-6 audit, LOW finding #8).
 * Focuses on the properties that matter most: rollback-on-server-failure for
 * every sync path (username claim/release, display name, bio, privacy), the
 * validation rules on claimUsername, and refreshAccountProfile's
 * server-preferred merge (including the immutable-avatar exception).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initializeAccountProfile,
  getAccountProfile,
  saveAccountProfile,
  updateAccountProfile,
  claimUsername,
  releaseUsername,
  getClaimedUsernames,
  generateShortCode,
  removeShortCode,
  updateDisplayName,
  updateBio,
  toggleUnlistedStatus,
  refreshAccountProfile,
  exportProfile,
  importProfile,
  getProfileDisplayInfo,
  syncProfileToServer,
} from '../auth/account-manager';

const RELAY_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';

function mockFetchOk(body: unknown = {}) {
  return vi.fn(async () => ({ ok: true, json: async () => body }));
}
function mockFetchFail(status = 500, body: unknown = { error: 'boom' }) {
  return vi.fn(async () => ({ ok: false, status, json: async () => body }));
}
function lookupRelayIdByUsername(username: string): string | null {
  return getClaimedUsernames()[username.toLowerCase()]?.relayId ?? null;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', mockFetchOk());
});

describe('initializeAccountProfile / getAccountProfile', () => {
  it('creates a fresh profile when none exists, and persists it', () => {
    const profile = initializeAccountProfile(RELAY_ID);
    expect(profile.relayId).toBe(RELAY_ID);
    expect(profile.isUnlisted).toBe(false);
    expect(getAccountProfile(RELAY_ID)).toEqual(profile);
  });

  it('returns the existing profile on a second call rather than resetting it', () => {
    const first = initializeAccountProfile(RELAY_ID);
    const updated = updateAccountProfile(RELAY_ID, { displayName: 'Alice' });
    expect(updated.createdAt).toBe(first.createdAt);
    const second = initializeAccountProfile(RELAY_ID);
    expect(second.displayName).toBe('Alice');
  });

  it('getAccountProfile returns null when nothing is stored', () => {
    expect(getAccountProfile('never-existed')).toBeNull();
  });

  it('throws RelayError on corrupted stored JSON rather than crashing silently', () => {
    localStorage.setItem(`relay_account_profile_${RELAY_ID}`, '{not json');
    expect(() => getAccountProfile(RELAY_ID)).toThrow();
    expect(() => initializeAccountProfile(RELAY_ID)).toThrow();
  });
});

describe('updateAccountProfile', () => {
  it('never lets relayId or createdAt be overwritten by the patch', () => {
    const original = initializeAccountProfile(RELAY_ID);
    const updated = updateAccountProfile(RELAY_ID, {
      relayId: 'someone-else',
      createdAt: 0,
      displayName: 'Bob',
    } as never);
    expect(updated.relayId).toBe(RELAY_ID);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.displayName).toBe('Bob');
  });
});

describe('claimUsername', () => {
  it('rejects empty, too-long, invalid-character, and reserved usernames without touching storage', async () => {
    initializeAccountProfile(RELAY_ID);
    expect((await claimUsername(RELAY_ID, '   ')).success).toBe(false);
    expect((await claimUsername(RELAY_ID, 'a'.repeat(21))).success).toBe(false);
    expect((await claimUsername(RELAY_ID, 'not valid!')).success).toBe(false);
    const reserved = await claimUsername(RELAY_ID, 'admin');
    expect(reserved.success).toBe(false);
    expect(reserved.error).toMatch(/reserved/i);
    expect(getAccountProfile(RELAY_ID)?.username).toBeUndefined();
  });

  it('on success, saves the profile and registers the claimed-usernames entry', async () => {
    initializeAccountProfile(RELAY_ID);
    const result = await claimUsername(RELAY_ID, 'Alice');
    expect(result.success).toBe(true);
    expect(getAccountProfile(RELAY_ID)?.username).toBe('alice');
    expect(lookupRelayIdByUsername('alice')).toBe(RELAY_ID);
  });

  it('rolls back both the profile and the claimed-usernames registry if the server sync fails', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchFail(409, { error: 'Username taken' }));

    const result = await claimUsername(RELAY_ID, 'Alice');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Username taken/);
    expect(getAccountProfile(RELAY_ID)?.username).toBeUndefined();
    expect(lookupRelayIdByUsername('alice')).toBeNull();
  });
});

describe('releaseUsername', () => {
  it('clears the username locally and from the claimed-usernames registry', async () => {
    initializeAccountProfile(RELAY_ID);
    await claimUsername(RELAY_ID, 'alice');

    await releaseUsername(RELAY_ID);
    expect(getAccountProfile(RELAY_ID)?.username).toBeUndefined();
    expect(lookupRelayIdByUsername('alice')).toBeNull();
  });

  it('rolls back (restores username + registry entry) if the server sync fails', async () => {
    initializeAccountProfile(RELAY_ID);
    await claimUsername(RELAY_ID, 'alice');
    vi.stubGlobal('fetch', mockFetchFail(500));

    await expect(releaseUsername(RELAY_ID)).rejects.toThrow();
    expect(getAccountProfile(RELAY_ID)?.username).toBe('alice');
    expect(lookupRelayIdByUsername('alice')).toBe(RELAY_ID);
  });
});

describe('generateShortCode / removeShortCode', () => {
  it('generateShortCode saves the server-returned code on success', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchOk({ profile: { shortCode: 'xoep-4910' } }));

    const result = await generateShortCode(RELAY_ID);
    expect(result.success).toBe(true);
    expect(result.shortCode).toBe('xoep-4910');
    expect(getAccountProfile(RELAY_ID)?.shortCode).toBe('xoep-4910');
  });

  it('generateShortCode treats a 200 response carrying shortCodeError as a failure', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchOk({ shortCodeError: 'Too many attempts' }));

    const result = await generateShortCode(RELAY_ID);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Too many attempts');
    expect(getAccountProfile(RELAY_ID)?.shortCode).toBeUndefined();
  });

  it('removeShortCode clears the cached code on success', async () => {
    updateAccountProfile(RELAY_ID, { shortCode: 'xoep-4910' });
    vi.stubGlobal('fetch', mockFetchOk({}));

    const result = await removeShortCode(RELAY_ID);
    expect(result.success).toBe(true);
    expect(getAccountProfile(RELAY_ID)?.shortCode).toBeUndefined();
  });

  it('removeShortCode surfaces a non-ok server response as a failure without clearing the local cache', async () => {
    updateAccountProfile(RELAY_ID, { shortCode: 'xoep-4910' });
    vi.stubGlobal('fetch', mockFetchFail(500));

    const result = await removeShortCode(RELAY_ID);
    expect(result.success).toBe(false);
    expect(getAccountProfile(RELAY_ID)?.shortCode).toBe('xoep-4910');
  });
});

describe('updateDisplayName / updateBio', () => {
  it('rejects an over-length display name before ever touching storage or the network', async () => {
    initializeAccountProfile(RELAY_ID);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(updateDisplayName(RELAY_ID, 'x'.repeat(101))).rejects.toThrow(/100 characters/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an over-length bio before ever touching storage or the network', async () => {
    initializeAccountProfile(RELAY_ID);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(updateBio(RELAY_ID, 'x'.repeat(501))).rejects.toThrow(/500 characters/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('updateDisplayName rolls back the local profile if the server sync fails', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchFail(500));
    await expect(updateDisplayName(RELAY_ID, 'Alice')).rejects.toThrow();
    expect(getAccountProfile(RELAY_ID)?.displayName).toBeUndefined();
  });

  it('updateBio rolls back the local profile if the server sync fails', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchFail(500));
    await expect(updateBio(RELAY_ID, 'hello')).rejects.toThrow();
    expect(getAccountProfile(RELAY_ID)?.bio).toBeUndefined();
  });
});

describe('toggleUnlistedStatus', () => {
  it('flips isUnlisted on success', async () => {
    initializeAccountProfile(RELAY_ID);
    const updated = await toggleUnlistedStatus(RELAY_ID);
    expect(updated.isUnlisted).toBe(true);
  });

  it('rolls back to the previous value if the server sync fails', async () => {
    initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', mockFetchFail(500));
    await expect(toggleUnlistedStatus(RELAY_ID)).rejects.toThrow();
    expect(getAccountProfile(RELAY_ID)?.isUnlisted).toBe(false);
  });
});

describe('refreshAccountProfile', () => {
  it('prefers server values but keeps a locally-claimed username the server has no record of', async () => {
    initializeAccountProfile(RELAY_ID);
    await claimUsername(RELAY_ID, 'alice');
    vi.stubGlobal('fetch', mockFetchOk({ displayName: 'Server Name', bio: null, isUnlisted: true }));

    const merged = await refreshAccountProfile(RELAY_ID);
    expect(merged.displayName).toBe('Server Name');
    expect(merged.isUnlisted).toBe(true);
    expect(merged.username).toBe('alice'); // server said nothing about it — keep local
  });

  it('never overwrites an already-cached avatar from the server payload', async () => {
    updateAccountProfile(RELAY_ID, { avatarEmoji: '🦊', avatarColor: '#123456' });
    vi.stubGlobal('fetch', mockFetchOk({ avatarEmoji: '🐙', avatarColor: '#abcdef' }));

    const merged = await refreshAccountProfile(RELAY_ID);
    expect(merged.avatarEmoji).toBe('🦊');
    expect(merged.avatarColor).toBe('#123456');
  });

  it('falls back to the cached profile if the fetch itself throws', async () => {
    const cached = initializeAccountProfile(RELAY_ID);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await refreshAccountProfile(RELAY_ID);
    expect(result).toEqual(cached);
  });
});

describe('exportProfile / importProfile', () => {
  it('round-trips a profile through export then import', () => {
    updateAccountProfile(RELAY_ID, { displayName: 'Alice' });
    const exported = exportProfile(RELAY_ID);
    localStorage.clear();
    const imported = importProfile(exported);
    expect(imported.relayId).toBe(RELAY_ID);
    expect(imported.displayName).toBe('Alice');
    expect(getAccountProfile(RELAY_ID)?.displayName).toBe('Alice');
  });

  it('exportProfile throws when no profile exists', () => {
    expect(() => exportProfile('never-existed')).toThrow(/No profile found/);
  });

  it('importProfile rejects a payload missing relayId', () => {
    expect(() => importProfile(JSON.stringify({ displayName: 'no id' }))).toThrow(/missing relayId/);
  });
});

describe('getProfileDisplayInfo', () => {
  it('falls back to the short-hash identifier when no profile exists', () => {
    const info = getProfileDisplayInfo('never-existed');
    expect(info.showUsername).toBe(false);
  });

  it('hides the username entirely when the profile is unlisted, even if claimed', async () => {
    initializeAccountProfile(RELAY_ID);
    await claimUsername(RELAY_ID, 'alice');
    await toggleUnlistedStatus(RELAY_ID);

    const info = getProfileDisplayInfo(RELAY_ID);
    expect(info.showUsername).toBe(false);
    expect(info.identifier).not.toMatch(/@alice/);
  });

  it('shows @username as the identifier when claimed and listed', async () => {
    initializeAccountProfile(RELAY_ID);
    await claimUsername(RELAY_ID, 'alice');

    const info = getProfileDisplayInfo(RELAY_ID);
    expect(info.showUsername).toBe(true);
    expect(info.identifier).toBe('@alice');
  });
});

describe('syncProfileToServer', () => {
  it('returns ok:true on a successful response', async () => {
    vi.stubGlobal('fetch', mockFetchOk({}));
    const result = await syncProfileToServer(RELAY_ID, { displayName: 'Alice' });
    expect(result).toEqual({ ok: true });
  });

  it('returns ok:false with the server-provided reason on a non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetchFail(400, { error: 'Invalid field' }));
    const result = await syncProfileToServer(RELAY_ID, { displayName: 'Alice' });
    expect(result).toEqual({ ok: false, reason: 'Invalid field' });
  });

  it('returns ok:false with the network error message when fetch itself throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await syncProfileToServer(RELAY_ID, { displayName: 'Alice' });
    expect(result).toEqual({ ok: false, reason: 'network down' });
  });
});

describe('getClaimedUsernames', () => {
  it('throws RelayError on corrupted registry JSON', () => {
    localStorage.setItem('relay_claimed_usernames', '{not json');
    expect(() => getClaimedUsernames()).toThrow();
  });
});
