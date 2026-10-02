/**
 * @vitest-environment node
 *
 * Messaging pipeline integration test
 *
 * The default project-wide `jsdom` environment provides a Uint8Array from a
 * different realm than Node's `Buffer`, which breaks `Buffer instanceof
 * Uint8Array` checks (used by @noble/curves' argument validation, and by
 * lib/crypto/message-signing.ts internally) — this file forces the real
 * Node environment to avoid that cross-realm artifact, matching the
 * convention already used in sqlite-client.test.ts.
 *
 * lib/use-relay-messaging.ts was split into lib/messaging/{send,receive,
 * key-exchange,...}.ts in this refactor. None of those modules are unit
 * tested directly (they're React hooks wired into a shared refs object),
 * but the wire-format contract between them is pure logic: derive a shared
 * secret + complementary Session roles the same way key-exchange.ts does,
 * build/sign the exact JSON envelope send.ts builds, then decrypt + verify
 * it the way receive.ts does. If a future change to that envelope shape (or
 * to role derivation) breaks compatibility between two peers, this test
 * catches it even though it never touches React.
 *
 * Mirrors the "real crypto, minimal mocking" convention used by
 * relay-crypto.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  Session,
  generateKeypair,
  computeSharedSecret,
  deriveSessionRole,
  buildDictionary,
} from '../crypto/relay-crypto';
import { signMessage, verifyMessageSignature, deriveSigningKeypair, type SignedMessage } from '../crypto/message-signing';
import { v4 as uuidv4 } from 'uuid';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A properly-matched Ed25519 keypair, i.e. what lib/crypto/message-signing.ts
 * (ed25519.sign / ed25519.verify) actually expects: publicKey must be
 * ed25519.getPublicKey(privateKey), NOT x25519.getPublicKey(privateKey).
 */
function makeEd25519Identity(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const { secretKey, publicKey } = ed25519.keygen();
  return { privateKey: secretKey, publicKey };
}

function makeDict(): Uint8Array {
  return buildDictionary([
    'This is a test message for Relay messenger',
    'Encryption and compression working together',
    'Building secure communication channels',
  ]);
}

/**
 * Build the exact wire payload lib/messaging/send.ts's sendMessage()
 * constructs (see the `wirePayload = JSON.stringify({...})` block), sign
 * it with the sender's long-term identity key, and encrypt it with the
 * per-contact Session — the same two steps send.ts performs before hexing
 * the ciphertext onto the wire.
 */
async function buildAndEncryptTextEnvelope(opts: {
  session: Session;
  msgId: string;
  text: string;
  senderRelayId: string;
  senderIdentityPrivateKey: Uint8Array;
  replyTo?: unknown;
  expiresAt?: number;
}): Promise<{ blob: Uint8Array; signed: SignedMessage }> {
  const signed = await signMessage(opts.msgId, opts.text, opts.senderRelayId, opts.senderIdentityPrivateKey);

  const wirePayload = JSON.stringify({
    type: 'text',
    text: opts.text,
    ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    sig: signed.signature,
    sigTs: signed.timestamp,
  });
  const plaintext = encoder.encode(wirePayload);
  const blob = opts.session.encrypt(plaintext);
  return { blob, signed };
}

/**
 * Decrypt + parse + verify the way lib/messaging/receive.ts's onmessage
 * handler does for a `type: 'text'` envelope: decrypt with the recipient's
 * Session, JSON.parse the plaintext, and — when `sig`/`sigTs` are present —
 * verify against the claimed sender's long-term identity public key using
 * the message's relay-assigned `messageId` and the `fromRelayId` the relay
 * attached to the frame (NOT the session/content alone).
 */
function decryptAndVerifyTextEnvelope(opts: {
  session: Session;
  blob: Uint8Array;
  messageId: string;
  fromRelayId: string;
  senderIdentityPublicKey: Uint8Array;
}): { text: string; verified: boolean } {
  const plaintext = opts.session.decrypt(opts.blob);
  const parsed = JSON.parse(decoder.decode(plaintext));
  expect(parsed.type).toBe('text');

  let verified = false;
  if (typeof parsed.sig === 'string' && typeof parsed.sigTs === 'number') {
    verified = verifyMessageSignature(
      {
        messageId: opts.messageId,
        content: parsed.text ?? '',
        signature: parsed.sig,
        timestamp: parsed.sigTs,
        senderRelayId: opts.fromRelayId,
      },
      opts.senderIdentityPublicKey
    );
  }
  return { text: parsed.text, verified };
}

describe('messaging pipeline: key-exchange -> send -> receive', () => {
  it('derives complementary Session roles from X25519 public keys regardless of which side computes them', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();

    const roleFromAlice = deriveSessionRole(alice.publicKey, bob.publicKey);
    const roleFromBob = deriveSessionRole(bob.publicKey, alice.publicKey);

    expect(roleFromAlice).not.toBe(roleFromBob);
    expect(['A', 'B']).toContain(roleFromAlice);
    expect(['A', 'B']).toContain(roleFromBob);
  });

  it('two peers derive the same shared secret and build sessions with complementary roles that can talk to each other', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();

    const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey);
    expect(Buffer.from(aliceShared).toString('hex')).toBe(Buffer.from(bobShared).toString('hex'));

    const dict = makeDict();
    const aliceRole = deriveSessionRole(alice.publicKey, bob.publicKey);
    const bobRole = deriveSessionRole(bob.publicKey, alice.publicKey);

    // Same construction as key-exchange.ts: `new Session(sharedSecret, dict, 1, role)`.
    const aliceSession = new Session(aliceShared, dict, 1, aliceRole);
    const bobSession = new Session(bobShared, dict, 1, bobRole);

    const probe = aliceSession.encrypt(encoder.encode('role sanity check'));
    expect(decoder.decode(bobSession.decrypt(probe))).toBe('role sanity check');
  });

  it('sends a signed text envelope end-to-end: encrypt+sign on Alice, decrypt+verify on Bob', async () => {
    // A properly-matched Ed25519 identity keypair — see makeEd25519Identity()
    // and the "KNOWN BUG" test below for why generateKeypair() (X25519)
    // cannot be substituted here despite being what send.ts/receive.ts
    // actually pass to signMessage/verifyMessageSignature in production.
    const aliceIdentity = makeEd25519Identity();
    const aliceRelayId = 'relay:alice0000000001';

    const aliceSession = generateKeypair();
    const bobSession = generateKeypair();
    const aliceShared = computeSharedSecret(aliceSession.privateKey, bobSession.publicKey);
    const bobShared = computeSharedSecret(bobSession.privateKey, aliceSession.publicKey);
    const dict = makeDict();
    const aliceRole = deriveSessionRole(aliceSession.publicKey, bobSession.publicKey);
    const bobRole = deriveSessionRole(bobSession.publicKey, aliceSession.publicKey);

    const aliceSess = new Session(aliceShared, dict, 1, aliceRole);
    const bobSess = new Session(bobShared, dict, 1, bobRole);

    const msgId = uuidv4();
    const { blob } = await buildAndEncryptTextEnvelope({
      session: aliceSess,
      msgId,
      text: 'Hello Bob, this is signed and encrypted.',
      senderRelayId: aliceRelayId,
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const result = decryptAndVerifyTextEnvelope({
      session: bobSess,
      blob,
      messageId: msgId,
      fromRelayId: aliceRelayId,
      senderIdentityPublicKey: aliceIdentity.publicKey,
    });

    expect(result.text).toBe('Hello Bob, this is signed and encrypted.');
    expect(result.verified).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Regression test for a fixed bug: signing/verification used to run
  // directly on the user's long-term X25519 DH identity key
  // (lib/messaging/identity.ts) fed straight into ed25519.sign()/verify()
  // (lib/crypto/message-signing.ts). Ed25519 and X25519 are different curve
  // forms (twisted Edwards vs. Montgomery) with different key-derivation/
  // clamping — reusing the same 32-byte seed for both does NOT yield a
  // matching keypair (`ed25519.getPublicKey(seed) !== x25519.getPublicKey(seed)`),
  // so verification failed for every legitimately-signed message, not just
  // tampered ones. Fixed by deriveSigningKeypair() (message-signing.ts),
  // which HKDF-derives a dedicated Ed25519 keypair from the X25519 identity
  // key; the derived public half is exchanged alongside the X25519 public
  // key during key exchange (see key-exchange.ts / SessionData.signingPublicKeyHex)
  // so peers can actually verify it. This test exercises the real fixed
  // path end-to-end: X25519 identity key in, deriveSigningKeypair, sign,
  // verify against the derived (not the X25519) public key.
  // ---------------------------------------------------------------------
  it('regression: deriveSigningKeypair makes the real X25519 identity key produce a verifiable signature', async () => {
    const aliceIdentity = generateKeypair(); // X25519 — matches identity.ts's real identity key type
    const aliceRelayId = 'relay:alice0000000001';
    const aliceSigningKeypair = deriveSigningKeypair(aliceIdentity.privateKey);

    const aliceSession = generateKeypair();
    const bobSession = generateKeypair();
    const aliceShared = computeSharedSecret(aliceSession.privateKey, bobSession.publicKey);
    const bobShared = computeSharedSecret(bobSession.privateKey, aliceSession.publicKey);
    const dict = makeDict();
    const aliceRole = deriveSessionRole(aliceSession.publicKey, bobSession.publicKey);
    const bobRole = deriveSessionRole(bobSession.publicKey, aliceSession.publicKey);
    const aliceSess = new Session(aliceShared, dict, 1, aliceRole);
    const bobSess = new Session(bobShared, dict, 1, bobRole);

    const msgId = uuidv4();
    const { blob } = await buildAndEncryptTextEnvelope({
      session: aliceSess,
      msgId,
      text: 'this message is completely genuine and untampered',
      senderRelayId: aliceRelayId,
      senderIdentityPrivateKey: aliceSigningKeypair.privateKey, // derived Ed25519 key, as send.ts now does
    });

    // Bob verifies against Alice's derived Ed25519 signing public key —
    // exchanged during key exchange and stored as
    // sessionData.signingPublicKeyHex, exactly what receive.ts now uses.
    const result = decryptAndVerifyTextEnvelope({
      session: bobSess,
      blob,
      messageId: msgId,
      fromRelayId: aliceRelayId,
      senderIdentityPublicKey: aliceSigningKeypair.publicKey,
    });

    expect(result.text).toBe('this message is completely genuine and untampered');
    expect(result.verified).toBe(true);

    // Sanity check the bug is real: signing/verifying with the RAW X25519
    // identity key (the old, broken behavior) must still fail, proving this
    // test would have caught the original bug.
    const staleMsgId = uuidv4();
    const staleEnvelope = await buildAndEncryptTextEnvelope({
      session: new Session(aliceShared, dict, 1, aliceRole),
      msgId: staleMsgId,
      text: 'another message',
      senderRelayId: aliceRelayId,
      senderIdentityPrivateKey: aliceIdentity.privateKey, // raw X25519 key — the old bug
    });
    expect(() =>
      decryptAndVerifyTextEnvelope({
        session: new Session(bobShared, dict, 1, bobRole),
        blob: staleEnvelope.blob,
        messageId: staleMsgId,
        fromRelayId: aliceRelayId,
        senderIdentityPublicKey: aliceIdentity.publicKey, // raw X25519 public key
      })
    ).toThrow(/verification/i);
  });

  it('a tampered ciphertext fails AEAD authentication before signature verification is even reached', async () => {
    const aliceIdentity = generateKeypair();
    const aliceSession = generateKeypair();
    const bobSession = generateKeypair();
    const aliceShared = computeSharedSecret(aliceSession.privateKey, bobSession.publicKey);
    const bobShared = computeSharedSecret(bobSession.privateKey, aliceSession.publicKey);
    const dict = makeDict();
    const aliceRole = deriveSessionRole(aliceSession.publicKey, bobSession.publicKey);
    const bobRole = deriveSessionRole(bobSession.publicKey, aliceSession.publicKey);
    const aliceSess = new Session(aliceShared, dict, 1, aliceRole);
    const bobSess = new Session(bobShared, dict, 1, bobRole);

    const msgId = uuidv4();
    const { blob } = await buildAndEncryptTextEnvelope({
      session: aliceSess,
      msgId,
      text: 'tamper with me',
      senderRelayId: 'relay:alice0000000001',
      senderIdentityPrivateKey: aliceIdentity.privateKey,
    });

    const corrupted = new Uint8Array(blob);
    corrupted[corrupted.length - 1] ^= 0xff;

    expect(() => bobSess.decrypt(corrupted)).toThrow(/[Dd]ecryption failed/);
  });

  it('a valid decryption but forged sender identity (signature/public-key mismatch) is detected as unverified, not silently trusted', async () => {
    // Proper matched Ed25519 identity keypairs (see makeEd25519Identity) so
    // this test isolates forgery detection from the X25519/Ed25519 key-type
    // bug documented above — Alice's genuine signature must verify while
    // Mallory's forged one must not, using otherwise-identical plumbing.
    const aliceIdentity = makeEd25519Identity();
    const mallory = makeEd25519Identity(); // attacker's own identity keypair
    const aliceSession = generateKeypair();
    const bobSession = generateKeypair();
    const aliceShared = computeSharedSecret(aliceSession.privateKey, bobSession.publicKey);
    const bobShared = computeSharedSecret(bobSession.privateKey, aliceSession.publicKey);
    const dict = makeDict();
    const aliceRole = deriveSessionRole(aliceSession.publicKey, bobSession.publicKey);
    const bobRole = deriveSessionRole(bobSession.publicKey, aliceSession.publicKey);
    const aliceSess = new Session(aliceShared, dict, 1, aliceRole);
    const bobSess = new Session(bobShared, dict, 1, bobRole);

    const msgId = uuidv4();
    // Alice's session/ciphertext, but the envelope is *signed* by Mallory's
    // key rather than Alice's — simulating a compromised relay trying to
    // relabel who a message came from without holding Alice's identity key.
    const { blob } = await buildAndEncryptTextEnvelope({
      session: aliceSess,
      msgId,
      text: 'trust me, this is alice',
      senderRelayId: 'relay:alice0000000001',
      senderIdentityPrivateKey: mallory.privateKey,
    });

    // Bob verifies against the real Alice's identity public key (what his
    // contact list actually has on file for her).
    expect(() =>
      decryptAndVerifyTextEnvelope({
        session: bobSess,
        blob,
        messageId: msgId,
        fromRelayId: 'relay:alice0000000001',
        senderIdentityPublicKey: aliceIdentity.publicKey,
      })
    ).toThrow(/verification/i);
  });

  it('replyTo and expiresAt metadata survive the envelope round trip untouched', async () => {
    const aliceIdentity = generateKeypair();
    const aliceSession = generateKeypair();
    const bobSession = generateKeypair();
    const aliceShared = computeSharedSecret(aliceSession.privateKey, bobSession.publicKey);
    const bobShared = computeSharedSecret(bobSession.privateKey, aliceSession.publicKey);
    const dict = makeDict();
    const aliceRole = deriveSessionRole(aliceSession.publicKey, bobSession.publicKey);
    const bobRole = deriveSessionRole(bobSession.publicKey, aliceSession.publicKey);
    const aliceSess = new Session(aliceShared, dict, 1, aliceRole);
    const bobSess = new Session(bobShared, dict, 1, bobRole);

    const msgId = uuidv4();
    const replyTo = { id: 'earlier-msg-id', text: 'preview of earlier message' };
    const expiresAt = Date.now() + 60_000;

    const { blob } = await buildAndEncryptTextEnvelope({
      session: aliceSess,
      msgId,
      text: 'replying with a ghost expiry',
      senderRelayId: 'relay:alice0000000001',
      senderIdentityPrivateKey: aliceIdentity.privateKey,
      replyTo,
      expiresAt,
    });

    const plaintext = bobSess.decrypt(blob);
    const parsed = JSON.parse(decoder.decode(plaintext));
    expect(parsed.replyTo).toEqual(replyTo);
    expect(parsed.expiresAt).toBe(expiresAt);
  });

  it('a session key mismatch (e.g. stale contact key cache) fails decryption rather than producing garbage text', () => {
    const alice = generateKeypair();
    const bob = generateKeypair();
    const eve = generateKeypair(); // Bob's cached key is stale/wrong
    const dict = makeDict();

    const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey);
    // Bob mistakenly derives against Eve's key instead of Alice's (simulates
    // a stale contact-key-cache entry from lib/messaging/contact-key-cache.ts).
    const bobShared = computeSharedSecret(bob.privateKey, eve.publicKey);

    const aliceSess = new Session(aliceShared, dict, 1, 'A');
    const bobSess = new Session(bobShared, dict, 1, 'B');

    const encrypted = aliceSess.encrypt(encoder.encode('should not decrypt'));
    expect(() => bobSess.decrypt(encrypted)).toThrow();
  });
});
