'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { initStorage } from '@/lib/db/relay-store';
import { Lock, Settings } from 'lucide-react';
import Link from 'next/link';
import { log } from '@/lib/platform/logger';

export default function VaultLayout({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [showExplainer, setShowExplainer] = useState(false);
  const router = useRouter();
  const authStore = useRelayAuthStoreV2();
  const { flow } = authStore;

  useEffect(() => {
    const initialize = async () => {
      try {
        if (flow !== 'authenticated') {
          router.push('/auth/login');
          return;
        }

        const privateKey = authStore.getPrivateKey();
        if (!privateKey) {
          router.push('/auth/login');
          return;
        }

        await initStorage(privateKey);

        const visited = localStorage.getItem('relay-vault-visited');
        if (!visited) {
          setShowExplainer(true);
          localStorage.setItem('relay-vault-visited', 'true');
        }

        setMounted(true);
      } catch (err) {
        log.error('Failed to initialize vault:', err);
        router.push('/auth/login');
      }
    };

    initialize();
  }, [authStore, flow, router]);

  if (!mounted) return null;

  const navItems = [
    { name: 'Settings', path: '/vault/settings', icon: Settings },
  ];

  return (
    <div className="flex h-screen bg-black text-white overflow-hidden">
      {/* Sidebar */}
      <div className="w-52 border-r border-relay-border flex flex-col flex-shrink-0">
        <div className="px-5 py-5 border-b border-relay-border">
          <div className="text-sm font-semibold text-white">Relay Vault</div>
          <div className="text-xs text-relay-text-muted mt-0.5">Encrypted</div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.path}
                href={item.path}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-relay-surface transition-colors text-sm text-relay-text-secondary hover:text-white"
              >
                <Icon className="w-4 h-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-relay-border p-3">
          <Link
            href="/app"
            className="flex items-center justify-center w-full px-3 py-2 text-xs text-relay-text-muted hover:text-white hover:bg-relay-surface rounded-lg transition-colors"
          >
            Back to Messages
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>

      {/* Explainer Modal */}
      {showExplainer && (
        <div
          className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
          onClick={() => setShowExplainer(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-relay-bg border border-relay-border rounded-xl p-8 max-w-sm w-full"
          >
            <div className="w-10 h-10 rounded-xl bg-relay-surface border border-relay-border flex items-center justify-center mb-5">
              <Lock className="w-5 h-5 text-relay-text-secondary" />
            </div>

            <h2 className="text-lg font-semibold mb-2">Welcome to Relay Vault</h2>
            <p className="text-sm text-relay-text-muted mb-5">
              Everything in your Vault is encrypted with your Relay key. Not even we can read it.
            </p>

            <div className="space-y-3 mb-6 text-sm">
              <div className="flex gap-3">
                <Settings className="w-4 h-4 text-relay-text-secondary flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-relay-text-primary">Encrypted cloud backup</div>
                  <div className="text-relay-text-muted text-xs">Opt-in sync of contacts, conversations, and messages</div>
                </div>
              </div>
            </div>

            <button
              onClick={() => setShowExplainer(false)}
              className="w-full px-4 py-2.5 bg-white text-black text-sm font-semibold rounded-xl hover:bg-relay-surface-hover transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
