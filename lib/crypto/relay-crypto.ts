/**
 * Relay Crypto — CryptoPress V6 TypeScript Port
 * 
 * Wire format: [1 dict_ver][8 seq][4 pad_len][12 nonce][2 unused][16 tag][N ciphertext]
 * Header: 43 bytes total (dict_ver + seq + pad_len + nonce + unused + Poly1305 tag)
 * 
 * Features:
 * - ChaCha20-Poly1305 AEAD encryption
 * - Zlib compression with n-gram dictionary
 * - HKDF-SHA256 key derivation
 * - X25519 elliptic curve Diffie-Hellman
 * - Replay attack protection (up to 2000 recent sequence numbers)
 * - PADMÉ padding (power-of-two alignment, min 64 bytes)
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as pako from 'pako';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { workerEncrypt, workerDecrypt } from './crypto-worker';

// ─────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

// Note: ChaCha20 uses 12-byte nonce (RFC 8439), Poly1305 tag is 16 bytes
const HEADER_SIZE = 43; // 1 + 8 + 4 + 12 + 2 + 16 = 43 bytes (dict_ver, seq, pad_len[u32], nonce, flags+reserved, tag)
const NONCE_SIZE = 12; // ChaCha20 RFC 8439 nonce size
const TAG_SIZE = 16;   // Poly1305 tag
const KEY_SIZE = 32;
const MIN_PAD_SIZE = 64;

// Cipher-suite identifiers mixed into the root key as a downgrade-binding
// transcript (#8). Both peers fold the negotiated suite id (plus both identity
// keys) into the root-key KDF, so an ASYMMETRIC downgrade — a relay tricking one
// side into classical while the other stays hybrid — makes their root keys
// diverge and the session fails closed (a dead session, never a quietly-readable
// one). This binding alone does NOT stop a SYMMETRIC strip, where the relay
// removes the PQ advertisement from BOTH directions so both peers see classical
// and legitimately agree on SUITE_CLASSICAL. That case is caught separately in
// key-exchange: a classical-only offer from a peer already known to be
// PQ-capable is refused and re-driven to hybrid rather than silently accepted.
// A true FIRST-contact symmetric strip — before either side has learned the
// other's PQ key — remains open until PQ capability is bound to the
// authenticated identity (followUp).
export const SUITE_HYBRID = 'x25519+ml-kem768+chacha20poly1305';
export const SUITE_CLASSICAL = 'x25519+chacha20poly1305';

/**
 * Deterministic downgrade-binding transcript for the negotiated cipher suite.
 *
 * Mixed into the session root key (see the Session constructor) so both peers
 * MUST agree on (a) which suite was actually negotiated and (b) both identity
 * public keys. The two X25519 public keys are sorted lexicographically so both
 * sides compute an identical transcript regardless of role. If a MITM downgrades
 * one side to classical while the other believes it stayed hybrid, the `suiteId`
 * differs between them, the derived root keys diverge, and the handshake fails
 * closed rather than falling back to an attacker-readable classical channel.
 */
export function deriveSuiteTranscript(
  suiteId: string,
  ownPublicKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  const [first, second] =
    deriveSessionRole(ownPublicKey, theirPublicKey) === 'A'
      ? [ownPublicKey, theirPublicKey]
      : [theirPublicKey, ownPublicKey];
  const suiteBytes = new TextEncoder().encode(`relay-suite-v1:${suiteId}:`);
  const combined = new Uint8Array(suiteBytes.length + first.length + second.length);
  combined.set(suiteBytes, 0);
  combined.set(first, suiteBytes.length);
  combined.set(second, suiteBytes.length + first.length);
  return sha256(combined);
}

// ─────────────────────────────────────────────────────────────────────────
// WIRE FORMAT
// ─────────────────────────────────────────────────────────────────────────

interface WireFormat {
  dict_version: number;
  seq_number: bigint;
  padding_len: number;
  nonce: Uint8Array;
  tag: Uint8Array;
  ciphertext: Uint8Array;
}

function wireFormatToBytes(wire: WireFormat): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);
  
  // [1 byte] dict_version
  view.setUint8(0, wire.dict_version);
  
  // [8 bytes] seq_number (big-endian)
  view.setBigUint64(1, wire.seq_number, false);
  
  // [4 bytes] padding_len (big-endian uint32 — supports up to 4 GB of padding)
  view.setUint32(9, wire.padding_len, false);
  
  // [12 bytes] nonce (offset 13, after the 4-byte padding_len)
  header.set(wire.nonce, 13);
  
  // [2 bytes unused at 25-26]
  
  // [16 bytes] tag (offset 27, unchanged)
  header.set(wire.tag, 27);
  
  // Append ciphertext
  const result = new Uint8Array(header.length + wire.ciphertext.length);
  result.set(header);
  result.set(wire.ciphertext, header.length);
  
  return result;
}

/**
 * Associated data binding the cleartext wire-header fields (dict_version,
 * seq_number, padding_len) into the AEAD tag. Without this they're fully
 * malleable — a relay/network attacker can flip seq_number or padding_len
 * on an intercepted ciphertext and the tag still verifies, since neither
 * field is otherwise covered by anything cryptographic. nonce and tag
 * themselves don't need to be in here: nonce is bound by the AEAD API
 * argument itself, and tag is the output being verified.
 */
function buildAAD(dictVersion: number, seq: bigint, paddingLen: number): Uint8Array {
  const aad = new Uint8Array(13);
  const view = new DataView(aad.buffer);
  view.setUint8(0, dictVersion);
  view.setBigUint64(1, seq, false);
  view.setUint32(9, paddingLen, false);
  return aad;
}

function wireFormatFromBytes(data: Uint8Array): WireFormat {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Blob too short: ${data.length} < ${HEADER_SIZE}`);
  }
  
  // Make sure we work with a fresh DataView from byte 0
  const freshData = new Uint8Array(data); // Create a copy to ensure proper byte alignment
  const view = new DataView(freshData.buffer, freshData.byteOffset);
  
  const dict_version = view.getUint8(0);
  const seq_number = view.getBigUint64(1, false);
  // uint32 padding_len at offset 9 (supports large file payloads without overflow)
  const padding_len = view.getUint32(9, false);
  
  // Sanity check: padding must be less than 32 MB (protects against corrupt headers)
  if (padding_len > 33554432) {
    throw new Error(`Invalid padding_len: ${padding_len}`);
  }
  
  // nonce at offset 13 (shifted 2 bytes due to uint32 padding_len)
  const nonce = new Uint8Array(freshData.buffer, freshData.byteOffset + 13, NONCE_SIZE);
  // tag at offset 27 (unchanged)
  const tag = new Uint8Array(freshData.buffer, freshData.byteOffset + 27, TAG_SIZE);
  const ciphertext = new Uint8Array(freshData.buffer, freshData.byteOffset + HEADER_SIZE);
  
  return {
    dict_version,
    seq_number,
    padding_len,
    nonce: new Uint8Array(nonce), // copy
    tag: new Uint8Array(tag),     // copy
    ciphertext: new Uint8Array(ciphertext), // copy
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PADMÉ PADDING
// ─────────────────────────────────────────────────────────────────────────

function padmePad(data: Uint8Array, minSize: number = MIN_PAD_SIZE): [Uint8Array, number] {
  let target = minSize;
  if (data.length > 0) {
    // Next power of 2 >= data.length
    // For data.length > 2^30 the 32-bit left shift would overflow; handle via Math.pow instead
    const bits = 32 - Math.clz32(data.length - 1);
    const powerOf2 = bits < 31 ? (1 << bits) : Math.pow(2, bits);
    target = Math.max(minSize, powerOf2);
  }
  const padLen = target - data.length;

  const padded = new Uint8Array(target); // zero-initialised by the runtime
  padded.set(data);
  // Padding bytes are left as zero — safe because:
  // 1. ChaCha20-Poly1305 authenticates the entire ciphertext (no oracle attack possible)
  // 2. padLen is recorded in the wire header so the receiver knows exactly where data ends
  // 3. crypto.getRandomValues has a 65536-byte per-call limit that would fail for large files

  return [padded, padLen];
}

function padmeUnpad(data: Uint8Array, padLen: number): Uint8Array {
  if (padLen > 0) {
    return data.slice(0, data.length - padLen);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────
// DICTIONARY BUILDING (n-gram based)
// ─────────────────────────────────────────────────────────────────────────

export function buildDictionary(sentences: string[], maxSize: number = 32768): Uint8Array {
  const text = sentences.join(' ');
  const words = text.split(/\s+/).filter(w => w.length > 0);
  
  // Build n-gram frequency map
  const counts = new Map<string, number>();
  for (let n = 2; n <= 6; n++) {
    for (let i = 0; i < words.length - n + 1; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      counts.set(phrase, (counts.get(phrase) || 0) + 1);
    }
  }
  
  // Sort by frequency (descending)
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1]);
  
  // Build dictionary
  const db = new TextEncoder();
  let result = new Uint8Array();
  const seen = new Set<string>();
  
  for (const [phrase] of sorted) {
    if (!seen.has(phrase)) {
      const entry = db.encode(phrase + ' ');
      if (result.length + entry.length < maxSize) {
        const combined = new Uint8Array(result.length + entry.length);
        combined.set(result);
        combined.set(entry, result.length);
        result = combined;
        seen.add(phrase);
      }
    }
  }
  
  // Add full sentences
  for (const sentence of sentences) {
    const entry = db.encode(sentence + '\n');
    if (result.length + entry.length < maxSize) {
      const combined = new Uint8Array(result.length + entry.length);
      combined.set(result);
      combined.set(entry, result.length);
      result = combined;
    }
  }
  
  return result.slice(0, maxSize);
}

// ─────────────────────────────────────────────────────────────────────────
// COMPRESSION (zlib with dictionary)
// ─────────────────────────────────────────────────────────────────────────

function compressZlib(data: Uint8Array, dict: Uint8Array): Uint8Array {
  if (!data || data.length === 0) {
    throw new Error('compressZlib: data is empty or null');
  }

  try {
    // pako's deflateRaw/inflateRaw accept a Node zlib-compatible `dictionary`
    // option (preset shared dictionary) — pass it through so the per-contact
    // n-gram corpus from buildDictionary() actually shrinks ciphertexts
    // instead of only feeding the HKDF salt.
    const compressed = dict && dict.length > 0
      ? pako.deflateRaw(data, { dictionary: dict })
      : pako.deflateRaw(data);
    return new Uint8Array(compressed);
  } catch (err: any) {
    throw new Error(`Compression failed: ${err.message}`);
  }
}

function decompressZlib(data: Uint8Array, dict: Uint8Array): Uint8Array {
  try {
    const decompressed = dict && dict.length > 0
      ? pako.inflateRaw(data, { dictionary: dict })
      : pako.inflateRaw(data);
    return new Uint8Array(decompressed);
  } catch (err: any) {
    // If decompression failed, throw a more informative error
    throw new Error(`Decompression failed: ${err.message}. Data length: ${data.length}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// KEY DERIVATION (HKDF-SHA256)
// ─────────────────────────────────────────────────────────────────────────

function kdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number = 32): Uint8Array {
  // hkdf from @noble/hashes expects Uint8Array inputs
  return hkdf(sha256, ikm, salt, info, length);
}

// Export public version of HKDF for external use
export function hkdfDerive(
  ikm: Uint8Array,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number = 32
): Uint8Array {
  const saltBytes = typeof salt === 'string' ? new TextEncoder().encode(salt) : salt;
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  return hkdf(sha256, ikm, saltBytes, infoBytes, length);
}

// ─────────────────────────────────────────────────────────────────────────
// ELLIPTIC CURVE DIFFIE-HELLMAN (X25519)
// ─────────────────────────────────────────────────────────────────────────

export function generateKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function computeSharedSecret(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(myPrivate, theirPublic);
}

// ─────────────────────────────────────────────────────────────────────────
// HYBRID POST-QUANTUM KEY EXCHANGE (X25519 + ML-KEM768)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Represents a complete hybrid keypair (classical X25519 + post-quantum ML-KEM768)
 */
export interface HybridKeypair {
  classicalPrivate: Uint8Array;
  classicalPublic: Uint8Array;
  pqPrivate: Uint8Array;
  pqPublic: Uint8Array;
}

/**
 * Generate a hybrid keypair: X25519 + ML-KEM768
 * Used at signup to create both classical and quantum-resistant keys
 */
export function generateHybridKeypair(): HybridKeypair {
  const classicalKeypair = generateKeypair();
  const pqKeypair = ml_kem768.keygen();

  return {
    classicalPrivate: classicalKeypair.privateKey,
    classicalPublic: classicalKeypair.publicKey,
    pqPrivate: pqKeypair.secretKey,
    pqPublic: pqKeypair.publicKey,
  };
}

/**
 * Perform PQ encapsulation: encapsulate to recipient's ML-KEM768 public key
 * Used when initiating key exchange (sender side)
 * Returns cipherText that recipient can decapsulate and shared secret both parties derive
 */
export function performPqEncapsulation(recipientPqPublic: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
  return ml_kem768.encapsulate(recipientPqPublic);
}

/**
 * Perform PQ decapsulation: decapsulate cipherText with own ML-KEM768 private key
 * Used when receiving key exchange (receiver side)
 * Produces same shared secret as the encapsulator
 */
export function performPqDecapsulation(cipherText: Uint8Array, myPqPrivate: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(cipherText, myPqPrivate);
}

/**
 * Derive hybrid shared secret from classical X25519 and post-quantum ML-KEM768 shared secrets
 * Combines both using HKDF: makes breaking the session require breaking BOTH algorithms
 */
export function deriveHybridSecret(classicalShared: Uint8Array, pqShared: Uint8Array): Uint8Array {
  // Concatenate both secrets and derive final key using HKDF
  const combined = new Uint8Array(classicalShared.length + pqShared.length);
  combined.set(classicalShared, 0);
  combined.set(pqShared, classicalShared.length);

  // Use HKDF with "relay-pq-v1" info to derive the session key
  return hkdfDerive(combined, new Uint8Array(0), 'relay-pq-v1', 32);
}

/**
 * Compute hybrid shared secret: handles both encapsulation (sender) and decapsulation (receiver)
 * Sender: has recipient's PQ public key, encapsulates to it
 * Receiver: has cipherText from sender, decapsulates with own PQ private key
 */
export function computeHybridSharedSecret(options: {
  myClassicalPrivate: Uint8Array;
  theirClassicalPublic: Uint8Array;
  theirPqPublic?: Uint8Array; // Present on sender side
  cipherText?: Uint8Array;     // Present on receiver side
  myPqPrivate?: Uint8Array;    // Present on receiver side
}): Uint8Array {
  const { myClassicalPrivate, theirClassicalPublic, theirPqPublic, cipherText, myPqPrivate } = options;

  // Classical X25519 shared secret (both sides always compute this)
  const classicalShared = x25519.getSharedSecret(myClassicalPrivate, theirClassicalPublic);

  // Post-quantum shared secret (depends on which side we are)
  let pqShared: Uint8Array;

  if (theirPqPublic && !myPqPrivate) {
    // Sender side: encapsulate to recipient's PQ public key
    const encResult = performPqEncapsulation(theirPqPublic);
    pqShared = encResult.sharedSecret;
    // Note: caller must handle cipherText separately and send it in the key exchange message
  } else if (cipherText && myPqPrivate) {
    // Receiver side: decapsulate cipherText with our PQ private key
    pqShared = performPqDecapsulation(cipherText, myPqPrivate);
  } else if (!theirPqPublic && !cipherText) {
    // Fallback to classical-only (backward compatibility)
    return classicalShared;
  } else {
    throw new Error('Invalid hybrid key exchange parameters: must provide either (theirPqPublic) or (cipherText + myPqPrivate)');
  }

  // Derive final hybrid secret
  return deriveHybridSecret(classicalShared, pqShared);
}

// ─────────────────────────────────────────────────────────────────────────
// SESSION (stateful encryption/decryption with key tracking)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Which side of a session a peer plays. Both sides derive two directional
 * chain keys from the same shared secret; role picks which one is "send"
 * and which is "recv" so the two peers' chains line up. Determine this with
 * `deriveSessionRole()` — comparing the two participants' public keys gives
 * both sides complementary roles deterministically, without exchanging any
 * extra protocol message.
 */
export type SessionRole = 'A' | 'B';

/**
 * Derive a symmetric-breaking role from two X25519 public keys so both
 * peers land on complementary Session roles without an explicit
 * initiator/responder handshake. Comparison is lexicographic over raw
 * bytes — deterministic and identical no matter which side computes it.
 */
export function deriveSessionRole(ownPublicKey: Uint8Array, theirPublicKey: Uint8Array): SessionRole {
  const len = Math.min(ownPublicKey.length, theirPublicKey.length);
  for (let i = 0; i < len; i++) {
    if (ownPublicKey[i] !== theirPublicKey[i]) {
      return ownPublicKey[i] < theirPublicKey[i] ? 'A' : 'B';
    }
  }
  return ownPublicKey.length <= theirPublicKey.length ? 'A' : 'B';
}

export interface SessionOptions {
  /**
   * Downgrade-binding cipher-suite transcript (see deriveSuiteTranscript),
   * folded into the root-key KDF so a stripped-PQ downgrade fails closed (#8).
   */
  suiteTranscript?: Uint8Array;
}

/**
 * JSON-safe snapshot of a Session's ratchet state for encrypted-at-rest
 * persistence + resume-on-restore (#3, #10). Chain keys are hex; bigint
 * counters are decimal strings.
 */
export interface SerializedSession {
  v: number;
  dictVersion: number;
  sendChainKeyHex: string;
  counter: string;
  recvChainKeyHex: string;
  recvChainCounter: string;
  skipped: Array<[string, string]>;
}

export class Session {
  private dictVersion: number;
  private dictHash: Uint8Array;
  private dict: Uint8Array;

  // Outgoing (send) ratchet: advances one step per encrypt(), old chain
  // state is discarded immediately — a compromise of the current chain key
  // cannot recover message keys already spent.
  private sendChainKey: Uint8Array;
  private counter: bigint;

  // Incoming (recv) ratchet: advances as messages arrive in order. Keys for
  // sequence numbers skipped over (out-of-order delivery) are cached in
  // skippedRecvKeys, bounded by maxSkip, so a bounded reordering window is
  // still tolerated without weakening forward secrecy for the rest of the
  // stream.
  private recvChainKey: Uint8Array;
  private recvChainCounter: bigint;
  private skippedRecvKeys: Map<bigint, Uint8Array>;
  private maxSkip: number = 2000;

  constructor(
    sharedSecret: Uint8Array,
    dict: Uint8Array,
    dictVersion: number = 1,
    role: SessionRole = 'A',
    options?: SessionOptions
  ) {
    if (!sharedSecret || sharedSecret.length === 0) {
      throw new Error('Session: sharedSecret is required and cannot be empty');
    }
    if (!dict || dict.length === 0) {
      throw new Error('Session: dictionary is required and cannot be empty');
    }

    this.dict = dict;
    this.dictVersion = dictVersion;
    this.counter = 0n;
    this.recvChainCounter = 0n;
    this.skippedRecvKeys = new Map();

    // Derive root key: HKDF(shared_secret, SHA256(dict), "session-v6" [|| suite
    // transcript], 32), then split into two directional chains so each side's
    // outgoing messages never reuse the peer's incoming chain state.
    //
    // When a downgrade-binding `suiteTranscript` is supplied (production key
    // exchange, #8) it is folded into the KDF `info`, so the two peers only
    // derive matching chains if they agree on the negotiated cipher suite and
    // each other's identity keys. Omitting it (legacy 4-arg construction and
    // the existing unit tests) leaves the derivation byte-for-byte unchanged.
    this.dictHash = sha256(dict);
    const infoLabel = new TextEncoder().encode('session-v6');
    const transcript = options?.suiteTranscript;
    let info: Uint8Array;
    if (transcript && transcript.length > 0) {
      info = new Uint8Array(infoLabel.length + transcript.length);
      info.set(infoLabel, 0);
      info.set(transcript, infoLabel.length);
    } else {
      info = infoLabel;
    }
    const rootKey = kdf(sharedSecret, this.dictHash, info, 32);
    const chainA = kdf(rootKey, new Uint8Array(0), new TextEncoder().encode('chain-A'), 32);
    const chainB = kdf(rootKey, new Uint8Array(0), new TextEncoder().encode('chain-B'), 32);
    this.sendChainKey = role === 'A' ? chainA : chainB;
    this.recvChainKey = role === 'A' ? chainB : chainA;
  }

  /**
   * Snapshot the live ratchet state (chain keys + counters + skipped-key
   * cache) as a JSON-safe object so it can be PERSISTED ENCRYPTED and RESUMED
   * on the next app start (#3, #10). Resuming instead of re-deriving from the
   * static identity keys at counter 0 is what preserves forward secrecy across
   * a restart AND stops a replayed key-exchange offer from rolling the recv
   * counter back to 0 (which would let previously-captured ciphertexts decrypt
   * again). The chain keys are sensitive key material — callers MUST only ever
   * write this through the app's encrypted-at-rest storage.
   */
  serialize(): SerializedSession {
    return {
      v: 1,
      dictVersion: this.dictVersion,
      sendChainKeyHex: bytesToHex(this.sendChainKey),
      counter: this.counter.toString(),
      recvChainKeyHex: bytesToHex(this.recvChainKey),
      recvChainCounter: this.recvChainCounter.toString(),
      skipped: Array.from(this.skippedRecvKeys.entries()).map(
        ([seq, key]) => [seq.toString(), bytesToHex(key)] as [string, string]
      ),
    };
  }

  /**
   * Rebuild a Session directly from persisted ratchet state, bypassing the
   * shared-secret derivation entirely — the persisted chain keys already
   * encode every ratchet step taken before the restart. Used on the session
   * restore paths (connection.ts / receive.ts) so a restored session resumes
   * exactly where it left off rather than resetting counters to 0.
   */
  static fromSerialized(state: SerializedSession, dict: Uint8Array): Session {
    // The dummy secret only seeds throwaway chains that are immediately
    // overwritten from `state`; nothing derived from it survives.
    const session = new Session(new Uint8Array(KEY_SIZE), dict, state.dictVersion, 'A');
    session.sendChainKey = hexToBytes(state.sendChainKeyHex);
    session.counter = BigInt(state.counter);
    session.recvChainKey = hexToBytes(state.recvChainKeyHex);
    session.recvChainCounter = BigInt(state.recvChainCounter);
    session.skippedRecvKeys = new Map(
      state.skipped.map(([seq, key]) => [BigInt(seq), hexToBytes(key)] as [bigint, Uint8Array])
    );
    return session;
  }

  /**
   * Permanently consume the recv-ratchet key for an already-decrypted blob,
   * enforcing single-use (replay) protection AFTER the message has been
   * accepted. Pairs with a `decrypt(blob, checkReplay=false)` "peek":
   * receive.ts peeks so it can inspect a signed envelope it may have to HOLD
   * un-ACKed (peer's signing key not yet delivered) and re-process later; once
   * it commits to accepting the message it calls this so the relay can't
   * redeliver the same ciphertext under a fresh messageId and have it decrypt a
   * second time. Cheap: no AEAD/decompress, just drops the cached key.
   */
  consumeRecvKey(blob: Uint8Array): void {
    const wire = wireFormatFromBytes(blob);
    this.skippedRecvKeys.delete(wire.seq_number);
  }

  /**
   * Advance a chain key one step: derive this step's message key and the
   * next chain key. The chain key is a one-way function of the previous
   * one (HKDF), so holding a chain key at step N never allows recomputing
   * step N-1's message key — that's what gives forward secrecy once the
   * old chain key is overwritten/discarded.
   */
  private static stepChain(chainKey: Uint8Array): { messageKey: Uint8Array; nextChainKey: Uint8Array } {
    const messageKey = kdf(chainKey, new Uint8Array(0), new TextEncoder().encode('msg'), 32);
    const nextChainKey = kdf(chainKey, new Uint8Array(0), new TextEncoder().encode('chain-next'), 32);
    return { messageKey, nextChainKey };
  }

  /** Derive the next outgoing message key and irreversibly advance the send chain. */
  private deriveSendKey(): Uint8Array {
    const { messageKey, nextChainKey } = Session.stepChain(this.sendChainKey);
    this.sendChainKey = nextChainKey;
    return messageKey;
  }

  /**
   * Derive the message key for an incoming sequence number, ratcheting the
   * recv chain forward as needed and caching keys for any positions skipped
   * over (bounded reordering tolerance). `checkReplay` controls whether the
   * key is consumed (deleted) after use — most callers want single-use
   * (real forward secrecy per message); a few callers (receipt
   * verification, post-desync reprocessing) legitimately re-derive the same
   * position and pass checkReplay=false to keep that one key cached instead.
   *
   * This only COMPUTES the key and the state change it would cause — it does
   * not mutate `this` yet. The caller must call the returned `commit()` only
   * after the AEAD tag has verified. Committing unconditionally (the old
   * behavior) let an attacker who merely intercepts ciphertext — no key,
   * no valid tag needed — permanently desync the ratchet or burn a skipped-key
   * slot by sending garbage at a chosen seq_number, since the ratchet
   * advanced from the cleartext header alone, before authentication.
   */
  private deriveRecvKey(seq: bigint, checkReplay: boolean): { messageKey: Uint8Array; commit: () => void } {
    if (seq < this.recvChainCounter) {
      const cached = this.skippedRecvKeys.get(seq);
      if (!cached) {
        throw new Error(`Replay detected: sequence ${seq} already processed`);
      }
      return {
        messageKey: cached,
        commit: () => {
          if (checkReplay) {
            this.skippedRecvKeys.delete(seq);
          }
        },
      };
    }

    const gap = seq - this.recvChainCounter;
    if (gap > BigInt(this.maxSkip)) {
      throw new Error(`Sequence ${seq} too far ahead of expected ${this.recvChainCounter} (gap exceeds max skip ${this.maxSkip})`);
    }

    let chainKey = this.recvChainKey;
    let cursor = this.recvChainCounter;
    let messageKey: Uint8Array | null = null;
    const newSkipped = new Map<bigint, Uint8Array>();
    while (cursor <= seq) {
      const step = Session.stepChain(chainKey);
      if (cursor === seq) {
        messageKey = step.messageKey;
        if (!checkReplay) {
          // Retain this position's key so a legitimate re-decrypt (receipt
          // verification, retry) can still succeed — narrows forward
          // secrecy for this one message only, not the whole chain.
          newSkipped.set(cursor, step.messageKey);
        }
      } else {
        newSkipped.set(cursor, step.messageKey);
      }
      chainKey = step.nextChainKey;
      cursor += 1n;
    }

    const finalChainKey = chainKey;
    const finalCounter = seq + 1n;

    return {
      messageKey: messageKey!,
      commit: () => {
        this.recvChainKey = finalChainKey;
        this.recvChainCounter = finalCounter;
        for (const [k, v] of newSkipped) this.skippedRecvKeys.set(k, v);

        // Bound cache growth: evict the oldest cached skip entries once past the window.
        if (this.skippedRecvKeys.size > this.maxSkip) {
          const excess = this.skippedRecvKeys.size - this.maxSkip;
          const oldest = Array.from(this.skippedRecvKeys.keys())
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
            .slice(0, excess);
          for (const k of oldest) this.skippedRecvKeys.delete(k);
        }
      },
    };
  }

  private advance(): void {
    this.counter += 1n;
  }
  
  /**
   * Encrypt plaintext: compress → pad → encrypt → MAC
   */
  encrypt(plaintext: Uint8Array): Uint8Array {
    // Generate nonce
    const nonce = new Uint8Array(NONCE_SIZE);
    crypto.getRandomValues(nonce);
    
    const seq = this.counter;

    // Compress
    const compressed = compressZlib(plaintext, this.dict);

    // Pad
    const [padded, padLen] = padmePad(compressed);

    // Derive this message's key from the send ratchet and advance it —
    // the key used here can never be recomputed once the chain moves on.
    const encKey = this.deriveSendKey();
    this.advance();

    // Bind the cleartext header fields (dict_version/seq/padding_len) as AAD
    // so they can't be flipped in transit without invalidating the tag.
    const aad = buildAAD(this.dictVersion, seq, padLen);
    const cipher = chacha20poly1305(encKey, nonce, aad);

    // Cipher.encrypt() returns [ciphertext || tag] all together
    const ctWithTag = cipher.encrypt(padded);
    
    // Extract ciphertext and tag (tag is last TAG_SIZE bytes)
    const ct = ctWithTag.slice(0, ctWithTag.length - TAG_SIZE);
    const tag = ctWithTag.slice(ctWithTag.length - TAG_SIZE);
    
    const wire: WireFormat = {
      dict_version: this.dictVersion,
      seq_number: seq,
      padding_len: padLen,
      nonce,
      tag,
      ciphertext: ct,
    };
    
    return wireFormatToBytes(wire);
  }
  
  /**
   * Decrypt ciphertext: verify → decrypt → unpad → decompress
   */
  decrypt(blob: Uint8Array, checkReplay: boolean = true): Uint8Array {
    if (!blob || blob.length < HEADER_SIZE + 1) {
      throw new Error(`decrypt: blob too short (${blob.length} bytes, need at least ${HEADER_SIZE + 1})`);
    }
    
    const wire = wireFormatFromBytes(blob);

    // Derive this message's key from the recv ratchet, walking it forward
    // as needed. this.counter (the local outgoing counter) is never
    // touched here — send/recv chains are fully independent. State is not
    // committed yet — only after the AEAD tag verifies below, so a forged
    // or corrupted blob can never advance/desync the ratchet.
    const { messageKey: encKey, commit } = this.deriveRecvKey(wire.seq_number, checkReplay);

    const aad = buildAAD(wire.dict_version, wire.seq_number, wire.padding_len);
    const cipher = chacha20poly1305(encKey, wire.nonce, aad);

    // Reconstruct [ciphertext || tag] for chacha20poly1305.decrypt()
    const ctWithTag = new Uint8Array(wire.ciphertext.length + wire.tag.length);
    ctWithTag.set(wire.ciphertext);
    ctWithTag.set(wire.tag, wire.ciphertext.length);

    if (ctWithTag.length < 16) {
      throw new Error(`decrypt: ciphertext+tag too short (${ctWithTag.length} bytes, need at least 16)`);
    }

    let padded: Uint8Array | null = null;
    try {
      padded = cipher.decrypt(ctWithTag);
    } catch (err) {
      throw new Error(`Decryption failed — authentication tag mismatch or corrupted data: ${err}`);
    }

    if (!padded) {
      throw new Error('Decryption failed — authentication tag mismatch or corrupted data');
    }

    // Tag verified — now safe to commit the ratchet advance.
    commit();

    // Unpad
    const compressed = padmeUnpad(padded, wire.padding_len);

    // Decompress
    return decompressZlib(compressed, this.dict);
  }

  /**
   * Encrypt plaintext asynchronously, offloading the heavy crypto + compression
   * to a Web Worker. Falls back to synchronous main-thread encrypt() when
   * workers are unavailable.
   */
  async encryptAsync(plaintext: Uint8Array): Promise<Uint8Array> {
    // Generate nonce
    const nonce = new Uint8Array(NONCE_SIZE);
    crypto.getRandomValues(nonce);

    const seq = this.counter;

    // Derive encryption key from the send ratchet (fast HKDF — stays on
    // main thread) and advance it immediately, same as the sync path.
    const encKey = this.deriveSendKey();
    this.advance();

    // Try worker offload for the heavy part (compress + pad + chacha20poly1305)
    const workerResult = await workerEncrypt(plaintext, encKey, nonce, this.dict, this.dictVersion, seq);

    if (workerResult) {
      // Worker handled compress -> pad -> encrypt
      const { ctWithTag, padLen } = workerResult;

      // Extract ciphertext and tag (tag is last TAG_SIZE bytes)
      const ct = ctWithTag.slice(0, ctWithTag.length - TAG_SIZE);
      const tag = ctWithTag.slice(ctWithTag.length - TAG_SIZE);

      const wire: WireFormat = {
        dict_version: this.dictVersion,
        seq_number: seq,
        padding_len: padLen,
        nonce,
        tag,
        ciphertext: ct,
      };

      return wireFormatToBytes(wire);
    }

    // Fallback: run everything on main thread (same as synchronous encrypt)
    const compressed = compressZlib(plaintext, this.dict);
    const [padded, padLen] = padmePad(compressed);
    const aad = buildAAD(this.dictVersion, seq, padLen);
    const cipher = chacha20poly1305(encKey, nonce, aad);
    const ctWithTag = cipher.encrypt(padded);
    const ct = ctWithTag.slice(0, ctWithTag.length - TAG_SIZE);
    const tag = ctWithTag.slice(ctWithTag.length - TAG_SIZE);

    const wire: WireFormat = {
      dict_version: this.dictVersion,
      seq_number: seq,
      padding_len: padLen,
      nonce,
      tag,
      ciphertext: ct,
    };

    return wireFormatToBytes(wire);
  }

  // Serializes concurrent decryptAsync() calls against the SAME session.
  // deriveRecvKey() reads this.recvChainCounter/recvChainKey and its
  // commit() writes them back only after an `await` (the worker round
  // trip) — without this queue, two messages decrypting concurrently
  // (a long message split into back-to-back segments, or two ordinary
  // messages arriving close together) can commit out of order: whichever
  // commit() runs last wins, even if it was derived from an earlier,
  // now-stale read. That silently rolls recvChainCounter backward and
  // re-inserts an already-consumed key into skippedRecvKeys — a real
  // replay-protection break, not just a state glitch. Queuing the whole
  // derive-await-commit body ensures the next call's read only happens
  // after the previous call's commit has actually run.
  //
  // Residual gap: the synchronous decrypt() path (used by burn.ts /
  // use-call-signaling.ts for non-message payloads on the same session)
  // has no await point of its own, so it can't be preempted mid-flight —
  // but it isn't queued here, so it can still race a concurrently
  // in-flight decryptAsync() call for the same session. Narrower window
  // (requires a burn/call-signaling decrypt to land during another
  // message's worker round trip) and not fixed here.
  private decryptQueue: Promise<unknown> = Promise.resolve();

  /**
   * Decrypt ciphertext asynchronously, offloading the heavy crypto + decompression
   * to a Web Worker. Falls back to synchronous main-thread decrypt() when
   * workers are unavailable.
   */
  decryptAsync(blob: Uint8Array, checkReplay: boolean = true): Promise<Uint8Array> {
    const run = this.decryptQueue.then(() => this.decryptAsyncSerialized(blob, checkReplay));
    this.decryptQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async decryptAsyncSerialized(blob: Uint8Array, checkReplay: boolean): Promise<Uint8Array> {
    if (!blob || blob.length < HEADER_SIZE + 1) {
      throw new Error(`decrypt: blob too short (${blob.length} bytes, need at least ${HEADER_SIZE + 1})`);
    }

    const wire = wireFormatFromBytes(blob);

    // Derive this message's key from the recv ratchet, same as the sync
    // path — not committed until the tag verifies below.
    const { messageKey: encKey, commit } = this.deriveRecvKey(wire.seq_number, checkReplay);

    // Reconstruct [ciphertext || tag]
    const ctWithTag = new Uint8Array(wire.ciphertext.length + wire.tag.length);
    ctWithTag.set(wire.ciphertext);
    ctWithTag.set(wire.tag, wire.ciphertext.length);

    if (ctWithTag.length < 16) {
      throw new Error(`decrypt: ciphertext+tag too short (${ctWithTag.length} bytes, need at least 16)`);
    }

    const aad = buildAAD(wire.dict_version, wire.seq_number, wire.padding_len);

    // Try worker offload for the heavy part (chacha20poly1305 + unpad + decompress)
    const workerResult = await workerDecrypt(ctWithTag, encKey, wire.nonce, wire.padding_len, aad, this.dict);

    if (workerResult) {
      commit();
      return workerResult;
    }

    // Fallback: run everything on main thread (same as synchronous decrypt)
    const cipher = chacha20poly1305(encKey, wire.nonce, aad);
    let padded: Uint8Array | null = null;
    try {
      padded = cipher.decrypt(ctWithTag);
    } catch (err) {
      throw new Error(`Decryption failed — authentication tag mismatch or corrupted data: ${err}`);
    }

    if (!padded) {
      throw new Error('Decryption failed — authentication tag mismatch or corrupted data');
    }

    commit();

    const compressed = padmeUnpad(padded, wire.padding_len);
    return decompressZlib(compressed, this.dict);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// TEST (commented out — run manually or in test suite)
// ─────────────────────────────────────────────────────────────────────────

/*

Quick Integration Test:

import { Session, generateKeypair, computeSharedSecret, buildDictionary } from './relay-crypto';
import { log } from '@/lib/platform/logger';

async function testRoundtrip() {
  log.debug('=== Relay Crypto Roundtrip Test ===\n');
  
  // 1. Generate keypairs for Alice and Bob
  const aliceKeys = generateKeypair();
  const bobKeys = generateKeypair();
  log.debug('✓ Generated keypairs for Alice and Bob');
  
  // 2. Compute shared secrets (both directions should be identical)
  const aliceSharedSecret = computeSharedSecret(aliceKeys.privateKey, bobKeys.publicKey);
  const bobSharedSecret = computeSharedSecret(bobKeys.privateKey, aliceKeys.publicKey);
  
  const secretsMatch = aliceSharedSecret.every((v, i) => v === bobSharedSecret[i]);
  log.debug(`✓ Shared secrets match: ${secretsMatch}`);
  
  // 3. Build dictionary from sample corpus
  const corpus = [
    'This is a test message for Relay messenger',
    'Encryption and compression working together',
    'Building secure communication channels',
  ];
  const dict = buildDictionary(corpus);
  log.debug(`✓ Built dictionary: ${dict.length} bytes`);
  
  // 4. Create sessions on both sides
  const aliceSession = new Session(aliceSharedSecret, dict, 1);
  const bobSession = new Session(bobSharedSecret, dict, 1);
  log.debug('✓ Created sessions for Alice and Bob');
  
  // 5. Alice encrypts a message
  const message = new TextEncoder().encode('Hello Bob, this is Alice!');
  const encrypted = aliceSession.encrypt(message);
  log.debug(`✓ Alice encrypted message: ${encrypted.length} bytes`);
  
  // 6. Bob decrypts
  const decrypted = bobSession.decrypt(encrypted);
  const decryptedText = new TextDecoder().decode(decrypted);
  log.debug(`✓ Bob decrypted: "${decryptedText}"`);
  
  // 7. Verify roundtrip
  const messagesMatch = new TextDecoder().decode(message) === decryptedText;
  log.debug(`✓ Roundtrip successful: ${messagesMatch}`);
  
  // 8. Test multiple messages to verify sequence tracking
  log.debug('\n--- Testing Sequence Tracking ---');
  for (let i = 0; i < 5; i++) {
    const msg = new TextEncoder().encode(`Message ${i + 1}`);
    const enc = aliceSession.encrypt(msg);
    const dec = bobSession.decrypt(enc);
    log.debug(`  Message ${i + 1}: "${new TextDecoder().decode(dec)}"`);
  }
  
  // 9. Test replay detection
  log.debug('\n--- Testing Replay Detection ---');
  const testMsg = new TextEncoder().encode('Replay test');
  const testEnc = aliceSession.encrypt(testMsg);
  bobSession.decrypt(testEnc); // First time OK
  log.debug('  ✓ First decryption OK');
  
  try {
    bobSession.decrypt(testEnc); // Should fail
    log.debug('  ✗ Replay not detected!');
  } catch (e) {
    log.debug('  ✓ Replay attack blocked');
  }
  
  log.debug('\n=== All Tests Passed ===');
}

// testRoundtrip().catch(console.error);

*/
