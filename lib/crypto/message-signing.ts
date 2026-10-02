/**
 * Message Signing and Verification
 * 
 * Provides Ed25519 digital signatures for end-to-end encrypted message integrity.
 * Ensures messages cannot be modified by relay server between sender and recipient.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

export interface SignedMessage {
  messageId: string;
  content: string;
  signature: string; // hex-encoded Ed25519 signature
  timestamp: number;
  senderRelayId: string;
}

export interface SigningKeypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

/**
 * Derive a dedicated Ed25519 signing keypair from the identity's X25519
 * private key.
 *
 * The identity keypair (lib/crypto/relay-crypto.ts's generateKeypair) is
 * X25519 — meant for ECDH, not signing. Ed25519 and X25519 keys are NOT
 * interchangeable: they use different curve representations, and while
 * @noble's ed25519.sign() won't throw if handed a 32-byte X25519 scalar (it
 * just hashes whatever 32 bytes it's given as an Ed25519 seed), the
 * resulting signature can only ever be verified against
 * ed25519.getPublicKey() of that same seed — which is a completely
 * different value than the X25519 public key derived from the same bytes.
 * Verifying against the X25519 public key (the only one peers actually
 * have) would therefore ALWAYS fail. Deriving a separate signing keypair
 * via HKDF also keeps the two primitives properly domain-separated, the
 * same reasoning as lib/relay-vault.ts's deriveVaultAuthKey.
 *
 * Deterministic: the same identity private key always derives the same
 * signing keypair, so it doesn't need to be persisted separately — but the
 * derived PUBLIC key must still be exchanged with peers (they can't derive
 * it themselves without the private key), see lib/messaging/key-exchange.ts.
 */
export function deriveSigningKeypair(identityPrivateKey: Uint8Array): SigningKeypair {
  const seed = hkdf(sha256, identityPrivateKey, new Uint8Array(0), new TextEncoder().encode('relay-signing-v1'), 32);
  const privateKey = seed;
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

/**
 * Sign a message with private key
 * 
 * **SECURITY**: The message content itself is encrypted separately.
 * This signature verifies the encrypted message hasn't been tampered with.
 */
export async function signMessage(
  messageId: string,
  content: string,
  senderRelayId: string,
  privateKey: Uint8Array
): Promise<SignedMessage> {
  // Create signature payload: messageId + senderRelayId + content + timestamp
  const timestamp = Date.now();
  const signaturePayload = `${messageId}:${senderRelayId}:${content}:${timestamp}`;
  
  // Sign using Ed25519
  const signatureBytes = ed25519.sign(
    new TextEncoder().encode(signaturePayload),
    privateKey
  );
  
  // Convert to hex for transmission
  const signature = Buffer.from(signatureBytes).toString('hex');
  
  return {
    messageId,
    content,
    signature,
    timestamp,
    senderRelayId,
  };
}

/**
 * Verify a message signature
 * 
 * Throws if signature is invalid or message appears tampered.
 */
export function verifyMessageSignature(
  signedMessage: SignedMessage,
  senderPublicKey: Uint8Array
): boolean {
  try {
    // Reconstruct the payload that was signed
    const signaturePayload = `${signedMessage.messageId}:${signedMessage.senderRelayId}:${signedMessage.content}:${signedMessage.timestamp}`;
    
    // Convert hex signature back to bytes
    const signatureBytes = Buffer.from(signedMessage.signature, 'hex');
    
    // Verify signature
    const isValid = ed25519.verify(
      signatureBytes,
      new TextEncoder().encode(signaturePayload),
      senderPublicKey
    );
    
    if (!isValid) {
      throw new Error('Message signature verification failed - message may have been tampered with');
    }
    
    // Check timestamp is recent. The relay server holds undelivered messages
    // for up to MESSAGE_TTL_MINUTES (default 20 min, see server/relay-node.ts)
    // before dropping them — a legitimately signed message can arrive that
    // late if the recipient was offline. Use a tolerance comfortably wider
    // than that default TTL (25 min) plus a minute of clock skew, rather
    // than a tight window that would flag genuinely valid delayed messages
    // as tampered.
    const now = Date.now();
    const timeDiff = now - signedMessage.timestamp;
    if (timeDiff < -60000 || timeDiff > 25 * 60 * 1000) {
      throw new Error('Message timestamp is invalid or too old');
    }
    
    return true;
  } catch (err) {
    if (err instanceof Error && err.message.includes('verification')) {
      throw err;
    }
    throw new Error(`Signature verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
}

/**
 * Create a message fingerprint for comparison
 * Users can manually verify this fingerprint over an out-of-band channel
 */
export function getMessageFingerprint(signedMessage: SignedMessage): string {
  const payload = `${signedMessage.messageId}:${signedMessage.senderRelayId}:${signedMessage.content}`;
  const hash = sha256(new TextEncoder().encode(payload));
  return Buffer.from(hash).toString('hex').substring(0, 16).toUpperCase();
}
