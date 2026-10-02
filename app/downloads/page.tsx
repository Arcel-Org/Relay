'use client';

import Link from 'next/link';
import { Globe, Terminal, ShieldCheck, ArrowLeft, CheckCircle } from 'lucide-react';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';

const VERSION = '0.1.0';

const FACTS = [
  'No app stores, no installers, no signing keys — the web app is the product',
  'Same post-quantum encryption in every browser on every OS',
  'Works on desktop browsers and mobile browsers alike',
  'Self-host in one command with Docker Compose',
];

const DEPLOY_STEPS = [
  { cmd: 'cp .env.example .env', note: 'then edit .env: set NEXT_PUBLIC_RELAY_URL, WS_ALLOWED_ORIGINS, SESSION_SECRET, TOTP_ENCRYPTION_KEY' },
  { cmd: 'docker compose up -d --build', note: 'builds and starts the web app + relay + optional TURN in one shot' },
  { cmd: 'docker compose ps', note: 'both services healthy → you are live' },
];

export default function DownloadsPage() {
  return (
    <div className="mk-marketing">
      {/* Nav */}
      <header
        className="sticky top-0 z-40 backdrop-blur-md"
        style={{ background: 'color-mix(in srgb, var(--mk-bg) 80%, transparent)', borderBottom: '1px solid var(--mk-border)' }}
      >
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Wordmark />
            <span className="text-[10px] uppercase tracking-[0.25em]" style={{ color: 'var(--mk-text-3)' }}>Relay</span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link href="/" className="mk-btn-ghost hidden md:inline-flex">
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </Link>
            <ThemeToggle />
            <Link href="/auth/landing" className="mk-btn-primary ml-2">Sign in / Sign up</Link>
          </nav>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-6 pt-20 pb-32">
        {/* Header */}
        <div className="mb-16">
          <div className="mk-eyebrow mb-4">Web · v{VERSION}</div>
          <h1
            className="font-black tracking-tight leading-tight mb-6"
            style={{ fontSize: 'clamp(2.5rem, 5vw, 4rem)', color: 'var(--mk-text)' }}
          >
            Relay is a web app
          </h1>
          <p className="text-lg max-w-2xl" style={{ color: 'var(--mk-text-2)' }}>
            There is nothing to download. Open Relay in any modern browser — desktop or mobile —
            and sign in. Native desktop/mobile apps are not shipped; the web app is the only client.
          </p>
        </div>

        {/* What you get */}
        <div
          className="rounded-xl p-6 mb-12 border"
          style={{ background: 'var(--mk-bg-1)', borderColor: 'var(--mk-border)' }}
        >
          <div className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4" style={{ color: 'var(--mk-accent)' }}>
            Web, everywhere
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {FACTS.map((f) => (
              <div key={f} className="flex items-start gap-2 text-sm" style={{ color: 'var(--mk-text-2)' }}>
                <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--mk-accent)' }} />
                {f}
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-start gap-2 text-sm" style={{ color: 'var(--mk-text-2)' }}>
            <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--mk-accent)' }} />
            <span>
              Browser notifications and vibration are native web APIs — no push infrastructure,
              no telemetry, no Firebase.
            </span>
          </div>
        </div>

        {/* Self-host with Docker */}
        <div
          className="rounded-xl border p-6 mb-12"
          style={{ background: 'var(--mk-bg-1)', borderColor: 'var(--mk-border)' }}
        >
          <div className="text-[11px] uppercase tracking-[0.2em] font-bold mb-4" style={{ color: 'var(--mk-accent)' }}>
            <Terminal className="w-3.5 h-3.5 inline mr-1" /> Self-host your own relay
          </div>
          <p className="text-sm leading-relaxed mb-6" style={{ color: 'var(--mk-text-2)' }}>
            Relay is open source. The canonical deployment is Docker Compose — one command brings up
            the web app and the WebSocket relay together. Point the app at your own server and no
            third party ever touches your messages.
          </p>
          <div className="space-y-4">
            {DEPLOY_STEPS.map(({ cmd, note }, i) => (
              <div key={cmd} className="flex items-start gap-3">
                <span
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ background: 'var(--mk-bg-2)', color: 'var(--mk-accent)' }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <code
                    className="inline-block text-xs px-2.5 py-1.5 rounded font-mono mb-1"
                    style={{ background: 'var(--mk-bg-2)', color: 'var(--mk-text)' }}
                  >
                    {cmd}
                  </code>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--mk-text-3)' }}>{note}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs mt-6" style={{ color: 'var(--mk-text-3)' }}>
            Full deployment guide (TLS, reverse proxy, TURN for calls, backups, updates) in{' '}
            <code className="font-mono" style={{ color: 'var(--mk-accent)' }}>docs/DEPLOY.md</code>.
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--mk-border)', background: 'var(--mk-bg-1)' }}>
        <div className="max-w-4xl mx-auto px-6 py-8 flex justify-between items-center text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>© {new Date().getFullYear()} Arcel · Relay v{VERSION}</div>
          <Link href="/" style={{ color: 'var(--mk-text-3)' }}>← Back to home</Link>
        </div>
      </footer>
    </div>
  );
}
