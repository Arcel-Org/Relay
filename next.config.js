const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't expose the tech stack to attackers
  poweredByHeader: false,
  // Standalone output is only for production builds (Docker).
  // Setting it in dev mode breaks chunk generation and HMR.
  output: process.env.NODE_ENV === 'production' ? 'standalone' : undefined,
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  // Allow dev-time access from LAN devices (e.g. http://10.0.1.12:3000).
  // Required by Next.js in a future major version — silences the warning now.
  // Gated the same way `output: 'standalone'` above is: this key has no
  // effect once `next start`/standalone serves the app today, but leaving
  // it unconditional means a future Next.js version that widens what
  // allowedDevOrigins affects — or someone copying this pattern to a
  // setting that does apply in prod — would ship the wildcard `*.local`
  // and this LAN IP to production with nothing here to catch it.
  allowedDevOrigins: process.env.NODE_ENV === 'production' ? undefined : ['10.0.1.12', '10.9.0.1', '*.local'],
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-XSS-Protection', value: '1; mode=block' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
}

module.exports = withBundleAnalyzer(nextConfig)
