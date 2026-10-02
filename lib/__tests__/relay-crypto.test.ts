import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  Session,
  generateKeypair,
  computeSharedSecret,
  buildDictionary,
  generateHybridKeypair,
  performPqEncapsulation,
  performPqDecapsulation,
  deriveHybridSecret,
  computeHybridSharedSecret,
} from '../crypto/relay-crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build a minimal dictionary suitable for creating a Session. */
function makeDict(): Uint8Array {
  return buildDictionary([
    'This is a test message for Relay messenger',
    'Encryption and compression working together',
    'Building secure communication channels',
  ]);
}

/** Create an Alice/Bob session pair that share the same secret + dict. */
function makeSessionPair(dict?: Uint8Array) {
  const alice = generateKeypair();
  const bob = generateKeypair();
  const sharedA = computeSharedSecret(alice.privateKey, bob.publicKey);
  const sharedB = computeSharedSecret(bob.privateKey, alice.publicKey);
  const d = dict ?? makeDict();
  return {
    aliceSession: new Session(sharedA, d, 1, 'A'),
    bobSession: new Session(sharedB, d, 1, 'B'),
  };
}

// ---------------------------------------------------------------------------
// 1. Session encrypt / decrypt roundtrip
// ---------------------------------------------------------------------------

describe('Session encrypt/decrypt roundtrip', () => {
  it('encrypts and decrypts a simple text message', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const plaintext = encoder.encode('Hello Bob, this is Alice!');

    const encrypted = aliceSession.encrypt(plaintext);
    const decrypted = bobSession.decrypt(encrypted);

    expect(decoder.decode(decrypted)).toBe('Hello Bob, this is Alice!');
  });

  it('handles multiple sequential messages', () => {
    const { aliceSession, bobSession } = makeSessionPair();

    for (let i = 0; i < 10; i++) {
      const msg = `Message number ${i}`;
      const enc = aliceSession.encrypt(encoder.encode(msg));
      const dec = bobSession.decrypt(enc);
      expect(decoder.decode(dec)).toBe(msg);
    }
  });

  it('detects replay attacks', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(encoder.encode('replay me'));

    // First decryption succeeds
    bobSession.decrypt(encrypted);

    // Second decryption of same blob must throw
    expect(() => bobSession.decrypt(encrypted)).toThrow(/[Rr]eplay/);
  });

  it('allows re-decrypting the same blob via checkReplay=false as long as it has not been consumed with checkReplay=true first', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(encoder.encode('no replay check'));

    const dec1 = bobSession.decrypt(encrypted, false);
    const dec2 = bobSession.decrypt(encrypted, false);
    expect(decoder.decode(dec1)).toBe('no replay check');
    expect(decoder.decode(dec2)).toBe('no replay check');
  });

  it('forward secrecy: checkReplay=true permanently discards the message key, even for a later checkReplay=false call', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(encoder.encode('single use'));

    bobSession.decrypt(encrypted, true);
    expect(() => bobSession.decrypt(encrypted, false)).toThrow(/[Rr]eplay/);
  });

  it('forward secrecy: compromising the current recv chain key cannot decrypt an already-consumed earlier message', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const first = aliceSession.encrypt(encoder.encode('secret from the past'));
    bobSession.decrypt(first); // consumed — chain advances past seq 0

    aliceSession.encrypt(encoder.encode('padding to advance the send chain'));
    const third = aliceSession.encrypt(encoder.encode('current message'));

    // A fresh Session built with bob's *current* chain state (simulating key
    // compromise at this point in time) must not be able to derive seq 0's
    // key — only whoever held it at the time could ever decrypt it.
    expect(() => bobSession.decrypt(first, false)).toThrow(/[Rr]eplay/);

    // But current/future traffic still decrypts fine with the live session.
    const dec = bobSession.decrypt(third);
    expect(decoder.decode(dec)).toBe('current message');
  });
});

// ---------------------------------------------------------------------------
// 1b. Bidirectional Session (one Session instance used for both encrypt AND
// decrypt, matching how sessionsRef is used in lib/use-relay-messaging.ts).
// Regression coverage for a bug where decrypt() overwrote the shared
// `counter` field with the peer's inbound sequence number, corrupting the
// local outgoing counter used by encrypt() on the same instance.
// ---------------------------------------------------------------------------

describe('Session used bidirectionally on a single instance', () => {
  it("a peer's low-sequence reply does not roll back this instance's own outgoing counter and cause a later message to collide with one already sent", () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const sharedA = computeSharedSecret(alice.privateKey, bob.publicKey);
    const sharedB = computeSharedSecret(bob.privateKey, alice.publicKey);
    const dict = makeDict();

    // A single Session per side, used for both directions — same as sessionsRef
    // in lib/use-relay-messaging.ts.
    const aliceSession = new Session(sharedA, dict, 1, 'A');
    const bobSession = new Session(sharedB, dict, 1, 'B');

    // Alice sends 3 messages in a burst (her outgoing seq: 0, 1, 2). Bob
    // hasn't decrypted any of them yet.
    const a0 = aliceSession.encrypt(encoder.encode('alice message 0'));
    const a1 = aliceSession.encrypt(encoder.encode('alice message 1'));
    const a2 = aliceSession.encrypt(encoder.encode('alice message 2'));

    // Bob replies right away, before decrypting any of Alice's messages —
    // his own outgoing counter is still fresh (seq 0).
    const b0 = bobSession.encrypt(encoder.encode('bob reply 0'));

    // Bob now catches up and decrypts Alice's 3 messages. This populates his
    // seenSeqs (tracking Alice's used sequence numbers) with {0, 1, 2}.
    expect(decoder.decode(bobSession.decrypt(a0))).toBe('alice message 0');
    expect(decoder.decode(bobSession.decrypt(a1))).toBe('alice message 1');
    expect(decoder.decode(bobSession.decrypt(a2))).toBe('alice message 2');

    // Alice decrypts Bob's reply (seq 0). Before the fix, decrypt()
    // unconditionally set aliceSession's own outgoing counter to the inbound
    // seq (0), rolling it back from 3 (her true next-seq, having already
    // sent 3 messages) down to 0, then advancing to 1.
    expect(decoder.decode(aliceSession.decrypt(b0))).toBe('bob reply 0');

    // Alice sends a 4th message. Pre-fix this would reuse seq=1 — a sequence
    // number she already used for `a1` above — instead of the correct seq=3.
    // Bob's checkReplay already has seq 1 recorded (from a1), so decrypting
    // this new, legitimate message would be wrongly rejected as a replay.
    const a3 = aliceSession.encrypt(encoder.encode('alice message 3'));
    expect(decoder.decode(bobSession.decrypt(a3))).toBe('alice message 3');
  });
});

// ---------------------------------------------------------------------------
// 1c. decryptAsync() concurrency — regression coverage for a race where two
// messages decrypting at once (e.g. a long message split into back-to-back
// segments) could commit their ratchet advance out of order: whichever
// commit() ran last won, even if it was derived from an earlier, now-stale
// read of the chain state. That could roll the receive ratchet backward and
// resurrect an already-consumed message key, reopening the replay window.
// ---------------------------------------------------------------------------

describe('Session.decryptAsync concurrency', () => {
  it('two concurrent decryptAsync calls for adjacent sequence numbers both decrypt correctly and do not desync the ratchet', async () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const enc0 = aliceSession.encrypt(encoder.encode('segment 0'));
    const enc1 = aliceSession.encrypt(encoder.encode('segment 1'));

    // Fire the higher sequence number's decrypt BEFORE the lower one's,
    // without awaiting in between — this is the call order that would let a
    // naive implementation's stale read/late commit roll the ratchet back.
    const p1 = bobSession.decryptAsync(enc1, false);
    const p0 = bobSession.decryptAsync(enc0, false);
    const [dec1, dec0] = await Promise.all([p1, p0]);
    expect(decoder.decode(dec1)).toBe('segment 1');
    expect(decoder.decode(dec0)).toBe('segment 0');

    // Accept + permanently consume both, exactly as receive.ts does after a
    // peeked (checkReplay=false) decrypt is accepted.
    bobSession.consumeRecvKey(enc1);
    bobSession.consumeRecvKey(enc0);

    // A subsequent, unrelated message must still decrypt normally — the
    // ratchet must have actually advanced past both concurrent messages,
    // not just past whichever one committed last.
    const enc2 = aliceSession.encrypt(encoder.encode('segment 2'));
    const dec2 = await bobSession.decryptAsync(enc2, false);
    expect(decoder.decode(dec2)).toBe('segment 2');
    bobSession.consumeRecvKey(enc2);

    // Redelivering the already-consumed seq=1 blob must be rejected, not
    // silently re-decrypted — this is the actual replay-protection break a
    // rolled-back ratchet would cause.
    await expect(bobSession.decryptAsync(enc1, false)).rejects.toThrow(/[Rr]eplay/);
    await expect(bobSession.decryptAsync(enc0, false)).rejects.toThrow(/[Rr]eplay/);
  });
});

// ---------------------------------------------------------------------------
// serialize()/fromSerialized() — crash-resume persistence of the SEND
// ratchet specifically. This is the scenario the round-2/3 audit flagged as
// the most significant unfixed finding: encryptAsync() advances send-chain
// state in memory, but nothing persisted it until the NEXT incoming message
// (receive.ts) or a visibilitychange/pagehide snapshot — so a hard
// crash/force-kill right after sending permanently desynced the outgoing
// direction (the app would resume from a stale, already-superseded send
// chain key, producing ciphertext the peer's still-advanced recv ratchet
// could never decrypt). Fixed by calling saveRatchetState() immediately
// after every encryptAsync() call site (send.ts, key-exchange.ts,
// connection.ts, use-group-messaging.ts, use-reactions.ts,
// use-message-editing.ts). These tests exercise the underlying Session
// primitive that fix relies on — not the React hooks around it, which would
// require mocking the entire WebSocket/store stack for no additional
// assurance about the actual crypto invariant.
// ---------------------------------------------------------------------------

describe('Session serialize/fromSerialized: send-ratchet crash-resume', () => {
  it('a session rebuilt from a snapshot taken right after encrypt continues the SAME chain — the peer can still decrypt in order', () => {
    const { aliceSession, bobSession } = makeSessionPair();

    // Alice sends message 1, then "crashes": snapshot + rebuild immediately,
    // simulating a persisted saveRatchetState() call followed by an app
    // restart before anything else happens.
    const enc1 = aliceSession.encrypt(encoder.encode('before crash'));
    const snapshot = aliceSession.serialize();
    const dict = makeDict();
    const restoredAlice = Session.fromSerialized(snapshot, dict);

    // Alice (post-restart) sends message 2 from the restored session.
    const enc2 = restoredAlice.encrypt(encoder.encode('after crash'));

    // Bob's session was never touched by the crash — it must decrypt BOTH
    // messages, in order, exactly as if no restart had happened.
    expect(decoder.decode(bobSession.decrypt(enc1))).toBe('before crash');
    expect(decoder.decode(bobSession.decrypt(enc2))).toBe('after crash');
  });

  it('without persisting after send, a crash rolls the chain back and desyncs the peer (demonstrates the bug this fix closes)', () => {
    const { aliceSession, bobSession } = makeSessionPair();

    // Snapshot BEFORE the send (the old behavior: nothing saves state on
    // send, so a crash resumes from whatever was last persisted, which is
    // stale the moment even one message has gone out since).
    const staleSnapshot = aliceSession.serialize();
    const enc1 = aliceSession.encrypt(encoder.encode('sent but never persisted'));
    // Bob accepts it — his recv ratchet is now one step ahead of Alice's
    // stale snapshot.
    expect(decoder.decode(bobSession.decrypt(enc1))).toBe('sent but never persisted');

    // "Crash": Alice restarts from the stale (pre-send) snapshot.
    const dict = makeDict();
    const restoredAlice = Session.fromSerialized(staleSnapshot, dict);
    const enc2 = restoredAlice.encrypt(encoder.encode('desynced message'));

    // Bob's recv ratchet has already moved past this sequence number — the
    // desynced retransmit is rejected as a replay rather than decrypting.
    expect(() => bobSession.decrypt(enc2)).toThrow(/[Rr]eplay/);
  });

  it('serialize()/fromSerialized() preserves the skipped-key cache for out-of-order recv too, not just the send chain', () => {
    const { aliceSession, bobSession } = makeSessionPair();

    // Alice sends 3 messages; Bob only receives the 3rd (1 and 2 arrive
    // "later" — out-of-order delivery), populating his skipped-key cache.
    const enc1 = aliceSession.encrypt(encoder.encode('one'));
    const enc2 = aliceSession.encrypt(encoder.encode('two'));
    const enc3 = aliceSession.encrypt(encoder.encode('three'));
    expect(decoder.decode(bobSession.decrypt(enc3))).toBe('three');

    // Bob "crashes" right after — his skipped keys for seq 0/1 must survive
    // the restart so the still-outstanding messages 1 and 2 can decrypt later.
    const bobSnapshot = bobSession.serialize();
    expect(bobSnapshot.skipped.length).toBe(2);
    const dict = makeDict();
    const restoredBob = Session.fromSerialized(bobSnapshot, dict);

    expect(decoder.decode(restoredBob.decrypt(enc1))).toBe('one');
    expect(decoder.decode(restoredBob.decrypt(enc2))).toBe('two');
  });
});

// ---------------------------------------------------------------------------
// 2. Key generation
// ---------------------------------------------------------------------------

describe('generateKeypair', () => {
  it('returns 32-byte private and public keys', () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  it('generates distinct keypairs on each call', () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(bytesToHex(a.privateKey)).not.toBe(bytesToHex(b.privateKey));
    expect(bytesToHex(a.publicKey)).not.toBe(bytesToHex(b.publicKey));
  });

  it('public key matches x25519.getPublicKey(privateKey)', () => {
    const kp = generateKeypair();
    const derivedPub = x25519.getPublicKey(kp.privateKey);
    expect(bytesToHex(kp.publicKey)).toBe(bytesToHex(derivedPub));
  });
});

// ---------------------------------------------------------------------------
// 3. Shared secret computation
// ---------------------------------------------------------------------------

describe('computeSharedSecret', () => {
  it('produces the same shared secret for both sides of a DH exchange', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();

    const secretA = computeSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(bytesToHex(secretA)).toBe(bytesToHex(secretB));
  });

  it('returns a 32-byte shared secret', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = computeSharedSecret(alice.privateKey, bob.publicKey);
    expect(secret.length).toBe(32);
  });

  it('produces different secrets for different keypair combinations', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const carol = generateKeypair();

    const secretAB = computeSharedSecret(alice.privateKey, bob.publicKey);
    const secretAC = computeSharedSecret(alice.privateKey, carol.publicKey);

    expect(bytesToHex(secretAB)).not.toBe(bytesToHex(secretAC));
  });
});

// ---------------------------------------------------------------------------
// 4. PADME padding (tested indirectly through encrypt/decrypt roundtrip)
// ---------------------------------------------------------------------------

describe('PADME padding', () => {
  it('encrypted output is at least HEADER + MIN_PAD_SIZE bytes', () => {
    const { aliceSession } = makeSessionPair();
    // A 1-byte plaintext should still produce a padded ciphertext
    const encrypted = aliceSession.encrypt(encoder.encode('x'));
    // Header = 43 bytes; min padded plaintext = 64 bytes (after compression + pad)
    expect(encrypted.length).toBeGreaterThanOrEqual(43 + 1);
  });

  it('different-length messages that round to the same power of 2 produce same ciphertext length', () => {
    // Two messages whose compressed sizes both fall within the same power-of-2 bucket
    // should produce identical ciphertext lengths (demonstrating PADME alignment).
    const dict = makeDict();
    const alice1 = generateKeypair();
    const bob1 = generateKeypair();
    const shared1 = computeSharedSecret(alice1.privateKey, bob1.publicKey);

    const alice2 = generateKeypair();
    const bob2 = generateKeypair();
    const shared2 = computeSharedSecret(alice2.privateKey, bob2.publicKey);

    const s1 = new Session(shared1, dict, 1);
    const s2 = new Session(shared2, dict, 1);

    // These short messages should compress to very small sizes, both fitting in the 64-byte minimum pad bucket
    const enc1 = s1.encrypt(encoder.encode('hi'));
    const enc2 = s2.encrypt(encoder.encode('hello'));

    // Both should be padded to the same bucket (64 min), so ciphertext lengths should match
    expect(enc1.length).toBe(enc2.length);
  });

  it('padding is reversible (roundtrip preserves exact plaintext)', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const original = 'The quick brown fox jumps over the lazy dog';
    const encrypted = aliceSession.encrypt(encoder.encode(original));
    const decrypted = bobSession.decrypt(encrypted);
    expect(decoder.decode(decrypted)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 5. Compression + encryption pipeline (buildDictionary + Session with dict)
// ---------------------------------------------------------------------------

describe('Compression + encryption pipeline', () => {
  it('buildDictionary returns a non-empty Uint8Array', () => {
    const dict = buildDictionary([
      'alpha bravo charlie delta echo foxtrot',
      'alpha bravo charlie delta echo foxtrot golf hotel',
    ]);
    expect(dict).toBeInstanceOf(Uint8Array);
    expect(dict.length).toBeGreaterThan(0);
  });

  it('buildDictionary respects maxSize parameter', () => {
    const sentences = Array.from({ length: 100 }, (_, i) =>
      `sentence number ${i} with some repeated words for dictionary building`
    );
    const dict = buildDictionary(sentences, 1024);
    expect(dict.length).toBeLessThanOrEqual(1024);
  });

  it('session constructed with a custom dictionary can roundtrip', () => {
    const corpus = [
      'the quick brown fox jumps over the lazy dog',
      'the quick brown fox jumps over the lazy dog again',
      'the quick brown fox is tired of jumping',
    ];
    const dict = buildDictionary(corpus, 4096);

    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = computeSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = computeSharedSecret(bob.privateKey, alice.publicKey);

    const sA = new Session(secret, dict, 2, 'A');
    const sB = new Session(secretB, dict, 2, 'B');

    const msg = 'the quick brown fox jumps over the lazy dog';
    const enc = sA.encrypt(encoder.encode(msg));
    const dec = sB.decrypt(enc);
    expect(decoder.decode(dec)).toBe(msg);
  });

  it('rejects empty dictionary in Session constructor', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = computeSharedSecret(alice.privateKey, bob.publicKey);

    expect(() => new Session(secret, new Uint8Array(0), 1)).toThrow(/dictionary/i);
  });

  it('rejects empty shared secret in Session constructor', () => {
    const dict = makeDict();
    expect(() => new Session(new Uint8Array(0), dict, 1)).toThrow(/sharedSecret/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles a very long text message', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    // 100 KB of text
    const longMsg = 'A'.repeat(100_000);
    const encrypted = aliceSession.encrypt(encoder.encode(longMsg));
    const decrypted = bobSession.decrypt(encrypted);
    expect(decoder.decode(decrypted)).toBe(longMsg);
  });

  it('handles binary data (non-UTF8 bytes)', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    // Create a buffer with all 256 byte values
    const binary = new Uint8Array(256);
    for (let i = 0; i < 256; i++) binary[i] = i;

    const encrypted = aliceSession.encrypt(binary);
    const decrypted = bobSession.decrypt(encrypted);

    expect(decrypted.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(decrypted[i]).toBe(i);
    }
  });

  it('encrypted output differs for the same plaintext (nonce uniqueness)', () => {
    const dict = makeDict();
    const alice = generateKeypair();
    const bob = generateKeypair();
    const secret = computeSharedSecret(alice.privateKey, bob.publicKey);

    const s1 = new Session(secret, dict, 1);
    const s2 = new Session(secret, dict, 1);

    const msg = encoder.encode('same plaintext');
    const enc1 = s1.encrypt(msg);
    const enc2 = s2.encrypt(msg);

    // Even though both sessions share the same key and the plaintext is
    // identical, each encryption uses a random nonce so the output must differ.
    expect(bytesToHex(enc1)).not.toBe(bytesToHex(enc2));
  });

  it('rejects truncated / corrupted ciphertext', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(encoder.encode('will be corrupted'));

    // Truncate to just the header
    const truncated = encrypted.slice(0, 43);
    expect(() => bobSession.decrypt(truncated)).toThrow();
  });

  it('rejects ciphertext with flipped bits (authentication failure)', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(encoder.encode('integrity check'));

    // Flip a byte in the ciphertext portion (after the 43-byte header)
    const corrupted = new Uint8Array(encrypted);
    corrupted[44] ^= 0xff;

    expect(() => bobSession.decrypt(corrupted)).toThrow(/[Dd]ecryption failed/);
  });

  it('handles a short 1-byte message', () => {
    const { aliceSession, bobSession } = makeSessionPair();
    const encrypted = aliceSession.encrypt(new Uint8Array([42]));
    const decrypted = bobSession.decrypt(encrypted);
    expect(decrypted.length).toBe(1);
    expect(decrypted[0]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 7. Post-quantum hybrid key exchange (X25519 + ML-KEM768)
// ---------------------------------------------------------------------------

describe('Post-quantum hybrid key exchange', () => {
  it('generateHybridKeypair produces both classical and PQ keypairs', () => {
    const hybrid = generateHybridKeypair();

    // Classical X25519 keypair
    expect(hybrid.classicalPrivate).toBeInstanceOf(Uint8Array);
    expect(hybrid.classicalPublic).toBeInstanceOf(Uint8Array);
    expect(hybrid.classicalPrivate.length).toBe(32);
    expect(hybrid.classicalPublic.length).toBe(32);

    // Post-quantum ML-KEM768 keypair
    expect(hybrid.pqPrivate).toBeInstanceOf(Uint8Array);
    expect(hybrid.pqPublic).toBeInstanceOf(Uint8Array);
    // ML-KEM768: private key is 2400 bytes, public key is 1184 bytes
    expect(hybrid.pqPrivate.length).toBe(2400);
    expect(hybrid.pqPublic.length).toBe(1184);
  });

  it('generates distinct hybrid keypairs on each call', () => {
    const a = generateHybridKeypair();
    const b = generateHybridKeypair();

    // Classical keys should be different
    expect(bytesToHex(a.classicalPrivate)).not.toBe(bytesToHex(b.classicalPrivate));
    expect(bytesToHex(a.classicalPublic)).not.toBe(bytesToHex(b.classicalPublic));

    // PQ keys should be different
    expect(bytesToHex(a.pqPublic)).not.toBe(bytesToHex(b.pqPublic));
  });

  it('PQ encapsulation/decapsulation roundtrip produces same shared secret', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Alice encapsulates to Bob's PQ public key
    const { cipherText, sharedSecret: aliceSecret } = performPqEncapsulation(bob.pqPublic);

    // Bob decapsulates using his PQ private key
    const bobSecret = performPqDecapsulation(cipherText, bob.pqPrivate);

    // Secrets should match
    expect(bytesToHex(aliceSecret)).toBe(bytesToHex(bobSecret));
  });

  it('deriveHybridSecret combines classical and PQ secrets via HKDF', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Classical X25519 shared secret
    const classicalShared = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);

    // PQ shared secret
    const { sharedSecret: pqShared } = performPqEncapsulation(bob.pqPublic);

    // Derive hybrid secret
    const hybridSecret = deriveHybridSecret(classicalShared, pqShared);

    // Result should be 32 bytes (HKDF output)
    expect(hybridSecret.length).toBe(32);
    expect(hybridSecret).toBeInstanceOf(Uint8Array);
  });

  it('hybrid shared secret is different from classical-only secret', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Classical-only secret
    const classicalSecret = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);

    // Hybrid secret (classical + PQ)
    const { cipherText, sharedSecret: pqShared } = performPqEncapsulation(bob.pqPublic);
    const hybridSecret = deriveHybridSecret(classicalSecret, pqShared);

    // Secrets should be different
    expect(bytesToHex(hybridSecret)).not.toBe(bytesToHex(classicalSecret));
  });

  it('computeHybridSharedSecret handles sender side (with theirPqPublic)', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Alice sends key exchange with encapsulation to Bob's PQ key
    const sharedSecret = computeHybridSharedSecret({
      myClassicalPrivate: alice.classicalPrivate,
      theirClassicalPublic: bob.classicalPublic,
      theirPqPublic: bob.pqPublic,
    });

    expect(sharedSecret.length).toBe(32);
  });

  it('computeHybridSharedSecret handles receiver side (with cipherText)', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Encapsulate from Alice to Bob's PQ key
    const { cipherText } = performPqEncapsulation(bob.pqPublic);

    // Bob receives and decapsulates
    const sharedSecret = computeHybridSharedSecret({
      myClassicalPrivate: bob.classicalPrivate,
      theirClassicalPublic: alice.classicalPublic,
      cipherText,
      myPqPrivate: bob.pqPrivate,
    });

    expect(sharedSecret.length).toBe(32);
  });

  it('hybrid key exchange: Alice → Bob roundtrip produces matching secrets', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Alice initiates: she encapsulates to Bob's PQ key to get the ciphertext
    const { cipherText, sharedSecret: alicePqShared } = performPqEncapsulation(bob.pqPublic);

    // Alice computes her hybrid secret
    const aliceClassicalShared = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);
    const aliceSecret = deriveHybridSecret(aliceClassicalShared, alicePqShared);

    // Bob receives the ciphertext and decapsulates it with his private key
    const bobPqShared = performPqDecapsulation(cipherText, bob.pqPrivate);

    // Bob computes his hybrid secret (should match Alice's)
    const bobClassicalShared = computeSharedSecret(bob.classicalPrivate, alice.classicalPublic);
    const bobSecret = deriveHybridSecret(bobClassicalShared, bobPqShared);

    // Both should arrive at the same hybrid secret
    expect(bytesToHex(aliceSecret)).toBe(bytesToHex(bobSecret));
  });

  it('backward compatibility: classical-only fallback when PQ keys missing', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();

    // Simulate old client (no PQ key)
    const classicalSecret = computeHybridSharedSecret({
      myClassicalPrivate: alice.classicalPrivate,
      theirClassicalPublic: bob.classicalPublic,
      // No theirPqPublic, no cipherText - fallback
    });

    // Should return classical-only secret (not hybrid)
    const classicalOnlySecret = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);
    expect(bytesToHex(classicalSecret)).toBe(bytesToHex(classicalOnlySecret));
  });

  it('hybrid key exchange with Session encryption roundtrip', () => {
    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();
    const dict = makeDict();

    // Establish hybrid shared secrets via proper PQ key exchange
    // Alice encapsulates to Bob's PQ key
    const { cipherText, sharedSecret: alicePqShared } = performPqEncapsulation(bob.pqPublic);

    // Alice computes hybrid secret
    const aliceClassicalShared = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);
    const aliceSecret = deriveHybridSecret(aliceClassicalShared, alicePqShared);

    // Bob decapsulates Alice's ciphertext
    const bobPqShared = performPqDecapsulation(cipherText, bob.pqPrivate);

    // Bob computes hybrid secret (should match Alice's)
    const bobClassicalShared = computeSharedSecret(bob.classicalPrivate, alice.classicalPublic);
    const bobSecret = deriveHybridSecret(bobClassicalShared, bobPqShared);

    // Create sessions with matched hybrid secrets
    const aliceSession = new Session(aliceSecret, dict, 1, 'A');
    const bobSession = new Session(bobSecret, dict, 1, 'B');

    // Encrypt/decrypt roundtrip using hybrid session
    const plaintext = encoder.encode('Quantum-resistant message');
    const encrypted = aliceSession.encrypt(plaintext);
    const decrypted = bobSession.decrypt(encrypted);

    expect(decoder.decode(decrypted)).toBe('Quantum-resistant message');
  });

  it('initiator/responder derive identical hybrid secrets (one-way encapsulation protocol)', () => {
    // This test mirrors the use-relay-messaging protocol:
    // 1. Alice (initiator) encapsulates to Bob's PQ key, stores the PQ ss
    // 2. Alice sends: her classical key, her PQ key, the ciphertext
    // 3. Bob (responder) receives and decapsulates → gets the same PQ ss
    // 4. Bob replies with just his classical key (no ciphertext back)
    // 5. Alice uses her stored PQ ss + Bob's classical key to derive hybrid secret
    // Both must arrive at the same session key.

    const alice = generateHybridKeypair();
    const bob = generateHybridKeypair();
    const dict = makeDict();

    // Step 1-2: Alice initiates, encapsulates to Bob's PQ public key
    const { cipherText, sharedSecret: aliceStoredPqSs } = performPqEncapsulation(bob.pqPublic);

    // Step 3: Bob receives ciphertext, decapsulates, derives hybrid secret (responder path)
    const bobPqSs = performPqDecapsulation(cipherText, bob.pqPrivate);
    const bobClassical = computeSharedSecret(bob.classicalPrivate, alice.classicalPublic);
    const bobHybridSecret = deriveHybridSecret(bobClassical, bobPqSs);

    // Step 4-5: Alice receives Bob's reply (no ciphertext), uses stored PQ ss (initiator path)
    const aliceClassical = computeSharedSecret(alice.classicalPrivate, bob.classicalPublic);
    const aliceHybridSecret = deriveHybridSecret(aliceClassical, aliceStoredPqSs);

    // Both must arrive at the same key
    expect(bytesToHex(aliceHybridSecret)).toBe(bytesToHex(bobHybridSecret));

    // Both sessions must successfully exchange messages
    const aliceSession = new Session(aliceHybridSecret, dict, 1, 'A');
    const bobSession = new Session(bobHybridSecret, dict, 1, 'B');

    const msg = encoder.encode('initiator-responder hybrid roundtrip');
    const enc = aliceSession.encrypt(msg);
    const dec = bobSession.decrypt(enc);
    expect(decoder.decode(dec)).toBe('initiator-responder hybrid roundtrip');
  });
});
