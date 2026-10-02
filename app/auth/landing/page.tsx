'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowRight, KeyRound, Shield, UserPlus } from 'lucide-react';
import { useRelayAuthStoreV2, useInitializeAuthV2 } from '@/lib/crypto/relay-auth-store-v2';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';
import { log } from '@/lib/platform/logger';

export default function LandingPage() {
  const router = useRouter();
  const { flow, availableUsers, startSignup, loadAvailableUsers } = useRelayAuthStoreV2();
  const [isInitialized, setIsInitialized] = useState(false);

  useInitializeAuthV2();

  useEffect(() => {
    if (flow === 'authenticated') router.push('/app');
  }, [flow, router]);

  useEffect(() => {
    const init = async () => {
      try {
        await loadAvailableUsers();
      } catch (error) {
        log.error('Failed to load users:', error);
      } finally {
        setIsInitialized(true);
      }
    };
    init();
  }, [loadAvailableUsers]);

  const handleSignup = async () => {
    try {
      await startSignup();
      router.push('/auth/signup');
    } catch (error) {
      log.error('Failed to start signup:', error);
    }
  };

  const handleLogin = async () => {
    try {
      await loadAvailableUsers();
    } catch (error) {
      log.error('Failed to load users:', error);
    }
    router.push('/auth/login');
  };

  return (
    <div className="mk-marketing min-h-screen flex flex-col">
      {/* Header */}
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
            <Link href="/legal/privacy" className="mk-btn-ghost">Privacy</Link>
            <Link href="/legal/terms" className="mk-btn-ghost">Terms</Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {/* Hero — sign up / in chooser */}
      <section className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-lg">
          <div className="mk-eyebrow mb-4">{availableUsers.length > 0 ? 'Welcome back' : 'Start here'}</div>
          <h1
            className="font-black tracking-tight leading-[1.05] mb-4"
            style={{ fontSize: 'clamp(2.25rem, 5vw, 3.5rem)', color: 'var(--mk-text)' }}
          >
            {availableUsers.length > 0 ? (
              <>Your identity is<br /><span style={{ color: 'var(--mk-accent)' }}>on this device.</span></>
            ) : (
              <>Create a <span style={{ color: 'var(--mk-accent)' }}>cryptographic</span><br /> identity.</>
            )}
          </h1>
          <p className="text-base md:text-lg mb-10 leading-relaxed" style={{ color: 'var(--mk-text-2)' }}>
            {availableUsers.length > 0
              ? 'Sign in with your PIN and 2FA, or create a new identity alongside the existing one.'
              : 'No email, no phone number, no legal name. Just a keypair generated on your device, protected by a PIN and a TOTP authenticator.'}
          </p>

          {!isInitialized ? (
            <div className="logo-searching">
              <Wordmark className="text-xl" />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {availableUsers.length > 0 ? (
                <>
                  <button onClick={handleLogin} className="mk-btn-primary w-full justify-between px-6 py-4 text-sm">
                    <span className="inline-flex items-center gap-2"><KeyRound className="w-4 h-4" /> Sign in to existing identity</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button onClick={handleSignup} className="mk-btn-secondary w-full justify-between px-6 py-4 text-sm">
                    <span className="inline-flex items-center gap-2"><UserPlus className="w-4 h-4" /> Create another identity</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <button onClick={handleSignup} className="mk-btn-primary w-full justify-between px-6 py-4 text-sm">
                    <span className="inline-flex items-center gap-2"><UserPlus className="w-4 h-4" /> Create new identity</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button onClick={handleLogin} className="mk-btn-secondary w-full justify-between px-6 py-4 text-sm">
                    <span className="inline-flex items-center gap-2"><KeyRound className="w-4 h-4" /> Sign in with username or Relay ID</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* Privacy box */}
          <div
            className="mt-10 p-5 mk-card-accent"
            style={{ background: 'var(--mk-bg-1)', border: '1px solid var(--mk-border)', borderLeftWidth: '3px', borderLeftColor: 'var(--mk-accent)' }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4" style={{ color: 'var(--mk-accent)' }} />
              <div className="text-[11px] uppercase tracking-[0.2em] font-bold" style={{ color: 'var(--mk-text)' }}>How your identity is stored</div>
            </div>
            <ul className="space-y-2 text-sm" style={{ color: 'var(--mk-text-2)' }}>
              <li className="flex gap-2"><span style={{ color: 'var(--mk-text-4)' }}>→</span><span>Your private key is generated in-browser and never transmitted.</span></li>
              <li className="flex gap-2"><span style={{ color: 'var(--mk-text-4)' }}>→</span><span>Encrypted at rest with your PIN and a TOTP-derived secret.</span></li>
              <li className="flex gap-2"><span style={{ color: 'var(--mk-text-4)' }}>→</span><span>Lose the recovery phrase, lose the identity — no server-side recovery exists.</span></li>
            </ul>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-6xl mx-auto px-6 py-6 flex justify-between text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>© {new Date().getFullYear()} Arcel</div>
          <div className="flex gap-5">
            <Link href="/" style={{ color: 'var(--mk-text-2)' }}>Home</Link>
            <Link href="/legal/canary" style={{ color: 'var(--mk-text-2)' }}>Canary</Link>
            <Link href="/legal/transparency" style={{ color: 'var(--mk-text-2)' }}>Transparency</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
