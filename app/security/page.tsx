import Link from 'next/link';
import {
  Lock,
  KeyRound,
  EyeOff,
  ShieldCheck,
  Server,
  Atom,
  Network,
  Hash,
  Trash2,
  ArrowRight,
  Database,
  Clock,
  CircleCheck,
  XCircle,
  Ban,
  ShieldAlert,
  FingerprintPattern,
  Download,
  Users,
  Radio,
} from 'lucide-react';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';

export const metadata = {
  title: 'Security Architecture — Arcel',
  description: 'How Arcel actually protects you, compared step by step against how most messaging apps work — every mechanism, every honest limitation, grounded in the real code.',
};

interface FlowStep {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail: string;
  sees: string;
}

const TYPICAL_STEPS: FlowStep[] = [
  {
    icon: Lock,
    title: 'You send a message',
    detail: 'Your device opens an encrypted connection (TLS) to the service’s server. That connection protects the message in transit.',
    sees: 'Nothing yet — just an encrypted pipe to the server.',
  },
  {
    icon: Server,
    title: 'The server receives it',
    detail: 'For most messaging services, TLS ends at the server, and the server itself can read the message as plain text at that point — that’s how the service is built to work, even if it doesn’t always choose to look.',
    sees: 'The full message content, unencrypted, at least momentarily.',
  },
  {
    icon: Database,
    title: 'It gets stored',
    detail: 'Message content and full sender/recipient/timestamp metadata are typically written to a database, often kept for as long as the account exists, or longer for backups.',
    sees: 'Message content plus full metadata, often indefinitely.',
  },
  {
    icon: EyeOff,
    title: 'It can be processed',
    detail: 'Because the plaintext is available server-side, it can be run through spam filters, moderation systems, ranking, or ad targeting — whatever the operator has built, whenever they choose to run it.',
    sees: 'Whatever the operator decides to point at it.',
  },
  {
    icon: ArrowRight,
    title: 'Delivered',
    detail: 'The recipient receives it over another encrypted connection.',
    sees: 'A record already exists on the server, independent of delivery.',
  },
];

const ARCEL_STEPS: FlowStep[] = [
  {
    icon: KeyRound,
    title: 'You send a message',
    detail: 'Your device already encrypted this message specifically for your recipient — using a hybrid post-quantum + classical key exchange and a forward-secret ratchet — before it ever touches the network.',
    sees: 'Nothing — the ciphertext is sealed before it leaves your device.',
  },
  {
    icon: Network,
    title: 'Our relay receives it',
    detail: 'The relay gets an opaque encrypted blob. It holds no key that could decrypt it — not because it chooses not to, but because the key never exists anywhere but on your and your recipient’s devices.',
    sees: 'Ciphertext, plus routing metadata (from/to Relay ID, size, timestamp). Never content.',
  },
  {
    icon: Clock,
    title: 'Delivered, or held briefly',
    detail: 'Online recipients get it instantly. Offline, it waits in memory — never written to any database — for up to 20 minutes, then is destroyed whether or not it was ever delivered.',
    sees: 'The same opaque blob, briefly, in RAM only.',
  },
  {
    icon: Ban,
    title: 'Nothing to process',
    detail: 'There is no plaintext anywhere on the server for any system — ours or a third party’s — to scan, rank, or moderate against. Not a policy choice; a technical impossibility.',
    sees: 'Nothing. There is nothing there to look at.',
  },
  {
    icon: Trash2,
    title: 'Delivered, then gone',
    detail: 'Your recipient’s device decrypts it with keys that never left their device. The server’s copy is already gone.',
    sees: 'No record remains on the server, delivered or not.',
  },
];

function FlowColumn({ heading, tone, steps }: { heading: string; tone: 'warn' | 'good'; steps: FlowStep[] }) {
  const accentVar = tone === 'good' ? 'var(--mk-success)' : 'var(--mk-accent)';
  return (
    <div>
      <div
        className="text-[11px] uppercase tracking-[0.2em] font-bold mb-6 pb-3"
        style={{ color: accentVar, borderBottom: `2px solid ${accentVar}` }}
      >
        {heading}
      </div>
      <div className="relative pl-8" style={{ borderLeft: `2px solid var(--mk-border)` }}>
        {steps.map((step, i) => (
          <div key={step.title} className={i < steps.length - 1 ? 'pb-8 relative' : 'relative'}>
            <div
              className="absolute flex items-center justify-center rounded-full"
              style={{
                left: '-2.55rem',
                top: 0,
                width: '2rem',
                height: '2rem',
                background: 'var(--mk-bg)',
                border: `2px solid ${accentVar}`,
                color: accentVar,
              }}
            >
              <step.icon className="w-3.5 h-3.5" />
            </div>
            <h4 className="text-sm font-bold mb-1.5" style={{ color: 'var(--mk-text)' }}>{step.title}</h4>
            <p className="text-sm leading-relaxed mb-2" style={{ color: 'var(--mk-text-2)' }}>{step.detail}</p>
            <div
              className="inline-flex items-start gap-1.5 text-xs px-2.5 py-1.5 rounded"
              style={{
                background: tone === 'good' ? 'color-mix(in srgb, var(--mk-success) 10%, transparent)' : 'var(--mk-accent-dim)',
                color: accentVar,
              }}
            >
              {tone === 'good' ? <CircleCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
              <span><strong>Server sees:</strong> {step.sees}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Mechanism {
  n: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  title: string;
  intro: string;
  technical: string[];
  caveat?: string;
}

const MECHANISMS: Mechanism[] = [
  {
    n: '01',
    icon: Lock,
    title: 'Message encryption — a forward-secret ratchet',
    intro: 'Every conversation has its own session with two one-way key chains — one for sending, one for receiving. Each message derives a brand-new key and destroys the one before it, so a compromise of your current key material can never reach backward into messages already sent.',
    technical: [
      'A root key is derived once, at session establishment, from the hybrid key exchange (see mechanism 02).',
      'Each send/receive runs HKDF-SHA256 over the current chain key to produce a one-time message key and a new chain key.',
      'The prior chain key is discarded immediately — there is no operation that can reconstruct it from the new one.',
      'The message itself is sealed with ChaCha20-Poly1305 (authenticated encryption — tampering is detected, not just hidden).',
      'Out-of-order delivery is tolerated by caching a bounded number of skipped message keys (up to 2,000), each usable exactly once, then discarded.',
    ],
    caveat: 'This is a one-way ratchet seeded once by a key exchange at session start — not a continuous Diffie-Hellman ratchet on every message. Forward secrecy (past messages stay safe) is strong; full self-healing from an actively compromised device only happens when a new session is established, not automatically message-by-message.',
  },
  {
    n: '02',
    icon: Atom,
    title: 'Key exchange — hybrid post-quantum + classical',
    intro: 'Starting a conversation runs a hybrid key exchange combining classical elliptic-curve Diffie-Hellman (X25519) with ML-KEM768, a post-quantum key encapsulation mechanism standardized by NIST. An attacker has to break both problems, not just one, to recover the session.',
    technical: [
      'X25519 ECDH and ML-KEM768 encapsulation both run independently; their outputs are concatenated.',
      'The combined secret is passed through HKDF-SHA256 to derive the session root key — breaking either primitive alone yields nothing usable.',
      'The negotiated suite identifier and both parties’ identity keys are bound into that derivation, so an asymmetric downgrade attempt (tricking one side into classical-only) makes the two sides derive different keys — the session fails outright instead of silently weakening.',
    ],
    caveat: 'This binding stops an asymmetric downgrade. It doesn’t yet fully close the case of two people’s very first contact, where an attacker intercepts and strips post-quantum support from both sides at once before either has learned the other’s post-quantum key. Closing that requires binding post-quantum capability to verified identity — today, safety-number verification (mechanism 08) is the real defense against that specific scenario.',
  },
  {
    n: '03',
    icon: KeyRound,
    title: 'Identity — cryptographic, not personal',
    intro: 'Your Relay ID is derived mathematically from your public key, not assigned by a server or looked up from a username table. Anyone can independently verify a Relay ID matches a given public key without asking us.',
    technical: [
      'Relay ID = the first 128 bits of SHA-256(your public key), hex-encoded and grouped for readability.',
      'Both keypairs — the classical X25519 pair and the post-quantum ML-KEM768 pair — are generated entirely on your device.',
      'Signup transmits only your public keys to the server. The private keys never leave the device that generated them, encrypted or otherwise.',
    ],
  },
  {
    n: '04',
    icon: Lock,
    title: 'What protects your keys on your device',
    intro: 'Your local private keys are encrypted at rest under a key derived from your PIN — the PIN itself is never stored anywhere.',
    technical: [
      'PBKDF2-SHA256 with 200,000 iterations, combined with a per-device value, derives the local encryption key from your PIN.',
      'Private keys are encrypted with XChaCha20-Poly1305 (24-byte random nonce) before being written to local storage.',
    ],
    caveat: '200,000 PBKDF2 iterations is a real, deliberate barrier — not an unbreakable one. A short numeric PIN is still weaker than a long passphrase against someone with a copy of your encrypted data and enough compute time. Use a longer PIN if your threat model includes physical device or backup compromise.',
  },
  {
    n: '05',
    icon: ShieldCheck,
    title: 'Two-factor authentication',
    intro: 'Arcel supports both TOTP (standard authenticator-app codes) and WebAuthn/FIDO2 hardware security keys.',
    technical: [
      'TOTP secrets are encrypted at rest server-side with AES-256-GCM, under a key kept separate from the database itself — a database leak alone can’t forge a login.',
      'WebAuthn logins check the hardware key’s signature counter on every login; if the counter fails to advance, login is rejected as a possible cloned authenticator.',
    ],
    caveat: 'Unlike your message-encryption keys, the server necessarily holds a decryptable copy of your TOTP secret — required to check a code you type in. It’s encrypted at rest, not zero-knowledge: a full compromise of both the database and the running server’s environment could expose it. WebAuthn doesn’t have this limitation — its private key never leaves your hardware key.',
  },
  {
    n: '06',
    icon: ShieldAlert,
    title: 'Duress PIN and panic wipe',
    intro: 'A second, decoy PIN you can set: entering it looks exactly like a normal login, but silently and permanently wipes the account and all local data instead.',
    technical: [
      'Five consecutive wrong guesses at your real PIN triggers the identical full wipe.',
      'The decoy-PIN check and the real-PIN check run concurrently, not sequentially — so timing alone can’t reveal which one fired.',
      'The on-screen “attempts remaining” warning deliberately stops updating right before a wipe would trigger, so a genuine last attempt and the decoy are indistinguishable to anyone watching.',
    ],
    caveat: 'Opt-in, and local to the device it’s set on — it doesn’t protect other devices already logged into the same account.',
  },
  {
    n: '07',
    icon: Network,
    title: 'Session security',
    intro: 'Logging in issues a random 256-bit token — not a self-describing signed token like a JWT.',
    technical: [
      'The server stores only a hash of the token, and verifies every request against actually-issued sessions.',
      'A leaked signing secret alone cannot forge a login — there is no secret a valid session is mathematically derived from.',
      'Sessions can be revoked instantly (e.g. on account deletion); a revoked or expired session is rejected immediately, not trusted until an embedded expiry is reached.',
    ],
  },
  {
    n: '08',
    icon: FingerprintPattern,
    title: 'Verifying who you’re talking to',
    intro: 'Every contact’s profile shows a fingerprint — a hash of their public key, formatted for comparison.',
    technical: [
      'Verify this fingerprint with someone through a channel you both trust — in person, a phone call, another app — and you can be confident the person you’re messaging controls the key you think they do, independent of anything our servers tell either of you.',
    ],
  },
  {
    n: '09',
    icon: Hash,
    title: 'Rate limiting and abuse protection',
    intro: 'Requests are rate-limited per client without us storing your IP address to do it.',
    technical: [
      'Client IPs are hashed with a random value regenerated every server restart — even a memory dump of the running process reveals only hashes, not raw IPs.',
      'A separate, stricter limit specifically targets enumeration/scanning patterns (like guessing short codes), independent of the general per-route limit.',
    ],
  },
  {
    n: '10',
    icon: Users,
    title: 'Group messaging',
    intro: 'Group chats don’t use one shared group key. Every group message is individually end-to-end encrypted and sent separately to each member, using the same pairwise session described in mechanism 01.',
    technical: [
      'The public group directory (used for discovery/joining) stores only plaintext metadata — name, handle, description — never membership keys or message content.',
      'Real membership and message delivery happen entirely through pairwise encrypted sessions, fanned out to every current member.',
    ],
    caveat: 'There is no cryptographic enforcement of group membership today — each member’s app maintains its own list of who’s in the group and decides locally whether to accept a message from a given sender. This is the least mature part of Arcel’s design, and we won’t describe it as more than it is.',
  },
  {
    n: '11',
    icon: Radio,
    title: 'Calls',
    intro: 'Voice and video calls use WebRTC — the same browser-standard technology behind most modern calling products.',
    technical: [
      'Call media is protected by WebRTC’s own mandatory encryption (DTLS/SRTP), negotiated automatically between the two apps.',
      'Arcel additionally end-to-end encrypts the call-setup handshake itself (the SDP/ICE exchange) the same way it encrypts chat messages, specifically so our relay — which that setup data briefly passes through — never sees your network details.',
    ],
  },
];

export default function SecurityPage() {
  return (
    <div className="mk-marketing">
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
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20">
        <div className="max-w-3xl">
          <div className="mk-eyebrow mb-6">Security architecture</div>
          <h1
            className="font-black tracking-tight leading-[0.95] mb-8"
            style={{ fontSize: 'clamp(2.5rem, 5.5vw, 4.5rem)', color: 'var(--mk-text)' }}
          >
            Shown, not told.
          </h1>
          <p className="text-lg md:text-xl max-w-2xl leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>
            Every cryptographic and security mechanism Arcel actually uses, in plain language, compared step-by-step against how most messaging services are built. Nothing here is aspirational — where a protection has a real limitation, we say so in the same section, not somewhere you’d have to find it later.
          </p>
        </div>
      </section>

      {/* Comparison diagram */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="max-w-2xl mb-16">
            <div className="mk-eyebrow mb-4">The comparison</div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
              What happens to your message.
            </h2>
            <p className="mt-6 text-base" style={{ color: 'var(--mk-text-2)' }}>
              Same starting point — you hit send — two very different paths from there.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-x-16 gap-y-16">
            <FlowColumn heading="How most messaging apps work" tone="warn" steps={TYPICAL_STEPS} />
            <FlowColumn heading="How Arcel works" tone="good" steps={ARCEL_STEPS} />
          </div>
        </div>
      </section>

      {/* Deep-dive mechanisms */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="max-w-2xl mb-16">
            <div className="mk-eyebrow mb-4">Mechanism by mechanism</div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
              Every layer, in depth.
            </h2>
          </div>
          <div className="space-y-px" style={{ background: 'var(--mk-border)' }}>
            {MECHANISMS.map((m) => (
              <div key={m.n} className="grid md:grid-cols-[auto_auto_1fr] gap-8 items-start p-8" style={{ background: 'var(--mk-bg)' }}>
                <div className="font-mono text-2xl font-black w-12" style={{ color: 'var(--mk-accent)' }}>{m.n}</div>
                <m.icon className="w-5 h-5 mt-1" style={{ color: 'var(--mk-text-3)' }} />
                <div className="max-w-3xl">
                  <h3 className="text-lg font-bold mb-2" style={{ color: 'var(--mk-text)' }}>{m.title}</h3>
                  <p className="text-sm leading-relaxed mb-4" style={{ color: 'var(--mk-text-2)' }}>{m.intro}</p>
                  <ul className="space-y-2 mb-4">
                    {m.technical.map((t, i) => (
                      <li key={i} className="flex gap-2.5 text-sm leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>
                        <span className="shrink-0" style={{ color: 'var(--mk-accent)' }}>&rarr;</span>
                        <span>{t}</span>
                      </li>
                    ))}
                  </ul>
                  {m.caveat && (
                    <div className="p-4 mk-card-accent" style={{ background: 'var(--mk-bg-1)', borderLeftColor: 'var(--mk-warn)' }}>
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold mb-2" style={{ color: 'var(--mk-warn)' }}>What this doesn&apos;t cover</div>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>{m.caveat}</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Primitives table */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="max-w-2xl mb-12">
            <div className="mk-eyebrow mb-4">Reference</div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-tight" style={{ color: 'var(--mk-text)' }}>
              Cryptographic primitives at a glance.
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--mk-border-2)' }}>
                  <th className="text-left py-3 pr-4 font-bold" style={{ color: 'var(--mk-text)' }}>Purpose</th>
                  <th className="text-left py-3 pr-4 font-bold" style={{ color: 'var(--mk-text)' }}>Primitive</th>
                  <th className="text-left py-3 font-bold" style={{ color: 'var(--mk-text)' }}>Where it&apos;s used</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Key exchange (classical)', 'X25519 (Curve25519 ECDH)', 'Session establishment, hybrid with ML-KEM768'],
                  ['Key exchange (post-quantum)', 'ML-KEM768 (NIST-standardized)', 'Session establishment, hybrid with X25519'],
                  ['Key derivation', 'HKDF-SHA256', 'Root key + per-message ratchet key derivation'],
                  ['Message encryption', 'ChaCha20-Poly1305', 'Every message and call-signaling payload'],
                  ['Local key storage', 'PBKDF2-SHA256, 200,000 iterations', 'Deriving your device’s local storage key from your PIN'],
                  ['Local key encryption', 'XChaCha20-Poly1305', 'Encrypting private keys at rest on your device'],
                  ['TOTP secret at rest', 'AES-256-GCM', 'Server-side TOTP secret encryption'],
                  ['Identity derivation', 'SHA-256 (truncated)', 'Deriving your Relay ID and contact fingerprints from public keys'],
                  ['Session tokens', '256-bit CSPRNG, hashed at rest', 'Login sessions — opaque, not a signed/self-describing token'],
                  ['Rate-limit privacy', 'HMAC-SHA256', 'Hashing IPs before use as a rate-limit key'],
                ].map(([purpose, primitive, where]) => (
                  <tr key={purpose} style={{ borderBottom: '1px solid var(--mk-border)' }}>
                    <td className="py-3 pr-4" style={{ color: 'var(--mk-text-2)' }}>{purpose}</td>
                    <td className="py-3 pr-4 font-mono text-xs" style={{ color: 'var(--mk-text)' }}>{primitive}</td>
                    <td className="py-3 text-xs" style={{ color: 'var(--mk-text-3)' }}>{where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Closing */}
      <section style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl md:text-4xl font-black tracking-tight leading-tight mb-6" style={{ color: 'var(--mk-text)' }}>
              Found a gap between this page and the app?
            </h2>
            <p className="text-base leading-relaxed mb-8" style={{ color: 'var(--mk-text-2)' }}>
              Tell us. We&apos;d rather hear it from you than have this page describe something that stopped being true. See our <Link href="/legal/terms" className="underline">Terms</Link> for how to reach us, and our <Link href="/legal/transparency" className="underline">Transparency report</Link> for what we&apos;ve actually been asked for.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/legal/privacy" className="mk-btn-secondary">Privacy policy</Link>
              <Link href="/legal/terms" className="mk-btn-secondary">Terms of Service</Link>
              <Link href="/auth/landing" className="mk-btn-primary">Create account<ArrowRight className="w-3.5 h-3.5" /></Link>
            </div>
          </div>
        </div>
      </section>

      <footer style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-8 flex justify-between text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>&copy; {new Date().getFullYear()} Arcel</div>
          <Link href="/" className="uppercase tracking-[0.2em]" style={{ color: 'var(--mk-text-2)' }}>&larr; home</Link>
        </div>
      </footer>
    </div>
  );
}
