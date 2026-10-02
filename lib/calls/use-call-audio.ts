'use client';

import { useEffect, useRef } from 'react';
import type { CallPhase } from '@/lib/calls/use-webrtc-call';

type AudioCueType = 'ring' | 'ringback' | 'connected' | 'ended' | 'failed';

/**
 * Generates call audio cues entirely via the Web Audio API (no audio files needed).
 * Responds to callPhase changes and loops/stops automatically.
 */
export function useCallAudio(callPhase: CallPhase, direction: 'incoming' | 'outgoing') {
  const ctxRef = useRef<AudioContext | null>(null);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodesRef = useRef<{ osc: OscillatorNode; gain: GainNode }[]>([]);

  const stopAll = () => {
    if (loopRef.current) { clearTimeout(loopRef.current); loopRef.current = null; }
    activeNodesRef.current.forEach(({ osc, gain }) => {
      try { gain.gain.setTargetAtTime(0, ctxRef.current!.currentTime, 0.05); } catch { /* ignore */ }
      try { osc.stop(ctxRef.current!.currentTime + 0.1); } catch { /* ignore */ }
    });
    activeNodesRef.current = [];
  };

  const getCtx = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      try { ctxRef.current = new AudioContext(); } catch { return null; }
    }
    if (ctxRef.current.state === 'suspended') {
      ctxRef.current.resume().catch(() => {});
    }
    return ctxRef.current;
  };

  /** Play a short tone burst: frequency, duration, attack, release. */
  const tone = (freq: number, durationSec: number, vol = 0.25, startOffset = 0) => {
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime + startOffset;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.setValueAtTime(vol, t + durationSec - 0.05);
    gain.gain.linearRampToValueAtTime(0, t + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + durationSec);
    activeNodesRef.current.push({ osc, gain });
  };

  /** Phone-style dual ring: two bursts at 800+1000 Hz, looping. */
  const startRing = () => {
    stopAll();
    const ring = () => {
      tone(800, 0.4, 0.22, 0);
      tone(1000, 0.4, 0.22, 0);
      tone(800, 0.4, 0.22, 0.5);
      tone(1000, 0.4, 0.22, 0.5);
      loopRef.current = setTimeout(ring, 3200);
    };
    ring();
  };

  /** Softer outgoing ringback tone: 440+480 Hz. */
  const startRingback = () => {
    stopAll();
    const rb = () => {
      tone(440, 1.8, 0.15, 0);
      tone(480, 1.8, 0.15, 0);
      loopRef.current = setTimeout(rb, 4000);
    };
    rb();
  };

  /** Short ascending connected chime. */
  const playConnected = () => {
    stopAll();
    tone(523, 0.12, 0.25, 0);   // C5
    tone(659, 0.12, 0.25, 0.12); // E5
    tone(784, 0.18, 0.25, 0.24); // G5
  };

  /** Short descending end-call tone. */
  const playEnded = () => {
    stopAll();
    tone(523, 0.12, 0.2, 0);
    tone(440, 0.12, 0.2, 0.12);
    tone(349, 0.2, 0.2, 0.24);
  };

  useEffect(() => {
    if (callPhase === 'ringing' && direction === 'incoming') {
      startRing();
    } else if (
      callPhase === 'calling' ||
      (callPhase === 'ringing' && direction === 'outgoing')
    ) {
      startRingback();
    } else if (callPhase === 'in_call') {
      playConnected();
    } else if (callPhase === 'ended' || callPhase === 'failed') {
      playEnded();
    } else {
      stopAll();
    }

    return stopAll;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callPhase, direction]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAll();
      ctxRef.current?.close().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
