import { NextResponse } from 'next/server';

// Deliberately has zero dependencies (no DB, no auth) — this is what an
// orchestrator/load balancer should hit to check the Next.js process itself
// is up and serving, not whether the whole stack is healthy.
export function GET() {
  return NextResponse.json({ ok: true });
}
