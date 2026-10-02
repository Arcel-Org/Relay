'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Cloud, Trash2, RefreshCw, Lock } from 'lucide-react';
import { pushToVault, pullFromVault, deleteVault, isVaultEnabled, enableVault, disableVault, getLastSyncTime, startAutoSync } from '@/lib/vault/relay-vault';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { log } from '@/lib/platform/logger';

export default function VaultSettingsPage() {
  const router = useRouter();
  const { getPrivateKey, flow } = useRelayAuthStoreV2();
  const [mounted, setMounted] = useState(false);

  // This page previously had no auth guard at all — it rendered its full UI
  // (toggle, sync controls, "how it works") for anyone who navigated here,
  // regardless of session state. Actions themselves were harmless (each
  // checks getPrivateKey() and alerts "Not authenticated"), but the page
  // shouldn't be reachable in the first place — matches the redirect guard
  // every other authenticated page in this app already has.
  useEffect(() => {
    if (flow !== 'authenticated') {
      router.push('/auth/login');
    }
  }, [flow, router]);
  const [enabled, setEnabled] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [syncStatus, setSyncStatus] = useState<'ready' | 'syncing' | 'error'>('ready');

  useEffect(() => {
    const load = async () => {
      try {
        const isEnabled = await isVaultEnabled();
        setEnabled(isEnabled);

        const lastSyncTime = await getLastSyncTime();
        if (lastSyncTime) {
          setLastSync(lastSyncTime);
        }

        // startAutoSync's interval is in-memory only — it does not survive
        // a reload. If the vault was already enabled in a prior session,
        // the periodic 5-minute sync must be re-armed here, or the "syncs
        // automatically" promise in the UI silently stops being true after
        // every page refresh until the user manually hits "Sync Now".
        if (isEnabled) {
          const privateKey = getPrivateKey();
          if (privateKey) {
            startAutoSync(privateKey);
          }
        }

        setMounted(true);
      } catch (err) {
        log.error('Failed to load vault settings:', err);
        // Retry after 1 second if storage not ready
        if (err instanceof Error && err.message.includes('Storage not ready')) {
          setTimeout(load, 1000);
        } else {
          setMounted(true);
        }
      }
    };

    load();
  }, []);

  const handleEnable = async () => {
    if (!enabled) {
      setShowConsent(true);
    }
  };

  const handleConfirmEnable = async () => {
    try {
      const privateKey = getPrivateKey();
      if (!privateKey) {
        alert('Not authenticated');
        return;
      }

      setSyncStatus('syncing');
      await enableVault(privateKey);
      setEnabled(true);
      setShowConsent(false);
      startAutoSync(privateKey);

      // Pull BEFORE push. This device may be new/reinstalled with empty
      // local data but an existing server-side backup from a prior device
      // (same Relay key recovered) — pushing first would overwrite that
      // backup with nothing before the user ever got a chance to restore
      // it. syncFromVault's merge is non-destructive (newest-wins per
      // record), so this is always safe even when there's nothing to pull
      // (404 is a documented no-op) or this genuinely is the first device.
      await pullFromVault(privateKey);
      await pushToVault(privateKey);
      const lastSyncTime = await getLastSyncTime();
      setLastSync(lastSyncTime);
      setSyncStatus('ready');
    } catch (err) {
      alert('Failed to enable vault: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setSyncStatus('error');
    }
  };

  const handleDisable = async () => {
    if (!confirm('Disable Relay Vault? Your data will remain on the server but won\'t sync automatically.')) {
      return;
    }

    try {
      // disableVault() already clears the auto-sync interval internally.
      await disableVault();
      setEnabled(false);
    } catch (err) {
      alert('Failed to disable vault: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleSyncNow = async () => {
    try {
      const privateKey = getPrivateKey();
      if (!privateKey) {
        alert('Not authenticated');
        return;
      }

      setSyncing(true);
      setSyncStatus('syncing');
      await pushToVault(privateKey);
      const lastSyncTime = await getLastSyncTime();
      setLastSync(lastSyncTime);
      setSyncStatus('ready');
      setSyncing(false);
    } catch (err) {
      alert('Sync failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setSyncStatus('error');
      setSyncing(false);
    }
  };

  const handleRestoreNow = async () => {
    if (!confirm('Pull the latest backup from Relay Vault and merge it into this device? Existing local data is never overwritten by older server data.')) {
      return;
    }

    try {
      const privateKey = getPrivateKey();
      if (!privateKey) {
        alert('Not authenticated');
        return;
      }

      setRestoring(true);
      setSyncStatus('syncing');
      await pullFromVault(privateKey);
      const lastSyncTime = await getLastSyncTime();
      setLastSync(lastSyncTime);
      setSyncStatus('ready');
      setRestoring(false);
      alert('✓ Restore complete');
    } catch (err) {
      alert('Restore failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setSyncStatus('error');
      setRestoring(false);
    }
  };

  const handleDeleteVault = async () => {
    if (!confirm('Delete all vault data on the server? This cannot be undone. Local data will not be affected.')) {
      return;
    }

    try {
      const privateKey = getPrivateKey();
      if (!privateKey) {
        alert('Not authenticated');
        return;
      }

      setSyncStatus('syncing');
      await deleteVault(privateKey);
      setSyncStatus('ready');
      alert('✓ Vault data deleted');
    } catch (err) {
      alert('Failed to delete vault: ' + (err instanceof Error ? err.message : 'Unknown error'));
      setSyncStatus('error');
    }
  };

  if (flow !== 'authenticated') return null;

  if (!mounted) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black">
        <div className="text-relay-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-black overflow-auto">
      <div className="max-w-lg mx-auto p-6">
        <h1 className="text-lg font-semibold mb-6">Vault Settings</h1>

        {/* Main Vault Toggle */}
        <div className="bg-relay-surface border border-relay-border rounded-xl p-5 mb-3">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-relay-surface-hover flex items-center justify-center flex-shrink-0">
                <Cloud className="w-4 h-4 text-relay-text-secondary" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">Relay Vault</h2>
                <p className="text-xs text-relay-text-muted mt-0.5">
                  Encrypted cloud backup of your messages and data
                </p>
              </div>
            </div>

            <button
              onClick={enabled ? handleDisable : handleEnable}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors flex-shrink-0 ${
                enabled
                  ? 'bg-red-600 hover:bg-red-700 text-white'
                  : 'bg-white hover:bg-relay-surface-hover text-black'
              }`}
            >
              {enabled ? 'Disable' : 'Enable'}
            </button>
          </div>

          {enabled && (
            <div className="p-3 bg-relay-surface-hover rounded-xl text-xs text-relay-text-secondary">
              ✓ Vault is active. Your data syncs automatically every 5 minutes.
            </div>
          )}
        </div>

        {/* Consent Modal */}
        {showConsent && (
          <div
            className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
            onClick={() => setShowConsent(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="bg-relay-bg border border-relay-border rounded-xl p-6 max-w-sm w-full"
            >
              <h3 className="text-base font-semibold mb-2">Enable Relay Vault?</h3>
              <p className="text-sm text-relay-text-muted mb-4">
                Relay Vault stores an encrypted backup of your messages and data. We cannot read this data — it's encrypted with your private key before it leaves your device.
              </p>
              <p className="text-xs text-relay-text-muted mb-5 flex items-center gap-2">
                <Lock className="w-3.5 h-3.5" />
                Requires Relay Core ($4/mo)
              </p>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowConsent(false)}
                  className="flex-1 px-4 py-2.5 bg-relay-surface hover:bg-relay-surface-hover rounded-xl transition-colors text-sm border border-relay-border"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmEnable}
                  className="flex-1 px-4 py-2.5 bg-white hover:bg-relay-surface-hover rounded-xl transition-colors text-sm font-semibold text-black"
                >
                  Enable Vault
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Sync Controls */}
        {enabled && (
          <div className="space-y-3">
            <div className="bg-relay-surface border border-relay-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-relay-text-muted">Last Sync</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-lg ${
                    syncStatus === 'ready'
                      ? 'bg-relay-surface-hover text-relay-text-secondary'
                      : syncStatus === 'syncing'
                      ? 'bg-relay-surface-hover text-relay-text-secondary'
                      : 'bg-red-950 text-red-400'
                  }`}
                >
                  {syncStatus === 'ready' && '✓ Ready'}
                  {syncStatus === 'syncing' && '⟳ Syncing...'}
                  {syncStatus === 'error' && '✕ Error'}
                </span>
              </div>
              {lastSync ? (
                <div className="text-sm text-relay-text-secondary">
                  {new Date(lastSync).toLocaleString()}
                </div>
              ) : (
                <div className="text-sm text-relay-text-muted">Never synced</div>
              )}
            </div>

            <button
              onClick={handleSyncNow}
              disabled={syncing || restoring || syncStatus === 'syncing'}
              className="w-full px-4 py-3 bg-relay-surface hover:bg-relay-surface-hover disabled:opacity-40 border border-relay-border rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>

            <button
              onClick={handleRestoreNow}
              disabled={syncing || restoring || syncStatus === 'syncing'}
              className="w-full px-4 py-3 bg-relay-surface hover:bg-relay-surface-hover disabled:opacity-40 border border-relay-border rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Cloud className={`w-4 h-4 ${restoring ? 'animate-pulse' : ''}`} />
              {restoring ? 'Restoring...' : 'Restore from Vault'}
            </button>

            <button
              onClick={handleDeleteVault}
              className="w-full px-4 py-3 bg-relay-surface hover:bg-red-950 border border-relay-border hover:border-red-900 text-relay-text-secondary hover:text-red-400 rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Delete Vault Data
            </button>
          </div>
        )}

        {/* Info Section */}
        <div className="mt-6 p-4 bg-relay-surface border border-relay-border rounded-xl">
          <h3 className="text-xs text-relay-text-muted mb-3">How it works</h3>
          <ul className="space-y-2 text-sm text-relay-text-secondary">
            <li className="flex gap-2">
              <span className="text-relay-text-muted flex-shrink-0">•</span>
              <span>All data is encrypted before leaving your device</span>
            </li>
            <li className="flex gap-2">
              <span className="text-relay-text-muted flex-shrink-0">•</span>
              <span>Syncs automatically every 5 minutes when enabled</span>
            </li>
            <li className="flex gap-2">
              <span className="text-relay-text-muted flex-shrink-0">•</span>
              <span>Restore on a new device with the same Relay key</span>
            </li>
            <li className="flex gap-2">
              <span className="text-relay-text-muted flex-shrink-0">•</span>
              <span>Local data always takes priority over server data</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
