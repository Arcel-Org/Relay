'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Phone,
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  Pause,
  Play,
  Volume2,
  Info,
  Minimize2,
  RotateCcw,
} from 'lucide-react';
import type { CallPhase, CallQualityMetrics, CallDiagnosticEvent } from '@/lib/calls/use-webrtc-call';
import { useVoiceActivity } from '@/lib/calls/use-voice-activity';
import { useCallAudio } from '@/lib/calls/use-call-audio';
import { UserAvatar } from '@/components/UserAvatar';
import { CallDiagnosticsDrawer } from '@/components/CallDiagnosticsDrawer';

interface PeerInfo {
  id: string;
  displayName?: string;
  avatarEmoji?: string;
  avatarColor?: string;
}

interface CallOverlayProps {
  callPhase: CallPhase;
  peerId: string;
  peerDisplayName?: string;
  peerAvatarEmoji?: string;
  peerAvatarColor?: string;
  direction: 'incoming' | 'outgoing';
  isVideo: boolean;
  muted: boolean;
  videoEnabled: boolean;
  isScreenSharing: boolean;
  isHeld: boolean;
  speakerPhone: boolean;
  formattedCallDuration: string;
  callQuality: CallQualityMetrics | null;
  callDiagnostics: CallDiagnosticEvent[];
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** All connected peers (for group call participant display) */
  connectedPeers?: PeerInfo[];
  canAcceptIncoming: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onToggleScreenShare: () => void;
  onToggleHold: () => void;
  onToggleSpeakerPhone: () => void;
  onRetryConnection: () => void;
  onMinimise: () => void;
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function VideoView({
  stream,
  muted,
  mirror,
  className = '',
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  if (!stream) return null;
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`w-full h-full object-cover ${mirror ? 'scale-x-[-1]' : ''} ${className}`}
    />
  );
}

function QualityDots({ quality }: { quality: CallQualityMetrics | null }) {
  if (!quality) return null;
  const level =
    quality.packetLossPct < 1 && quality.roundTripTimeMs < 150
      ? 3
      : quality.packetLossPct < 5 && quality.roundTripTimeMs < 300
        ? 2
        : 1;
  const colors = ['bg-red-400', 'bg-yellow-400', 'bg-green-400'] as const;
  return (
    <div className="flex items-end gap-0.5 h-3.5">
      {[1, 2, 3].map((bar) => (
        <div
          key={bar}
          className={`w-1 rounded-sm transition-colors ${bar <= level ? colors[level - 1] : 'bg-relay-surface-hover'}`}
          style={{ height: `${bar * 33}%` }}
        />
      ))}
      <span className="ml-1 text-[10px] text-relay-text-secondary font-mono">{quality.roundTripTimeMs.toFixed(0)}ms</span>
    </div>
  );
}

function SpeakingRing({
  isSpeaking,
  audioLevel,
  color = 'border-green-400',
}: {
  isSpeaking: boolean;
  audioLevel: number;
  color?: string;
}) {
  return (
    <motion.div
      className={`absolute inset-0 rounded-full border-2 ${color} pointer-events-none`}
      animate={{
        scale: isSpeaking ? 1 + audioLevel * 0.22 : 1,
        opacity: isSpeaking ? 0.85 : 0,
      }}
      transition={{ type: 'spring', stiffness: 300, damping: 18 }}
    />
  );
}

function ControlButton({
  icon,
  label,
  active,
  danger,
  onClick,
  disabled,
  large,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
  large?: boolean;
}) {
  const size = large ? 'w-[64px] h-[64px]' : 'w-[56px] h-[56px]';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center gap-1.5 transition-all ${disabled ? 'opacity-30 pointer-events-none' : ''}`}
    >
      <div
        className={`${size} rounded-full flex items-center justify-center transition-all duration-200 ${
          danger
            ? 'bg-relay-danger text-relay-accent-foreground hover:brightness-110 shadow-lg'
            : active
              ? 'bg-relay-accent text-relay-accent-foreground shadow-lg'
              : 'bg-relay-surface-hover/80 text-relay-text-secondary hover:bg-relay-surface-hover backdrop-blur-sm'
        }`}
      >
        {icon}
      </div>
      <span className="text-[10px] text-relay-text-muted leading-none select-none">{label}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

export default function CallOverlay({
  callPhase,
  peerId,
  peerDisplayName,
  peerAvatarEmoji,
  peerAvatarColor,
  direction,
  isVideo,
  muted,
  videoEnabled,
  isScreenSharing,
  isHeld,
  speakerPhone,
  formattedCallDuration,
  callQuality,
  callDiagnostics,
  localStream,
  remoteStream,
  connectedPeers = [],
  canAcceptIncoming,
  onAccept,
  onDecline,
  onEndCall,
  onToggleMute,
  onToggleVideo,
  onToggleScreenShare,
  onToggleHold,
  onToggleSpeakerPhone,
  onRetryConnection,
  onMinimise,
}: CallOverlayProps) {
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [swapLayout, setSwapLayout] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { isSpeaking: localSpeaking, audioLevel: localLevel } = useVoiceActivity({ stream: localStream });
  const { isSpeaking: remoteSpeaking, audioLevel: remoteLevel } = useVoiceActivity({ stream: remoteStream });

  useCallAudio(callPhase, direction);

  const [showMutedWarning, setShowMutedWarning] = useState(false);
  useEffect(() => {
    if (muted && localSpeaking) {
      setShowMutedWarning(true);
      const t = setTimeout(() => setShowMutedWarning(false), 3000);
      return () => clearTimeout(t);
    }
  }, [muted, localSpeaking]);

  // Escape gives keyboard users a way out of this full-screen overlay —
  // unlike a typical modal there's no non-destructive dismiss available
  // (the call IS the content), so this hangs up rather than just closing:
  // decline while still ringing/unaccepted, end the call otherwise. Every
  // other modal in the app (SafetyNumberModal, AddContactModal, etc.)
  // already supports Escape; this one previously had no keyboard exit at
  // all, trapping a keyboard-only user in a full-screen call view.
  useEffect(() => {
    if (callPhase === 'idle' || callPhase === 'ended') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (direction === 'incoming' && callPhase === 'ringing') {
        onDecline();
      } else {
        onEndCall();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [callPhase, direction, onDecline, onEndCall]);

  const remoteHasVideo =
    !!remoteStream && remoteStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');

  if (callPhase === 'idle' || callPhase === 'ended') return null;

  const displayName = peerDisplayName || peerId;
  const isActive = callPhase === 'in_call';
  const isRinging = callPhase === 'ringing';
  const isCalling = callPhase === 'calling';
  const isConnecting = callPhase === 'connecting';
  const isFailed = callPhase === 'failed';
  const isIncoming = direction === 'incoming';

  const fullScreenStream = swapLayout ? localStream : remoteStream;
  const pipStream = swapLayout ? remoteStream : localStream;
  const fullScreenHasVideo = swapLayout ? (videoEnabled && !!localStream) : remoteHasVideo;

  return (
    <AnimatePresence>
      <motion.div
        key="call-overlay"
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Call with ${displayName}`}
        className="fixed inset-0 z-[100] bg-relay-bg flex flex-col overflow-hidden"
      >
        {/* Background video */}
        {isVideo && isActive && fullScreenHasVideo && fullScreenStream && (
          <div className={`absolute inset-0 transition-all ${remoteSpeaking && !swapLayout ? 'ring-inset ring-2 ring-green-500/40' : ''}`}>
            <VideoView stream={fullScreenStream} muted={swapLayout} />
          </div>
        )}
        {(!isVideo || !isActive || !fullScreenHasVideo) && (
          <div className="absolute inset-0 bg-relay-surface" />
        )}

        {/* Top bar */}
        <div className="relative z-10 flex items-center justify-between px-4 py-3 bg-relay-surface">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-relay-accent animate-pulse" />
            <span className="text-xs text-relay-text-secondary uppercase tracking-wider font-medium">
              {isVideo ? 'Video Call' : 'Voice Call'}
              {isScreenSharing && ' · Sharing'}
              {isHeld && ' · On Hold'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <QualityDots quality={callQuality} />
            <button
              onClick={() => setShowDiagnostics((v) => !v)}
              className="text-relay-text-muted hover:text-relay-text-secondary transition-colors"
              title="Diagnostics"
            >
              <Info className="w-4 h-4" />
            </button>
            {isActive && (
              <button
                onClick={onMinimise}
                className="text-relay-text-muted hover:text-relay-text-secondary transition-colors"
                title="Minimise"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className="relative flex-1 flex flex-col items-center justify-center z-10">

          {/* Avatar view — voice calls or no-video */}
          {(!isVideo || !isActive || !fullScreenHasVideo) && (
            <div className="flex flex-col items-center gap-5">

              {/* Multi-participant grid (group call) */}
              {isActive && connectedPeers.length > 0 ? (
                <div className="flex flex-col items-center gap-4">
                  <div className={`flex items-center justify-center gap-3 flex-wrap ${connectedPeers.length > 3 ? 'max-w-xs' : ''}`}>
                    {connectedPeers.map((peer) => (
                      <div key={peer.id} className="flex flex-col items-center gap-1.5">
                        <div className="relative">
                          <UserAvatar emoji={peer.avatarEmoji} color={peer.avatarColor} size={connectedPeers.length > 3 ? 64 : 80} />
                          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-relay-bg" />
                        </div>
                        <span className="text-xs text-relay-text-secondary font-medium max-w-[80px] truncate">
                          {peer.displayName || peer.id.slice(0, 10)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="text-center mt-2">
                    <p className="text-lg font-semibold text-relay-text-primary">{connectedPeers.length + 1} in call</p>
                    <p className="text-sm text-relay-text-secondary font-mono">{formattedCallDuration}</p>
                  </div>
                </div>
              ) : (
                /* Single peer / ringing state */
                <>
                  <div className="relative w-28 h-28">
                    <SpeakingRing isSpeaking={isActive && remoteSpeaking} audioLevel={remoteLevel} color="border-green-400" />
                    {(isCalling || (isRinging && isIncoming)) && (
                      <motion.div
                        className="absolute inset-0 rounded-full bg-relay-accent/20"
                        animate={{ scale: [1, 1.7], opacity: [0.5, 0] }}
                        transition={{ duration: 1.4, repeat: Infinity }}
                      />
                    )}
                    <UserAvatar emoji={peerAvatarEmoji} color={peerAvatarColor} size={112} />
                  </div>

                  <div className="text-center">
                    <h2 className="text-2xl font-bold text-relay-text-primary">{displayName}</h2>
                    <div className="text-sm text-relay-text-secondary mt-1.5 min-h-5">
                      {isCalling && 'Calling…'}
                      {isRinging && isIncoming && 'Incoming call'}
                      {isRinging && !isIncoming && 'Ringing…'}
                      {isConnecting && (
                        <span className="flex items-center justify-center gap-1.5">
                          {[0, 0.3, 0.6].map((delay, i) => (
                            <motion.span
                              key={i}
                              className="w-1.5 h-1.5 rounded-full bg-relay-accent inline-block"
                              animate={{ opacity: [0, 1, 0] }}
                              transition={{ duration: 1, repeat: Infinity, delay }}
                            />
                          ))}
                          <span className="ml-1">Connecting</span>
                        </span>
                      )}
                      {isActive && formattedCallDuration}
                      {isFailed && 'Connection failed'}
                    </div>
                  </div>
                </>
              )}

              {/* Local mic indicator for voice calls */}
              {isActive && !isVideo && (
                <div className="relative w-10 h-10">
                  <SpeakingRing isSpeaking={localSpeaking && !muted} audioLevel={localLevel} color="border-white/60" />
                  <div className="w-10 h-10 rounded-full bg-relay-surface-hover flex items-center justify-center">
                    {muted ? <MicOff className="w-4 h-4 text-relay-danger" /> : <Mic className="w-4 h-4 text-relay-text-secondary" />}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Video overlays */}
          {isVideo && isActive && (
            <>
              <div className="absolute top-2 left-4 bg-relay-surface/80 text-relay-text-primary text-xs px-3 py-1 rounded-full backdrop-blur">
                {formattedCallDuration}
              </div>

              {!fullScreenHasVideo && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <UserAvatar emoji={peerAvatarEmoji} color={peerAvatarColor} size={96} />
                  <p className="mt-3 text-relay-text-secondary text-sm">Camera off</p>
                </div>
              )}

              {/* Draggable PiP */}
              {pipStream && (
                <motion.button
                  type="button"
                  drag
                  dragConstraints={containerRef}
                  onClick={() => setSwapLayout((v) => !v)}
                  className="absolute top-4 right-4 w-28 h-20 rounded-xl overflow-hidden border border-relay-border-light/70 shadow-sm z-20 cursor-pointer select-none"
                  aria-label="Swap video views"
                >
                  {(swapLayout ? remoteHasVideo : (videoEnabled && !!localStream)) ? (
                    <VideoView stream={pipStream} muted={!swapLayout} mirror={!swapLayout} />
                  ) : (
                    <div className="w-full h-full bg-relay-surface-hover flex items-center justify-center">
                      {swapLayout
                        ? <UserAvatar emoji={peerAvatarEmoji} color={peerAvatarColor} size={36} />
                        : <VideoOff className="w-5 h-5 text-relay-text-muted" />}
                    </div>
                  )}
                  <motion.div
                    className="absolute inset-0 rounded-xl border-2 border-white/70 pointer-events-none"
                    animate={{ opacity: (!swapLayout && localSpeaking && !muted) || (swapLayout && remoteSpeaking) ? 0.8 : 0 }}
                    transition={{ duration: 0.2 }}
                  />
                </motion.button>
              )}
            </>
          )}
        </div>

        {/* Controls */}
        <div className="relative z-10 px-4 pb-10 pt-4 bg-relay-surface">

          {isRinging && isIncoming && (
            <div className="flex items-center justify-center gap-20">
              <ControlButton icon={<PhoneOff className="w-6 h-6" />} label="Decline" danger onClick={onDecline} large />
              <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
                <ControlButton
                  icon={isVideo ? <Video className="w-6 h-6" /> : <Phone className="w-6 h-6" />}
                  label="Accept"
                  active
                  onClick={onAccept}
                  large
                />
              </motion.div>
            </div>
          )}

          {(isActive || isCalling || isConnecting || (isRinging && !isIncoming)) && (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-center gap-5">
                <ControlButton
                  icon={muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                  label={muted ? 'Unmute' : 'Mute'}
                  active={muted}
                  onClick={onToggleMute}
                  disabled={isHeld}
                />
                {isVideo && (
                  <ControlButton
                    icon={videoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
                    label={videoEnabled ? 'Cam Off' : 'Cam On'}
                    active={!videoEnabled}
                    onClick={onToggleVideo}
                    disabled={isHeld}
                  />
                )}
                <ControlButton icon={<PhoneOff className="w-5 h-5" />} label="End" danger onClick={onEndCall} />
              </div>

              {isActive && (
                <div className="flex items-center justify-center gap-5">
                  {isVideo && (
                    <ControlButton
                      icon={isScreenSharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
                      label={isScreenSharing ? 'Stop Share' : 'Share'}
                      active={isScreenSharing}
                      onClick={onToggleScreenShare}
                    />
                  )}
                  <ControlButton
                    icon={isHeld ? <Play className="w-5 h-5" /> : <Pause className="w-5 h-5" />}
                    label={isHeld ? 'Resume' : 'Hold'}
                    active={isHeld}
                    onClick={onToggleHold}
                  />
                  <ControlButton
                    icon={<Volume2 className="w-5 h-5" />}
                    label="Speaker"
                    active={speakerPhone}
                    onClick={onToggleSpeakerPhone}
                  />
                </div>
              )}
            </div>
          )}

          {isFailed && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-sm text-relay-text-secondary text-center">
                {callQuality?.connectionState === 'failed'
                  ? 'The connection dropped and could not be recovered.'
                  : 'Could not establish a connection.'}
              </p>
              <div className="flex gap-3">
                <button
                  onClick={onRetryConnection}
                  className="flex items-center gap-2 px-4 py-2 bg-relay-accent text-relay-accent-foreground hover:brightness-110 text-sm rounded-xl transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry
                </button>
                <button
                  onClick={onEndCall}
                  className="px-4 py-2 bg-relay-surface-hover hover:bg-relay-surface-hover text-relay-text-primary text-sm rounded-xl transition-colors"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        {/* "You are muted" toast */}
        <AnimatePresence>
          {showMutedWarning && (
            <motion.div
              key="muted-toast"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              className="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-relay-surface-hover/95 border border-relay-border-light rounded-xl px-4 py-2.5 shadow-sm z-30"
            >
              <MicOff className="w-4 h-4 text-relay-danger" />
              <span className="text-sm text-relay-text-primary font-medium">You are muted</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Diagnostics drawer */}
        <AnimatePresence>
          {showDiagnostics && (
            <CallDiagnosticsDrawer
              quality={callQuality}
              diagnostics={callDiagnostics}
              onClose={() => setShowDiagnostics(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  );
}
