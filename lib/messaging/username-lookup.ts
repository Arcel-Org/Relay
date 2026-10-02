/**
 * Username and Profile Lookup Service
 * 
 * Handles:
 * - Looking up users by username
 * - Converting @username to relayId
 * - Storing profile information in users.json
 * - Syncing account manager data with users.json
 */

import { getAccountProfile } from '@/lib/auth/account-manager';
import { log } from '@/lib/platform/logger';
import { normalizeRelayId, relayIdFromPublicKeyHex, isValidShortCode } from '@/lib/crypto/relay-id';
import { cacheContactKeysFromDirectory } from '@/lib/messaging/contact-key-cache';

// Type for user profile data stored in users.json
export interface UserProfileData {
  relayId: string;
  displayName?: string;
  username?: string;
  /** Opt-in short discoverability code (e.g. `xoep-4910`) — unset if the user never generated one. */
  shortCode?: string;
  bio?: string;
  isUnlisted: boolean;
  avatarEmoji?: string;
  avatarColor?: string;
  publicKeyHex?: string;
  pqPublicKeyHex?: string;
}

/**
 * Pre-seed the contact-key-cache's PQ (and classical) public key from a
 * profile lookup — an authenticated HTTPS channel, independent of the WS
 * relay connection. Closes the first-contact PQ-downgrade gap documented in
 * key-exchange.ts: without this, loadContactPqPublicKey() only ever gets
 * populated by a PREVIOUSLY observed key-exchange offer over WS, so a
 * network MITM tampering with that specific channel could strip the PQ
 * advertisement on the very first exchange with a new contact undetected.
 * With this cache pre-seeded before any key exchange happens, that same
 * exchange now goes through the "known PQ-capable peer sent a classical-only
 * offer" refusal path key-exchange.ts already has for re-negotiation.
 *
 * publicKeyHex is self-certifying (relayId = hash of it) — verified against
 * the relayId being looked up before anything is trusted from this response,
 * so a server returning a mismatched key for a relayId can't poison the
 * cache with an arbitrary substitute key.
 */
function seedContactKeysFromProfile(relayId: string, publicKeyHex?: string, pqPublicKeyHex?: string): void {
  if (!publicKeyHex) return;
  try {
    if (relayIdFromPublicKeyHex(publicKeyHex) !== relayId) {
      log.warn(`[Profile] publicKeyHex returned for ${relayId} does not match its relayId — ignoring`);
      return;
    }
  } catch {
    return;
  }
  cacheContactKeysFromDirectory(relayId, publicKeyHex, pqPublicKeyHex);
}

/**
 * Shared GET /api/profile/lookup?<param>=<value> caller — used by both the
 * relayId-only lookups below and resolveUserInput (which needs the full
 * profile, not just the relayId, to avoid a second round-trip).
 */
async function fetchProfileByParam(param: 'username' | 'shortCode', value: string): Promise<UserProfileData | null> {
  try {
    const response = await fetch(`/api/profile/lookup?${param}=${encodeURIComponent(value)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.relayId) {
        seedContactKeysFromProfile(data.relayId, data.publicKeyHex, data.pqPublicKeyHex);
        return data as UserProfileData;
      }
    }
  } catch (err) {
    log.warn(`Server ${param} lookup failed:`, err);
  }
  return null;
}

/**
 * Look up a user's relayId by their @username
 * Supports both local lookup and API lookup in production
 */
export async function lookupUserByUsername(username: string): Promise<string | null> {
  if (!username || !username.trim()) {
    log.warn('Empty username provided to lookup');
    return null;
  }

  const trimmed = username.toLowerCase().replace(/^@/, '').trim();

  if (!trimmed) {
    log.warn('Username is empty after trimming');
    return null;
  }

  // Server authority first
  const profile = await fetchProfileByParam('username', trimmed);
  if (profile) return profile.relayId;

  // Fallback to local storage cache
  try {
    const claimedUsernames = localStorage.getItem('relay_claimed_usernames');
    if (claimedUsernames) {
      const registry = JSON.parse(claimedUsernames);
      const entry = registry[trimmed];
      if (entry?.relayId) {
        return entry.relayId;
      }
    }
  } catch (err) {
    log.error('Error looking up username in local storage:', err);
  }

  return null;
}

/**
 * Look up a user's relayId by their opt-in short code (e.g. `xoep-4910`).
 * Short codes are randomly generated, not derived from anything, so unlike
 * a Relay ID this always requires a server round-trip — same shape as
 * lookupUserByUsername, just a different query param.
 */
export async function lookupUserByShortCode(shortCode: string): Promise<string | null> {
  const trimmed = shortCode.trim().toLowerCase();
  if (!isValidShortCode(trimmed)) return null;

  const profile = await fetchProfileByParam('shortCode', trimmed);
  return profile?.relayId ?? null;
}

/**
 * Look up user profile by ID
 */
export async function lookupUserProfile(
  relayId: string
): Promise<UserProfileData | null> {
  try {
    // Server authority first
    const response = await fetch(`/api/profile/lookup?relayId=${encodeURIComponent(relayId)}`);
    if (response.ok) {
      const data = await response.json();
      seedContactKeysFromProfile(relayId, data.publicKeyHex, data.pqPublicKeyHex);
      return data as UserProfileData;
    }

    // Fallback to local cache (primarily for current user)
    const profile = getAccountProfile(relayId);
    if (profile) {
      return {
        relayId,
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        isUnlisted: profile.isUnlisted,
        avatarEmoji: profile.avatarEmoji,
        avatarColor: profile.avatarColor,
      };
    }

    return null;
  } catch (err) {
    log.error('Error looking up user profile:', err);
    return null;
  }
}

/**
 * Get display name for a user (handles privacy mode)
 */
export async function getUserDisplayName(relayId: string): Promise<string> {
  try {
    const profile = await lookupUserProfile(relayId);
    if (!profile) return relayId;

    // If unlisted, don't show username
    if (profile.isUnlisted) return profile.displayName || relayId;

    // Show display name, username, or fallback to ID
    if (profile.displayName) return profile.displayName;
    if (profile.username) return `@${profile.username}`;
    return relayId;
  } catch (err) {
    log.error('Error getting user display name:', err);
    return relayId;
  }
}

/**
 * Normalize user ID - handles both @username and relayId formats
 * Returns the actual relayId
 */
export async function normalizeUserId(userInput: string): Promise<string | null> {
  const trimmed = userInput.trim();
  const lower = trimmed.toLowerCase();

  // Full Relay ID — self-certifying, no server round-trip needed to resolve it.
  const canonical = normalizeRelayId(lower);
  if (canonical) return canonical;

  // Opt-in short code (4 letters-4 digits) — always needs a server lookup,
  // it isn't derived from anything.
  if (isValidShortCode(lower)) {
    return await lookupUserByShortCode(lower);
  }

  // If looks like @username (starts with @)
  if (trimmed.startsWith('@')) {
    const username = trimmed.substring(1);
    return await lookupUserByUsername(username);
  }

  // Try as username (alphanumeric + underscore, no dashes)
  if (/^[a-zA-Z0-9_]+$/.test(trimmed)) {
    return await lookupUserByUsername(trimmed);
  }

  return null;
}

/**
 * Same format-detection branching as normalizeUserId, but returns the full
 * profile alongside the relayId in one round trip — for a username/shortCode
 * input, /api/profile/lookup already returns the full profile, so a caller
 * that needs both (e.g. AddContactModal) previously fetched it twice: once
 * (discarded down to just relayId) via lookupUserByUsername/ByShortCode, then
 * again via lookupUserProfile(relayId). This does it in one request instead
 * of two for those two branches.
 *
 * For a raw Relay ID input, `profile` may be null even though `relayId` is
 * returned — the ID is self-certifying and doesn't require the server to
 * recognize it, matching normalizeUserId's existing behavior of resolving a
 * relayId-shaped input unconditionally, with no existence check.
 */
export async function resolveUserInput(
  userInput: string
): Promise<{ relayId: string; profile: UserProfileData | null } | null> {
  const trimmed = userInput.trim();
  const lower = trimmed.toLowerCase();

  const canonical = normalizeRelayId(lower);
  if (canonical) {
    return { relayId: canonical, profile: await lookupUserProfile(canonical) };
  }

  if (isValidShortCode(lower)) {
    const profile = await fetchProfileByParam('shortCode', lower);
    return profile ? { relayId: profile.relayId, profile } : null;
  }

  const username = (trimmed.startsWith('@') ? trimmed.substring(1) : trimmed).toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username)) return null;

  const profile = await fetchProfileByParam('username', username);
  return profile ? { relayId: profile.relayId, profile } : null;
}

/**
 * Get formatted user identifier (respects privacy)
 * Used for display purposes
 */
export async function getFormattedUserIdentifier(relayId: string): Promise<string> {
  try {
    const profile = await lookupUserProfile(relayId);

    if (!profile || profile.isUnlisted) {
      // Privacy mode or no profile - show ID
      return relayId;
    }

    // Show username if claimed, otherwise ID
    if (profile.username) {
      return `@${profile.username}`;
    }

    return relayId;
  } catch (err) {
    log.error('Error getting formatted identifier:', err);
    return relayId;
  }
}
