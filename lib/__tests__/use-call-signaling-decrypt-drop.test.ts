/**
 * Regression coverage for use-call-signaling.ts's decryptSignalPayload.
 * On a decrypt failure it used to only log.warn and leave the field as the
 * raw encrypted hex string — handleCallSignal then pushed the signal to
 * callSignals state UNCONDITIONALLY, forwarding a malformed payload (a
 * string where an RTCSessionDescriptionInit/RTCIceCandidateInit is
 * expected) to whatever consumes callSignals downstream (use-webrtc-call.ts),
 * with no signal that decryption specifically was what failed. Fix:
 * decryptSignalPayload now returns success/failure, and handleCallSignal
 * drops the signal entirely on failure instead of forwarding it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCallSignaling } from '../hooks/use-call-signaling';

function makeShared(sessionsMap: Map<string, any>) {
  return {
    wsRef: { current: null },
    sessionsRef: { current: sessionsMap },
  } as any;
}

describe('useCallSignaling — drops a signal it cannot decrypt', () => {
  it('THE REGRESSION: drops a call_offer whose decrypt throws, instead of forwarding the raw encrypted string', () => {
    const session = { decrypt: vi.fn(() => { throw new Error('bad ciphertext'); }) };
    const sessions = new Map([['peer-1', { session }]]);
    const { result } = renderHook(() => useCallSignaling(makeShared(sessions), vi.fn()));

    act(() => {
      result.current.handleCallSignal(
        { fromRelayId: 'peer-1', callId: 'call-1', offer: 'deadbeef' },
        'call_offer'
      );
    });

    expect(result.current.callSignals).toHaveLength(0);
  });

  it('drops a call signal from a contact with no session to decrypt with', () => {
    const sessions = new Map(); // no session for peer-1
    const { result } = renderHook(() => useCallSignaling(makeShared(sessions), vi.fn()));

    act(() => {
      result.current.handleCallSignal(
        { fromRelayId: 'peer-1', callId: 'call-1', answer: 'deadbeef' },
        'call_answer'
      );
    });

    expect(result.current.callSignals).toHaveLength(0);
  });

  it('forwards a call signal that decrypts successfully', () => {
    const plaintext = JSON.stringify({ type: 'offer', sdp: 'v=0...' });
    const session = { decrypt: vi.fn(() => new TextEncoder().encode(plaintext)) };
    const sessions = new Map([['peer-1', { session }]]);
    const { result } = renderHook(() => useCallSignaling(makeShared(sessions), vi.fn()));

    act(() => {
      result.current.handleCallSignal(
        { fromRelayId: 'peer-1', callId: 'call-1', offer: 'deadbeef' },
        'call_offer'
      );
    });

    expect(result.current.callSignals).toHaveLength(1);
    expect(result.current.callSignals[0].offer).toEqual({ type: 'offer', sdp: 'v=0...' });
  });

  it('forwards a non-decrypt signal (e.g. call_hangup) unaffected', () => {
    const { result } = renderHook(() => useCallSignaling(makeShared(new Map()), vi.fn()));

    act(() => {
      result.current.handleCallSignal({ fromRelayId: 'peer-1', callId: 'call-1' }, 'call_hangup');
    });

    expect(result.current.callSignals).toHaveLength(1);
  });
});
