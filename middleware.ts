import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isDevLikeEnv } from '@/lib/platform/env';

// CSRF defense-in-depth on top of the session cookie's SameSite=Strict
// attribute (the primary defense — see lib/db/server-session.ts). Strict
// already blocks the cross-site cases that matter for a same-site app with
// no third-party embeds, but it isn't a substitute for checking the request
// actually originated from this app: a misconfigured intermediary that
// drops/rewrites SameSite, or a non-browser HTTP client that ignores it
// entirely, would otherwise sail through. Any state-changing request to
// /api/* must carry an Origin (or, failing that, Referer) that matches this
// deployment's own origin. Browsers always send Origin on cross-origin AND
// same-origin fetch/form requests for non-safe methods, so a same-origin
// call from this app's own frontend is unaffected.
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Scheme-agnostic host (host + port) of an Origin/Referer URL. The app is
// commonly served behind a TLS-terminating proxy (nginx, Cloudflare tunnel)
// that forwards plain HTTP to this process, so the *scheme* the app sees
// (http) legitimately differs from what the browser sees (https). CSRF is
// about the request originating from a different *site* (host), not a
// different scheme, so comparing host:port — not the full origin — is both
// correct here and required for the proxy setup to work.
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function hasValidOrigin(request: NextRequest): boolean {
  if (CSRF_SAFE_METHODS.has(request.method)) return true;
  if (!request.nextUrl.pathname.startsWith('/api/')) return true;

  // The browser's Origin is compared against the Host header the request
  // actually arrived on. Using request.nextUrl.host is wrong here: Next.js
  // builds it from the process's own listen address (e.g. localhost:5555)
  // rather than the real Host header, so behind any reverse proxy / tunnel
  // it never matches a real client's Origin. The Host header is preserved
  // through nginx/Cloudflare-tunnel (it's what the browser dialed) and is
  // the correct CSRF reference for a proxied deployment.
  const selfHost = request.headers.get('host') || request.nextUrl.host;
  const origin = request.headers.get('origin');
  if (origin) return hostOf(origin) === selfHost;

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return hostOf(referer) === selfHost;
    } catch {
      return false;
    }
  }

  // Neither header present on a mutating request — a real browser request
  // (same-origin or not) always sends at least one of these.
  return false;
}

// Mirrors lib/db/server-session.ts's SESSION_COOKIE. Not imported from there
// directly — that module pulls in session-store.ts's Node-only fs/path/crypto
// imports, which aren't available in this file's Edge runtime.
const SESSION_COOKIE = 'relay_session';

// Routes that only make sense once logged in. This is a presence-only check
// (no DB round trip — the DB client is Node-only, and Edge middleware can't
// reach it) so it can't tell an expired/revoked cookie from a valid one;
// every actual API call and the WS handshake still independently re-verify
// the token server-side via requireSession(). What this closes is the
// architecturally wrong case: someone with NO session at all (a fresh
// visitor, an old bookmark, a stale tab after logout) landing on the real
// app shell before client-side JS has a chance to redirect them away, or —
// for /vault/settings specifically — not being redirected at all (see its
// page component, which had no auth guard whatsoever before this).
const AUTHED_ROUTE_PREFIXES = ['/app', '/vault'];

function requiresSession(pathname: string): boolean {
  return AUTHED_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(request: NextRequest) {
  if (!hasValidOrigin(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }

  if (requiresSession(request.nextUrl.pathname) && !request.cookies.get(SESSION_COOKIE)) {
    const loginUrl = new URL('/auth/login', request.nextUrl.origin);
    return NextResponse.redirect(loginUrl);
  }

  // Generate a per-request nonce for CSP — allows specific inline scripts
  // without blanket 'unsafe-inline'. Next.js reads x-nonce to inject the
  // nonce attribute onto its own inline <script> tags.
  // Use Web Crypto (available in Edge Runtime); Node crypto is not.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = btoa(String.fromCharCode(...nonceBytes));
  const response = NextResponse.next({
    request: { headers: new Headers({ ...Object.fromEntries(request.headers), 'x-nonce': nonce }) },
  });

  // Strict Transport Security — enforce HTTPS for 1 year + subdomains.
  // Skipped only in explicit local dev to avoid SSL errors on HTTP dev
  // servers; browsers ignore this header over plain HTTP anyway, so
  // defaulting to "on" for any non-development env is safe.
  if (!isDevLikeEnv()) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking
  response.headers.set('X-Frame-Options', 'DENY');

  // XSS filter (legacy browsers)
  response.headers.set('X-XSS-Protection', '1; mode=block');

  // Referrer policy — only send origin on cross-origin
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy — disable unused browser features
  response.headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()'
  );

  // Content Security Policy
  // F3: Use nonce-based script-src to eliminate 'unsafe-inline'.
  // 'strict-dynamic' allows scripts loaded by trusted nonce'd scripts (Next.js
  // chunks) without listing each origin explicitly.
  // 'unsafe-eval' is still required in dev for HMR.
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Restrict outbound connections to self + relay server only.
    // NEXT_PUBLIC_RELAY_URL should be set in production (e.g. wss://relay.arcel.org).
    // Fall back to allowing all WS origins only in dev — never ship without the env var.
    `connect-src 'self' ${process.env.NEXT_PUBLIC_RELAY_URL ?? (isDev ? 'ws: wss:' : '')}`.trimEnd(),
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);
  // Do NOT echo the nonce in the response — the layout reads it from the
  // forwarded request headers server-side. Exposing it in the response
  // headers would let scripts or CDN caches observe the nonce value.

  // API responses must never be cached by an intermediary CDN/proxy
  // (Cloudflare in particular). Most routes here are session-authenticated
  // mutations or auth flows (login, signup, profile updates, WS tickets) —
  // if a Cloudflare "Cache Everything" rule or an overly broad Page Rule
  // ever gets applied to this origin, caching one user's 200 response and
  // serving it to the next visitor at the same URL would leak session data
  // across users. Setting this explicitly at the origin means correctness
  // doesn't depend on the operator remembering a Cloudflare dashboard
  // setting — see docs/DEPLOY.md's Cloudflare section for the recommended
  // Cache Rule as defense-in-depth on top of this header.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('Cache-Control', 'no-store');
  }

  return response;
}

export const config = {
  matcher: [
    // Apply to all routes except static files and _next internals
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
