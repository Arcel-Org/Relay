# Crypto Review Packet: Ratchet-Resync Recovery & Group Epoch-Key Scheme

**Purpose.** Two protocol-level changes shipped this session without independent
review: authenticated ratchet-resync recovery, and a real per-group shared
symmetric key (replacing pure pairwise fan-out for group content). Both are
genuine security-relevant protocol changes, not refactors — this document
exists so a human reviewer (or a future audit) can evaluate them efficiently
without reverse-engineering the design from source. Everything below reflects
what is actually implemented and tested today (verified by direct file
inspection, not the original design plan, which can and did drift slightly
from what shipped).

**How to use this document.** Each feature section has: the problem it
solves, the design, what a self-review (mine) already checked, and — most
importantly — an **Open Questions** list of things a self-review is
structurally bad at catching. Start there.

---

## 1. Ratchet-Resync Recovery

### Problem

A 1:1 double-ratchet session can desync (e.g., a crash between encrypting a
message and persisting the ratchet's post-send state). Before this feature,
there was no recovery path — the receiver would permanently show "message
could not be verified," with no way back short of both parties somehow
starting over. A plain `key_exchange` message can't be the recovery
mechanism, because the existing anti-replay hardening deliberately refuses to
reset an existing session's ratchet on receipt of one — otherwise an
attacker who captured an old `key_exchange` could replay it to roll back the
recv counter and make previously-captured ciphertexts decryptable again.

### Design

A new, narrower, more strongly authenticated message pair —
`resync_request` / `resync_response` — that only ever fires on an
already-broken session, gated by:

- **Signature**: signed with the sender's Ed25519 signing key (derived via
  HKDF from the identity key, domain-separated `'relay-signing-v1'`), reusing
  the existing generic `signMessage`/`verifyMessageSignature` primitives — no
  new signing code. The signed payload binds `nonce + senderRelayId +
  recipientRelayId + timestamp` together.
- **Freshness**: a generic ±window timestamp check (shared with all signed
  messages) plus a resync-specific **persisted, strictly-monotonic**
  `{nonce, timestamp}` record per contact — a request must have a newer
  timestamp AND a different nonce than the last one accepted from that
  contact, checked against disk-persisted state (survives app restart), not
  just in-memory. This closes exact-replay of a captured resync packet.
- **Trigger throttling**: requires 2 consecutive decrypt failures within 60s
  (not one — a single failure is already tolerated by the ratchet's own
  skipped-key window and reaches this code only when the chain is actually
  broken) before the *client* even sends a request, itself rate-limited to
  once per 5 minutes per contact.
- **Incoming accept throttling**: a *separate* 5-minute rate limit on
  accepting an incoming request/response from a given sender, checked
  **before** signature verification — this bounds a contact with a
  genuinely valid, correctly-signing device (real contact, or a compromised
  device of one) from forcing unlimited re-keys by replaying a signature
  that will always pass.
- **Asymmetric roles**: the request-receiver clears its ratchet state and
  drives the actual new `key_exchange` (with a cooldown bypass, since a
  cooldown built for the ordinary case would otherwise block exactly the
  recovery this feature exists for); the response-receiver only clears its
  own state and waits for that incoming `key_exchange` — this avoids both
  sides racing to initiate a new session simultaneously.

The server has zero role here: `resync_request`/`resync_response` are
validated server-side only as generic well-formed control messages (opaque
string/number fields, no crypto inspection) and routed exactly like
`burn_request`/`typing` through the same generic pass-through path. All
trust decisions are client-side.

### What a self-review already checked (test coverage)

`lib/__tests__/resync.test.ts` (8 tests) exercises: a lone failure doesn't
trigger anything; a 2nd failure does; outgoing requests are rate-limited;
an incoming request from a sender with no pinned signing key is ignored; an
incoming request with an invalid/forged signature is rejected even when a
signing key IS on file; a second *validly-signed* request within the
incoming-accept window is still rejected; and a full two-party round trip
(failure detection → request → validation → clear+respond+rekey →
requester validates response and clears its own side) completes correctly.

### Open Questions for a reviewer

1. **Is 2-failures-in-60s the right trigger threshold in practice?** Too
   sensitive and an attacker who can induce transient decrypt noise (e.g., a
   malicious relay dropping/reordering a couple of packets) could force
   repeated re-keys within the outer rate limit's cadence; too conservative
   and a genuinely desynced user waits longer than necessary. This was
   chosen by engineering judgment, not measured against real-world failure
   patterns.
2. **Downgrade/rollback surface**: does resetting a session via resync ever
   let an attacker who has since compromised ONE party's device (but not
   its signing key at the time of the exchange) force a *fresh* key
   exchange under conditions more favorable to them than the original one
   was? The signing-key pin means they can't forge the request itself, but
   the broader question — "does this recovery path ever weaken the
   guarantees of the ORIGINAL key exchange it's replacing" — deserves a
   second pair of eyes with the full key-exchange protocol in view, not
   just this file in isolation.
3. **The persisted last-accepted-resync record**: confirm the storage layer
   backing it (`contact-key-cache.ts`) has the same at-rest protection as
   other sensitive per-contact state, and that a device-level compromise
   that can read/tamper with it doesn't undermine the monotonicity
   guarantee in a way the signature alone doesn't already prevent.
4. **No test exists for**: concurrent resync attempts from both sides at
   nearly the same instant (a genuine two-sided desync, not the
   one-detects-first case the round-trip test covers) — worth confirming
   the asymmetric-roles design doesn't have a race if BOTH sides
   simultaneously hit the failure threshold and both try to become the
   "request" side.

---

## 2. Group Shared Epoch-Key Scheme

### Problem

Before this feature, every "group message" was really N independent
pairwise-encrypted copies, one per member, sent through each member's
ordinary 1:1 ratchet session. Removing a member only removed their ID from a
locally-synced membership list — nothing cryptographic ever changed. A
member removed while offline (or during the propagation window before all
clients process the removal) could still be sent, and decrypt, new group
content indefinitely, since their pairwise session with each remaining
member is never touched (deliberately — that same session is also their
ordinary 1:1 DM channel, untouched on purpose).

### Design

A real per-group symmetric **epoch key**, generated fresh on group creation,
distributed pairwise (reusing the *existing* pairwise fan-out mechanism — no
new transport-layer crypto for distribution), and used to AEAD-encrypt
group message/file content as an **inner layer**, wrapped inside the
existing outer pairwise-session encryption (genuinely double-encrypted, not
a euphemism — confirmed by reading the send path directly).

- **Cipher**: ChaCha20-Poly1305, same construction used elsewhere in this
  codebase (1:1 sessions, at-rest encryption). Wire format: 12-byte random
  nonce + ciphertext+tag, matching the existing at-rest encryption helper's
  layout.
- **AAD**: binds `groupId:epoch:senderRelayId` — ciphertext from one
  group/epoch/sender can't be replayed into a different context.
- **Epoch lifecycle**:
  - *Create*: epoch 1, generated immediately, included in the bootstrap
    `add_members` event.
  - *Add member*: no rotation (new members never see history anyway,
    confirmed nothing retroactive is ever sent) — they just get the
    current epoch key inline.
  - *Remove member* (the security-critical case): a **new** epoch key is
    generated, and the fan-out is **split into two different payloads** —
    remaining members get the removal notice *plus* the new epoch key;
    the removed member gets *only* the removal notice, no key material.
  - *Legacy/migration*: a group created before this feature shipped has no
    epoch key until an owner/admin sends the first message post-upgrade,
    which lazily bootstraps epoch 1 and distributes it via a one-time
    `rotate_key` event, reusing the existing owner/admin governance gate.
- **Previous-epoch tolerance**: exactly one prior epoch's key is retained,
  to tolerate a message encrypted just before a rotation arriving slightly
  late from a remaining member (a normal race, not an error) — anything
  older than one epoch back is simply unreadable.
- **Receive-side missing-key handling**: if a message references an epoch
  the receiver doesn't have yet (a normal race — the rotation notice hasn't
  arrived), the client asks a validated fellow member for it
  (`key_request`/`key_share`, rate-limited, and re-validates both parties
  against the *local* roster before answering — a crafted request can't be
  used to learn which groups a device is tracking) and **drops** that
  specific message rather than buffering it; a later message (or the key
  arriving) recovers naturally.
- **Server role**: none. Group traffic isn't even a distinct wire-level
  type to the relay — it rides inside the same generic opaque encrypted
  envelope every 1:1 message uses. The server has no notion of groups,
  epochs, or membership.

### What a self-review already checked (test coverage)

- `group-crypto.test.ts` (7 tests): encrypt/decrypt round-trip; nonce
  uniqueness; wrong key rejected; wrong AAD (any of groupId/epoch/sender)
  rejected; tampered ciphertext rejected; truncated/malformed input
  rejected without an out-of-bounds read.
- `group-key-cache.test.ts` (6 tests): current-epoch and one-back-epoch
  resolution both correct; anything else returns null; persistence/hydration
  round-trips.
- `use-group-messaging-key-rotation.test.ts` (4 tests) — **the flagship
  guarantee, directly tested**: after a removal, a message encrypted under
  the new epoch is verified **undecryptable** using only the removed
  member's held (old) key, while it decrypts correctly for a remaining
  member holding the new key. This is the actual security property the
  whole feature exists for, and it's asserted directly, not just inferred
  from the design.
- `use-group-messaging-key-recovery.test.ts` (7 tests): missing-epoch
  triggers a request to a validated member; **no** key request goes to a
  non-member sender; repeated requests for the same missing epoch are
  rate-limited; `key_request` is answered only for a validated fellow
  member and **not** for a requester outside the local roster; `key_share`
  updates silently.
- `use-group-messaging-governance.test.ts` (13 tests) — gates *who* can
  trigger rotation/distribution in the first place: actor/sender mismatch
  rejected; plain members can't rename/remove/change settings; only
  owner can promote-to-admin or transfer ownership; **an admin's rename
  event can't smuggle an ownerId/adminIds takeover** alongside it.

### Gaps this self-review found in its own test coverage (not fixed, flagged)

- **No dedicated test** asserting a *plain member* (not owner/admin) is
  actually blocked from bootstrapping a legacy (pre-feature) group's epoch
  1 — the authorization check exists in code (`ensureGroupKeyOrThrow`
  throws for non-owner/admin), but is only exercised indirectly through
  other tests, not asserted directly.
- **No dedicated test** for the legacy plaintext-relative-to-pairwise-layer
  fallback path itself (a group message with no `ciphertext`/`epoch`
  fields, for a group that hasn't been migrated yet) — behavior is
  documented in code comments but not independently verified by a test
  that would fail if it regressed.
- **No test** for two members independently attempting to serve the same
  `key_request` simultaneously (not a correctness issue since `key_share`
  is presumably idempotent, but not verified).

### Open Questions for a reviewer

1. **Forward secrecy of the epoch key itself**: the epoch key is a single
   static symmetric key per epoch (not ratcheted per-message). Is
   "rotate on membership change only" a sufficient guarantee, or should a
   group with very long-lived, rarely-changing membership rotate on some
   additional cadence (time-based, or message-count-based) to bound the
   blast radius of a single key-material compromise? This is a real design
   tradeoff, not an oversight — worth a second opinion on whether the
   current policy matches the threat model this app claims (a compromised
   *device* mid-conversation, not just a removed *member*).
2. **The removed member retains the OLD epoch key indefinitely.** Nothing
   erases it from their local storage. If a "removed" member is later
   RE-ADDED to the same group, do they still hold stale key material that
   could matter (e.g., could they decrypt anything from the window they
   were absent, if a stale copy of an old message somehow reaches them)?
   The design intends "gains nothing cryptographically" at removal time —
   worth confirming this holds for the "removed-then-readded" case too,
   which wasn't explicitly called out as considered.
3. **Two-layer encryption performance/complexity cost** — is double
   encrypting every group message (inner group-key AEAD + outer pairwise
   ratchet) an acceptable-forever design, or a stepping stone? Not a
   security question, but worth the reviewer's opinion on whether the
   layering itself introduces any subtle interaction (e.g., ciphertext
   size growth compounding for large groups/files) worth flagging now
   rather than after it's harder to change.
4. **`key_request`/`key_share` being open to "any current member," not
   owner/admin-gated** — deliberate (matches the file's own comment: it
   solves a genuine straggler problem for **any** member, not just
   privileged ones). Worth confirming this can't be abused by a
   just-removed-but-not-yet-processed member to extract the NEW epoch key
   from a remaining member who hasn't yet processed the removal event —
   i.e., is there a window where a `key_request` from a since-removed
   member could still be served because the responder's local roster
   hasn't caught up yet? The code re-validates against the *local* roster,
   which narrows this, but the exact race window deserves explicit
   verification.

---

## 3. Cross-Cutting Notes

- **Server trust boundary, confirmed for both features**: the relay
  validates only generic wire-format shape (string/number field types,
  length caps) for `resync_request`/`resync_response`, and doesn't even
  have a distinct schema for group traffic — it rides inside the same
  opaque encrypted-blob envelope as ordinary 1:1 messages. All actual
  security decisions for both features are 100% client-side. A compromised
  or hostile relay operator can drop, delay, or duplicate any of these
  messages, but cannot forge, decrypt, or downgrade either mechanism
  without breaking the underlying signature/AEAD primitives themselves.
- **Nothing here has had a second pair of eyes.** Every guarantee listed
  as "tested" above was written and verified by the same process (an AI
  session) that implemented the feature, in one sitting, without an
  adversarial external review. The tests are real and the specific
  properties they assert are the right properties to assert — but a test
  suite authored by the same mind that wrote the code it's testing is
  structurally blind to design-level mistakes both share, which is
  exactly the gap independent review exists to close.
- **Neither feature has run against a real network** — both are tested via
  mocked sessions/WebSocket in `lib/__tests__/`, never as two genuine
  separate clients talking to a live relay server. (Separately from this
  document: an e2e test suite covering real two-client messaging and group
  flows now exists — `tests/e2e/multi-client.spec.ts` — but it does not
  yet cover the resync-recovery scenario specifically, only ordinary
  send/receive and group create/remove-member.)
