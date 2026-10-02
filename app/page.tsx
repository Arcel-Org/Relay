'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Lock,
  KeyRound,
  EyeOff,
  ShieldCheck,
  Server,
  Flame,
  ArrowRight,
  Network,
  Hash,
  Trash2,
  Download,
  Monitor,
  Smartphone,
  Atom,
} from 'lucide-react';
import { useRelayAuthStoreV2, useInitializeAuthV2 } from '@/lib/crypto/relay-auth-store-v2';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';

export default function Home() {
  const router = useRouter();
  const { flow } = useRelayAuthStoreV2();
  const [ready, setReady] = useState(false);

  useInitializeAuthV2();

  useEffect(() => {
    const t = setTimeout(() => {
      const state = useRelayAuthStoreV2.getState();
      if (state.flow === 'authenticated') {
        router.replace('/app');
      } else {
        setReady(true);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [router, flow]);

  if (!ready) {
    return (
      <div className="mk-marketing flex items-center justify-center min-h-screen">
        <div className="logo-searching">
          <Wordmark className="text-3xl" />
        </div>
      </div>
    );
  }

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
            <Link href="/security" className="mk-btn-ghost hidden md:inline-flex">Security</Link>
            <Link href="/legal/transparency" className="mk-btn-ghost hidden md:inline-flex">Transparency</Link>
            <Link href="/legal/canary" className="mk-btn-ghost hidden md:inline-flex">Canary</Link>
            <Link href="/status" className="mk-btn-ghost hidden md:inline-flex">Status</Link>
            <Link href="/downloads" className="mk-btn-ghost hidden md:inline-flex">
              <Download className="w-3.5 h-3.5" />
              Downloads
            </Link>
            <ThemeToggle />
            <Link href="/auth/landing" className="mk-btn-primary ml-2">Sign in / Sign up</Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-28">
        <div className="max-w-3xl">
          <div className="mk-eyebrow mb-6">Arcel · Relay · v1</div>
          <h1
            className="font-black tracking-tight leading-[0.95] mb-8"
            style={{ fontSize: 'clamp(2.75rem, 6vw, 5.5rem)', color: 'var(--mk-text)' }}
          >
            Messages that<br />
            belong to <span style={{ color: 'var(--mk-accent)' }}>no one</span><br />
            but you.
          </h1>
          <p className="text-lg md:text-xl max-w-2xl mb-10 leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>
            A zero-knowledge relay. Ciphertext routes through our servers for twenty minutes, then is forgotten. Your keys never leave your device. No email. No phone. No profile for anyone to subpoena.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/auth/landing" className="mk-btn-primary">
              Create account
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
            <Link href="/downloads" className="mk-btn-secondary flex items-center gap-2">
              <Download className="w-3.5 h-3.5" />
              Download desktop app
            </Link>
            <Link href="/legal/privacy" className="mk-btn-ghost">Privacy policy</Link>
          </div>
          <p className="mt-6 text-xs uppercase tracking-[0.15em]" style={{ color: 'var(--mk-text-4)' }}>
            Free to create an account · No invite needed · Never a subscription
          </p>
        </div>
      </section>

      {/* Stat strip */}
      <section style={{ borderTop: '1px solid var(--mk-border)', borderBottom: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 divide-x" style={{ borderColor: 'var(--mk-border)' }}>
          {[
            { k: '20 min', v: 'Message TTL' },
            { k: 'Zero', v: 'Content stored' },
            { k: '30 min', v: 'IP retention' },
            { k: 'Finland', v: 'Server location' },
          ].map((s, i) => (
            <div
              key={s.v}
              className="py-8 px-4 text-center"
              style={{ borderLeft: i === 0 ? 'none' : '1px solid var(--mk-border)' }}
            >
              <div className="text-3xl md:text-4xl font-black tracking-tight" style={{ color: 'var(--mk-accent)' }}>{s.k}</div>
              <div className="mt-2 text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--mk-text-3)' }}>{s.v}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Principles */}
      <section className="max-w-6xl mx-auto px-6 py-28">
        <div className="max-w-2xl mb-16">
          <div className="mk-eyebrow mb-4">Principles</div>
          <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
            The things we refuse to do.
          </h2>
          <p className="mt-6 text-base md:text-lg" style={{ color: 'var(--mk-text-2)' }}>
            Most messengers list features. Here&apos;s what isn&apos;t in Arcel — on purpose, enforced in code, audited in public.
          </p>
        </div>
        <div className="grid md:grid-cols-2 gap-px" style={{ background: 'var(--mk-border)' }}>
          {[
            { icon: EyeOff, title: 'No content scanning', body: 'We cannot read your messages. There is no server-side AI, no keyword matching, no image hashing. The code that would let us do so does not exist in this repository.' },
            { icon: KeyRound, title: 'No key escrow', body: 'Your private key is generated on your device, encrypted with your PIN and a TOTP-derived secret, and never transmitted. We could not decrypt your messages if a court ordered us to.' },
            { icon: Server, title: 'No metadata persistence', body: 'We do not store who messaged whom. Message queues live in memory with a 20-minute TTL. IP addresses are salted-hashed and rotated out of memory within 30 minutes.' },
            { icon: Flame, title: 'No email, no phone, no name', body: 'Accounts are cryptographic identities. Signup is free — no invite code, no payment. Lose your recovery phrase and the account is gone forever — by design.' },
            { icon: Lock, title: 'No tracking, no analytics', body: 'No Google Analytics, no Segment, no Sentry uploads with user content, no cookies beyond the session. Open your browser&apos;s network tab. Everything Arcel does is in it.' },
            { icon: ShieldCheck, title: 'No silent changes', body: 'The warrant canary is refreshed monthly. If it stops, assume compromise.' },
            { icon: Atom, title: 'No trust in tomorrow\'s computer', body: 'Every key exchange is hybrid X25519 + ML-KEM768 (post-quantum). Ciphertext intercepted today and stored for a future quantum computer to crack later — harvest-now, decrypt-later — still isn\'t enough on its own.' },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="p-8" style={{ background: 'var(--mk-bg)' }}>
              <Icon className="w-5 h-5 mb-5" style={{ color: 'var(--mk-accent)' }} />
              <h3 className="text-lg font-bold mb-3" style={{ color: 'var(--mk-text)' }}>{title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-28">
          <div className="max-w-2xl mb-16">
            <div className="mk-eyebrow mb-4">Protocol</div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
              How a message travels.
            </h2>
          </div>
          <div className="space-y-px" style={{ background: 'var(--mk-border)' }}>
            {[
              { n: '01', icon: Lock, title: 'Your device encrypts', body: 'A hybrid X25519 + ML-KEM768 (post-quantum) key exchange establishes a shared secret with your recipient, then a forward-secret ratchet derives a fresh key for every message. ChaCha20-Poly1305 seals it. Only ciphertext leaves your device.' },
              { n: '02', icon: Network, title: 'Our relay routes', body: 'Ciphertext arrives at our Finland relay over WebSocket. We see: the recipient\'s Relay ID, the approximate size, the timestamp. Neither the content nor any sender identity beyond a cryptographic handle.' },
              { n: '03', icon: Hash, title: 'Recipient decrypts', body: 'If the recipient is online, delivery is instant and the ciphertext is evicted from memory. If offline, it holds for up to 20 minutes, then is destroyed — delivered or not.' },
              { n: '04', icon: Trash2, title: 'Nothing remains', body: 'There is no archive. No backup. No deleted-messages folder a warrant could unearth. The data existed for minutes and now does not.' },
            ].map(({ n, icon: Icon, title, body }) => (
              <div key={n} className="grid md:grid-cols-[auto_auto_1fr] gap-8 items-start p-8" style={{ background: 'var(--mk-bg)' }}>
                <div className="font-mono text-2xl font-black w-12" style={{ color: 'var(--mk-accent)' }}>{n}</div>
                <Icon className="w-5 h-5 mt-1" style={{ color: 'var(--mk-text-3)' }} />
                <div>
                  <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--mk-text)' }}>{title}</h3>
                  <p className="text-sm leading-relaxed max-w-2xl" style={{ color: 'var(--mk-text-2)' }}>{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Threat model */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-28">
          <div className="max-w-2xl mb-16">
            <div className="mk-eyebrow mb-4">Threat model</div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
              What we protect against.<br />
              <span style={{ color: 'var(--mk-text-3)' }}>What we don&apos;t.</span>
            </h2>
            <p className="mt-6 text-base" style={{ color: 'var(--mk-text-2)' }}>Honesty before marketing.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-px" style={{ background: 'var(--mk-border)' }}>
            <div className="p-8 mk-card-accent" style={{ background: 'var(--mk-bg)', borderLeftColor: 'var(--mk-success)' }}>
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold mb-6" style={{ color: 'var(--mk-success)' }}>In scope</div>
              <ul className="space-y-4 text-sm" style={{ color: 'var(--mk-text-2)' }}>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-success)' }}>→</span><span>Passive network observation — ISPs, Wi-Fi snoops, Cloudflare middleboxes</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-success)' }}>→</span><span>Server compromise — we have nothing to leak</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-success)' }}>→</span><span>Subpoenas for message content — we cannot comply with what we don&apos;t have</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-success)' }}>→</span><span>Phishing of recovery data — nothing to phish server-side</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-success)' }}>→</span><span>Mass surveillance dragnets</span></li>
              </ul>
            </div>
            <div className="p-8 mk-card-accent" style={{ background: 'var(--mk-bg)', borderLeftColor: 'var(--mk-accent)' }}>
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold mb-6" style={{ color: 'var(--mk-accent)' }}>Out of scope</div>
              <ul className="space-y-4 text-sm" style={{ color: 'var(--mk-text-2)' }}>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-accent)' }}>→</span><span>A compromised device — keylogger, stolen unlocked phone</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-accent)' }}>→</span><span>Someone looking over your shoulder</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-accent)' }}>→</span><span>The person you trusted with your messages sharing them</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-accent)' }}>→</span><span>Targeted nation-state attacks on your endpoint</span></li>
                <li className="flex gap-3"><span style={{ color: 'var(--mk-accent)' }}>→</span><span>You losing your recovery phrase</span></li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Abuse stance */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-4xl mx-auto px-6 py-28">
          <div className="mk-eyebrow mb-4">On abuse</div>
          <h2 className="text-3xl md:text-4xl font-black tracking-tight leading-tight mb-6" style={{ color: 'var(--mk-text)' }}>
            Privacy is not a loophole.
          </h2>
          <div className="space-y-4 text-base leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>
            <p>
              Arcel is built for journalists, domestic violence survivors, political dissidents, protest organizers, security researchers and incident responders handling sensitive disclosures, and ordinary people who want a conversation that isn&apos;t mined for ads. It is not a haven.
            </p>
            <p>
              If a contact is sending you child sexual abuse material, or making a credible imminent threat of violence, you can report their Relay ID directly from their profile. An operator reviews and acts on it. We cannot and will not proactively scan your conversations. We will act decisively on what users bring to us.
            </p>
          </div>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/legal/terms" className="mk-btn-secondary">Terms of Service</Link>
            <Link href="/legal/transparency" className="mk-btn-secondary">Transparency report</Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-4xl mx-auto px-6 py-28 text-center">
          <h2 className="text-5xl md:text-6xl font-black tracking-tight leading-[1.05] mb-8" style={{ color: 'var(--mk-text)' }}>
            Take your conversations<br />
            <span style={{ color: 'var(--mk-accent)' }}>back.</span>
          </h2>
          <p className="text-lg mb-10 max-w-xl mx-auto" style={{ color: 'var(--mk-text-2)' }}>
            Two minutes from first click to first message. No phone number. No email. No regret.
          </p>
          <Link href="/auth/landing" className="mk-btn-primary text-sm px-10 py-4">
            Create your account
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--mk-border)', background: 'var(--mk-bg-1)' }}>
        <div className="max-w-6xl mx-auto px-6 py-16 grid md:grid-cols-4 gap-10">
          <div>
            <div className="mb-5">
              <Wordmark />
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--mk-text-3)' }}>
              Zero-knowledge relay messaging. Built for people who need their conversations to stay theirs.
            </p>
          </div>
          {[
            {
              title: 'Legal',
              items: [
                { label: 'Terms of Service', href: '/legal/terms' },
                { label: 'Privacy Policy', href: '/legal/privacy' },
                { label: 'Security architecture', href: '/security' },
                { label: 'Warrant canary', href: '/legal/canary' },
                { label: 'Transparency report', href: '/legal/transparency' },
              ],
            },
            {
              title: 'Product',
              items: [
                { label: 'Sign up', href: '/auth/signup' },
                { label: 'Sign in', href: '/auth/login' },
                { label: 'Downloads', href: '/downloads' },
              ],
            },
          ].map((col) => (
            <div key={col.title}>
              <div className="text-[10px] uppercase tracking-[0.25em] font-bold mb-4" style={{ color: 'var(--mk-text-3)' }}>{col.title}</div>
              <ul className="space-y-2 text-sm">
                {col.items.map((it) => (
                  <li key={it.href}>
                    <Link href={it.href} className="transition-colors" style={{ color: 'var(--mk-text-2)' }}>
                      {it.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] font-bold mb-4" style={{ color: 'var(--mk-text-3)' }}>Principles</div>
            <ul className="space-y-2 text-xs leading-relaxed" style={{ color: 'var(--mk-text-4)' }}>
              <li>Messages: 20-minute TTL in memory, never written to disk.</li>
              <li>Identity: cryptographic only. No email, no phone.</li>
              <li>Analytics: none.</li>
            </ul>
          </div>
        </div>
        <div className="max-w-6xl mx-auto px-6 pb-10 flex justify-between text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>© {new Date().getFullYear()} Arcel · Relay infrastructure operated from Finland.</div>
          <div className="uppercase tracking-[0.2em]">Built for the people</div>
        </div>
      </footer>
    </div>
  );
}
