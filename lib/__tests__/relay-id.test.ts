/**
 * Tests for lib/crypto/relay-id.ts.
 *
 * Format redesign (the earlier Arcel rebrand, no real users existed yet so
 * this is a breaking change, not a migration): the Relay ID dropped its
 * `relay:` prefix and grew from 8 base36 chars to 128 bits (32 hex chars, 8
 * dash-separated 4-char groups) — still deterministically derived from the
 * public key (self-certifying), just longer and prefix-free. A separate,
 * NOT-derived, opt-in short code (4 letters-4 digits, e.g. `xoep-4910`) was
 * added alongside it for human-shareable discoverability.
 */
import { describe, it, expect } from 'vitest';
import {
  relayIdFromPublicKey,
  relayIdFromPublicKeyHex,
  isValidRelayId,
  normalizeRelayId,
  RELAY_ID_REGEX,
  isValidShortCode,
  normalizeShortCode,
  generateShortCode,
  SHORT_CODE_REGEX,
} from '../crypto/relay-id';

function fakeKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i++) key[i] = (seed + i * 7) % 256;
  return key;
}

describe('relayIdFromPublicKey', () => {
  it('is deterministic for the same public key', () => {
    const key = fakeKey(1);
    expect(relayIdFromPublicKey(key)).toBe(relayIdFromPublicKey(key));
  });

  it('produces different ids for different keys', () => {
    expect(relayIdFromPublicKey(fakeKey(1))).not.toBe(relayIdFromPublicKey(fakeKey(2)));
  });

  it('always matches the canonical RELAY_ID_REGEX shape', () => {
    for (let seed = 0; seed < 20; seed++) {
      const id = relayIdFromPublicKey(fakeKey(seed));
      expect(id).toMatch(RELAY_ID_REGEX);
    }
  });

  it('is always 39 characters — 8 groups of 4 hex chars + 7 dashes (128 bits)', () => {
    for (let seed = 0; seed < 500; seed++) {
      const id = relayIdFromPublicKey(fakeKey(seed));
      expect(id.length).toBe(39);
      expect(id.split('-')).toHaveLength(8);
    }
  });

  it('has no prefix — does not start with a scheme marker like the old relay:', () => {
    const id = relayIdFromPublicKey(fakeKey(7));
    expect(id.startsWith('relay:')).toBe(false);
    expect(id).toMatch(/^[0-9a-f]{4}-/);
  });

  it('does not throw on an empty key and still produces a well-formed id', () => {
    const id = relayIdFromPublicKey(new Uint8Array(0));
    expect(id).toMatch(RELAY_ID_REGEX);
  });

  it('relayIdFromPublicKeyHex matches relayIdFromPublicKey on the decoded bytes', () => {
    const key = fakeKey(3);
    const hex = Array.from(key).map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(relayIdFromPublicKeyHex(hex)).toBe(relayIdFromPublicKey(key));
  });
});

describe('isValidRelayId', () => {
  it('accepts a canonical id', () => {
    const id = relayIdFromPublicKey(fakeKey(5));
    expect(isValidRelayId(id)).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(isValidRelayId(undefined)).toBe(false);
    expect(isValidRelayId(null)).toBe(false);
    expect(isValidRelayId(1234)).toBe(false);
    expect(isValidRelayId({})).toBe(false);
  });

  it('rejects the old relay:-prefixed format', () => {
    expect(isValidRelayId('relay:ab12-cd34')).toBe(false);
  });

  it('rejects malformed groupings', () => {
    const good = 'ab12-cd34-ef56-ab12-cd34-ef56-ab12-cd34';
    expect(isValidRelayId(good)).toBe(true);
    expect(isValidRelayId(good.replace(/-/g, ''))).toBe(false); // no dashes
    expect(isValidRelayId(good.slice(0, -1))).toBe(false); // one char short
    expect(isValidRelayId(good + '0')).toBe(false); // one char long
    expect(isValidRelayId('')).toBe(false);
  });

  it('is case-sensitive: uppercase hex is NOT valid (no normalization applied)', () => {
    expect(isValidRelayId('AB12-CD34-EF56-AB12-CD34-EF56-AB12-CD34')).toBe(false);
  });

  it('rejects characters outside hex', () => {
    expect(isValidRelayId('gh12-cd34-ef56-ab12-cd34-ef56-ab12-cd34')).toBe(false);
    expect(isValidRelayId('ab1!-cd34-ef56-ab12-cd34-ef56-ab12-cd34')).toBe(false);
  });
});

describe('normalizeRelayId', () => {
  const canonical = 'ab12-cd34-ef56-ab12-cd34-ef56-ab12-cd34';

  it('returns the canonical form unchanged', () => {
    expect(normalizeRelayId(canonical)).toBe(canonical);
  });

  it('lowercases mixed-case input', () => {
    expect(normalizeRelayId(canonical.toUpperCase())).toBe(canonical);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRelayId(`  ${canonical}  `)).toBe(canonical);
  });

  it('returns null for malformed input', () => {
    expect(normalizeRelayId('')).toBeNull();
    expect(normalizeRelayId('not-a-relay-id')).toBeNull();
    expect(normalizeRelayId('relay:ab12-cd34')).toBeNull(); // old format, no longer accepted
    expect(normalizeRelayId(canonical.slice(0, -5))).toBeNull(); // truncated
  });

  it('rejects whitespace embedded inside the id, not just around it', () => {
    expect(normalizeRelayId(canonical.replace('-', ' -'))).toBeNull();
  });

  it('every id normalizeRelayId accepts also satisfies isValidRelayId', () => {
    const candidates = [canonical, canonical.toUpperCase(), `  ${canonical}  `];
    for (const c of candidates) {
      const normalized = normalizeRelayId(c);
      expect(normalized).not.toBeNull();
      expect(isValidRelayId(normalized)).toBe(true);
    }
  });
});

describe('short codes', () => {
  it('generateShortCode always produces a valid, matching code', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateShortCode();
      expect(code).toMatch(SHORT_CODE_REGEX);
      expect(isValidShortCode(code)).toBe(true);
    }
  });

  it('generateShortCode is 4 lowercase letters, a dash, and 4 digits', () => {
    const code = generateShortCode();
    const [letters, digits] = code.split('-');
    expect(letters).toMatch(/^[a-z]{4}$/);
    expect(digits).toMatch(/^[0-9]{4}$/);
  });

  it('isValidShortCode rejects non-string and malformed input', () => {
    expect(isValidShortCode(undefined)).toBe(false);
    expect(isValidShortCode(null)).toBe(false);
    expect(isValidShortCode('xoep-491')).toBe(false); // short digit group
    expect(isValidShortCode('xoep4910')).toBe(false); // missing dash
    expect(isValidShortCode('xoe1-4910')).toBe(false); // digit in the letters group
    expect(isValidShortCode('xoep-491a')).toBe(false); // letter in the digits group
  });

  it('a short code and a Relay ID can never be mistaken for each other', () => {
    const shortCode = generateShortCode();
    const relayId = relayIdFromPublicKey(fakeKey(9));
    expect(isValidRelayId(shortCode)).toBe(false);
    expect(isValidShortCode(relayId)).toBe(false);
  });

  it('normalizeShortCode lowercases and trims, rejects malformed input', () => {
    expect(normalizeShortCode('  XOEP-4910  ')).toBe('xoep-4910');
    expect(normalizeShortCode('not a code')).toBeNull();
  });
});
