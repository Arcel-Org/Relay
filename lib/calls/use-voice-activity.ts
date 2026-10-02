'use client';

import { useEffect, useRef, useState } from 'react';

interface UseVoiceActivityOptions {
  stream: MediaStream | null;
  /** RMS amplitude threshold to consider as speaking. Default 0.012. */
  threshold?: number;
  /** Milliseconds above threshold before isSpeaking flips true. Default 150. */
  sustainMs?: number;
}

/**
 * Measure real-time voice activity on a MediaStream using the Web Audio API.
 * Returns `isSpeaking` (debounced boolean) and `audioLevel` (0-1 normalised RMS).
 * No server or signalling changes required — entirely local.
 */
export function useVoiceActivity({
  stream,
  threshold = 0.012,
  sustainMs = 150,
}: UseVoiceActivityOptions): { isSpeaking: boolean; audioLevel: number } {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  // Keep a ref so the cleanup in the effect can close the context exactly once.
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (!stream) {
      setIsSpeaking(false);
      setAudioLevel(0);
      return;
    }

    // Skip streams with no audio tracks (e.g. screen share video-only)
    if (stream.getAudioTracks().length === 0) {
      setIsSpeaking(false);
      setAudioLevel(0);
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    ctxRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let sustainTimer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    const tick = () => {
      if (!active) return;
      analyser.getByteTimeDomainData(buffer);

      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = buffer[i] / 128 - 1;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / buffer.length);

      // Normalise to 0-1 (0.4 is a comfortable "loud speech" ceiling)
      setAudioLevel(Math.min(1, rms / 0.4));

      if (rms > threshold) {
        if (!sustainTimer) {
          sustainTimer = setTimeout(() => setIsSpeaking(true), sustainMs);
        }
      } else {
        if (sustainTimer) {
          clearTimeout(sustainTimer);
          sustainTimer = null;
        }
        setIsSpeaking(false);
      }
    };

    const intervalId = setInterval(tick, 60);

    return () => {
      active = false;
      clearInterval(intervalId);
      if (sustainTimer) clearTimeout(sustainTimer);
      ctx.close().catch(() => {});
      ctxRef.current = null;
    };
  }, [stream, threshold, sustainMs]);

  return { isSpeaking, audioLevel };
}
