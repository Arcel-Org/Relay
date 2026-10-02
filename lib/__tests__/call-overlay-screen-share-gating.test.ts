/**
 * Regression coverage for CallOverlay's Share control on voice-only calls.
 *
 * The Share button used to be gated only on `isActive`, so it rendered
 * (and was clickable) on a voice call too. Clicking it triggered a
 * fundamentally incomplete path in use-webrtc-call.ts's toggleScreenShare:
 * an audio-only call has no video sender, so it added a brand-new video
 * transceiver and replaced its track with the screen capture — WITHOUT
 * renegotiating the peer connection, so the remote side was never told
 * about the new m-line and never received it, while the local UI's own
 * video-rendering paths are all gated on `isVideo` and so showed nothing
 * either. Net effect: clicking Share on a voice call silently did nothing
 * visible to either party while still holding a live screen-capture
 * stream open. Fix: hide the button unless `isVideo`, and delete the
 * now-unreachable (and broken) audio-only branch in toggleScreenShare.
 *
 * No .tsx test files exist elsewhere in this repo (vitest.config.ts only
 * includes *.test.ts), so this uses React.createElement instead of JSX to
 * stay a plain .ts file rather than widening the shared test glob.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/CallDiagnosticsDrawer', () => ({ CallDiagnosticsDrawer: () => null }));

import CallOverlay from '../../components/CallOverlay';

function baseProps(overrides: Partial<Parameters<typeof CallOverlay>[0]> = {}) {
  return {
    callPhase: 'in_call' as const,
    peerId: 'peer-1',
    direction: 'outgoing' as const,
    isVideo: false,
    muted: false,
    videoEnabled: false,
    isScreenSharing: false,
    isHeld: false,
    speakerPhone: false,
    formattedCallDuration: '00:01',
    callQuality: null,
    callDiagnostics: [],
    localStream: null,
    remoteStream: null,
    canAcceptIncoming: false,
    onAccept: vi.fn(),
    onDecline: vi.fn(),
    onEndCall: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleVideo: vi.fn(),
    onToggleScreenShare: vi.fn(),
    onToggleHold: vi.fn(),
    onToggleSpeakerPhone: vi.fn(),
    onRetryConnection: vi.fn(),
    onMinimise: vi.fn(),
    ...overrides,
  };
}

describe('CallOverlay — Share control gated on isVideo', () => {
  it('THE REGRESSION: hides the Share button on an active voice-only call', () => {
    render(createElement(CallOverlay, baseProps({ isVideo: false })));
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('shows the Share button on an active video call', () => {
    render(createElement(CallOverlay, baseProps({ isVideo: true })));
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeNull();
  });
});
