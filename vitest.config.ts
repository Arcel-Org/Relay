import { defineConfig } from 'vitest/config';
import path from 'path';

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
    // Node 22.4+ ships an experimental global `localStorage` that shadows
    // jsdom's own (vitest's environment setup skips any key already present
    // on globalThis) — without this flag, every test touching localStorage
    // silently gets Node's non-functional stub instead of jsdom's, and
    // fails with "Cannot read properties of undefined". See
    // https://github.com/vitest-dev/vitest/issues (Node webstorage clash).
    poolOptions: {
      threads: { execArgv: ['--no-experimental-webstorage'] },
      forks: { execArgv: ['--no-experimental-webstorage'] },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
