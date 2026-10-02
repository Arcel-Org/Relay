import Link from 'next/link';
import { Wordmark } from '@/components/marketing/Wordmark';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mk-marketing">
      <header
        className="sticky top-0 z-40 backdrop-blur-md"
        style={{ background: 'color-mix(in srgb, var(--mk-bg) 80%, transparent)', borderBottom: '1px solid var(--mk-border)' }}
      >
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Wordmark />
            <span className="text-[10px] uppercase tracking-[0.25em]" style={{ color: 'var(--mk-text-3)' }}>Relay</span>
          </Link>
          <nav className="flex items-center gap-1">
            <Link href="/legal/terms" className="mk-btn-ghost hidden md:inline-flex">Terms</Link>
            <Link href="/legal/privacy" className="mk-btn-ghost hidden md:inline-flex">Privacy</Link>
            <Link href="/security" className="mk-btn-ghost hidden md:inline-flex">Security</Link>
            <Link href="/legal/canary" className="mk-btn-ghost hidden md:inline-flex">Canary</Link>
            <Link href="/legal/transparency" className="mk-btn-ghost hidden lg:inline-flex">Transparency</Link>
            <ThemeToggle />
            <Link href="/auth/landing" className="mk-btn-primary ml-2">Sign in / Sign up</Link>
          </nav>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-20">
        <article className="legal-prose">{children}</article>
      </main>

      <footer style={{ borderTop: '1px solid var(--mk-border)' }}>
        <div className="max-w-4xl mx-auto px-6 py-8 flex justify-between text-xs" style={{ color: 'var(--mk-text-4)' }}>
          <div>© {new Date().getFullYear()} Arcel</div>
          <Link href="/" className="uppercase tracking-[0.2em]" style={{ color: 'var(--mk-text-2)' }}>← home</Link>
        </div>
      </footer>
    </div>
  );
}
