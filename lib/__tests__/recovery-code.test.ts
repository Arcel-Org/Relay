/**
 * Tests for lib/crypto/recovery-code.ts — generation, hashing (BLAKE3 +
 * legacy SHA-256), verification, and display formatting/parsing. This module
 * has no existing test coverage anywhere in the repo.
 */
import { describe, it, expect } from 'vitest';
import {
  generateRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
  formatRecoveryCode,
  parseRecoveryCode,
} from '../crypto/recovery-code';

describe('generateRecoveryCode', () => {
  it('produces a 64-char uppercase hex string (256 bits)', () => {
    const code = generateRecoveryCode();
    expect(code.length).toBe(64);
    expect(code).toMatch(/^[0-9A-F]{64}$/);
  });

  it('produces different codes on successive calls', () => {
    const a = generateRecoveryCode();
    const b = generateRecoveryCode();
    expect(a).not.toBe(b);
  });
});

describe('hashRecoveryCode / verifyRecoveryCode', () => {
  it('a freshly generated code verifies against its own blake3 hash', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'blake3');
    const result = verifyRecoveryCode(code, hash);
    expect(result.valid).toBe(true);
    expect(result.algorithm).toBe('blake3');
  });

  it('a freshly generated code verifies against its own legacy sha256 hash', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'sha256');
    const result = verifyRecoveryCode(code, hash);
    expect(result.valid).toBe(true);
    expect(result.algorithm).toBe('sha256');
  });

  it('defaults to blake3 when no algorithm is specified', () => {
    const code = generateRecoveryCode();
    const defaultHash = hashRecoveryCode(code);
    const explicitHash = hashRecoveryCode(code, 'blake3');
    expect(defaultHash).toBe(explicitHash);
  });

  it('rejects a wrong code against a valid hash', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'blake3');
    const wrongCode = generateRecoveryCode();
    const result = verifyRecoveryCode(wrongCode, hash);
    expect(result.valid).toBe(false);
  });

  it('rejects an empty code', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'blake3');
    expect(verifyRecoveryCode('', hash).valid).toBe(false);
  });

  it('normalizes case and separators before hashing, so formatted and raw forms match', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'blake3');
    const formatted = formatRecoveryCode(code); // dash-separated, same length groups
    expect(verifyRecoveryCode(formatted, hash).valid).toBe(true);
  });

  it('is tolerant of lowercase input and surrounding whitespace', () => {
    const code = generateRecoveryCode();
    const hash = hashRecoveryCode(code, 'blake3');
    expect(verifyRecoveryCode(`  ${code.toLowerCase()}  `, hash).valid).toBe(true);
  });

  it('blake3 and sha256 hashes of the same code are different', () => {
    const code = generateRecoveryCode();
    expect(hashRecoveryCode(code, 'blake3')).not.toBe(hashRecoveryCode(code, 'sha256'));
  });

  it('a hash only produced under blake3 does not verify under a wrong code even by algorithm coincidence', () => {
    const codeA = generateRecoveryCode();
    const codeB = generateRecoveryCode();
    const hashA = hashRecoveryCode(codeA, 'sha256');
    const result = verifyRecoveryCode(codeB, hashA);
    expect(result.valid).toBe(false);
    // Falls through both algorithm attempts and returns the documented
    // default of 'sha256' on total failure.
    expect(result.algorithm).toBe('sha256');
  });
});

describe('formatRecoveryCode / parseRecoveryCode', () => {
  it('round-trips a well-formed 64-char code (length is a multiple of 4)', () => {
    const code = generateRecoveryCode();
    const formatted = formatRecoveryCode(code);
    expect(formatted).toMatch(/^([0-9A-F]{4}-){15}[0-9A-F]{4}$/);
    expect(parseRecoveryCode(formatted)).toBe(code);
  });

  it('parseRecoveryCode strips dashes and whitespace and uppercases', () => {
    expect(parseRecoveryCode('ab12-cd34 ef56')).toBe('AB12CD34EF56');
  });

  it('parseRecoveryCode is idempotent on an already-bare code', () => {
    const code = generateRecoveryCode();
    expect(parseRecoveryCode(code)).toBe(code);
  });

  it('formatRecoveryCode on an empty string does not throw', () => {
    expect(formatRecoveryCode('')).toBe('');
  });

  it('BUG: formatRecoveryCode silently drops the final character when input length is not a multiple of 4', () => {
    // formatRecoveryCode groups every 4 chars via /(.{4})/g and then blindly
    // slice(0, -1)'s the result to remove what it assumes is always a
    // trailing separator. When the cleaned code's length isn't a multiple of
    // 4, the leftover 1-3 chars at the end are left unmatched by the regex
    // (so no trailing "-" is ever appended for them), and slice(0, -1) then
    // chops off the last REAL character instead of a separator.
    //
    // generateRecoveryCode() always emits exactly 64 chars (a multiple of 4)
    // so this path isn't hit by the current call sites, but formatRecoveryCode
    // is a general-purpose exported function with no length precondition or
    // guard, so any future caller (e.g. formatting a user-edited/pasted code)
    // can silently lose data with no error.
    //
    // This assertion documents the CORRECT/expected round-trip behavior and
    // is expected to fail against the current implementation.
    const oddLengthCode = 'ABCD123'; // 7 chars, not a multiple of 4
    const formatted = formatRecoveryCode(oddLengthCode);
    const roundTripped = parseRecoveryCode(formatted);
    expect(roundTripped).toBe(oddLengthCode); // <-- fails: actual is 'ABCD12'
  });
});
