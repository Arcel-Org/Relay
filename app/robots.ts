import type { MetadataRoute } from 'next';

/**
 * Without this, crawlers had no guidance at all — free to attempt indexing
 * authenticated app routes, the API surface, or mid-flow auth/setup pages,
 * none of which are meant to appear in search results (and hitting /api/*
 * repeatedly is just wasted load, on top of counting against per-IP rate
 * limits meant for real clients). Everything under the marketing/legal
 * surface (/, /legal/*, /security, /downloads) is fine to index; everything
 * else is explicitly disallowed rather than relying on an allowlist, so a
 * newly added route defaults to "don't index" until deliberately opened up.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      disallow: ['/app/', '/api/', '/vault/', '/auth/', '/setup/', '/status', '/login'],
    },
  };
}
