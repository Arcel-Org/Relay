'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { log } from '@/lib/platform/logger';
import type { CallSignalEvent } from '@/lib/messaging/use-relay-messaging';
import type { CallHangupReason } from '@/lib/relay/relay-websocket';
import { isPolitePeer } from '@/lib/webrtc/perfect-negotiation';
import { toast } from '@/components/ToastNotification';

// ─── Mesh call cap ───
// Group calls use a full-mesh topology (every participant holds a direct
// PeerConnection to every other participant) — there is no SFU to fan media
// out through a single upload per client. Mesh cost grows O(n^2): at N
// participants each client uploads/decodes N-1 simultaneous audio+video
// streams. Past ~8 total participants (7 PeerConnections per client) typical
// consumer upload bandwidth and CPU/encoder budgets are already saturated by
// video, and call quality degrades badly for everyone — that's the point
// most P2P mesh implementations (e.g. early WebRTC group chat apps) treat as
// the practical ceiling before you need an SFU. We cap here rather than
// silently degrading or crashing under an unbounded number of connections.
export const MAX_GROUP_CALL_PARTICIPANTS = 8;
const MAX_GROUP_CALL_PEERS = MAX_GROUP_CALL_PARTICIPANTS - 1; // excludes self

// callId is the sole authorization token a call_answer is checked against
// (see the call_answer handler below) — it must not be guessable. A
// Math.random()-derived suffix is neither cryptographically random nor
// wide enough (~31 bits, further narrowed by the visible Date.now() prefix)
// to resist being guessed/brute-forced by another connected relay client.
function generateCallId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `call_${hex}`;
}

// ─── Auto-reconnect tuning ───
// 'disconnected' often self-heals within a few seconds (brief wifi handoff,
// short network hiccup) — jumping straight to an ICE restart would cause
// needless renegotiation churn, so we give it a grace period first.
// 'failed' is a harder signal that ICE has given up, so we react fast (just
// enough of a debounce to coalesce multiple peers failing at once in a mesh
// call into a single restart pass) before restarting.
const RECONNECT_DISCONNECTED_GRACE_MS = 4000;
const RECONNECT_FAILED_DEBOUNCE_MS = 500;
// Backoff between successive automatic restart attempts once we're already
// retrying, so a persistently-bad network doesn't hammer signaling.
const RECONNECT_BACKOFF_MS = [1000, 4000, 8000];
const MAX_AUTO_RECONNECT_ATTEMPTS = 3;

export type CallPhase =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'in_call'
  | 'ended'
  | 'failed';

interface ActiveCall {
  callId: string;
  peerId: string;
  direction: 'incoming' | 'outgoing';
  isVideo: boolean;
  phase: CallPhase;
  startedAt?: number;
  connectedAt?: number;
  error?: string;
  isHeld?: boolean;
  isScreenSharing?: boolean;
}

export interface CallQualityMetrics {
  roundTripTimeMs: number;
  jitterMs: number;
  packetLossPct: number;
  bitrateKbps: number;
  audioLevel: number;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  reconnectAttempts: number;
  updatedAt: number;
}

export interface CallDiagnosticEvent {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  code:
    | 'call_start'
    | 'incoming_offer'
    | 'call_accept'
    | 'call_decline'
    | 'call_answer'
    | 'call_hangup'
    | 'state_change'
    | 'reconnect_attempt'
    | 'reconnect_success'
    | 'reconnect_failed'
    | 'timeout'
    | 'cleanup';
  message: string;
}

export interface CallHistoryRecord {
  id: string;
  callId: string;
  peerId: string;
  direction: 'incoming' | 'outgoing';
  isVideo: boolean;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  outcome: 'completed' | 'failed' | 'missed' | 'declined' | 'ended';
  endReason?: string;
  reconnectAttempts: number;
  avgRttMs: number;
  avgPacketLossPct: number;
  setupMs?: number;
}

interface UseWebRTCCallParams {
  localRelayId?: string | null;
  callSignals: CallSignalEvent[];
  consumeCallSignals: (count: number) => void;
  sendCallOffer: (toContactId: string, offer: RTCSessionDescriptionInit, callId: string) => void;
  sendCallAnswer: (toContactId: string, answer: RTCSessionDescriptionInit, callId: string) => void;
  sendCallIce: (toContactId: string, candidate: RTCIceCandidateInit, callId: string) => void;
  sendCallRing: (toContactId: string, callId: string) => void;
  sendCallHangup: (toContactId: string, callId: string, reason?: CallHangupReason) => void;
  sendCallPeers: (toContactId: string, callId: string, peerIds: string[]) => void;
  // The relay server forwards call signaling to any connected relayId with
  // no contact-relationship check (it's an intentionally "dumb" relay) —
  // relayIds are also discoverable via profile search, so a total stranger
  // can otherwise ring any user. Callers should pass a predicate that
  // checks the local contact list; omitted means "allow everyone" for
  // backward compatibility, so this is opt-in hardening at the call site.
  isKnownCaller?: (relayId: string) => boolean;
}

interface PendingOffer {
  fromRelayId: string;
  callId: string;
  offer: RTCSessionDescriptionInit;
}

interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

// Fetched once per page load (and refreshed before its TTL expires) from
// /api/turn-credentials, which mints a short-lived HMAC credential server-side
// — see that route for why: a static, non-expiring username/credential baked
// into the client bundle would let anyone who views-source the app use the
// operator's TURN server as an open relay indefinitely.
let _turnCreds: TurnCredentials | null = null;
let _turnFetchInFlight: Promise<TurnCredentials | null> | null = null;

async function fetchTurnCredentials(): Promise<TurnCredentials | null> {
  if (_turnFetchInFlight) return _turnFetchInFlight;
  _turnFetchInFlight = (async () => {
    try {
      const res = await fetch('/api/turn-credentials', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.configured) return null;
      const creds: TurnCredentials = { urls: data.urls, username: data.username, credential: data.credential };
      _turnCreds = creds;
      // Refresh a few minutes before expiry so a long-idle tab doesn't start
      // a call with a credential that's about to be rejected by coturn.
      const refreshInMs = Math.max(30_000, (data.ttlSeconds - 300) * 1000);
      setTimeout(() => { _turnCreds = null; }, refreshInMs);
      return creds;
    } catch {
      return null;
    } finally {
      _turnFetchInFlight = null;
    }
  })();
  return _turnFetchInFlight;
}

/**
 * Build an RTCConfiguration. When a TURN server is configured for this
 * deployment (TURN_SECRET set server-side), routes ALL media through it —
 * `iceTransportPolicy: 'relay'` blocks direct peer-to-peer and STUN
 * candidates entirely, so neither party can observe the other's IP address.
 * Falls back to public STUN + 'all' (P2P allowed, IPs not hidden) when no
 * TURN server is configured, so calling still works in that deployment.
 */
async function buildRtcConfig(): Promise<RTCConfiguration> {
  const creds = _turnCreds || (await fetchTurnCredentials());

  if (!creds) {
    return {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      iceTransportPolicy: 'all',
    };
  }

  return {
    iceServers: [
      { urls: creds.urls, username: creds.username, credential: creds.credential },
      // Fallback: public STUN for ICE gathering when TURN is unreachable
      { urls: 'stun:stun.l.google.com:19302' },
    ],
    iceTransportPolicy:
      (process.env.NEXT_PUBLIC_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy) || 'relay',
  };
}

async function getRtcConfig(): Promise<RTCConfiguration> {
  return buildRtcConfig();
}

export function useWebRTCCall({
  localRelayId,
  callSignals,
  consumeCallSignals,
  sendCallOffer,
  sendCallAnswer,
  sendCallIce,
  sendCallRing,
  sendCallHangup,
  sendCallPeers,
  isKnownCaller,
}: UseWebRTCCallParams) {
  // Multi-peer support: one PeerConnection per remote participant
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const activeCallRef = useRef<ActiveCall | null>(null);
  const pendingOfferRef = useRef<PendingOffer | null>(null);
  // Guards acceptIncomingCall against a double-invoke (double-click, or a
  // second call before getUserMedia/SDP negotiation resolves) racing on the
  // same offer — without this, the second invocation's createPeerConnection
  // closes the first invocation's still-negotiating PC out from under it.
  const acceptingCallIdRef = useRef<string | null>(null);
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const outgoingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const incomingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const disconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastStatsRef = useRef<{ bytes: number; timestamp: number } | null>(null);
  const callQualityRef = useRef<CallQualityMetrics | null>(null);
  const callDiagnosticsRef = useRef<CallDiagnosticEvent[]>([]);
  // Perfect-negotiation state per remote peer — see lib/webrtc/perfect-negotiation.ts
  const negotiationRef = useRef<Map<string, { polite: boolean; makingOffer: boolean; ignoreOffer: boolean }>>(new Map());
  // Guards a single toast per call_peers batch that exceeds the mesh cap,
  // rather than one toast per rejected peer.
  const meshCapToastShownRef = useRef(false);

  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [localStream, _setLocalStream] = useState<MediaStream | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const setLocalStream = useCallback((s: MediaStream | null) => {
    localStreamRef.current = s;
    _setLocalStream(s);
  }, []);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  // Backwards-compat: first remote stream (for 1:1 calls and UI that expects a single stream)
  const remoteStream = remoteStreams.size > 0 ? remoteStreams.values().next().value ?? null : null;
  const [callQuality, setCallQuality] = useState<CallQualityMetrics | null>(null);
  const [callDiagnostics, setCallDiagnostics] = useState<CallDiagnosticEvent[]>([]);
  const [callHistory, setCallHistory] = useState<CallHistoryRecord[]>([]);
  const [muted, setMuted] = useState(false);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isHeld, setIsHeld] = useState(false);
  const [callDurationSec, setCallDurationSec] = useState(0);
  const [speakerPhone, setSpeakerPhone] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const originalVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const callDurationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const callPhase: CallPhase = activeCall?.phase || 'idle';

  const historyStorageKey = useMemo(() => {
    if (!localRelayId) return null;
    return `relay_call_history_${localRelayId}`;
  }, [localRelayId]);

  const pushDiagnostic = useCallback(
    (entry: Omit<CallDiagnosticEvent, 'id' | 'timestamp'>) => {
      setCallDiagnostics((prev) => {
        const next: CallDiagnosticEvent = {
          id: `diag_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          ...entry,
        };
        return [...prev.slice(-29), next];
      });
    },
    []
  );

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    callQualityRef.current = callQuality;
  }, [callQuality]);

  useEffect(() => {
    callDiagnosticsRef.current = callDiagnostics;
  }, [callDiagnostics]);

  // Load call history from localStorage
  const historyLoadedRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !historyStorageKey) return;
    try {
      const raw = localStorage.getItem(historyStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as CallHistoryRecord[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          setCallHistory(parsed);
          log.debug(`[Call] Loaded ${parsed.length} call history records`);
        }
      }
      historyLoadedRef.current = true;
    } catch (err) {
      log.warn('Failed to load call history:', err);
      historyLoadedRef.current = true;
    }
  }, [historyStorageKey]);

  // Persist call history to localStorage (only after initial load)
  useEffect(() => {
    if (typeof window === 'undefined' || !historyStorageKey || !historyLoadedRef.current) return;
    try {
      localStorage.setItem(historyStorageKey, JSON.stringify(callHistory));
    } catch (err) {
      log.warn('Failed to persist call history:', err);
    }
  }, [callHistory, historyStorageKey]);

  const clearReconnectInterval = useCallback(() => {
    if (reconnectIntervalRef.current) {
      clearInterval(reconnectIntervalRef.current);
      reconnectIntervalRef.current = null;
    }
  }, []);

  const clearStatsInterval = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (outgoingTimeoutRef.current) {
      clearTimeout(outgoingTimeoutRef.current);
      outgoingTimeoutRef.current = null;
    }
    if (incomingTimeoutRef.current) {
      clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = null;
    }
    if (disconnectTimeoutRef.current) {
      clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = null;
    }
    clearReconnectInterval();
  }, [clearReconnectInterval]);

  const stopStream = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
  }, []);

  const finalizeCallHistory = useCallback((resetTo: CallPhase, error?: string) => {
    const call = activeCallRef.current;
    if (!call) return;

    const startedAt = call.startedAt || Date.now();
    const connectedAt = call.connectedAt;
    const endedAt = Date.now();
    const durationSec = connectedAt ? Math.max(0, Math.round((endedAt - connectedAt) / 1000)) : 0;
    const setupMs = connectedAt ? Math.max(0, connectedAt - startedAt) : undefined;
    const endReason = error || call.error;
    const lowered = (endReason || '').toLowerCase();

    let outcome: CallHistoryRecord['outcome'] = 'ended';
    if (resetTo === 'failed') outcome = 'failed';
    else if (lowered.includes('missed')) outcome = 'missed';
    else if (lowered.includes('declined')) outcome = 'declined';
    else if (durationSec > 0 && (resetTo === 'ended' || resetTo === 'in_call')) outcome = 'completed';

    const quality = callQualityRef.current;
    const record: CallHistoryRecord = {
      id: `call_hist_${endedAt}_${Math.random().toString(36).slice(2, 8)}`,
      callId: call.callId,
      peerId: call.peerId,
      direction: call.direction,
      isVideo: call.isVideo,
      startedAt,
      endedAt,
      durationSec,
      outcome,
      endReason,
      reconnectAttempts: reconnectAttemptsRef.current,
      avgRttMs: quality?.roundTripTimeMs || 0,
      avgPacketLossPct: quality?.packetLossPct || 0,
      setupMs,
    };

    setCallHistory((prev) => [record, ...prev].slice(0, 120));
  }, []);

  const cleanup = useCallback(
    (resetTo: CallPhase = 'ended', error?: string) => {
      // Close ALL peer connections
      for (const [, pc] of peersRef.current) {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      }
      peersRef.current.clear();
      negotiationRef.current.clear();
      meshCapToastShownRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      // Read from refs/functional-updater, not the closed-over `localStream`/
      // `remoteStreams` state — `cleanup` is a stable-ish useCallback whose
      // closure can be stale relative to a stream set just before an awaited
      // call (getUserMedia, SDP exchange) resolves into an error/timeout path.
      // Reading stale state here made stopStream() a no-op, leaking the live
      // mic/camera track (browser recording indicator stays on).
      stopStream(localStreamRef.current);
      setRemoteStreams((prev) => {
        for (const [, stream] of prev) { stopStream(stream); }
        return new Map();
      });
      stopStream(screenStreamRef.current);
      screenStreamRef.current = null;
      originalVideoTrackRef.current = null;

      setLocalStream(null);
      setCallQuality(null);
      setMuted(false);
      setVideoEnabled(true);
      setIsScreenSharing(false);
      setIsHeld(false);
      setSpeakerPhone(false);
      setCallDurationSec(0);
      if (callDurationIntervalRef.current) clearInterval(callDurationIntervalRef.current);
      pendingOfferRef.current = null;
      pendingIceCandidatesRef.current.clear();
    reconnectAttemptsRef.current = 0;
    lastStatsRef.current = null;
      clearTimers();
    clearStatsInterval();

  finalizeCallHistory(resetTo, error);

    pushDiagnostic({
    level: resetTo === 'failed' ? 'error' : 'info',
    code: 'cleanup',
    message: error || `Call cleanup (${resetTo})`,
    });

      // Clear immediately so a new call can start right away.
      // The UI uses callPhase which derives from activeCall — setting null
      // means callPhase goes to 'idle' instantly.
      setActiveCall(null);
    },
    [clearStatsInterval, clearTimers, finalizeCallHistory, pushDiagnostic, stopStream]
  );

  // Perfect negotiation: derive (and cache) the polite/impolite role for a
  // peer, deterministically from comparing relayIds. See
  // lib/webrtc/perfect-negotiation.ts for why this needs no coordination.
  const getNegotiationState = useCallback(
    (peerId: string) => {
      let state = negotiationRef.current.get(peerId);
      if (!state) {
        const polite = !!localRelayId && isPolitePeer(localRelayId, peerId);
        state = { polite, makingOffer: false, ignoreOffer: false };
        negotiationRef.current.set(peerId, state);
      }
      return state;
    },
    [localRelayId]
  );

  const attemptIceRestart = useCallback(async (manual = false) => {
    const call = activeCallRef.current;
    if (!call || peersRef.current.size === 0) return false;
    // The attempts cap exists to stop the *automatic* background scheduler
    // from hammering signaling on a persistently-bad network. A manual retry
    // is a deliberate, rate-limited-by-human-clicking action, not that —
    // without this bypass, once auto-reconnect exhausted its budget and gave
    // up (surfacing the "Retry" button in the UI), reconnectAttemptsRef
    // stayed pinned at MAX_AUTO_RECONNECT_ATTEMPTS forever, so every click of
    // that button hit the cap check below and returned false without ever
    // sending a restart offer — a manual retry could never work again for
    // the rest of the call.
    if (!manual && reconnectAttemptsRef.current >= MAX_AUTO_RECONNECT_ATTEMPTS) return false;
    if (manual) reconnectAttemptsRef.current = 0;

    reconnectAttemptsRef.current += 1;
    pushDiagnostic({
      level: 'warn',
      code: 'reconnect_attempt',
      message: `Reconnect attempt ${reconnectAttemptsRef.current}/${MAX_AUTO_RECONNECT_ATTEMPTS}`,
    });
    setActiveCall((prev) => (prev ? { ...prev, phase: 'connecting' } : prev));

    try {
      // Refresh TURN credentials before restarting ICE — a call that's been
      // up long enough to need a reconnect may well have outlived the
      // short-lived TURN credential it started with, and a stale credential
      // makes the restart itself fail.
      const freshConfig = await buildRtcConfig();

      // Restart ICE on all peer connections
      for (const [peerId, pc] of peersRef.current) {
        try {
          pc.setConfiguration(freshConfig);
        } catch (err) {
          log.warn(`[Call] setConfiguration failed for ${peerId} (PC likely closed):`, err);
          continue;
        }
        const state = getNegotiationState(peerId);
        state.makingOffer = true;
        try {
          const offer = await pc.createOffer({ iceRestart: true, offerToReceiveAudio: true, offerToReceiveVideo: call.isVideo });
          await pc.setLocalDescription(offer);
          sendCallOffer(peerId, offer, call.callId);
        } finally {
          state.makingOffer = false;
        }
      }
      return true;
    } catch (err) {
      pushDiagnostic({ level: 'error', code: 'reconnect_failed', message: 'ICE restart failed' });
      return false;
    }
  }, [getNegotiationState, pushDiagnostic, sendCallOffer]);

  // ─── Auto reconnect scheduling ───
  // Watches ICE state per-peer (wired in createPeerConnection) and, after the
  // appropriate grace/backoff delay, re-checks whether the connection is
  // still troubled before invoking attemptIceRestart. Debounced to a single
  // in-flight timer so multiple peers going bad at once (mesh calls) collapse
  // into one restart pass instead of one per peer.
  const scheduleReconnectCheck = useCallback(
    (delayMs: number) => {
      if (reconnectTimerRef.current) return; // a check is already scheduled/in-flight
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        const call = activeCallRef.current;
        if (!call || peersRef.current.size === 0) return;

        const stillTroubled = Array.from(peersRef.current.values()).some(
          (pc) => pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected'
        );
        if (!stillTroubled) return; // self-healed during the grace/backoff window

        void attemptIceRestart().then((started) => {
          const attemptsSoFar = reconnectAttemptsRef.current;
          if (attemptsSoFar < MAX_AUTO_RECONNECT_ATTEMPTS) {
            // Whether or not this attempt "started" (offer sent), re-check
            // after a backoff window — success is only confirmed later via
            // the iceconnectionstatechange handler.
            scheduleReconnectCheck(RECONNECT_BACKOFF_MS[Math.min(attemptsSoFar, RECONNECT_BACKOFF_MS.length - 1)]);
          } else if (!started) {
            // Cap reached and this attempt didn't even get an offer out —
            // give up automatically and surface the manual-retry UI.
            pushDiagnostic({
              level: 'error',
              code: 'reconnect_failed',
              message: 'Automatic reconnect exhausted — manual retry required',
            });
            setActiveCall((prev) => (prev ? { ...prev, phase: 'failed', error: prev.error || 'Connection lost' } : prev));
          }
        });
      }, delayMs);
    },
    [attemptIceRestart, pushDiagnostic]
  );

  const flushPendingIceCandidates = useCallback(async (peerId?: string) => {
    if (peerId) {
      const pc = peersRef.current.get(peerId);
      const pending = pendingIceCandidatesRef.current.get(peerId);
      if (!pc || !pc.remoteDescription || !pending?.length) return;
      pendingIceCandidatesRef.current.delete(peerId);
      for (const c of pending) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* skip */ }
      }
    } else {
      // Flush all
      for (const [pid] of pendingIceCandidatesRef.current) {
        const pc = peersRef.current.get(pid);
        const pending = pendingIceCandidatesRef.current.get(pid);
        if (!pc || !pc.remoteDescription || !pending?.length) continue;
        pendingIceCandidatesRef.current.delete(pid);
        for (const c of pending) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch { /* skip */ }
        }
      }
    }
  }, []);

  const createPeerConnection = useCallback(
    async (peerId: string, callId: string) => {
      // Close existing connection to this peer if any
      const existing = peersRef.current.get(peerId);
      if (existing) {
        existing.ontrack = null;
        existing.onicecandidate = null;
        existing.onconnectionstatechange = null;
        existing.oniceconnectionstatechange = null;
        existing.close();
      }
      negotiationRef.current.delete(peerId);

      const pc = new RTCPeerConnection(await getRtcConfig());

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendCallIce(peerId, event.candidate.toJSON(), callId);
      };

      pc.ontrack = (event) => {
        const track = event.track;
        if (track) {
          setRemoteStreams((prev) => {
            const next = new Map(prev);
            // Merge new tracks into existing stream (don't replace — screen
            // share adds video-only tracks and we must keep the audio track)
            const existing = next.get(peerId);
            if (existing) {
              // Only add if this track isn't already in the stream
              if (!existing.getTrackById(track.id)) {
                existing.addTrack(track);
              }
              // Force a new Map reference so React re-renders
              next.set(peerId, existing);
            } else {
              // First track from this peer — use the event's stream
              const [stream] = event.streams;
              next.set(peerId, stream || new MediaStream([track]));
            }
            return next;
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        pushDiagnostic({
          level: state === 'failed' ? 'error' : state === 'disconnected' ? 'warn' : 'info',
          code: 'state_change',
          message: `[${peerId.slice(0, 10)}] Connection: ${state}`,
        });

        if (state === 'connected') {
          setActiveCall((prev) =>
            prev ? { ...prev, phase: 'in_call', connectedAt: prev.connectedAt || Date.now() } : prev
          );
          // Mesh: tell the newly connected peer about all OTHER connected peers
          // so they can establish connections with them too.
          const call = activeCallRef.current;
          if (call) {
            const otherPeers = Array.from(peersRef.current.keys()).filter((id) => id !== peerId);
            if (otherPeers.length > 0) {
              sendCallPeers(peerId, call.callId, otherPeers);
            }
          }
        } else if (state === 'closed') {
          // Explicit close (hangup/cleanup already ran) — remove immediately.
          // 'failed' is intentionally NOT handled here: it's handled below via
          // oniceconnectionstatechange, which drives an automatic ICE restart
          // instead of tearing the peer down right away.
          peersRef.current.delete(peerId);
          setRemoteStreams((prev) => {
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          });
          if (peersRef.current.size === 0) {
            cleanup('ended', 'All peers disconnected');
          }
        }
      };

      // ─── Auto ICE-restart ───
      // iceConnectionState 'failed' means ICE gave up finding a working
      // candidate pair; 'disconnected' means candidates stopped working but
      // may recover on their own (see RECONNECT_DISCONNECTED_GRACE_MS above).
      // Either way we drive recovery through scheduleReconnectCheck rather
      // than immediately tearing the call down, replacing the previous
      // behavior where only a manual "Retry" button click could restart ICE.
      pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        if (iceState === 'failed') {
          scheduleReconnectCheck(RECONNECT_FAILED_DEBOUNCE_MS);
        } else if (iceState === 'disconnected') {
          scheduleReconnectCheck(RECONNECT_DISCONNECTED_GRACE_MS);
        } else if (iceState === 'connected' || iceState === 'completed') {
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          if (reconnectAttemptsRef.current > 0) {
            pushDiagnostic({
              level: 'info',
              code: 'reconnect_success',
              message: `Reconnected to ${peerId.slice(0, 10)}`,
            });
            reconnectAttemptsRef.current = 0;
          }
        }
      };

      peersRef.current.set(peerId, pc);
      return pc;
    },
    [cleanup, pushDiagnostic, scheduleReconnectCheck, sendCallIce, sendCallPeers]
  );

  // ─── Start a call ───
  // Acquires media immediately, creates a real SDP offer, and waits up to
  // 2 minutes for the peer to answer. The caller can sit in the call screen
  // as long as they want (no 30-second cutoff).
  const startCall = useCallback(
    async (peerId: string, isVideo: boolean) => {
      log.debug(`[Call] Starting ${isVideo ? 'video' : 'voice'} call to ${peerId}, current phase: ${activeCall?.phase || 'idle'}`);

      if (!peerId) throw new Error('Missing peer ID');

      if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        const isInsecure =
          typeof window !== 'undefined' &&
          window.location.protocol !== 'https:' &&
          window.location.hostname !== 'localhost' &&
          window.location.hostname !== '127.0.0.1';
        throw new Error(
          isInsecure
            ? 'Calling requires a secure connection (HTTPS). Your browser blocks microphone/camera access over plain HTTP on non-localhost addresses. Open the app via HTTPS or use localhost.'
            : 'Your browser does not support WebRTC media devices. Try Chrome or Firefox.'
        );
      }

      const current = activeCallRef.current;
      if (current && ['calling', 'ringing', 'connecting', 'in_call'].includes(current.phase)) {
        throw new Error(`A call is already active (phase: ${current.phase})`);
      }

      const callId = generateCallId();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: isVideo,
        });

        // Another call (e.g. an incoming offer that arrived and was
        // answered while the mic/camera permission prompt was pending) can
        // become active during any of these awaits — activeCallRef.current
        // was only checked synchronously above. Bail without touching it:
        // unlike the catch block below, this must NOT call cleanup(), which
        // is indiscriminate about which call is currently active and would
        // tear down the now-legitimate other call instead of this aborted one.
        if (activeCallRef.current) {
          stopStream(stream);
          return;
        }
        setLocalStream(stream);

        const pc = await createPeerConnection(peerId, callId);
        if (activeCallRef.current) {
          peersRef.current.delete(peerId);
          pc.close();
          stopStream(stream);
          return;
        }
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));

        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: isVideo,
        });
        await pc.setLocalDescription(offer);

        if (activeCallRef.current) {
          peersRef.current.delete(peerId);
          pc.close();
          stopStream(stream);
          return;
        }

        setActiveCall({
          callId,
          peerId,
          direction: 'outgoing',
          isVideo,
          phase: 'calling',
          startedAt: Date.now(),
        });

        setCallDiagnostics([]);
        pushDiagnostic({
          level: 'info',
          code: 'call_start',
          message: `Outgoing ${isVideo ? 'video' : 'voice'} call started`,
        });

        sendCallOffer(peerId, offer, callId);

        // 2-minute timeout so the caller can sit and wait
        outgoingTimeoutRef.current = setTimeout(() => {
          sendCallHangup(peerId, callId, 'timeout');
          pushDiagnostic({
            level: 'error',
            code: 'timeout',
            message: 'Call timed out — peer did not answer',
          });
          cleanup('failed', 'Call timed out');
        }, 120_000);
      } catch (err) {
        cleanup('failed', err instanceof Error ? err.message : 'Failed to start call');
        throw err;
      }
    },
    [cleanup, createPeerConnection, pushDiagnostic, sendCallHangup, sendCallOffer]
  );

  const acceptIncomingCall = useCallback(async () => {
    if (!pendingOfferRef.current) return;
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('WebRTC media devices are not available in this browser');
    }

    const pending = pendingOfferRef.current;
    if (acceptingCallIdRef.current === pending.callId) return;
    acceptingCallIdRef.current = pending.callId;

    const wantsVideo = !!pending.offer?.sdp?.includes('m=video');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: wantsVideo,
      });

      // The remote peer can hang up (or the call can otherwise be torn down)
      // while we're still awaiting the mic/camera prompt above — cleanup()
      // nulls pendingOfferRef.current synchronously when that happens. Bail
      // instead of resurrecting a call the UI already told the user ended.
      if (pendingOfferRef.current?.callId !== pending.callId) {
        stopStream(stream);
        return;
      }
      setLocalStream(stream);

      const pc = await createPeerConnection(pending.fromRelayId, pending.callId);

      if (pendingOfferRef.current?.callId !== pending.callId) {
        peersRef.current.delete(pending.fromRelayId);
        pc.close();
        stopStream(stream);
        return;
      }

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(pending.offer));
      await flushPendingIceCandidates(pending.fromRelayId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (pendingOfferRef.current?.callId !== pending.callId) {
        peersRef.current.delete(pending.fromRelayId);
        pc.close();
        stopStream(stream);
        return;
      }

      sendCallAnswer(pending.fromRelayId, answer, pending.callId);
      pushDiagnostic({
        level: 'info',
        code: 'call_accept',
        message: 'Accepted incoming call and sent answer',
      });

      setActiveCall({
        callId: pending.callId,
        peerId: pending.fromRelayId,
        direction: 'incoming',
        isVideo: wantsVideo,
        phase: 'connecting',
        startedAt: activeCallRef.current?.startedAt || Date.now(),
      });

      pendingOfferRef.current = null;
      if (incomingTimeoutRef.current) {
        clearTimeout(incomingTimeoutRef.current);
        incomingTimeoutRef.current = null;
      }
    } catch (err) {
      cleanup('failed', err instanceof Error ? err.message : 'Failed to accept call');
      throw err;
    } finally {
      if (acceptingCallIdRef.current === pending.callId) {
        acceptingCallIdRef.current = null;
      }
    }
  }, [cleanup, createPeerConnection, flushPendingIceCandidates, pushDiagnostic, sendCallAnswer]);

  const declineIncomingCall = useCallback(() => {
    const currentCall = activeCallRef.current;
    const pending = pendingOfferRef.current;
    const peerId = pending?.fromRelayId || currentCall?.peerId;
    const callId = pending?.callId || currentCall?.callId;
    if (!peerId || !callId) return;

    sendCallHangup(peerId, callId, 'declined');
    pushDiagnostic({
      level: 'info',
      code: 'call_decline',
      message: 'Declined incoming call',
    });
    pendingOfferRef.current = null;
    if (incomingTimeoutRef.current) {
      clearTimeout(incomingTimeoutRef.current);
      incomingTimeoutRef.current = null;
    }
    cleanup('ended');
  }, [cleanup, pushDiagnostic, sendCallHangup]);

  const endCall = useCallback(
    (reasonOrEvent?: CallHangupReason | unknown) => {
      // Guard: when used as onClick={endCall}, React passes the click event
      // as the first arg. Only accept known reason values.
      const KNOWN_REASONS: CallHangupReason[] = ['hangup', 'declined', 'busy', 'rejected', 'missed', 'timeout'];
      const reason: CallHangupReason = KNOWN_REASONS.includes(reasonOrEvent as CallHangupReason)
        ? (reasonOrEvent as CallHangupReason)
        : 'hangup';
      const call = activeCallRef.current;
      if (call?.callId) {
        // Send hangup to ALL connected peers
        for (const peerId of peersRef.current.keys()) {
          sendCallHangup(peerId, call.callId, reason);
        }
        // Also hangup the original peer(s) in case they're not in the map yet
        if (call.peerId && !peersRef.current.has(call.peerId)) {
          // peerId might be comma-separated for group calls
          for (const pid of call.peerId.split(',')) {
            sendCallHangup(pid, call.callId, reason);
          }
        }
        pushDiagnostic({ level: 'info', code: 'call_hangup', message: `Local hangup (${reason})` });
      }
      cleanup('ended');
    },
    [cleanup, pushDiagnostic, sendCallHangup]
  );

  const retryConnectionNow = useCallback(async () => {
    const started = await attemptIceRestart(true);
    if (!started) {
      pushDiagnostic({
        level: 'warn',
        code: 'reconnect_failed',
        message: 'Manual reconnect is not available right now',
      });
    }
    return started;
  }, [attemptIceRestart, pushDiagnostic]);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = !next;
      });
      return next;
    });
  }, [localStream]);

  useEffect(() => {
    if (!callSignals.length) return;

    const signalsToProcess = [...callSignals];
    // Tracks activeCall as of THIS point in the synchronous loop below, not
    // the render's closed-over `activeCall` state. Several signals (e.g. a
    // call_offer followed immediately by its own call_answer/call_ice/
    // call_hangup) can land in the same batch; setActiveCall() doesn't take
    // effect until the next render, so a naive `activeCall` read stays stale
    // for the rest of THIS loop pass even after an earlier iteration just
    // started a new call. Update this alongside every synchronous
    // setActiveCall(<new call object>) call below so later iterations in the
    // same batch see it.
    let currentCall = activeCallRef.current;

    for (const signal of signalsToProcess) {
      if (!signal?.fromRelayId) continue;

      if (signal.type === 'call_ring') {
        setActiveCall((prev) => {
          if (!prev || prev.callId !== signal.callId) return prev;
          if (prev.phase !== 'calling') return prev;
          return { ...prev, phase: 'ringing' };
        });
        continue;
      }

      // ─── call_peers: mesh discovery — connect to peers we don't have yet ───
      if (signal.type === 'call_peers') {
        const call = activeCallRef.current;
        const peerIds: string[] = signal.peerIds || [];
        const stream = localStream || localStreamRef.current;
        log.debug(`[Call] Received call_peers:`, { peerIds, hasCall: !!call, hasStream: !!stream, myId: localRelayId });
        if (!call || !stream || peerIds.length === 0) continue;

        // Must be for the call we're actually in, and must come from a peer
        // we already have a live PeerConnection with — otherwise anyone on
        // the relay who knows our relayId could forge a call_peers frame and
        // get themselves dialed into someone else's active call (the relay
        // forwards control frames to any relayId with no contact check).
        if (call.callId !== signal.callId) continue;
        if (!peersRef.current.has(signal.fromRelayId)) continue;

        for (const pid of peerIds) {
          if (pid === localRelayId || peersRef.current.has(pid)) continue;

          // Mesh cap: don't grow past MAX_GROUP_CALL_PEERS connections per
          // client (see MAX_GROUP_CALL_PARTICIPANTS comment above).
          if (peersRef.current.size >= MAX_GROUP_CALL_PEERS) {
            if (!meshCapToastShownRef.current) {
              meshCapToastShownRef.current = true;
              toast.error(
                'Group call full',
                `This call has reached its ${MAX_GROUP_CALL_PARTICIPANTS}-participant limit — new participants can't be added.`
              );
              pushDiagnostic({
                level: 'warn',
                code: 'state_change',
                message: `Mesh cap (${MAX_GROUP_CALL_PARTICIPANTS}) reached; ignoring additional peer(s)`,
              });
            }
            continue;
          }

          log.debug(`[Call] Mesh: sending offer to ${pid}`);
          (async () => {
            const pc = await createPeerConnection(pid, call.callId);
            // The call can be hung up while we were awaiting the PC/TURN
            // fetch above — cleanup() closes+clears peersRef synchronously,
            // so re-check before touching shared state or this resurrects a
            // connection (and leaks a PC) for a call that's already ended.
            if (activeCallRef.current?.callId !== call.callId) {
              peersRef.current.delete(pid);
              pc.ontrack = null;
              pc.onicecandidate = null;
              pc.onconnectionstatechange = null;
              pc.close();
              return;
            }
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
            const negState = getNegotiationState(pid);
            negState.makingOffer = true;
            pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: call.isVideo })
              .then((offer) => pc.setLocalDescription(offer).then(() => {
                sendCallOffer(pid, offer, call.callId);
              }))
              .catch((err) => {
                log.warn(`[Call] Mesh offer to ${pid} failed:`, err);
                if (peersRef.current.get(pid) === pc) {
                  pc.ontrack = null;
                  pc.onicecandidate = null;
                  pc.onconnectionstatechange = null;
                  pc.close();
                  peersRef.current.delete(pid);
                }
              })
              .finally(() => { negState.makingOffer = false; });
          })();
        }
        continue;
      }

      if (signal.type === 'call_offer') {
        if (!signal.offer || !signal.offer.sdp) continue;
        const offer = signal.offer; // narrowed alias — see note below on why closures need this

        const call = activeCallRef.current;

        // MESH / RENEGOTIATION: if we're in a call with the SAME callId
        const stream = localStream || localStreamRef.current;
        if (call && call.callId === signal.callId && ['connecting', 'in_call'].includes(call.phase) && stream) {
          const existingPc = peersRef.current.get(signal.fromRelayId);
          if (existingPc) {

            // ─── Perfect negotiation (glare handling) ───
            // Two sides can both try to renegotiate at once (e.g. both add a
            // screen-share track, or — in a mesh call — both independently
            // decide via call_peers to connect to each other and each send
            // their own offer). Without this, setRemoteDescription can throw
            // or silently corrupt signaling state on one side.
            //
            // The polite peer (see lib/webrtc/perfect-negotiation.ts) rolls
            // back its own in-flight offer and accepts the incoming one; the
            // impolite peer ignores the incoming colliding offer and keeps
            // its own — the polite side will get an answer for it instead.
            const negState = getNegotiationState(signal.fromRelayId);
            const offerCollision = existingPc.signalingState !== 'stable' || negState.makingOffer;
            negState.ignoreOffer = !negState.polite && offerCollision;

            if (negState.ignoreOffer) {
              log.debug(`[Call] Perfect negotiation: ignoring colliding offer from ${signal.fromRelayId} (impolite)`);
              pushDiagnostic({
                level: 'warn',
                code: 'state_change',
                message: `Ignored colliding offer from ${signal.fromRelayId.slice(0, 10)} (impolite side)`,
              });
              continue;
            }

            log.debug(`[Call] Renegotiation from ${signal.fromRelayId}${offerCollision ? ' (polite rollback)' : ''}`);
            (async () => {
              try {
                if (offerCollision) {
                  await existingPc.setLocalDescription({ type: 'rollback' });
                }
                await existingPc.setRemoteDescription(new RTCSessionDescription(offer));
                await flushPendingIceCandidates(signal.fromRelayId);
                const answer = await existingPc.createAnswer();
                await existingPc.setLocalDescription(answer);
                sendCallAnswer(signal.fromRelayId, answer, signal.callId);
              } catch (err) {
                log.warn('[Call] Renegotiation failed:', err);
              }
            })();
            continue;
          }
          // New participant joining the same call — auto-accept
          log.debug(`[Call] Mesh: auto-accepting offer from ${signal.fromRelayId}`);
          (async () => {
            const pc = await createPeerConnection(signal.fromRelayId, signal.callId);
            // Same reasoning as the call_peers guard above: the call can end
            // while we were awaiting the PC/TURN fetch.
            if (activeCallRef.current?.callId !== signal.callId) {
              peersRef.current.delete(signal.fromRelayId);
              pc.ontrack = null;
              pc.onicecandidate = null;
              pc.onconnectionstatechange = null;
              pc.close();
              return;
            }
            stream.getTracks().forEach((track) => pc.addTrack(track, stream));
            pc.setRemoteDescription(new RTCSessionDescription(offer))
              .then(() => flushPendingIceCandidates(signal.fromRelayId))
              .then(() => pc.createAnswer())
              .then((answer) => pc.setLocalDescription(answer).then(() => {
                sendCallAnswer(signal.fromRelayId, answer, signal.callId);
                pushDiagnostic({ level: 'info', code: 'call_accept', message: `Mesh: connected to ${signal.fromRelayId.slice(0, 10)}` });
              }))
              .catch((err) => {
                log.warn(`[Call] Mesh accept failed:`, err);
                // createPeerConnection registers into peersRef.current before
                // negotiation succeeds — on failure it must be torn down
                // explicitly, or a malformed-but-schema-valid offer
                // permanently occupies one of the MAX_GROUP_CALL_PEERS slots.
                if (peersRef.current.get(signal.fromRelayId) === pc) {
                  pc.ontrack = null;
                  pc.onicecandidate = null;
                  pc.onconnectionstatechange = null;
                  pc.close();
                  peersRef.current.delete(signal.fromRelayId);
                }
              });
          })();
          continue;
        }

        // Normal: new incoming call — reject if busy with a DIFFERENT call
        if (call && ['calling', 'ringing', 'connecting', 'in_call'].includes(call.phase)) {
          sendCallHangup(signal.fromRelayId, signal.callId, 'busy');
          continue;
        }

        // The relay forwards call signaling to any connected relayId with
        // no contact-relationship check, and relayIds are discoverable via
        // profile search — reject an unsolicited offer from someone who
        // isn't a known contact before ever surfacing the ring UI.
        if (isKnownCaller && !isKnownCaller(signal.fromRelayId)) {
          log.warn(`[Call] Rejected offer from non-contact ${signal.fromRelayId.slice(0, 10)}`);
          sendCallHangup(signal.fromRelayId, signal.callId, 'rejected');
          continue;
        }

        pendingOfferRef.current = {
          fromRelayId: signal.fromRelayId,
          callId: signal.callId,
          offer: signal.offer,
        };

        currentCall = {
          callId: signal.callId,
          peerId: signal.fromRelayId,
          direction: 'incoming',
          isVideo: !!signal.offer.sdp.includes('m=video'),
          phase: 'ringing',
          startedAt: Date.now(),
        };
        setActiveCall(currentCall);
        setCallDiagnostics([]);
        pushDiagnostic({
          level: 'info',
          code: 'incoming_offer',
          message: 'Incoming call offer received',
        });

        if (incomingTimeoutRef.current) clearTimeout(incomingTimeoutRef.current);
        incomingTimeoutRef.current = setTimeout(() => {
          if (pendingOfferRef.current?.callId === signal.callId) {
            sendCallHangup(signal.fromRelayId, signal.callId, 'missed');
            pushDiagnostic({ level: 'warn', code: 'timeout', message: 'Incoming call expired (missed)' });
            pendingOfferRef.current = null;
            cleanup('ended', 'Missed call');
          }
        }, 120_000);

        sendCallRing(signal.fromRelayId, signal.callId);
        continue;
      }

      if (!currentCall || currentCall.callId !== signal.callId) {
        continue;
      }

      if (signal.type === 'call_answer' && signal.answer) {
        // The PC is always registered under the exact relayId it was offered
        // to (createPeerConnection keys peersRef by that id at creation time,
        // for both 1:1 and group/mesh offers) — a legitimate answerer's
        // fromRelayId therefore always has a direct match here. There is no
        // re-key-to-any-unanswered-PC fallback: that used to let anyone who
        // knew a callId hijack another invitee's still-pending PC by sending
        // an answer for it.
        const pc = peersRef.current.get(signal.fromRelayId);
        if (!pc) continue;

        if (outgoingTimeoutRef.current) {
          clearTimeout(outgoingTimeoutRef.current);
          outgoingTimeoutRef.current = null;
        }
        pc.setRemoteDescription(new RTCSessionDescription(signal.answer))
          .then(async () => {
            await flushPendingIceCandidates(signal.fromRelayId);
            pushDiagnostic({ level: 'info', code: 'call_answer', message: `${signal.fromRelayId.slice(0,10)} connected` });
            setActiveCall((prev) => prev ? { ...prev, phase: 'connecting', peerId: signal.fromRelayId } : prev);
          })
          .catch((err) => {
            cleanup('failed', err instanceof Error ? err.message : 'Failed to apply call answer');
          });
        continue;
      }

      if (signal.type === 'call_ice' && signal.candidate) {
        // Route ICE candidate to the correct peer's connection
        const pc = peersRef.current.get(signal.fromRelayId);
        if (!pc || !pc.remoteDescription) {
          // Buffer it — will be flushed when the remote description is set
          const existing = pendingIceCandidatesRef.current.get(signal.fromRelayId) || [];
          existing.push(signal.candidate);
          pendingIceCandidatesRef.current.set(signal.fromRelayId, existing);
        } else {
          pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch((err) => {
            log.warn('Failed to add ICE candidate:', err);
          });
        }
        continue;
      }

      if (signal.type === 'call_hangup') {
        pushDiagnostic({
          level: 'info',
          code: 'call_hangup',
          message: `${signal.fromRelayId.slice(0, 10)} left${signal.reason ? ` (${signal.reason})` : ''}`,
        });
        // Remove only THIS peer's connection, not the whole call
        const peerPc = peersRef.current.get(signal.fromRelayId);
        if (peerPc) {
          peerPc.ontrack = null;
          peerPc.onicecandidate = null;
          peerPc.onconnectionstatechange = null;
          peerPc.close();
          peersRef.current.delete(signal.fromRelayId);
          setRemoteStreams((prev) => {
            const next = new Map(prev);
            next.delete(signal.fromRelayId);
            return next;
          });
        }
        // Only end the call if no peers remain
        if (peersRef.current.size === 0) {
          cleanup('ended', 'Call ended');
        }
      }
    }

    consumeCallSignals(signalsToProcess.length);
  }, [
    activeCall,
    callSignals,
    cleanup,
    consumeCallSignals,
    createPeerConnection,
    flushPendingIceCandidates,
    getNegotiationState,
    localRelayId,
    localStream,
    pushDiagnostic,
    sendCallAnswer,
    sendCallHangup,
    sendCallOffer,
    sendCallRing,
  ]);

  useEffect(() => {
    if (!activeCall || !['connecting', 'in_call'].includes(activeCall.phase)) {
      clearStatsInterval();
      setCallQuality(null);
      lastStatsRef.current = null;
      return;
    }

    const collectStats = async () => {
      // Get stats from the first connected peer
      const pc = peersRef.current.values().next().value;
      if (!pc) return;

      try {
        const stats = await pc.getStats();
        let rttMs = 0;
        let jitterMs = 0;
        let packetsLost = 0;
        let packetsReceived = 0;
        let bytesReceived = 0;
        let bytesSent = 0;
        let audioLevel = 0;

        stats.forEach((report: RTCStats) => {
          // RTCStatsReport values are typed as RTCStats but carry subtype-specific
          // fields (currentRoundTripTime, packetsLost, etc.) at runtime. We use a
          // Record overlay so we can inspect those fields without losing the base type.
          const entry = report as RTCStats & Record<string, unknown>;

          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) {
            if (typeof entry.currentRoundTripTime === 'number') {
              rttMs = Math.max(rttMs, entry.currentRoundTripTime * 1000);
            }
          }

          if (entry.type === 'inbound-rtp' && !entry.isRemote && entry.kind === 'audio') {
            packetsLost += (entry.packetsLost as number) || 0;
            packetsReceived += (entry.packetsReceived as number) || 0;
            bytesReceived += (entry.bytesReceived as number) || 0;
            if (typeof entry.jitter === 'number') {
              jitterMs = Math.max(jitterMs, entry.jitter * 1000);
            }
          }

          if (entry.type === 'outbound-rtp' && !entry.isRemote && entry.kind === 'audio') {
            bytesSent += (entry.bytesSent as number) || 0;
          }

          if (entry.type === 'media-source' && entry.kind === 'audio' && typeof entry.audioLevel === 'number') {
            audioLevel = Math.max(audioLevel, entry.audioLevel);
          }
        });

        const now = Date.now();
        const totalBytes = bytesReceived + bytesSent;
        let bitrateKbps = 0;

        if (lastStatsRef.current) {
          const deltaBytes = Math.max(0, totalBytes - lastStatsRef.current.bytes);
          const deltaMs = Math.max(1, now - lastStatsRef.current.timestamp);
          bitrateKbps = (deltaBytes * 8) / deltaMs;
        }

        lastStatsRef.current = { bytes: totalBytes, timestamp: now };

        const totalPackets = packetsReceived + packetsLost;
        const packetLossPct = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

        setCallQuality({
          roundTripTimeMs: Number(rttMs.toFixed(1)),
          jitterMs: Number(jitterMs.toFixed(1)),
          packetLossPct: Number(packetLossPct.toFixed(2)),
          bitrateKbps: Number(bitrateKbps.toFixed(1)),
          audioLevel: Number(audioLevel.toFixed(3)),
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          reconnectAttempts: reconnectAttemptsRef.current,
          updatedAt: now,
        });
      } catch (err) {
        log.warn('Failed to collect call quality stats:', err);
      }
    };

    void collectStats();
    statsIntervalRef.current = setInterval(() => {
      void collectStats();
    }, 2000);

    return () => {
      clearStatsInterval();
    };
  }, [activeCall, clearStatsInterval]);

  // Cleanup on unmount only — use a ref so we always call the latest cleanup
  // without re-running the effect when `cleanup` identity changes.
  const cleanupRef = useRef(cleanup);
  cleanupRef.current = cleanup;
  useEffect(() => {
    return () => {
      cleanupRef.current('ended');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Call duration timer
  useEffect(() => {
    if (activeCall?.phase === 'in_call' && activeCall.connectedAt) {
      const start = activeCall.connectedAt;
      const tick = () => setCallDurationSec(Math.floor((Date.now() - start) / 1000));
      tick();
      callDurationIntervalRef.current = setInterval(tick, 1000);
      return () => {
        if (callDurationIntervalRef.current) clearInterval(callDurationIntervalRef.current);
      };
    } else {
      setCallDurationSec(0);
    }
  }, [activeCall?.phase, activeCall?.connectedAt]);

  const canAcceptIncoming = useMemo(
    () => !!activeCall && activeCall.phase === 'ringing' && activeCall.direction === 'incoming',
    [activeCall]
  );

  // ─── Toggle video on/off during a call ───
  const toggleVideo = useCallback(async () => {
    if (!localStream) return;
    const videoTracks = localStream.getVideoTracks();

    if (videoTracks.length > 0) {
      const next = !videoEnabled;
      videoTracks.forEach((track) => { track.enabled = next; });
      setVideoEnabled(next);
    } else {
      // Audio-only call: acquire camera and add to ALL peer connections
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const camTrack = camStream.getVideoTracks()[0];
        if (!camTrack) return;

        // The call may have ended (cleanup() already ran, stopping and
        // detaching localStream) while getUserMedia was pending — attaching
        // to a stale, detached stream would leak a live camera capture with
        // nothing left to reference or stop it.
        if (!activeCallRef.current || localStreamRef.current !== localStream) {
          camStream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStream.addTrack(camTrack);

        const call = activeCallRef.current;
        for (const [peerId, pc] of peersRef.current) {
          pc.addTrack(camTrack, localStream);
          const negState = getNegotiationState(peerId);
          negState.makingOffer = true;
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (call) sendCallOffer(peerId, offer, call.callId);
          } finally {
            negState.makingOffer = false;
          }
        }
        setVideoEnabled(true);
        setActiveCall((prev) => prev ? { ...prev, isVideo: true } : prev);
      } catch (err) {
        log.warn('[Call] Failed to enable camera:', err);
      }
    }
  }, [getNegotiationState, localStream, videoEnabled, sendCallOffer]);

  // ─── Screen sharing — replaceTrack on ALL peer connections (no renegotiation) ───
  // Only reachable on video calls (CallOverlay hides the Share control when
  // !isVideo): a fresh video sender is always present, so there's no
  // audio-only path here that would need a renegotiated transceiver the
  // remote side was never told about.
  const toggleScreenShare = useCallback(async () => {
    if (peersRef.current.size === 0) return;

    if (isScreenSharing) {
      // Stop screen share
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      for (const [, pc] of peersRef.current) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && originalVideoTrackRef.current) {
          await sender.replaceTrack(originalVideoTrackRef.current).catch(() => {});
        }
      }
      setIsScreenSharing(false);
      setActiveCall((prev) => prev ? { ...prev, isScreenSharing: false } : prev);
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });

        // The call may have ended (cleanup() already ran, closing peersRef
        // and nulling screenStreamRef) while the picker was open — without
        // this check we'd resurrect a live screen-capture into the ref
        // after the call ended, leaking it until some later, unrelated
        // call's cleanup() happens to stop it.
        if (!activeCallRef.current || peersRef.current.size === 0) {
          screenStream.getTracks().forEach((t) => t.stop());
          return;
        }

        screenStreamRef.current = screenStream;
        const screenTrack = screenStream.getVideoTracks()[0];

        for (const [, pc] of peersRef.current) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender) {
            if (!originalVideoTrackRef.current) originalVideoTrackRef.current = sender.track;
            await sender.replaceTrack(screenTrack).catch(() => {});
          }
        }

        screenTrack.onended = () => {
          for (const [, pc] of peersRef.current) {
            const s = pc.getSenders().find((s) => s.track?.kind === 'video');
            if (s) {
              s.replaceTrack(originalVideoTrackRef.current || null).catch(() => {});
            }
          }
          screenStreamRef.current = null;
          setIsScreenSharing(false);
          setActiveCall((prev) => prev ? { ...prev, isScreenSharing: false } : prev);
        };

        setIsScreenSharing(true);
        setActiveCall((prev) => prev ? { ...prev, isScreenSharing: true } : prev);
      } catch (err) {
        log.warn('Screen share cancelled or failed:', err);
      }
    }
  }, [isScreenSharing]);

  // ─── Hold / Resume ───
  const toggleHold = useCallback(() => {
    if (!localStream) return;
    const next = !isHeld;
    // Mute all tracks when held
    localStream.getTracks().forEach((track) => { track.enabled = !next; });
    setIsHeld(next);
    setActiveCall((prev) => prev ? { ...prev, isHeld: next } : prev);
    pushDiagnostic({
      level: 'info',
      code: 'state_change',
      message: next ? 'Call placed on hold' : 'Call resumed',
    });
  }, [localStream, isHeld, pushDiagnostic]);

  // ─── Speaker phone toggle (set audio output if browser supports it) ───
  const toggleSpeakerPhone = useCallback(() => {
    setSpeakerPhone((prev) => !prev);
    // sinkId API is available on some browsers
    // Users can wire this to an <audio> element's setSinkId if needed
  }, []);

  // ─── Format call duration for display ───
  const formattedCallDuration = useMemo(() => {
    const mins = Math.floor(callDurationSec / 60);
    const secs = callDurationSec % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, [callDurationSec]);

  // ─── Group call: create a PeerConnection per member, ring everyone ───
  const startGroupCall = useCallback(
    async (memberIds: string[], isVideo: boolean) => {
      if (!memberIds.length) throw new Error('No members to call');
      if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        throw new Error('WebRTC not available');
      }
      if (activeCall && ['calling', 'ringing', 'connecting', 'in_call'].includes(activeCall.phase)) {
        throw new Error('A call is already active');
      }
      if (memberIds.length > MAX_GROUP_CALL_PEERS) {
        throw new Error(
          `Group calls support up to ${MAX_GROUP_CALL_PARTICIPANTS} participants (including you). This group has ${memberIds.length + 1}.`
        );
      }

      const callId = generateCallId();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
        setLocalStream(stream);

        // Create a separate PeerConnection + offer for EACH member
        for (const peerId of memberIds) {
          const pc = await createPeerConnection(peerId, callId);
          stream.getTracks().forEach((track) => pc.addTrack(track, stream));
          const negState = getNegotiationState(peerId);
          negState.makingOffer = true;
          try {
            const offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: isVideo,
            });
            await pc.setLocalDescription(offer);
            sendCallOffer(peerId, offer, callId);
          } finally {
            negState.makingOffer = false;
          }
        }

        setActiveCall({
          callId,
          peerId: memberIds.join(','),
          direction: 'outgoing',
          isVideo,
          phase: 'calling',
          startedAt: Date.now(),
        });

        setCallDiagnostics([]);
        pushDiagnostic({
          level: 'info',
          code: 'call_start',
          message: `Group call — ringing ${memberIds.length} members`,
        });

        outgoingTimeoutRef.current = setTimeout(() => {
          for (const peerId of memberIds) {
            sendCallHangup(peerId, callId, 'timeout');
          }
          cleanup('failed', 'No one answered');
        }, 120_000);
      } catch (err) {
        cleanup('failed', err instanceof Error ? err.message : 'Failed to start group call');
        throw err;
      }
    },
    [activeCall, cleanup, createPeerConnection, getNegotiationState, pushDiagnostic, sendCallHangup, sendCallOffer]
  );

  // List of connected peer IDs (for group call participant display)
  const connectedPeerIds = useMemo(() => {
    return Array.from(remoteStreams.keys());
  }, [remoteStreams]);

  return {
    activeCall,
    callPhase,
    localStream,
    remoteStream,
    remoteStreams,
    connectedPeerIds,
    callQuality,
    callDiagnostics,
    callHistory,
    muted,
    videoEnabled,
    isScreenSharing,
    isHeld,
    speakerPhone,
    callDurationSec,
    formattedCallDuration,
    canAcceptIncoming,
    startVoiceCall: (peerId: string) => startCall(peerId, false),
    startVideoCall: (peerId: string) => startCall(peerId, true),
    startGroupCall,
    acceptIncomingCall,
    declineIncomingCall,
    endCall,
    retryConnectionNow,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    toggleHold,
    toggleSpeakerPhone,
    localRelayId,
  };
}
