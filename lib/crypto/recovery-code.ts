import { sha256 } from '@noble/hashes/sha2.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { constantTimeHexEqual } from './relay-auth';

/**
 * Recovery Code System
 * Generates and manages recovery codes for account recovery
 * after site data is cleared
 * 
 * Security:
 * - 256-bit random codes are cryptographically unbreakable
 * - Hashed with BLAKE3 (post-quantum secure, unlike SHA-256)
 * - Server stores hash only (irreversible, one-way function)
 * - Post-quantum resistance: BLAKE3 is resistant to quantum computing attacks
 * 
 * Privacy: Server only stores hash of recovery code, never the code itself
 */

// Hash algorithm versions for migration support
export type HashAlgorithm = 'sha256' | 'blake3';

/**
 * Generate a random 256-bit recovery code (32 bytes = 256 bits)
 * Returns as hex string for easier display
 * Format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX (8 groups of 8 hex chars)
 */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes).toUpperCase();
}

/**
 * Hash a recovery code for server storage
 * Uses BLAKE3 (post-quantum secure) by default
 * BLAKE3 is cryptographically secure and resistant to quantum computing attacks
 * Server stores this hash, never the code itself
 */
export function hashRecoveryCode(code: string, algorithm: HashAlgorithm = 'blake3'): string {
  const cleaned = code.trim().replace(/[-\s]/g, '').toUpperCase();
  const bytes = new TextEncoder().encode(cleaned);
  
  if (algorithm === 'blake3') {
    const hash = blake3(bytes);
    return bytesToHex(hash);
  } else {
    // Legacy SHA-256 support for old codes
    const hash = sha256(bytes);
    return bytesToHex(hash);
  }
}

/**
 * Verify a recovery code against its hash
 * Supports both BLAKE3 (new, post-quantum) and SHA-256 (legacy)
 * During recovery login, we check the stored hash format to determine algorithm
 */
export function verifyRecoveryCode(code: string, hash: string): { valid: boolean; algorithm: HashAlgorithm } {
  const cleaned = code.trim().replace(/[-\s]/g, '').toUpperCase();
  const bytes = new TextEncoder().encode(cleaned);
  
  // Try BLAKE3 first (new codes use this)
  const blake3Hash = bytesToHex(blake3(bytes));
  if (constantTimeHexEqual(blake3Hash, hash)) {
    return { valid: true, algorithm: 'blake3' };
  }

  // Fall back to SHA-256 for legacy codes
  const sha256Hash = bytesToHex(sha256(bytes));
  if (constantTimeHexEqual(sha256Hash, hash)) {
    return { valid: true, algorithm: 'sha256' };
  }
  
  return { valid: false, algorithm: 'sha256' }; // Return default if neither match
}

/**
 * Check if a recovery code hash appears to be from a specific algorithm
 * Useful for determining which algorithm to use during verification
 */
export function getHashAlgorithm(recoveryCodeHash: string): HashAlgorithm {
  // BLAKE3 output length: 256 bits = 64 hex characters
  // SHA256 output length: 256 bits = 64 hex characters
  // Both are the same length, so we can't determine from length alone
  // Instead, rely on database field or try both during verification
  
  // For now, return 'blake3' as default since that's what new codes use
  return 'blake3';
}

/**
 * Format recovery code for display
 * Makes it easier to read/copy: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
 */
export function formatRecoveryCode(code: string): string {
  const cleaned = code.trim().toUpperCase();
  return cleaned.match(/.{1,4}/g)?.join('-') ?? cleaned;
}

/**
 * Parse formatted recovery code back to hex
 */
export function parseRecoveryCode(formatted: string): string {
  return formatted.replace(/[-\s]/g, '').toUpperCase();
}
