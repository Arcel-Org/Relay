/**
 * Crypto Worker Pool
 *
 * Offloads ChaCha20-Poly1305 encrypt/decrypt + zlib compression to a
 * Web Worker so the main thread stays responsive during heavy crypto ops.
 *
 * The worker at /workers/crypto.worker.js bundles @noble/ciphers and pako
 * so it runs fully self-contained, no ES module imports needed.
 *
 * Falls back to main-thread execution when Workers are unavailable (SSR,
 * older browsers, worker load failure).
 *
 * Protocol (main <-> worker):
 *   encrypt: main sends { plaintext, encKey, nonce, dict, dictVersion, seq } as ArrayBuffers/values
 *            worker replies { result: ArrayBuffer (ctWithTag), padLen }
 *   decrypt: main sends { ctWithTag, encKey, nonce, paddingLen, aad, dict } as ArrayBuffers/values
 *            worker replies { result: ArrayBuffer (plaintext) }
 */

// ── Types ──────────────────────────────────────────────────────────────

interface PendingJob {
  resolve: (data: { result: Uint8Array; padLen?: number }) => void;
  reject: (err: Error) => void;
}

interface WorkerMessage {
  id: string;
  result?: ArrayBuffer | string;
  padLen?: number;
  error?: string;
}

interface EncryptPayload {
  plaintext: ArrayBuffer;
  encKey: ArrayBuffer;
  nonce: ArrayBuffer;
  dict: ArrayBuffer;
  dictVersion: number;
  seq: bigint;
}

interface DecryptPayload {
  ctWithTag: ArrayBuffer;
  encKey: ArrayBuffer;
  nonce: ArrayBuffer;
  paddingLen: number;
  aad: ArrayBuffer;
  dict: ArrayBuffer;
}

// ── Worker Pool ────────────────────────────────────────────────────────

const POOL_SIZE = typeof navigator !== 'undefined'
  ? Math.min(navigator.hardwareConcurrency ?? 2, 4)
  : 2;

let workers: Worker[] = [];
let workerReady: boolean[] = [];
let workerSupported: boolean | null = null;
let roundRobinIdx = 0;
const pending = new Map<string, PendingJob>();
let idCounter = 0;

function nextId(): string {
  return `cw_${++idCounter}_${Date.now()}`;
}

function handleMessage(e: MessageEvent<WorkerMessage>): void {
  const { id, result, padLen, error } = e.data;

  // Ignore the initial ready signal
  if (id === '__ready__') return;

  const job = pending.get(id);
  if (!job) return;
  pending.delete(id);

  if (error) {
    job.reject(new Error(error));
  } else if (result instanceof ArrayBuffer) {
    job.resolve({ result: new Uint8Array(result), padLen });
  } else {
    // 'pong' or other string results
    job.resolve({ result: new Uint8Array(0), padLen });
  }
}

function handleError(idx: number): void {
  workerReady[idx] = false;
  // If all workers are dead, mark unsupported
  if (workerReady.every((r) => !r)) {
    workerSupported = false;
    // Reject all pending jobs
    for (const [, job] of pending) {
      job.reject(new Error('All crypto workers crashed'));
    }
    pending.clear();
  }
}

function initPool(): boolean {
  if (workerSupported === false) return false;
  if (workers.length > 0) return true;

  // SSR guard
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    workerSupported = false;
    return false;
  }

  try {
    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker('/workers/crypto.worker.js');
      w.onmessage = handleMessage;
      w.onerror = () => handleError(i);
      workers.push(w);
      workerReady.push(true);
    }
    workerSupported = true;
    return true;
  } catch {
    workerSupported = false;
    workers = [];
    workerReady = [];
    return false;
  }
}

function getWorker(): Worker | null {
  if (!initPool()) return null;

  // Round-robin over live workers
  for (let attempt = 0; attempt < POOL_SIZE; attempt++) {
    const idx = roundRobinIdx % POOL_SIZE;
    roundRobinIdx++;
    if (workerReady[idx]) {
      return workers[idx];
    }
  }
  return null;
}

/**
 * Send a job to a pooled worker and return a promise for the result.
 * Returns null if workers are unavailable.
 */
function postJob(
  type: 'encrypt' | 'decrypt',
  payload: EncryptPayload | DecryptPayload,
  transferList: ArrayBuffer[],
): Promise<{ result: Uint8Array; padLen?: number }> | null {
  const w = getWorker();
  if (!w) return null;

  const id = nextId();
  return new Promise<{ result: Uint8Array; padLen?: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, type, payload }, transferList);
    } catch (err) {
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Encrypt plaintext on a worker thread.
 *
 * The worker handles: compress -> pad -> ChaCha20-Poly1305 encrypt.
 *
 * @returns `{ ctWithTag, padLen }` or `null` if workers unavailable.
 *
 * Callers should fall back to main-thread when this returns null.
 */
export async function workerEncrypt(
  plaintext: Uint8Array,
  encKey: Uint8Array,
  nonce: Uint8Array,
  dict: Uint8Array,
  dictVersion: number,
  seq: bigint,
): Promise<{ ctWithTag: Uint8Array; padLen: number } | null> {
  // Clone buffers so they can be transferred without detaching the originals
  const ptBuf = plaintext.slice().buffer;
  const keyBuf = encKey.slice().buffer;
  const nonceBuf = nonce.slice().buffer;
  const dictBuf = dict.slice().buffer;

  const promise = postJob(
    'encrypt',
    { plaintext: ptBuf, encKey: keyBuf, nonce: nonceBuf, dict: dictBuf, dictVersion, seq },
    [ptBuf, keyBuf, nonceBuf, dictBuf],
  );

  if (!promise) return null;

  try {
    const { result, padLen } = await promise;
    return { ctWithTag: result, padLen: padLen ?? 0 };
  } catch {
    return null;
  }
}

/**
 * Decrypt ciphertext on a worker thread.
 *
 * The worker handles: ChaCha20-Poly1305 decrypt -> unpad -> decompress.
 *
 * @returns Decrypted plaintext or `null` if workers unavailable.
 *
 * Callers should fall back to main-thread when this returns null.
 * On actual decryption failure (bad tag), this throws.
 */
export async function workerDecrypt(
  ctWithTag: Uint8Array,
  encKey: Uint8Array,
  nonce: Uint8Array,
  paddingLen: number,
  aad: Uint8Array,
  dict: Uint8Array,
): Promise<Uint8Array | null> {
  // Clone buffers so they can be transferred without detaching the originals
  const ctBuf = ctWithTag.slice().buffer;
  const keyBuf = encKey.slice().buffer;
  const nonceBuf = nonce.slice().buffer;
  const aadBuf = aad.slice().buffer;
  const dictBuf = dict.slice().buffer;

  const promise = postJob(
    'decrypt',
    { ctWithTag: ctBuf, encKey: keyBuf, nonce: nonceBuf, paddingLen, aad: aadBuf, dict: dictBuf },
    [ctBuf, keyBuf, nonceBuf, aadBuf, dictBuf],
  );

  if (!promise) return null;

  // For decrypt, errors are real (tag mismatch etc.) — let them propagate
  const { result } = await promise;
  return result;
}

/**
 * Check whether the crypto worker pool is available.
 */
export function isWorkerAvailable(): boolean {
  return initPool();
}

/**
 * Terminate all workers in the pool (cleanup).
 */
export function terminateCryptoWorker(): void {
  for (const w of workers) {
    try { w.terminate(); } catch { /* ignore */ }
  }
  workers = [];
  workerReady = [];
  workerSupported = null;
  roundRobinIdx = 0;

  for (const [, job] of pending) {
    job.reject(new Error('Worker pool terminated'));
  }
  pending.clear();
}
