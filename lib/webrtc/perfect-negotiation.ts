/**
 * Perfect-negotiation role derivation for WebRTC calls.
 *
 * The "perfect negotiation" pattern (see MDN:
 * https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
 * requires every peer-to-peer connection to have exactly one "polite" side and
 * one "impolite" side, and both sides must independently agree on who is who
 * without any extra signaling round-trip. A pure, symmetric comparison of the
 * two participants' relayIds gives us that for free: whichever ID sorts
 * lexicographically lower is polite. String comparison is a strict total
 * order and relayIds are unique, so exactly one side of any pair is polite
 * and the other impolite, and both sides compute the same answer
 * independently — no coordination needed.
 *
 * The "polite" peer is the one that backs off during a signaling collision —
 * it rolls back its own in-flight local offer and accepts the incoming one.
 * The "impolite" peer ignores the incoming colliding offer and keeps its own.
 */
export function isPolitePeer(localRelayId: string, remoteRelayId: string): boolean {
  return localRelayId < remoteRelayId;
}
