/**
 * Account Manager - Handles user profile, username, display name, and privacy settings
 * 
 * Features:
 * - Custom username claiming and management
 * - Display name management
 * - Privacy settings (listed/unlisted)
 * - Account profile data persistence
 */

import { log } from '@/lib/platform/logger';
import { RelayError } from '@/lib/relay/relay-error';
import { getShortHash } from '@/lib/messaging/relay-display';
import { isReservedHandle } from '@/lib/crypto/relay-id';

export interface AccountProfile {
  relayId: string;
  username?: string;
  displayName?: string;
  bio?: string;
  isUnlisted: boolean;
  createdAt: number;
  updatedAt: number;
  // Avatar — permanently assigned at signup, never changed
  avatarEmoji?: string;
  avatarColor?: string;
  // Opt-in short discoverability code (e.g. `xoep-4910`) — server-generated,
  // unset unless the user explicitly requested one (see generateShortCode/
  // removeShortCode below). Cached locally the same way username is.
  shortCode?: string;
}

const ACCOUNT_STORAGE_KEY = 'relay_account_profile';
const CLAIMED_USERNAMES_KEY = 'relay_claimed_usernames'; // Track claimed usernames across sessions

type SyncableProfilePatch = {
  displayName?: string | null;
  username?: string | null;
  bio?: string | null;
  isUnlisted?: boolean;
};

function normalizeOptionalText(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Initialize or get account profile
 */
export function initializeAccountProfile(relayId: string): AccountProfile {
  const existing = localStorage.getItem(`${ACCOUNT_STORAGE_KEY}_${relayId}`);
  if (existing) {
    try {
      return JSON.parse(existing);
    } catch (err) {
      log.error('Failed to parse account profile:', err);
      throw new RelayError('STORAGE_CORRUPT', 'Account profile data is corrupted', err);
    }
  }

  const profile: AccountProfile = {
    relayId,
    isUnlisted: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  saveAccountProfile(profile);
  return profile;
}

/**
 * Get current account profile
 */
export function getAccountProfile(relayId: string): AccountProfile | null {
  const data = localStorage.getItem(`${ACCOUNT_STORAGE_KEY}_${relayId}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as AccountProfile;
  } catch (err) {
    throw new RelayError('STORAGE_CORRUPT', `Account profile for ${relayId} is corrupted`, err);
  }
}

/**
 * Save account profile
 */
export function saveAccountProfile(profile: AccountProfile): void {
  try {
    profile.updatedAt = Date.now();
    localStorage.setItem(`${ACCOUNT_STORAGE_KEY}_${profile.relayId}`, JSON.stringify(profile));
  } catch (err) {
    log.error('Failed to save account profile:', err);
    throw new Error('Failed to save account profile');
  }
}

/**
 * Update account profile fields
 */
export function updateAccountProfile(relayId: string, updates: Partial<AccountProfile>): AccountProfile {
  const profile = getAccountProfile(relayId) || initializeAccountProfile(relayId);
  
  const updated: AccountProfile = {
    ...profile,
    ...updates,
    relayId: profile.relayId, // Never allow changing this
    createdAt: profile.createdAt, // Never allow changing this
  };

  saveAccountProfile(updated);
  return updated;
}

/**
 * Claim a username (with server-side validation in real implementation)
 */
export async function claimUsername(relayId: string, username: string): Promise<{ success: boolean; error?: string }> {
  const trimmed = username.trim().toLowerCase();

  // Validation
  if (!trimmed) {
    return { success: false, error: 'Username is required' };
  }

  if (trimmed.length < 1 || trimmed.length > 20) {
    return { success: false, error: 'Username must be 1-20 characters' };
  }

  if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    return { success: false, error: 'Username can only contain letters, numbers, and underscores' };
  }

  if (isReservedHandle(trimmed)) {
    return { success: false, error: `@${trimmed} is reserved` };
  }

  try {
    // No pre-check GETs here — both the account's existence and the
    // username's availability are re-derived authoritatively by the
    // syncProfileToServer POST below anyway (a missing account 404s;
    // updateUserProfile's write-lock does an atomic uniqueness check and
    // throws UsernameConflictError on a real collision), so a pre-check
    // would just be an extra request duplicating a check that's about to
    // happen for real. The rollback path a few lines down already handles
    // either failure via `synced.reason`.
    const previous = getAccountProfile(relayId);
    const profile = updateAccountProfile(relayId, { username: trimmed });
    
    // Simulate proof generation (in real implementation, server would provide this)
    const proof = generateUsernameProof(relayId, trimmed);
    
    // Store the claimed username globally for lookup (in real app, server handles this)
    const claimedUsernames = getClaimedUsernames();
    claimedUsernames[trimmed] = {
      relayId,
      claimedAt: Date.now(),
      proof,
    };
    saveClaimedUsernames(claimedUsernames);

    // Sync profile to server
    const synced = await syncProfileToServer(relayId, {
      displayName: profile.displayName,
      username: profile.username,
      bio: profile.bio,
      isUnlisted: profile.isUnlisted,
    });

    if (!synced.ok) {
      // Roll back both the profile and the claimed-usernames registry
      const claimedUsernames = getClaimedUsernames();
      delete claimedUsernames[trimmed];
      saveClaimedUsernames(claimedUsernames);
      if (previous) saveAccountProfile(previous);
      else updateAccountProfile(relayId, { username: undefined });
      return { success: false, error: `Could not claim username: ${synced.reason}` };
    }

    return { success: true };
  } catch (err) {
    log.error('Failed to claim username:', err);
    return { success: false, error: 'Failed to claim username. Please try again.' };
  }
}

/**
 * Release/unclaim a username
 */
export async function releaseUsername(relayId: string): Promise<void> {
  try {
    const profile = getAccountProfile(relayId);
    const previous = profile ? { ...profile } : null;
    let previousClaimEntry: { relayId: string; claimedAt: number; proof: string } | undefined;
    if (profile?.username) {
      const claimedUsernames = getClaimedUsernames();
      previousClaimEntry = claimedUsernames[profile.username];
      delete claimedUsernames[profile.username];
      saveClaimedUsernames(claimedUsernames);
    }

    updateAccountProfile(relayId, { username: undefined });

    const synced = await syncProfileToServer(relayId, { username: null });
    if (!synced.ok) {
      if (previous) saveAccountProfile(previous);
      // Roll back the claimed-usernames registry too, or the local cache
      // would end up claiming the profile still has this username while the
      // registry says it's free — letting another local claim collide with it.
      if (previous?.username && previousClaimEntry) {
        const claimedUsernames = getClaimedUsernames();
        claimedUsernames[previous.username] = previousClaimEntry;
        saveClaimedUsernames(claimedUsernames);
      }
      throw new Error(`Failed to release username on server: ${synced.reason}`);
    }
  } catch (err) {
    log.error('Failed to release username:', err);
    throw new Error('Failed to release username');
  }
}

/**
 * Generate and claim a short discoverability code (e.g. `xoep-4910`) for
 * this account. Unlike username, the caller doesn't choose the value — the
 * server generates a fresh random one and retries internally on collision
 * (see generateAndAssignShortCode in relay-server-db.ts) — so there's no
 * client-side "is it taken" check to do first.
 */
export async function generateShortCode(relayId: string): Promise<{ success: boolean; shortCode?: string; error?: string }> {
  try {
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayId, generateShortCode: true }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return { success: false, error: error?.error || `Server error (${response.status})` };
    }
    const data = await response.json();
    // The route reports a shortCode-specific failure via `shortCodeError` on
    // an otherwise-200 response (any other profile field edits in the same
    // request may have already succeeded) — check that separately from the
    // HTTP status, or a real failure here would look like success.
    if (data?.shortCodeError) {
      return { success: false, error: data.shortCodeError };
    }
    const shortCode: string | undefined = data?.profile?.shortCode;
    if (shortCode) updateAccountProfile(relayId, { shortCode });
    return { success: true, shortCode };
  } catch (err) {
    log.error('Failed to generate short code:', err);
    return { success: false, error: 'Failed to generate short code. Please try again.' };
  }
}

/** Remove this account's short code. They can always generate a new one later. */
export async function removeShortCode(relayId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayId, removeShortCode: true }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      return { success: false, error: error?.error || `Server error (${response.status})` };
    }
    const data = await response.json();
    if (data?.shortCodeError) {
      return { success: false, error: data.shortCodeError };
    }
    updateAccountProfile(relayId, { shortCode: undefined });
    return { success: true };
  } catch (err) {
    log.error('Failed to remove short code:', err);
    return { success: false, error: 'Failed to remove short code. Please try again.' };
  }
}

/**
 * Get claimed usernames registry
 */
export function getClaimedUsernames(): Record<string, { relayId: string; claimedAt: number; proof: string }> {
  const data = localStorage.getItem(CLAIMED_USERNAMES_KEY);
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch (err) {
    throw new RelayError('STORAGE_CORRUPT', 'Claimed usernames registry is corrupted', err);
  }
}

/**
 * Save claimed usernames registry
 */
export function saveClaimedUsernames(data: Record<string, any>): void {
  try {
    localStorage.setItem(CLAIMED_USERNAMES_KEY, JSON.stringify(data));
  } catch (err) {
    log.error('Failed to save claimed usernames:', err);
  }
}

/**
 * Generate proof for username claim (simplified - server would sign this)
 */
function generateUsernameProof(relayId: string, username: string): string {
  // In a real implementation, this would be signed by the server
  // For now, just a deterministic hash
  const data = `${username}${relayId}${Date.now()}`;
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Update display name
 */
export async function updateDisplayName(relayId: string, displayName: string): Promise<AccountProfile> {
  const trimmed = displayName.trim();
  
  if (trimmed.length > 100) {
    throw new Error('Display name must be 100 characters or less');
  }

  const previous = getAccountProfile(relayId);
  const updated = updateAccountProfile(relayId, {
    displayName: normalizeOptionalText(trimmed),
  });

  const synced = await syncProfileToServer(relayId, {
    displayName: trimmed ? trimmed : null,
  });

  if (!synced.ok) {
    if (previous) saveAccountProfile(previous);
    throw new Error(`Failed to sync display name to server: ${synced.reason}`);
  }

  return updated;
}

/**
 * Update bio
 */
export async function updateBio(relayId: string, bio: string): Promise<AccountProfile> {
  const trimmed = bio.trim();
  
  if (trimmed.length > 500) {
    throw new Error('Bio must be 500 characters or less');
  }

  const previous = getAccountProfile(relayId);
  const updated = updateAccountProfile(relayId, {
    bio: normalizeOptionalText(trimmed),
  });

  const synced = await syncProfileToServer(relayId, {
    bio: trimmed ? trimmed : null,
  });

  if (!synced.ok) {
    if (previous) saveAccountProfile(previous);
    throw new Error(`Failed to sync bio to server: ${synced.reason}`);
  }

  return updated;
}

/**
 * Toggle privacy/unlisted status
 */
export async function toggleUnlistedStatus(relayId: string): Promise<AccountProfile> {
  const profile = getAccountProfile(relayId) || initializeAccountProfile(relayId);
  const previous = { ...profile };
  const updated = updateAccountProfile(relayId, { isUnlisted: !profile.isUnlisted });

  const synced = await syncProfileToServer(relayId, { isUnlisted: updated.isUnlisted });
  if (!synced.ok) {
    saveAccountProfile(previous);
    throw new Error(`Failed to sync privacy setting to server: ${synced.reason}`);
  }

  return updated;
}

/**
 * Refresh cached profile from server (authoritative source)
 */
export async function refreshAccountProfile(relayId: string): Promise<AccountProfile> {
  const cached = getAccountProfile(relayId) || initializeAccountProfile(relayId);

  try {
    const response = await fetch(`/api/profile/lookup?relayId=${encodeURIComponent(relayId)}`);
    if (!response.ok) return cached;

    const remote = await response.json();
    const remoteUsername = normalizeOptionalText(remote?.username);
    const remoteShortCode = normalizeOptionalText(remote?.shortCode);
    const merged: AccountProfile = {
      ...cached,
      displayName: normalizeOptionalText(remote?.displayName),
      // Prefer server value; only keep local cache if server has no record of it
      // (avoids wiping a valid locally-claimed username when server is behind)
      username: remoteUsername !== undefined ? remoteUsername : cached.username,
      shortCode: remoteShortCode !== undefined ? remoteShortCode : cached.shortCode,
      bio: normalizeOptionalText(remote?.bio),
      isUnlisted: typeof remote?.isUnlisted === 'boolean' ? remote.isUnlisted : cached.isUnlisted,
      // Only update avatar from server if not already cached locally (immutable after first set)
      avatarEmoji: cached.avatarEmoji ?? (remote?.avatarEmoji || undefined),
      avatarColor: cached.avatarColor ?? (remote?.avatarColor || undefined),
      updatedAt: Date.now(),
    };

    saveAccountProfile(merged);
    return merged;
  } catch (err) {
    log.warn('Profile refresh failed, using cached profile', err);
    return cached;
  }
}

/**
 * Export profile (for backup)
 */
export function exportProfile(relayId: string): string {
  const profile = getAccountProfile(relayId);
  if (!profile) {
    throw new Error('No profile found');
  }
  return JSON.stringify(profile, null, 2);
}

/**
 * Import profile (from backup)
 */
export function importProfile(profileJson: string): AccountProfile {
  try {
    const profile = JSON.parse(profileJson) as AccountProfile;
    
    // Validate required fields
    if (!profile.relayId) {
      throw new Error('Invalid profile: missing relayId');
    }

    saveAccountProfile(profile);
    return profile;
  } catch (err) {
    throw new Error(`Failed to import profile: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Get profile display info
 */
export function getProfileDisplayInfo(relayId: string): {
  displayName: string;
  identifier: string;
  showUsername: boolean;
} {
  const profile = getAccountProfile(relayId);

  if (!profile) {
    return {
      displayName: getShortHash(relayId),
      identifier: getShortHash(relayId),
      showUsername: false,
    };
  }

  if (profile.isUnlisted) {
    // Privacy mode: don't show username even if claimed
    return {
      displayName: profile.displayName || getShortHash(relayId),
      identifier: getShortHash(relayId),
      showUsername: false,
    };
  }

  return {
    displayName: profile.displayName || profile.username || getShortHash(relayId),
    identifier: profile.username ? `@${profile.username}` : (profile.shortCode || getShortHash(relayId)),
    showUsername: !!profile.username,
  };
}

/**
 * Sync profile to server backend
 */
export async function syncProfileToServer(
  relayId: string,
  profile: SyncableProfilePatch
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        relayId,
        ...profile,
      }),
    });

    if (!response.ok) {
      let reason = `Server error (${response.status})`;
      try {
        const error = await response.json();
        if (error?.error) reason = error.error;
      } catch {
        // ignore parse failure
      }
      log.error('Failed to sync profile to server:', reason);
      return { ok: false, reason };
    }

    log.debug('Profile synced to server');
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Network error';
    log.error('Error syncing profile to server:', err);
    return { ok: false, reason };
  }
}
