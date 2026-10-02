/**
 * Mic-recording setup for voice messages — extracted from the legacy
 * lib/features/voice-messages.ts (deleted; its waveform/base64 VoiceMessage
 * encoding was superseded by MessageThread.tsx sending the raw recorded
 * blob straight through the generic file-send pipeline). This function is
 * the only piece of that file actually wired into the app.
 */

// Safari / older WebKit browsers expose AudioContext under a vendor prefix.
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

import { log } from '@/lib/platform/logger';

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];

export function getSupportedAudioMimeType(): string {
  for (const mimeType of MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }
  return 'audio/webm'; // fallback
}

/**
 * Initialize audio recording (returns recorder and analysis context)
 */
export async function startVoiceRecording(): Promise<{
  mediaRecorder: MediaRecorder;
  audioContext: AudioContext;
  analyser: AnalyserNode;
  stream: MediaStream;
  getAmplitude: () => number;
  onStop: (callback: (blob: Blob, duration: number) => void) => void;
}> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);

    const mimeType = getSupportedAudioMimeType();
    const mediaRecorder = new MediaRecorder(stream, { mimeType });

    const chunks: BlobPart[] = [];
    const startTime = Date.now();

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    let stopCallback: ((blob: Blob, duration: number) => void) | null = null;

    mediaRecorder.onstop = () => {
      const duration = Date.now() - startTime;
      const mimeType = getSupportedAudioMimeType();
      const blob = new Blob(chunks, { type: mimeType });
      if (stopCallback) {
        stopCallback(blob, duration);
      }
      stream.getTracks().forEach(track => track.stop());
      // Both of this function's callers (MessageThread.tsx's stopRecording
      // and its unmount cleanup) only ever stop the MediaRecorder and the
      // media stream — neither closes the AudioContext created above, so
      // every voice message recorded leaked one open AudioContext for the
      // life of the tab. This is the one choke point both paths already
      // route through (calling mediaRecorder.stop() fires this handler), so
      // closing it here covers both without relying on the caller to
      // remember.
      if (audioContext.state !== 'closed') {
        audioContext.close().catch(() => { /* already closing/closed */ });
      }
    };

    const getAmplitude = () => {
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
      return average / 255; // normalize to 0-1
    };

    const onStop = (callback: (blob: Blob, duration: number) => void) => {
      stopCallback = callback;
    };

    return {
      mediaRecorder,
      audioContext,
      analyser,
      stream,
      getAmplitude,
      onStop,
    };
  } catch (err) {
    log.error('Failed to start recording:', err);
    throw new Error('Unable to access microphone. Please grant permission.');
  }
}
