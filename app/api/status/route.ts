import { NextRequest, NextResponse } from 'next/server';
import { connect } from 'net';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { getDb } from '@/lib/db/sqlite-client';
import pkg from '@/package.json';

// Node APIs (net.connect) are required for the relay reachability probe,
// so this route cannot run on the Edge runtime.
export const runtime = 'nodejs';

// Matches the RELAY_PORT convention server.js proxies WS upgrades to —
// see server.js's proxyToRelay(). A raw TCP connect is enough to prove the
// relay process is accepting connections without pulling in the ws client
// or touching server/relay-node.ts.
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '8080', 10);
// Host the relay is reachable at. In the single-process/dev/PM2 deployment
// this is 'localhost' (server.js proxies WS upgrades to RELAY_PORT on
// loopback). In the containerized docker-compose deployment the relay is a
// SEPARATE container, so compose sets RELAY_HOST=relay (the compose service
// name) on the app service — without it this probe would only ever test the
// app container's own loopback and report the (healthy) relay unreachable,
// which would fail the app's compose healthcheck forever.
const RELAY_HOST = process.env.RELAY_HOST || 'localhost';
const RELAY_CHECK_TIMEOUT_MS = 1500;

function checkRelayReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ port: RELAY_PORT, host: RELAY_HOST });

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(RELAY_CHECK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const DB_CHECK_TIMEOUT_MS = 1500;

// A fully-down DB layer (disk full, WAL corruption, lock wedged) previously
// went completely undetected here — this route only ever probed relay TCP
// reachability, so `ok: true` could be reported while every DB-backed route
// (login, signup, message delivery bookkeeping) was actually failing.
function checkDbReachable(): Promise<boolean> {
  return Promise.race([
    getDb()
      .then((db) => db.execute('SELECT 1'))
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), DB_CHECK_TIMEOUT_MS)),
  ]);
}

export async function GET(request: NextRequest) {
  const rateLimited = checkRateLimit(request, 'status', { maxRequests: 60, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const [relayReachable, dbReachable] = await Promise.all([
    checkRelayReachable(),
    checkDbReachable(),
  ]);

  return NextResponse.json({
    ok: relayReachable && dbReachable,
    relayReachable,
    dbReachable,
    // Uptime of this Next.js server process. server.js and the relay
    // process are started together by operators (see dev-server.sh /
    // process manager config) so this tracks overall deployment age
    // without needing a cross-process signal from relay-node.ts.
    uptimeSeconds: Math.floor(process.uptime()),
    version: pkg.version,
    timestamp: Date.now(),
  });
}
