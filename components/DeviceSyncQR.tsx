/**
 * Device Sync QR Code Component
 *
 * Two-QR handshake:
 *   "show" mode (new device):
 *     Step 1 — Display QR1 (ephemeral transfer public key)
 *     Step 2 — Scan QR2 (encrypted identity from existing device)
 *     Step 3 — Decrypt identity, then keep scanning for the animated
 *              sync-payload QR carousel (contacts/conversations/messages)
 *              the existing device displays right after QR2
 *     Step 4 — Decrypt + import sync payload, call onIdentityReceived
 *
 *   "scan" mode (existing device):
 *     Step 1 — Scan QR1 from new device
 *     Step 2 — User confirms the verification code matches on both screens
 *     Step 3 — Encrypt identity, prepare + encrypt the sync payload (same
 *              ECDH shared secret, domain-separated via HKDF info string),
 *              then display QR2 followed by an auto-advancing carousel of
 *              sync-payload chunk QR frames until the panel is closed
 *
 * There is no live network channel between the two devices during pairing
 * (see design notes in lib/relay-device-sync.ts) — the animated QR carousel
 * *is* the transport, chunked to fit comfortably inside a scannable QR code.
 * If the sync payload never arrives (old build on one side, camera misses
 * every chunk, transfer skipped by the user, etc.) the new device still
 * finishes with the identity alone — full history sync is a bonus on top of
 * the bare-identity path, never a requirement for pairing to succeed.
 */

'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { QRCodeSVG as QRCode } from 'qrcode.react';
import {
  generateQRCodeData,
  encryptIdentityForQR,
  decryptIdentityFromQR,
  deriveVerificationCode,
  isQR1Fresh,
  registerPairedDevice,
  prepareSyncPayload,
  encryptSyncPayload,
  decryptSyncPayload,
  buildSyncQRFrames,
  parseSyncQRFrame,
  importSyncPayload,
  reassembleChunks,
  type IdentityTransferPayload,
} from '@/lib/vault/relay-device-sync';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { computeSharedSecret } from '@/lib/crypto/relay-crypto';
import { initStorage } from '@/lib/db/relay-store';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { x25519 } from '@noble/curves/ed25519.js';
import { log } from '@/lib/platform/logger';
import { Camera, CheckCircle, AlertCircle, Loader2, RefreshCw } from 'lucide-react';

interface DeviceSyncQRProps {
  mode: 'show' | 'scan';
  onIdentityReceived?: (identity: IdentityTransferPayload) => void;
}

// How long the receiving device waits, after identity is captured, for the
// sync-payload carousel to complete before giving up and finishing with
// identity-only (bare-identity fallback path).
const SYNC_RECEIVE_TIMEOUT_MS = 45_000;
// How fast the sending device cycles through QR frames in the carousel.
const CAROUSEL_FRAME_MS = 350;

// ─── BarcodeDetector types (not in TS stdlib yet) ───────────────────────────
declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string; format: string }>>;
  static getSupportedFormats(): Promise<string[]>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isBarcodeDetectorSupported(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

// ─── Show mode (new device) ──────────────────────────────────────────────────

function ShowModeView({ onIdentityReceived }: { onIdentityReceived?: (id: IdentityTransferPayload) => void }) {
  const [step, setStep] = useState<'qr1' | 'scan_qr2' | 'receiving_sync' | 'success' | 'error'>('qr1');
  const [qrData, setQrData] = useState<string>('');
  const [verificationCode, setVerificationCode] = useState('');
  const [timeRemaining, setTimeRemaining] = useState(300);
  const [errorMsg, setErrorMsg] = useState('');
  const [syncProgress, setSyncProgress] = useState<{ received: number; total: number } | null>(null);
  const [historyImported, setHistoryImported] = useState(false);

  const transferKeypairRef = useRef<{ privateKey: Uint8Array; publicKey: Uint8Array } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const detectorRef = useRef<BarcodeDetector | null>(null);

  // Populated once QR2 (identity) is captured; used to decrypt the
  // sync-payload carousel with the SAME ECDH shared secret (domain-separated
  // internally via a different HKDF info string), not a new channel.
  const identityRef = useRef<IdentityTransferPayload | null>(null);
  const sharedSecretRef = useRef<Uint8Array | null>(null);
  const syncChunksRef = useRef<Map<number, Uint8Array>>(new Map());
  const syncTotalRef = useRef<number | null>(null);
  const finishedRef = useRef(false);
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const { qrCodeData, transferKeypair, expiresAt } = generateQRCodeData();
    transferKeypairRef.current = transferKeypair;
    setQrData(JSON.stringify(qrCodeData));
    setVerificationCode(deriveVerificationCode(qrCodeData.transferPublicKey));

    const end = expiresAt;
    const timer = setInterval(() => {
      const rem = Math.max(0, Math.floor((end - Date.now()) / 1000));
      setTimeRemaining(rem);
      if (rem === 0) clearInterval(timer);
      // The code rotates every 30s (see deriveVerificationCode) — re-derive
      // it here so the on-screen value stays in sync with what the scanning
      // device computes at its own current time.
      setVerificationCode(deriveVerificationCode(qrCodeData.transferPublicKey));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const startScanQR2 = useCallback(async () => {
    if (!isBarcodeDetectorSupported()) {
      setErrorMsg('QR scanning requires Chrome 83+ or Edge 83+. Use the manual import option.');
      setStep('error');
      return;
    }
    setStep('scan_qr2');
  }, []);

  // Finalize pairing: import whatever sync-payload chunks we collected (if
  // any/complete), then hand the identity up to the caller. Safe to call
  // more than once (finishedRef guards it) — both the completion path and
  // the timeout fallback path call this.
  const finalize = useCallback(async () => {
    if (finishedRef.current || !identityRef.current) return;
    finishedRef.current = true;

    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
      syncTimeoutRef.current = null;
    }

    const identity = identityRef.current;

    try {
      const total = syncTotalRef.current;
      if (total !== null && syncChunksRef.current.size === total && sharedSecretRef.current) {
        // initStorage is normally called by the main app hook once this
        // device finishes onboarding, but the sync payload needs to be
        // written to encrypted IndexedDB right now — deriving the same
        // storage key here is idempotent (same private key), so re-deriving
        // it later is harmless.
        await initStorage(fromHex(identity.privateKeyHex));
        const reassembled = reassembleChunks(syncChunksRef.current, total);
        const payload = await decryptSyncPayload(reassembled, sharedSecretRef.current);
        await importSyncPayload(payload);
        setHistoryImported(true);
      }
    } catch (err) {
      // Any failure here (tampered/incomplete/undecryptable sync data) must
      // NOT block pairing — fall back to the bare-identity path.
      log.warn('[DeviceSync] Sync payload import failed, continuing with identity only:', err);
    }

    setStep('success');
    onIdentityReceived?.(identity);
  }, [onIdentityReceived]);

  useEffect(() => {
    if (step !== 'scan_qr2' && step !== 'receiving_sync') return;

    let stream: MediaStream | null = null;
    detectorRef.current = new BarcodeDetector({ formats: ['qr_code'] });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
      } catch {
        setErrorMsg('Camera access denied. Check browser permissions.');
        setStep('error');
        return;
      }

      const scan = async () => {
        if (!videoRef.current || !detectorRef.current || finishedRef.current) return;
        try {
          const results = await detectorRef.current.detect(videoRef.current);
          if (results.length > 0) {
            const raw = results[0].rawValue;

            if (!identityRef.current) {
              // Still looking for QR2 (the encrypted identity).
              try {
                const parsed = JSON.parse(raw);
                if (parsed.v === 'rs1r' && parsed.enc && parsed.spk) {
                  const identity = decryptIdentityFromQR(
                    parsed.enc,
                    transferKeypairRef.current!.privateKey,
                    parsed.spk,
                  );
                  identityRef.current = identity;
                  sharedSecretRef.current = computeSharedSecret(
                    transferKeypairRef.current!.privateKey,
                    fromHex(parsed.spk),
                  );
                  setStep('receiving_sync');
                  // Give the sending device's carousel a bounded window to
                  // deliver the full history; otherwise fall back to
                  // identity-only rather than hang indefinitely.
                  syncTimeoutRef.current = setTimeout(() => {
                    finalize();
                  }, SYNC_RECEIVE_TIMEOUT_MS);
                }
              } catch {
                // Not a valid response QR, keep scanning
              }
            } else {
              // Identity already captured — now collecting sync-chunk frames.
              const chunk = parseSyncQRFrame(raw);
              // Once a frame has established the session's chunk count,
              // reject any frame claiming a different one — a misread of an
              // unrelated QR code in the camera's view (or the animation
              // wrapping back to a stale earlier frame) must not silently
              // reset progress or straddle two different totals.
              if (chunk && (syncTotalRef.current === null || syncTotalRef.current === chunk.totalChunks)) {
                syncChunksRef.current.set(chunk.chunkIndex, chunk.data);
                syncTotalRef.current = chunk.totalChunks;
                setSyncProgress({ received: syncChunksRef.current.size, total: chunk.totalChunks });
                if (syncChunksRef.current.size === chunk.totalChunks) {
                  stream?.getTracks().forEach((t) => t.stop());
                  cancelAnimationFrame(rafRef.current);
                  await finalize();
                  return;
                }
              }
            }
          }
        } catch {
          // Frame not ready, skip
        }
        if (!finishedRef.current) {
          rafRef.current = requestAnimationFrame(scan);
        }
      };
      rafRef.current = requestAnimationFrame(scan);
    })();

    return () => {
      cancelAnimationFrame(rafRef.current);
      stream?.getTracks().forEach((t) => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, finalize]);

  const skipHistorySync = useCallback(() => {
    finalize();
  }, [finalize]);

  if (step === 'success') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <CheckCircle className="w-12 h-12 text-green-500" />
        <p className="text-relay-text-primary font-semibold">Identity received!</p>
        <p className="text-xs text-relay-text-muted">
          {historyImported
            ? 'Your identity and message history have been imported. Complete setup to continue.'
            : 'Your identity has been imported. Complete setup to continue.'}
        </p>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <AlertCircle className="w-10 h-10 text-relay-danger" />
        <p className="text-sm text-relay-text-secondary">{errorMsg}</p>
        <button onClick={() => setStep('qr1')} className="relay-btn-secondary text-xs">
          <RefreshCw className="w-3 h-3" /> Try again
        </button>
      </div>
    );
  }

  if (step === 'scan_qr2') {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-relay-text-secondary text-center">
          Scan the response QR shown on your existing device
        </p>
        <div className="relative w-full max-w-[280px] aspect-square rounded-xl overflow-hidden border-2 border-relay-accent">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          {/* Scan frame overlay */}
          <div className="absolute inset-0 border-[3px] border-relay-accent/60 rounded-xl pointer-events-none" />
        </div>
        <div className="flex items-center gap-2 text-xs text-relay-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" /> Scanning…
        </div>
      </div>
    );
  }

  if (step === 'receiving_sync') {
    const pct = syncProgress && syncProgress.total > 0
      ? Math.min(100, Math.round((syncProgress.received / syncProgress.total) * 100))
      : 0;
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-relay-text-secondary text-center">
          Identity received — restoring contacts and message history…
        </p>
        <div className="relative w-full max-w-[280px] aspect-square rounded-xl overflow-hidden border-2 border-relay-accent">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          <div className="absolute inset-0 border-[3px] border-relay-accent/60 rounded-xl pointer-events-none" />
        </div>
        {syncProgress ? (
          <div className="w-full">
            <div className="h-2 w-full rounded-full bg-relay-surface-hover overflow-hidden">
              <div
                className="h-full bg-relay-accent transition-all duration-150"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-xs text-relay-text-muted text-center mt-1">
              Received {syncProgress.received} of {syncProgress.total} chunks
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-relay-text-muted">
            <Loader2 className="w-3 h-3 animate-spin" /> Waiting for history transfer to start…
          </div>
        )}
        <button onClick={skipHistorySync} className="relay-btn-ghost text-xs">
          Skip — continue without history
        </button>
      </div>
    );
  }

  // step === 'qr1'
  return (
    <div className="flex flex-col items-center gap-4">
      {qrData ? (
        <>
          <div className="p-3 bg-white rounded-xl">
            <QRCode value={qrData} size={200} level="H" includeMargin={false} />
          </div>
          <div className="text-center">
            <p className="text-xs text-relay-text-secondary">Show this QR to your existing device</p>
            <p className="text-xl font-mono font-bold text-relay-danger mt-1">
              {Math.floor(timeRemaining / 60)}:{String(timeRemaining % 60).padStart(2, '0')}
            </p>
          </div>
          <div className="w-full rounded-lg border border-relay-accent/40 bg-relay-surface-hover px-4 py-3 text-center">
            <p className="text-[11px] text-relay-text-muted">Verification code — read this out, or confirm it matches on your existing device</p>
            <p className="text-2xl font-mono font-bold text-relay-accent tracking-widest mt-1">{verificationCode}</p>
          </div>
          {timeRemaining === 0 ? (
            <p className="text-xs text-relay-danger">Expired — close and reopen to regenerate</p>
          ) : (
            <button onClick={startScanQR2} className="relay-btn-primary w-full">
              <Camera className="w-4 h-4" /> I have a response QR — scan it
            </button>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 text-relay-text-muted text-sm py-8">
          <Loader2 className="w-4 h-4 animate-spin" /> Generating…
        </div>
      )}
    </div>
  );
}

// ─── Scan mode (existing device) ─────────────────────────────────────────────

function ScanModeView() {
  const authStore = useRelayAuthStoreV2();
  const [step, setStep] = useState<'scan' | 'confirm' | 'preparing' | 'show_qr2' | 'error'>('scan');
  const [responseQR, setResponseQR] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const [frameCount, setFrameCount] = useState(0); // number of sync-chunk frames (0 = identity-only)

  const pendingTransferPublicKeyRef = useRef<string>('');
  const pendingIssuedAtRef = useRef<unknown>(null);
  const framesRef = useRef<string[]>([]); // [qr2Data, ...syncChunkFrames]
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number>(0);
  const detectorRef = useRef<BarcodeDetector | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const carouselRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The code rotates every 30s (deriveVerificationCode). Without re-deriving
  // it here too, this screen would freeze on whatever code was current at
  // scan time — if the user takes longer than the remainder of that window
  // to read and confirm, it would legitimately stop matching the new
  // device's (correctly live-updating) screen, breaking normal pairing.
  useEffect(() => {
    if (step !== 'confirm' || !pendingTransferPublicKeyRef.current) return;
    const id = setInterval(() => {
      setVerificationCode(deriveVerificationCode(pendingTransferPublicKeyRef.current));
    }, 1000);
    return () => clearInterval(id);
  }, [step]);

  const startCamera = useCallback(async () => {
    if (!isBarcodeDetectorSupported()) {
      setErrorMsg('QR scanning requires Chrome 83+ or Edge 83+.');
      setStep('error');
      return;
    }
    detectorRef.current = new BarcodeDetector({ formats: ['qr_code'] });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch {
      setErrorMsg('Camera access denied. Check browser permissions.');
      setStep('error');
      return;
    }

    const scan = async () => {
      if (!videoRef.current || !detectorRef.current) return;
      try {
        const results = await detectorRef.current.detect(videoRef.current);
        if (results.length > 0) {
          const raw = results[0].rawValue;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.version === 'rsync-v1' && parsed.transferPublicKey) {
              if (!isQR1Fresh(parsed.issuedAt)) {
                // Expired/stale code — keep scanning rather than erroring out,
                // in case the camera also picks up an old/reused QR in frame.
                rafRef.current = requestAnimationFrame(scan);
                return;
              }
              streamRef.current?.getTracks().forEach((t) => t.stop());
              cancelAnimationFrame(rafRef.current);

              // Do NOT auto-encrypt/release the identity here. Require the
              // user to explicitly confirm the verification code matches
              // what's shown on the actual new device first — otherwise a
              // planted/opportunistic QR code (sticker, poster, phishing
              // screen) scanned in passing would silently exfiltrate the
              // private key with no user awareness at all.
              pendingTransferPublicKeyRef.current = parsed.transferPublicKey;
              pendingIssuedAtRef.current = parsed.issuedAt;
              setVerificationCode(deriveVerificationCode(parsed.transferPublicKey));
              setStep('confirm');
              return;
            }
          } catch {
            // Not a valid sync QR, keep scanning
          }
        }
      } catch {
        // Frame not ready
      }
      rafRef.current = requestAnimationFrame(scan);
    };
    rafRef.current = requestAnimationFrame(scan);
  }, [authStore]);

  useEffect(() => {
    startCamera();
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the animated QR carousel while showing QR2 — cycles through the
  // identity frame followed by every sync-payload chunk frame, looping
  // continuously since there is no return channel to signal "got it all";
  // the receiving device stops scanning on its own once it has every chunk.
  useEffect(() => {
    if (step !== 'show_qr2') return;
    if (framesRef.current.length <= 1) return; // identity-only, nothing to cycle

    carouselRef.current = setInterval(() => {
      setFrameIndex((i) => (i + 1) % framesRef.current.length);
    }, CAROUSEL_FRAME_MS);

    return () => {
      if (carouselRef.current) clearInterval(carouselRef.current);
      carouselRef.current = null;
    };
  }, [step]);

  const handleConfirmPairing = useCallback(async () => {
    // Re-check freshness here, not just at scan time — a user can stall on
    // this screen (get interrupted, read the verification code slowly) long
    // enough for the original QR to age past its TTL. Without this, a stale
    // scan could still be confirmed after the code shown here has rotated
    // out of sync with the new device's screen.
    if (!isQR1Fresh(pendingIssuedAtRef.current)) {
      setErrorMsg('This pairing code expired. Please scan a fresh QR code.');
      setStep('error');
      return;
    }

    const privateKey = authStore.getPrivateKey();
    const relayId = authStore.currentRelayId;

    if (!privateKey || !relayId) {
      setErrorMsg('Could not read identity. Ensure you are logged in.');
      setStep('error');
      return;
    }

    const publicKey = x25519.getPublicKey(privateKey);
    // ML-KEM768's public key isn't derivable from the private key the way
    // X25519's is (generated together, not one-from-the-other), so the
    // public half has to come from this (sending) device's own local
    // IndexedDB record rather than being computed here.
    const pqPrivateKey = authStore.getPqPrivateKey();
    let pqPublicKeyHex: string | undefined;
    try {
      const { getUserByRelayId } = await import('@/lib/db/relay-db');
      const localUser = await getUserByRelayId(relayId);
      pqPublicKeyHex = localUser?.pqPublicKeyHex || undefined;
    } catch {
      // Best-effort — if this fails, the paired device just won't get a PQ
      // key either (same as today), not a regression.
    }
    const identity: IdentityTransferPayload = {
      privateKeyHex: toHex(privateKey),
      publicKeyHex: toHex(publicKey),
      relayId,
      pqPrivateKeyHex: pqPrivateKey ? toHex(pqPrivateKey) : undefined,
      pqPublicKeyHex,
    };

    const transferPublicKeyHex = pendingTransferPublicKeyRef.current;
    const enc = encryptIdentityForQR(identity, transferPublicKeyHex, privateKey);
    const qr2Data = JSON.stringify({ v: 'rs1r', spk: toHex(publicKey), enc });

    // Record the new device in this device's paired-device list so Settings
    // reflects reality (each device tracks its own view — see revoke UI note
    // about this not being a synced, server-enforced device table).
    const deviceId = transferPublicKeyHex.slice(0, 16);
    registerPairedDevice(deviceId, `Device added ${new Date().toLocaleDateString()}`, transferPublicKeyHex).catch(() => {});

    setStep('preparing');

    // Prepare + encrypt the sync payload (contacts/conversations/message
    // history) with the SAME ECDH shared secret used for the identity QR —
    // domain-separated internally via a distinct HKDF info string — and
    // chunk it for the animated QR carousel. Any failure here must not
    // block pairing: fall back to the identity-only QR2 (no carousel).
    let syncFrames: string[] = [];
    try {
      const sharedSecret = computeSharedSecret(privateKey, fromHex(transferPublicKeyHex));
      const payload = await prepareSyncPayload(identity.privateKeyHex);
      const encrypted = await encryptSyncPayload(payload, sharedSecret);
      syncFrames = buildSyncQRFrames(encrypted);
    } catch (err) {
      log.warn('[DeviceSync] Failed to prepare sync payload — falling back to identity-only pairing:', err);
      syncFrames = [];
    }

    framesRef.current = [qr2Data, ...syncFrames];
    setFrameCount(syncFrames.length);
    setFrameIndex(0);
    setResponseQR(qr2Data);
    setStep('show_qr2');
  }, [authStore]);

  const handleCancelPairing = () => {
    pendingTransferPublicKeyRef.current = '';
    setVerificationCode('');
    setStep('scan');
    startCamera();
  };

  if (step === 'confirm') {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <AlertCircle className="w-10 h-10 text-relay-accent" />
        <p className="text-sm font-semibold text-relay-text-primary">Confirm this is your device</p>
        <p className="text-xs text-relay-text-secondary max-w-xs">
          Your full account identity is about to be shared. Only continue if you personally
          initiated this on the other device and its screen shows the SAME code below.
        </p>
        <div className="w-full rounded-lg border border-relay-accent/40 bg-relay-surface-hover px-4 py-3">
          <p className="text-2xl font-mono font-bold text-relay-accent tracking-widest">{verificationCode}</p>
        </div>
        <div className="flex gap-2 w-full">
          <button onClick={handleCancelPairing} className="relay-btn-secondary flex-1">
            Cancel
          </button>
          <button onClick={handleConfirmPairing} className="relay-btn-primary flex-1">
            Codes match — share identity
          </button>
        </div>
      </div>
    );
  }

  if (step === 'preparing') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <Loader2 className="w-8 h-8 animate-spin text-relay-accent" />
        <p className="text-sm text-relay-text-secondary">Preparing transfer…</p>
      </div>
    );
  }

  if (step === 'show_qr2') {
    const currentFrame = framesRef.current[frameIndex] ?? responseQR;
    const isCarousel = frameCount > 0;
    const pct = isCarousel ? Math.round(((frameIndex) / Math.max(1, framesRef.current.length - 1)) * 100) : 100;
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="text-sm text-relay-text-secondary text-center">
          Let the new device scan this response QR
        </p>
        <div className="p-3 bg-white rounded-xl">
          <QRCode value={currentFrame} size={220} level={isCarousel ? 'L' : 'H'} includeMargin={false} />
        </div>
        {isCarousel ? (
          <div className="w-full">
            <div className="h-2 w-full rounded-full bg-relay-surface-hover overflow-hidden">
              <div className="h-full bg-relay-accent transition-all duration-150" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[11px] text-relay-text-muted text-center mt-1">
              Sending history — keep both devices steady (frame {frameIndex + 1} of {framesRef.current.length}, looping until the new device finishes)
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-relay-text-muted">
            <CheckCircle className="w-3.5 h-3.5 text-green-500" />
            Identity ready — new device should scan this now
          </div>
        )}
        <button onClick={() => { setStep('scan'); startCamera(); }} className="relay-btn-ghost text-xs">
          <RefreshCw className="w-3 h-3" /> Scan again
        </button>
      </div>
    );
  }

  if (step === 'error') {
    return (
      <div className="flex flex-col items-center gap-4 py-6 text-center">
        <AlertCircle className="w-10 h-10 text-relay-danger" />
        <p className="text-sm text-relay-text-secondary">{errorMsg}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-sm text-relay-text-secondary text-center">
        Point your camera at the new device&apos;s QR code
      </p>
      <div className="relative w-full max-w-[280px] aspect-square rounded-xl overflow-hidden border-2 border-relay-accent">
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
        <div className="absolute inset-0 border-[3px] border-relay-accent/60 rounded-xl pointer-events-none" />
      </div>
      <div className="flex items-center gap-2 text-xs text-relay-text-muted">
        <Loader2 className="w-3 h-3 animate-spin" /> Scanning for device QR…
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function DeviceSyncQR({ mode, onIdentityReceived }: DeviceSyncQRProps) {
  if (mode === 'show') return <ShowModeView onIdentityReceived={onIdentityReceived} />;
  return <ScanModeView />;
}
