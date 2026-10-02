'use strict';
/**
 * Server-side logger for the relay server. Plain CommonJS (not TypeScript)
 * so `node server.js` can require it directly with zero build step — that
 * direct, unbuilt require is exactly why this can't be a .ts file: server.js
 * is always run by plain `node`, never through ts-node or a bundler, in
 * every deployment path (local dev via dev-server.sh, PM2, Docker, e2e).
 * Compiled server code (dist-server/server/relay-node.js, via `./logger`)
 * resolves this same file too — tsconfig.server.json's include list covers
 * server/**\/*.js so `npm run build:relay` copies it into dist-server/server/
 * unchanged, no separate build step needed for this file specifically.
 *
 * `debug` lines include sender/recipient relayId pairs for every relayed
 * message (the social graph) — those must NOT be persisted by default in
 * production, since a compromised server (or just its log files/Docker
 * logging driver) would otherwise reveal who talks to whom even though
 * message content itself is E2E encrypted. Debug logging is opt-in via
 * RELAY_DEBUG_LOGS=true (or non-production NODE_ENV) rather than always-on.
 */

// Checking `NODE_ENV !== 'production'` (a deny-list) would turn debug
// logging — which includes the social graph, see above — on by default
// under 'staging', 'preview', or any other non-'production' value a real
// deployment might use, not just genuine local dev. Allow-list instead,
// matching lib/platform/env.ts's isDevLikeEnv() (duplicated here rather
// than imported, to keep this file dependency-free — it's used from the
// very first line of relay server startup).
const DEV_LIKE_ENVS = new Set([undefined, 'development', 'test']);
const debugEnabled = process.env.RELAY_DEBUG_LOGS === 'true' || DEV_LIKE_ENVS.has(process.env.NODE_ENV);

const log = {
  /** Operational / informational output — OFF by default in production (see above). */
  debug: debugEnabled ? console.log.bind(console) : () => {},
  /** Warnings — always logged, but callers should avoid embedding relayId pairs here. */
  warn: console.warn.bind(console),
  /** Errors — always logged */
  error: console.error.bind(console),
};

module.exports = { log };
