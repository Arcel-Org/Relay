import { defineConfig } from 'vitest/config';
import path from 'path';

// Node 22.4+ ships an experimental global `localStorage` that shadows jsdom's
// own (vitest's environment setup skips any key already present on globalThis)
// — without disabling it, every test touching localStorage silently gets
// Node's non-functional stub instead of jsdom's and fails with "Cannot read
// properties of undefined". The disable flag only exists on Node >=22.4, so
// pass it only where the runtime supports it: CI runs the suite under Node 20
// (workflow node-version), which rejects the unknown flag and makes vitest
// exit immediately with code 1 otherwise.
const webstorageFlag = '--no-experimental-webstorage';
const poolExecArgv =
  (typeof process.allowedNodeEnvironmentFlags?.has === 'function' &&
    process.allowedNodeEnvironmentFlags.has(webstorageFlag))
    ? [webstorageFlag]
    : [];

export default defineConfig({
  test: {
    environment: 'jsdom',
    // PIN hardening uses PBKDF2-SHA256 at 600k iterations (~2-4s per call);
    // the identity/duress tests derive several keys per case and comfortably
    // exceed vitest's 5s default. Raised so the more-secure KDF stays green
    // (and stays green on slower CI runners).
    testTimeout: 30000,
    include: ['lib/__tests__/**/*.test.ts'],
    exclude: ['lib/features/features.test.ts'],
    poolOptions: {
      threads: { execArgv: poolExecArgv },
      forks: { execArgv: poolExecArgv },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
