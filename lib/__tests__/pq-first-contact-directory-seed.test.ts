/**
 * Regression coverage for closing the first-contact PQ-downgrade gap
 * documented in key-exchange.ts: loadContactPqPublicKey() used to only ever
 * get populated by a PREVIOUSLY observed key-exchange offer over WS, so a
 * network MITM tampering with that one channel could strip the PQ
 * advertisement on the very first exchange with a brand-new contact and
 * neither side would have any cached evidence to catch it.
 *
 * The fix: username-lookup.ts's lookupUserProfile now pre-seeds the
 * contact-key-cache from the profile-directory HTTP(S) lookup — a channel
 * independent of the WS relay connection — before any key exchange happens.
 * This file covers both halves: the cache function itself
 * (contact-key-cache.ts) and the wiring + self-certification check
 * (username-lookup.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeypair } from '../crypto/relay-crypto';
import { relayIdFromPublicKey } from '../crypto/relay-id';
import { toHex } from '../crypto/hex-utils';
import {
  cacheContactKeysFromDirectory,
  loadContactPublicKey,
  loadContactPqPublicKey,
} from '../messaging/contact-key-cache';

function freshRelayIdAndKey() {
  const kp = generateKeypair();
  const publicKeyHex = toHex(kp.publicKey);
  const relayId = relayIdFromPublicKey(kp.publicKey);
  return { relayId, publicKeyHex };
}

describe('cacheContactKeysFromDirectory', () => {
  it('populates both caches when nothing is cached yet for this relayId', () => {
    const { relayId, publicKeyHex } = freshRelayIdAndKey();
    cacheContactKeysFromDirectory(relayId, publicKeyHex, 'deadbeef');
    expect(loadContactPublicKey(relayId)).toBe(publicKeyHex);
    expect(loadContactPqPublicKey(relayId)).toBe('deadbeef');
  });

  it('works with no PQ key present (genuinely classical peer)', () => {
    const { relayId, publicKeyHex } = freshRelayIdAndKey();
    cacheContactKeysFromDirectory(relayId, publicKeyHex);
    expect(loadContactPublicKey(relayId)).toBe(publicKeyHex);
    expect(loadContactPqPublicKey(relayId)).toBeNull();
  });

  it('never overwrites an already-cached key — the wire-based exchange is authoritative once established', () => {
    const { relayId, publicKeyHex } = freshRelayIdAndKey();
    cacheContactKeysFromDirectory(relayId, publicKeyHex, 'aaaa');

    const { publicKeyHex: differentKey } = freshRelayIdAndKey();
    cacheContactKeysFromDirectory(relayId, differentKey, 'bbbb');

    expect(loadContactPublicKey(relayId)).toBe(publicKeyHex);
    expect(loadContactPqPublicKey(relayId)).toBe('aaaa');
  });
});

describe('lookupUserProfile: directory-seed wiring + self-certification', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('seeds the PQ key cache from a profile lookup response for a brand-new relayId', async () => {
    const { relayId, publicKeyHex } = freshRelayIdAndKey();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ relayId, publicKeyHex, pqPublicKeyHex: 'cafe' }),
    } as Response)));

    const { lookupUserProfile } = await import('../messaging/username-lookup');
    const { loadContactPqPublicKey: reload } = await import('../messaging/contact-key-cache');

    await lookupUserProfile(relayId);
    expect(reload(relayId)).toBe('cafe');
  });

  it('ignores publicKeyHex that does not actually hash to the requested relayId (server returning a mismatched/forged key)', async () => {
    const { relayId } = freshRelayIdAndKey();
    const { publicKeyHex: unrelatedKey } = freshRelayIdAndKey();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ relayId, publicKeyHex: unrelatedKey, pqPublicKeyHex: 'cafe' }),
    } as Response)));

    const { lookupUserProfile } = await import('../messaging/username-lookup');
    const { loadContactPqPublicKey: reloadPq, loadContactPublicKey: reloadClassical } = await import('../messaging/contact-key-cache');

    await lookupUserProfile(relayId);
    expect(reloadPq(relayId)).toBeNull();
    expect(reloadClassical(relayId)).toBeNull();
  });

  it('does nothing when the profile response carries no publicKeyHex at all', async () => {
    const { relayId } = freshRelayIdAndKey();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ relayId, displayName: 'Alice' }),
    } as Response)));

    const { lookupUserProfile } = await import('../messaging/username-lookup');
    const { loadContactPqPublicKey: reload } = await import('../messaging/contact-key-cache');

    const profile = await lookupUserProfile(relayId);
    expect(profile?.displayName).toBe('Alice');
    expect(reload(relayId)).toBeNull();
  });
});
