/**
 * Regression coverage for CallOverlay's keyboard accessibility.
 *
 * Unlike every other modal in the app (SafetyNumberModal, AddContactModal,
 * GroupManageModal, MessageEditModal), CallOverlay previously had no
 * role="dialog"/aria-modal and no Escape-key handler at all — a keyboard-
 * only user had no way out of the full-screen overlay. Escape hangs up
 * (there's no non-destructive dismiss available; the call IS the content):
 * decline while still ringing/unaccepted, end the call otherwise.
 *
 * Same React.createElement approach as call-overlay-screen-share-gating.
 * test.ts — no .tsx test files exist in this repo (vitest.config.ts only
 * includes *.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/components/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('@/components/CallDiagnosticsDrawer', () => ({ CallDiagnosticsDrawer: () => null }));

import CallOverlay from '../../components/CallOverlay';

function baseProps(overrides: Partial<Parameters<typeof CallOverlay>[0]> = {}) {
  return {
    callPhase: 'in_call' as const,
    peerId: 'peer-1',
    peerDisplayName: 'Alice',
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

describe('CallOverlay — accessibility', () => {
  it('exposes itself as a labelled modal dialog', () => {
    render(createElement(CallOverlay, baseProps({ peerDisplayName: 'Bob' })));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toMatch(/Bob/);
  });

  it('Escape ends an active call', () => {
    const onEndCall = vi.fn();
    const onDecline = vi.fn();
    render(createElement(CallOverlay, baseProps({ callPhase: 'in_call', onEndCall, onDecline })));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onEndCall).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('Escape declines a still-ringing incoming call rather than ending it', () => {
    const onEndCall = vi.fn();
    const onDecline = vi.fn();
    render(createElement(CallOverlay, baseProps({
      callPhase: 'ringing', direction: 'incoming', canAcceptIncoming: true, onEndCall, onDecline,
    })));

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onEndCall).not.toHaveBeenCalled();
  });

  it('does not register a keyboard handler once the call has ended (component renders nothing)', () => {
    const onEndCall = vi.fn();
    const { container } = render(createElement(CallOverlay, baseProps({ callPhase: 'ended', onEndCall })));

    expect(container.firstChild).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEndCall).not.toHaveBeenCalled();
  });
});
