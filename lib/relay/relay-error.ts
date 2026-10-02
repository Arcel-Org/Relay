/**
 * Typed error class for internal (non-API) errors.
 *
 * Usage:
 *   import { RelayError } from '@/lib/relay-error';
 *
 *   throw new RelayError('STORAGE_CORRUPT', 'Failed to parse account profile');
 *   throw new RelayError('SESSION_EXPIRED', 'Session is no longer valid');
 *   throw new RelayError('CRYPTO_FAILURE', 'Decryption failed');
 */

export type RelayErrorCode =
  | 'STORAGE_CORRUPT'
  | 'STORAGE_WRITE_FAILED'
  | 'SESSION_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'CRYPTO_FAILURE'
  | 'IDENTITY_NOT_LOADED'
  | 'RELAY_DISCONNECTED'
  | 'GROUP_NOT_FOUND'
  | 'VALIDATION_ERROR';

export class RelayError extends Error {
  constructor(
    public readonly code: RelayErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RelayError';
  }
}
