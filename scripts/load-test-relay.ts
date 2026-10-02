/**
 * Basic connection-capacity load test for the relay WebSocket server.
 *
 * Opens many concurrent raw WebSocket connections and measures how many the
 * relay/OS actually accept, ramping up over time rather than all at once —
 * a real-world MAX_WS_CONNECTIONS/ulimit ceiling (see docs/DEPLOY.md §2 and
 * §5) has never had even a first real data point before this: is the
 * configured ulimit (65536 in docker-compose.yml/PM2 docs) actually
 * sufficient before MAX_WS_CONNECTIONS (default 10000) is reached, or does
 * something else fail first?
 *
 * Deliberately does NOT complete relay-node.ts's 'hello' handshake (which
 * requires a real signed session ticket from a real logged-in account —
 * exercising that at scale would mean creating thousands of real accounts
 * first, a heavier and different test). This measures raw WS
 * connection-accept capacity: TCP + TLS (if wss://) + WebSocket upgrade,
 * which is exactly what holds a file descriptor per DEPLOY.md's own ulimit
 * reasoning, whether or not 'hello' ever completes. A connection that never
 * sends 'hello' is intentionally never a no-op on the relay's side either:
 * relay-node.ts closes any socket that hasn't said 'hello' within 30s, so
 * this script's HOLD_MS should be kept under that if the goal is measuring
 * pure connection-accept capacity without also exercising that timeout path
 * (or set it above 30s deliberately to ALSO test that cleanup path at scale
 * — both are valid things to want to measure, so this is left in your
 * control rather than picking one silently).
 *
 * Usage:
 *   RELAY_URL=ws://localhost:8080 CONNECTIONS=2000 npm run load-test:relay
 *
 * Env vars (all optional):
 *   RELAY_URL     ws:// or wss:// URL of the relay          (default ws://localhost:8080)
 *   CONNECTIONS   total concurrent connections to attempt   (default 500)
 *   RAMP_MS       time to spread all connection attempts over, not instant (default 10000)
 *   HOLD_MS       how long to keep successful connections open before closing (default 15000)
 */
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:8080';
const CONNECTIONS = parseInt(process.env.CONNECTIONS || '500', 10);
const RAMP_MS = parseInt(process.env.RAMP_MS || '10000', 10);
const HOLD_MS = parseInt(process.env.HOLD_MS || '15000', 10);

interface ConnResult {
  index: number;
  openedAtMs: number | null;
  closedCode: number | null;
  closedReason: string | null;
  erroredBeforeOpen: boolean;
}

function openOne(index: number, startedAt: number): Promise<ConnResult> {
  return new Promise((resolve) => {
    const result: ConnResult = {
      index,
      openedAtMs: null,
      closedCode: null,
      closedReason: null,
      erroredBeforeOpen: false,
    };
    // No Origin header — matches how relay-node.ts treats a native (non-
    // browser) client: Origin absent skips the allow-list check entirely
    // (see relay-node.ts's own comment on this), so this doesn't need to
    // know WS_ALLOWED_ORIGINS to connect.
    const ws = new WebSocket(RELAY_URL);
    let settled = false;

    ws.on('open', () => {
      result.openedAtMs = Date.now() - startedAt;
    });

    ws.on('close', (code, reason) => {
      result.closedCode = code;
      result.closedReason = reason.toString();
      if (!settled) {
        settled = true;
        resolve(result);
      }
    });

    ws.on('error', () => {
      if (result.openedAtMs === null) result.erroredBeforeOpen = true;
      // 'close' still fires after 'error' for ws — don't resolve here,
      // let 'close' be the single source of truth for this connection's
      // final outcome.
    });

    // Track this connection so the teardown pass below can close it.
    openSockets.push(ws);
    pendingResolvers.push(resolve);
  });
}

const openSockets: WebSocket[] = [];
const pendingResolvers: Array<(r: ConnResult) => void> = [];

async function main() {
  console.log(`Load test: ${CONNECTIONS} connections to ${RELAY_URL}, ramped over ${RAMP_MS}ms, held for ${HOLD_MS}ms`);

  const startedAt = Date.now();
  const resultPromises: Promise<ConnResult>[] = [];
  const delayBetween = RAMP_MS / Math.max(CONNECTIONS, 1);

  for (let i = 0; i < CONNECTIONS; i++) {
    resultPromises.push(openOne(i, startedAt));
    if (delayBetween > 0) {
      await new Promise((r) => setTimeout(r, delayBetween));
    }
  }

  console.log(`All ${CONNECTIONS} connection attempts issued after ${Date.now() - startedAt}ms. Holding for ${HOLD_MS}ms...`);
  await new Promise((r) => setTimeout(r, HOLD_MS));

  const stillOpenCount = openSockets.filter((ws) => ws.readyState === WebSocket.OPEN).length;
  console.log(`Closing ${stillOpenCount} still-open connections...`);
  for (const ws of openSockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'load test complete');
    }
  }

  const results = await Promise.all(resultPromises);

  const opened = results.filter((r) => r.openedAtMs !== null);
  const neverOpened = results.filter((r) => r.openedAtMs === null);
  const capacityRejected = results.filter((r) => r.closedCode === 1013);
  const openTimes = opened.map((r) => r.openedAtMs as number).sort((a, b) => a - b);

  console.log('\n=== Results ===');
  console.log(`Attempted:        ${CONNECTIONS}`);
  console.log(`Opened:           ${opened.length}`);
  console.log(`Never opened:     ${neverOpened.length}`);
  console.log(`Capacity-rejected (close code 1013, "Server at capacity"): ${capacityRejected.length}`);
  if (openTimes.length > 0) {
    const p50 = openTimes[Math.floor(openTimes.length * 0.5)];
    const p99 = openTimes[Math.floor(openTimes.length * 0.99)];
    console.log(`Time-to-open:     min=${openTimes[0]}ms p50=${p50}ms p99=${p99}ms max=${openTimes[openTimes.length - 1]}ms`);
  }
  if (neverOpened.length > 0) {
    const closeCodeCounts = new Map<string, number>();
    for (const r of neverOpened) {
      const key = `${r.closedCode ?? 'no-close-event'} ${r.closedReason ?? ''}`.trim();
      closeCodeCounts.set(key, (closeCodeCounts.get(key) || 0) + 1);
    }
    console.log('Never-opened breakdown (close code + reason -> count):');
    for (const [key, count] of closeCodeCounts) {
      console.log(`  ${key}: ${count}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
