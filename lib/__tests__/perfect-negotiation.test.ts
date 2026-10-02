import { describe, expect, it } from 'vitest';
import { isPolitePeer } from '@/lib/webrtc/perfect-negotiation';

describe('isPolitePeer', () => {
  it('picks the lexicographically lower relayId as polite', () => {
    expect(isPolitePeer('alice', 'bob')).toBe(true);
    expect(isPolitePeer('bob', 'alice')).toBe(false);
  });

  it('is symmetric: exactly one side is polite for any pair of distinct ids', () => {
    const pairs: [string, string][] = [
      ['relay_0001', 'relay_0002'],
      ['zzz', 'aaa'],
      ['9abc', 'abc9'],
      ['user-a', 'user-b'],
    ];
    for (const [a, b] of pairs) {
      const aIsPolite = isPolitePeer(a, b);
      const bIsPolite = isPolitePeer(b, a);
      expect(aIsPolite).not.toBe(bIsPolite);
    }
  });

  it('is deterministic across repeated calls', () => {
    const a = 'relay_abc123';
    const b = 'relay_def456';
    const first = isPolitePeer(a, b);
    for (let i = 0; i < 5; i++) {
      expect(isPolitePeer(a, b)).toBe(first);
    }
  });

  it('never returns true for equal ids on both sides (no valid self-pair)', () => {
    // Not a real scenario (a peer never negotiates with itself), but the
    // function should still behave predictably rather than throwing.
    expect(isPolitePeer('same', 'same')).toBe(false);
  });
});
