/**
 * Relay ID format — canonical source of truth
 *
 * Two-tier identity, redesigned when the operating company moved from the previous company name
 * to Arcel (no real users existed yet, so this is a breaking format change,
 * not a migration):
 *
 * - The **Relay ID** is the actual, permanent identity: 128 bits of
 *   sha256(publicKey), hex-encoded and grouped into 8 dash-separated
 *   4-character chunks (`xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`, 39 chars).
 *   Still deterministically derived from the public key — self-certifying,
 *   like the previously-prefixed format — so a client can always
 *   independently verify a claimed Relay ID actually matches a given public
 *   key, without trusting a server. No prefix.
 *   It's long enough that it isn't the thing you casually read out loud or
 *   share — that's what the short code and username are for.
 *
 * - The **short code** (see SHORT_CODE_REGEX / generateShortCode below) is a
 *   separate, opt-in, human-shareable alias: 4 random lowercase letters, a
 *   dash, 4 random digits (e.g. `xoep-4910`). Unlike the Relay ID it is NOT
 *   derived from anything — it's randomly generated and claimed server-side
 *   (see lib/auth/account-manager.ts's generateShortCode/removeShortCode and
 *   app/api/profile/update's shortCode handling), the same
 *   claim-with-transactional-uniqueness pattern already used for usernames.
 *   A user only has one if they explicitly opted in.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';

const HEX_GROUP = '[0-9a-f]{4}';
export const RELAY_ID_REGEX = new RegExp(`^${Array(8).fill(HEX_GROUP).join('-')}$`);

/** 4 lowercase letters, a dash, 4 digits — e.g. `xoep-4910`. */
export const SHORT_CODE_REGEX = /^[a-z]{4}-[0-9]{4}$/;

/**
 * Derive the canonical Relay ID from an X25519 public key.
 *
 * Uses the first 16 bytes (128 bits) of sha256(publicKey), hex-encoded and
 * split into 8 dash-separated 4-character groups. Deterministic — the same
 * public key always produces the same Relay ID, which is what makes it
 * self-certifying (no server needs to be trusted to vouch for the mapping).
 */
export function relayIdFromPublicKey(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  const hex = Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += 4) groups.push(hex.slice(i, i + 4));
  return groups.join('-');
}

export function relayIdFromPublicKeyHex(publicKeyHex: string): string {
  return relayIdFromPublicKey(hexToBytes(publicKeyHex));
}

export function isValidRelayId(value: unknown): value is string {
  return typeof value === 'string' && RELAY_ID_REGEX.test(value);
}

/**
 * Trim + lowercase and validate. Returns the canonical form, or null if the
 * input isn't a valid Relay ID. There's only one accepted shape now (no
 * prefix, so no bare-vs-canonical distinction like the old format had).
 */
export function normalizeRelayId(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  return RELAY_ID_REGEX.test(trimmed) ? trimmed : null;
}

export function isValidShortCode(value: unknown): value is string {
  return typeof value === 'string' && SHORT_CODE_REGEX.test(value);
}

export function normalizeShortCode(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  return SHORT_CODE_REGEX.test(trimmed) ? trimmed : null;
}

// Handles that must never be claimable as a username or generated as a
// short code's letters — impersonation risk (a contact named "@support" or
// with the short code "help-xxxx" could be mistaken for this app's own
// staff/product). Previously enforced client-side ONLY (account-manager.ts's
// claimUsername, duplicated in a second, dead copy in username-lookup.ts) —
// a client bypassing that UI entirely and posting straight to
// /api/profile/update could claim any of these. Centralized here so the
// server-side username/short-code checks and the client-side claimUsername
// pre-validation all share one list.
export const RESERVED_HANDLES = ['relay', 'arcel', 'support', 'admin', 'official', 'system', 'bot', 'help', 'root', 'null', 'none', 'anon', 'test', 'user', 'info'];

export function isReservedHandle(value: string): boolean {
  return RESERVED_HANDLES.includes(value.toLowerCase());
}

const SHORT_CODE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Pick a uniformly random index in [0, max) from a CSPRNG byte, rejecting
 * (not just modulo-reducing) values that would bias the distribution —
 * e.g. for max=26, byte values 234-255 (22 values) would otherwise map to
 * indices 0-21 twice as often as 22-25. max must be <= 256.
 */
function randomIndex(max: number): number {
  const limit = 256 - (256 % max);
  let byte: number;
  do {
    byte = crypto.getRandomValues(new Uint8Array(1))[0];
  } while (byte >= limit);
  return byte % max;
}

/**
 * Generate a random candidate short code (4 letters + 4 digits). Purely
 * random — NOT derived from anything, so the caller must check it against
 * the server for uniqueness and retry on collision (same shape as claiming a
 * username; see lib/auth/account-manager.ts's generateShortCode).
 *
 * Uses a CSPRNG (Math.random() is not one — not seeded from an
 * unpredictable source, not suitable even for a low-stakes value like this
 * one) for defense-in-depth: short codes are a discoverability alias, not a
 * secret, and uniqueness is enforced transactionally server-side regardless
 * of how a candidate is generated, so this was never an exploitable gap —
 * just worth not being the one place in lib/crypto/ using a non-CSPRNG
 * source, matching every other value generated in this file/directory.
 */
export function generateShortCode(): string {
  let letters = '';
  for (let i = 0; i < 4; i++) {
    letters += SHORT_CODE_LETTERS[randomIndex(SHORT_CODE_LETTERS.length)];
  }
  const digits = Array.from({ length: 4 }, () => randomIndex(10)).join('');
  return `${letters}-${digits}`;
}
