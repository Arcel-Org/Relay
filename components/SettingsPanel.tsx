/**
 * Relay Settings — unified left-nav experience.
 * Sections: Account, Privacy, Notifications, Appearance, Chats, Security, Devices, Data, Sync, About.
 * Uses `Toggle` for all booleans. Matches relay-panel styling.
 */

'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User, Shield, ShieldOff, Bell, Palette, MessageSquare, Lock, Smartphone, Database, Cloud, Info,
  Copy, Check, Download, Upload, RefreshCw, Trash2, Loader2, Eye, AlertTriangle, Camera, ChevronRight, KeyRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import {
  exportEncryptedBackup, importEncryptedBackup, getStorageReady, getAllContacts,
} from '@/lib/db/relay-store';
import { unblockContact } from '@/lib/features/block';
import {
  getPairedDevices, revokePairedDevice,
} from '@/lib/vault/relay-device-sync';
import { isVaultEnabled, getLastSyncTime, enableVault, disableVault, pushToVault, deleteVault } from '@/lib/vault/relay-vault';
import { DeviceSyncQR } from '@/components/DeviceSyncQR';
import { toHex } from '@/lib/crypto/hex-utils';
import { getAccountProfile } from '@/lib/auth/account-manager';
import { formatRecoveryCode, generateRecoveryCode, hashRecoveryCode } from '@/lib/crypto/recovery-code';
import { encryptTOTPSecretForRecovery } from '@/lib/crypto/relay-auth';
import { listHardwareKeys, addHardwareKey, revokeHardwareKey, authenticateWithHardwareKey, type RegisteredKeySummary } from '@/lib/crypto/webauthn-client';
import { log } from '@/lib/platform/logger';
import { ThemePicker } from '@/components/ThemePicker';
import { Toggle } from '@/components/ui/Toggle';
import { getReadReceiptsEnabled, setReadReceiptsEnabled } from '@/lib/messaging/read-receipt-setting';
import { AUTO_LOGOUT_OPTIONS, getAutoLogoutSeconds, setAutoLogoutSeconds } from '@/lib/auth/auto-logout';
import { loadSession, formatGracePeriod } from '@/lib/auth/session-persistence';
import { getBoolSetting, setBoolSetting } from '@/lib/settings/relay-settings';
import { clearDictionaryCache } from '@/lib/messaging/compression-cache';

type SectionId =
  | 'account' | 'privacy' | 'notifications' | 'appearance' | 'chats'
  | 'security' | 'devices' | 'data' | 'sync' | 'about';

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'privacy', label: 'Privacy', icon: Shield },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'devices', label: 'Devices', icon: Smartphone },
  { id: 'data', label: 'Data & storage', icon: Database },
  { id: 'sync', label: 'Sync (Vault)', icon: Cloud },
  { id: 'about', label: 'About', icon: Info },
];

function useLocalNumber(key: string, defaultValue: number): [number, (v: number) => void] {
  const [v, setV] = useState<number>(defaultValue);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setV(parseInt(raw, 10) || defaultValue);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (next: number) => {
    setV(next);
    try { localStorage.setItem(key, String(next)); } catch {}
  };
  return [v, set];
}

function useLocalString(key: string, defaultValue: string): [string, (v: string) => void] {
  const [v, setV] = useState<string>(defaultValue);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) setV(raw);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = (next: string) => {
    setV(next);
    try { localStorage.setItem(key, next); } catch {}
  };
  return [v, set];
}

export function SettingsPanel() {
  const [active, setActive] = useState<SectionId>('account');

  return (
    <div className="w-full relay-panel rounded-xl overflow-hidden flex flex-col md:flex-row border border-relay-border min-h-[70vh]">
      {/* Left nav */}
      <nav className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-relay-border bg-relay-surface/60">
        <div className="px-4 py-4 border-b border-relay-border">
          <h1 className="text-sm font-semibold tracking-tight text-relay-text-primary">Settings</h1>
          <p className="text-[11px] text-relay-text-muted mt-0.5">Manage your Relay experience</p>
        </div>
        <ul className="p-2 flex md:block overflow-x-auto md:overflow-visible">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const isActive = active === s.id;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  onClick={() => setActive(s.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-xs text-left transition-colors ${
                    isActive
                      ? 'bg-relay-accent/15 text-relay-text-primary'
                      : 'text-relay-text-secondary hover:bg-relay-surface-hover hover:text-relay-text-primary'
                  }`}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="truncate">{s.label}</span>
                  {isActive && <ChevronRight size={12} className="ml-auto hidden md:inline" />}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Right pane */}
      <div className="flex-1 min-w-0 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div
            key={active}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="p-6 md:p-8 md:pr-10 max-w-3xl"
          >
            {active === 'account' && <AccountSection />}
            {active === 'privacy' && <PrivacySection />}
            {active === 'notifications' && <NotificationsSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'chats' && <ChatsSection />}
            {active === 'security' && <SecuritySection />}
            {active === 'devices' && <DevicesSection />}
            {active === 'data' && <DataSection />}
            {active === 'sync' && <SyncSection />}
            {active === 'about' && <AboutSection />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Shared UI helpers ──────────────────────────────────────────────────────

function SectionHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-sm font-semibold text-relay-text-primary">{title}</h2>
      {desc && <p className="text-[11px] text-relay-text-muted mt-0.5">{desc}</p>}
    </div>
  );
}

function SettingRow({
  label, hint, control,
}: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 px-3 rounded-md hover:bg-relay-surface-hover/40">
      <div className="min-w-0">
        <p className="text-sm text-relay-text-primary">{label}</p>
        {hint && <p className="text-[11px] text-relay-text-muted mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function Divider() {
  return <div className="my-4 h-px bg-relay-border" />;
}

// ─── Account ────────────────────────────────────────────────────────────────

function AccountSection() {
  const router = useRouter();
  const authStore = useRelayAuthStoreV2();
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const profile = useMemo(
    () => getAccountProfile(authStore.currentRelayId || ''),
    [authStore.currentRelayId],
  );

  const copyId = async () => {
    if (!authStore.currentRelayId) return;
    try {
      await navigator.clipboard.writeText(authStore.currentRelayId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const handleDeleteAccount = async () => {
    if (!confirm('Permanently delete your account? This removes your identity from the server (and any groups you own from the directory) and cannot be undone.')) return;
    if (!confirm('This is your last chance to back out. Delete this account permanently?')) return;

    // Step-up auth: the server now requires a live second factor for this,
    // the single most destructive action in the app — mirrors the pattern
    // already used for regenerating a recovery code and adding a hardware
    // key (see SecuritySection's handleRegenerate / handleAddKey).
    let stepUp: { totpCode?: string; webauthnAssertion?: unknown };
    try {
      const { getUserByRelayId } = await import('@/lib/db/relay-db');
      const user = authStore.currentRelayId ? await getUserByRelayId(authStore.currentRelayId) : null;
      if (user?.twoFactorMethod === 'webauthn') {
        stepUp = { webauthnAssertion: await authenticateWithHardwareKey(authStore.currentRelayId || '') };
      } else {
        const code = prompt('Enter your current 6-digit authenticator code to confirm:');
        if (!code) return;
        stepUp = { totpCode: code };
      }
    } catch (err) {
      alert('Failed: ' + (err instanceof Error ? err.message : 'Second-factor verification failed'));
      return;
    }

    setDeleting(true);
    try {
      const result = await authStore.deleteAccount(stepUp);
      if (!result.success) {
        alert(result.error || 'Failed to delete account. Check your connection and try again.');
        return;
      }
      router.push('/auth/landing');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      <SectionHeader title="Account" desc="Your identity on Relay." />
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center text-2xl shrink-0"
            style={{ backgroundColor: profile?.avatarColor || '#4ECDC4', filter: 'saturate(0.7) brightness(0.92)' }}
          >
            {profile?.avatarEmoji || '🙂'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-relay-text-primary font-medium truncate">
              {profile?.displayName || 'Unnamed'}
            </p>
            <p className="text-[11px] text-relay-text-muted truncate">
              {profile?.username ? `@${profile.username}` : 'No username set'}
            </p>
          </div>
        </div>

        <div>
          <p className="text-[11px] text-relay-text-muted mb-1">Relay ID</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs text-relay-text-primary bg-relay-surface-hover/60 rounded-md px-2 py-1.5 truncate">
              {authStore.currentRelayId}
            </code>
            <button onClick={copyId} className="relay-btn-secondary text-xs px-2 py-1.5 shrink-0">
              {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
            </button>
          </div>
        </div>

        <Divider />

        <button onClick={() => router.push('/app/account')} className="relay-btn-secondary w-full">
          Edit full profile <ChevronRight size={14} />
        </button>
        <p className="text-[11px] text-relay-text-muted text-center">
          Display name, username, avatar, and recovery
        </p>

        <Divider />

        <p className="text-sm font-medium text-relay-text-primary mb-1">Danger zone</p>
        <button onClick={handleDeleteAccount} disabled={deleting} className="relay-btn-danger w-full">
          {deleting ? <><Loader2 size={12} className="animate-spin" /> Deleting</> : <><Trash2 size={12} /> Delete account</>}
        </button>
        <p className="text-[11px] text-relay-text-muted text-center">
          Permanently removes your identity from the server. Cannot be undone.
        </p>
      </div>
    </div>
  );
}

// ─── Privacy ────────────────────────────────────────────────────────────────

function PrivacySection() {
  const [readReceipts, setReadReceipts] = useState(true);
  const [onlineStatus, setOnlineStatus] = useState(true);
  const [typingIndicators, setTypingIndicators] = useState(true);
  const [blockedContacts, setBlockedContacts] = useState<{ relayId: string; name: string }[]>([]);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);

  const loadBlockedContacts = useCallback(async () => {
    try {
      const all = (await getAllContacts()) as Array<{ relayId: string; name: string; displayName?: string; blocked?: boolean }>;
      const blocked = all.filter((c) => c.blocked);
      setBlockedContacts(blocked.map((c) => ({ relayId: c.relayId, name: c.displayName || c.name || c.relayId })));
    } catch (err) {
      log.error('Failed to load blocked contacts:', err);
    }
  }, []);

  useEffect(() => {
    setReadReceipts(getReadReceiptsEnabled());
    setOnlineStatus(getBoolSetting('online-status', true));
    setTypingIndicators(getBoolSetting('typing-indicators', true));
    void loadBlockedContacts();
  }, [loadBlockedContacts]);

  const handleUnblock = async (relayId: string) => {
    setUnblockingId(relayId);
    try {
      await unblockContact(relayId);
      await loadBlockedContacts();
    } catch (err) {
      log.error('Failed to unblock contact:', err);
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <div>
      <SectionHeader title="Privacy" desc="Control what others see about you." />
      <div className="space-y-1">
        <SettingRow
          label="Send read receipts"
          hint="Let contacts see when you've read their messages."
          control={<Toggle checked={readReceipts} ariaLabel="Send read receipts" onChange={(v) => { setReadReceipts(v); setReadReceiptsEnabled(v); }} />}
        />
        <SettingRow
          label="Show online status"
          hint="Show contacts when you're active."
          control={<Toggle checked={onlineStatus} ariaLabel="Show online status" onChange={(v) => { setOnlineStatus(v); setBoolSetting('online-status', v); }} />}
        />
        <SettingRow
          label="Typing indicators"
          hint="Send and show when you or a contact is typing."
          control={<Toggle checked={typingIndicators} ariaLabel="Typing indicators" onChange={(v) => { setTypingIndicators(v); setBoolSetting('typing-indicators', v); }} />}
        />
      </div>

      <Divider />

      <div>
        <p className="text-sm font-medium text-relay-text-primary mb-2">Block list</p>
        {blockedContacts.length === 0 ? (
          <p className="text-[11px] text-relay-text-muted">
            No blocked contacts. Block someone from their profile.
          </p>
        ) : (
          <div className="space-y-1.5">
            {blockedContacts.map((c) => (
              <div key={c.relayId} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-relay-surface-hover/50">
                <span className="text-xs text-relay-text-secondary truncate">{c.name}</span>
                <button
                  onClick={() => handleUnblock(c.relayId)}
                  disabled={unblockingId === c.relayId}
                  className="relay-btn-secondary text-[11px] px-2.5 py-1 shrink-0 inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <ShieldOff className="w-3 h-3" />
                  Unblock
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Notifications ──────────────────────────────────────────────────────────

function NotificationsSection() {
  const [push, setPush] = useState(false);
  const [sound, setSound] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    setPush(getBoolSetting('notifications', false));
    setSound(getBoolSetting('sound', true));
    setVibration(getBoolSetting('vibration', true));
    try {
      const v = localStorage.getItem('relay:setting:preview');
      setPreview(v === null ? true : v === '1');
    } catch {}
  }, []);

  return (
    <div>
      <SectionHeader title="Notifications" desc="How Relay alerts you." />
      <div className="space-y-1">
        <SettingRow
          label="Push notifications"
          hint="Show system alerts for new messages."
          control={<Toggle checked={push} ariaLabel="Push notifications" onChange={(v) => { setPush(v); setBoolSetting('notifications', v); }} />}
        />
        <SettingRow
          label="Sound"
          hint="Play a sound on new messages."
          control={<Toggle checked={sound} ariaLabel="Sound" onChange={(v) => { setSound(v); setBoolSetting('sound', v); }} />}
        />
        <SettingRow
          label="Vibration"
          hint="Vibrate on new messages (mobile)."
          control={<Toggle checked={vibration} ariaLabel="Vibration" onChange={(v) => { setVibration(v); setBoolSetting('vibration', v); }} />}
        />
        <SettingRow
          label="Message preview"
          hint="Show message text in notifications."
          control={<Toggle checked={preview} ariaLabel="Message preview" onChange={(v) => {
            setPreview(v);
            try { localStorage.setItem('relay:setting:preview', v ? '1' : '0'); } catch {}
          }} />}
        />
      </div>
    </div>
  );
}

// ─── Appearance ─────────────────────────────────────────────────────────────

function AppearanceSection() {
  const [density, setDensity] = useLocalString('relay:setting:density', 'comfortable');
  const [fontSize, setFontSize] = useLocalString('relay:setting:font-size', 'medium');

  useEffect(() => {
    const map = { small: '13px', medium: '14px', large: '16px' } as Record<string, string>;
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--relay-font-size', map[fontSize] || '14px');
    }
  }, [fontSize]);

  return (
    <div>
      <SectionHeader title="Appearance" desc="Theme, density, and typography." />
      <ThemePicker />

      <Divider />

      <p className="text-sm font-medium text-relay-text-primary mb-2">Density</p>
      <div className="grid grid-cols-2 gap-2 mb-5">
        {(['compact', 'comfortable'] as const).map((d) => (
          <button
            key={d}
            onClick={() => setDensity(d)}
            aria-pressed={density === d}
            className={`rounded-md border px-3 py-2 text-xs capitalize ${density === d ? 'border-relay-accent bg-relay-accent/10 text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
          >{d}</button>
        ))}
      </div>

      <p className="text-sm font-medium text-relay-text-primary mb-2">Font size</p>
      <div className="grid grid-cols-3 gap-2">
        {(['small', 'medium', 'large'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFontSize(f)}
            aria-pressed={fontSize === f}
            className={`rounded-md border px-3 py-2 text-xs capitalize ${fontSize === f ? 'border-relay-accent bg-relay-accent/10 text-relay-text-primary' : 'border-relay-border text-relay-text-secondary'}`}
          >{f}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Chats ──────────────────────────────────────────────────────────────────

function ChatsSection() {
  const [ghostInterval, setGhostInterval] = useLocalNumber('relay:setting:ghost-default', 0);
  const [autoDownload, setAutoDownload] = useState(true);
  const [enterToSend, setEnterToSend] = useState(true);

  useEffect(() => {
    try {
      const ad = localStorage.getItem('relay:setting:auto-download');
      if (ad !== null) setAutoDownload(ad === '1');
      const es = localStorage.getItem('relay:setting:enter-to-send');
      if (es !== null) setEnterToSend(es === '1');
    } catch {}
  }, []);

  const persist = (key: string, v: boolean) => { try { localStorage.setItem(key, v ? '1' : '0'); } catch {} };

  return (
    <div>
      <SectionHeader title="Chats" desc="Defaults for new and existing conversations." />
      <div className="space-y-1">
        <SettingRow
          label="Default disappearing messages"
          hint="Applied to new conversations by default."
          control={
            <select
              value={String(ghostInterval)}
              onChange={(e) => setGhostInterval(parseInt(e.target.value, 10))}
              aria-label="Default disappearing messages"
              className="relay-input text-xs py-1 px-2"
            >
              <option value="0">Off</option>
              <option value="3600">1 hour</option>
              <option value="86400">24 hours</option>
              <option value="604800">7 days</option>
              <option value="2592000">30 days</option>
            </select>
          }
        />
        <SettingRow
          label="Auto-download media"
          hint="Images and files are downloaded automatically."
          control={<Toggle checked={autoDownload} ariaLabel="Auto-download media" onChange={(v) => { setAutoDownload(v); persist('relay:setting:auto-download', v); }} />}
        />
        <SettingRow
          label="Enter to send"
          hint="Off: Shift+Enter sends, Enter adds a newline."
          control={<Toggle checked={enterToSend} ariaLabel="Enter to send" onChange={(v) => { setEnterToSend(v); persist('relay:setting:enter-to-send', v); }} />}
        />
      </div>
    </div>
  );
}

// ─── Security ───────────────────────────────────────────────────────────────

function SecuritySection() {
  const authStore = useRelayAuthStoreV2();
  const [autoLogout, setAutoLogout] = useState<number | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [lockOnClose, setLockOnClose] = useState(false);
  const [showRecoveryCode, setShowRecoveryCode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [regenerateTotpEntry, setRegenerateTotpEntry] = useState('');
  const [regenerateError, setRegenerateError] = useState('');

  const [twoFactorMethod, setTwoFactorMethod] = useState<'totp' | 'webauthn' | null>(null);
  const [hardwareKeys, setHardwareKeys] = useState<RegisteredKeySummary[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [addingKey, setAddingKey] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [keyError, setKeyError] = useState('');

  const [duressPinSet, setDuressPinSet] = useState(false);
  const [showDuressForm, setShowDuressForm] = useState(false);
  const [duressRealPin, setDuressRealPin] = useState('');
  const [duressNewPin, setDuressNewPin] = useState('');
  const [duressBusy, setDuressBusy] = useState(false);
  const [duressMessage, setDuressMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const refreshDuressStatus = useCallback(async () => {
    if (!authStore.currentRelayId) return;
    const { getUserByRelayId } = await import('@/lib/db/relay-db');
    const user = await getUserByRelayId(authStore.currentRelayId);
    setDuressPinSet(!!user?.duressPinHash);
  }, [authStore.currentRelayId]);

  const refreshHardwareKeys = useCallback(async () => {
    try {
      const data = await listHardwareKeys();
      setTwoFactorMethod(data.twoFactorMethod);
      setHardwareKeys(data.credentials);
    } catch (err) {
      log.error('Failed to load hardware keys:', err);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    setAutoLogout(getAutoLogoutSeconds());
    try {
      const v = localStorage.getItem('relay:setting:lock-on-close');
      setLockOnClose(v === '1');
    } catch {}
    refreshHardwareKeys();
    refreshDuressStatus();
  }, [refreshHardwareKeys, refreshDuressStatus]);

  // Session grace-period display — formatGracePeriod() existed with no UI
  // surfacing it anywhere; the 24h grace period was invisible to the user
  // entirely. Re-read every 30s (the window is measured in hours, not worth
  // ticking faster) rather than once, so it doesn't just freeze at whatever
  // it said on first render.
  useEffect(() => {
    const update = () => {
      const session = loadSession();
      setSessionStatus(session ? formatGracePeriod(session) : null);
    };
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, []);

  const handleSetDuressPin = async () => {
    setDuressBusy(true);
    setDuressMessage(null);
    const result = await authStore.setDuressPin(duressRealPin, duressNewPin);
    setDuressBusy(false);
    if (result.success) {
      setDuressMessage({ text: 'Duress PIN set.' });
      setDuressRealPin('');
      setDuressNewPin('');
      setShowDuressForm(false);
      await refreshDuressStatus();
    } else {
      setDuressMessage({ text: result.error || 'Failed to set duress PIN', error: true });
    }
  };

  const handleClearDuressPin = async () => {
    const pin = prompt('Enter your real PIN to remove the duress PIN:');
    if (!pin) return;
    setDuressBusy(true);
    const result = await authStore.clearDuressPin(pin);
    setDuressBusy(false);
    if (result.success) {
      setDuressMessage({ text: 'Duress PIN removed.' });
      await refreshDuressStatus();
    } else {
      setDuressMessage({ text: result.error || 'Failed to remove duress PIN', error: true });
    }
  };

  const handleAddKey = async () => {
    setAddingKey(true);
    setKeyError('');
    try {
      await addHardwareKey(authStore.currentRelayId || '');
      await refreshHardwareKeys();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to add hardware key');
    } finally {
      setAddingKey(false);
    }
  };

  const handleRevokeKey = async (credentialId: string) => {
    if (!confirm('Remove this hardware key? You will no longer be able to log in with it.')) return;
    setRevokingId(credentialId);
    setKeyError('');
    try {
      await revokeHardwareKey(credentialId);
      await refreshHardwareKeys();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Failed to remove hardware key');
    } finally {
      setRevokingId(null);
    }
  };

  // Step-up auth: the server now requires a live second factor (TOTP code or
  // WebAuthn assertion) in addition to the session cookie, mirroring login
  // (see app/api/auth/login/route.ts and app/api/auth/regenerate-recovery-code/route.ts).
  // For webauthn accounts the hardware-key tap itself *is* the fresh proof of
  // presence, so it's triggered immediately. For totp accounts we need a
  // freshly-typed code from the user's authenticator app, so an inline
  // confirm form is shown first.
  const handleRegenerate = async () => {
    if (!confirm('Regenerating your recovery code will invalidate the old one. Continue?')) return;
    setRegenerateError('');

    if (twoFactorMethod === 'webauthn') {
      setRegenerating(true);
      try {
        const assertion = await authenticateWithHardwareKey(authStore.currentRelayId || '');
        await performRegenerate({ webauthnAssertion: assertion });
      } catch (err) {
        log.error('Failed to regenerate:', err);
        alert('Failed: ' + (err instanceof Error ? err.message : 'Unknown'));
      } finally {
        setRegenerating(false);
      }
    } else {
      setRegenerateTotpEntry('');
      setShowRegenerateConfirm(true);
    }
  };

  const handleConfirmRegenerateTotp = async () => {
    if (regenerateTotpEntry.length !== 6) {
      setRegenerateError('Enter the 6-digit code from your authenticator app');
      return;
    }
    setRegenerating(true);
    setRegenerateError('');
    try {
      await performRegenerate({ totpCode: regenerateTotpEntry });
      setShowRegenerateConfirm(false);
      setRegenerateTotpEntry('');
    } catch (err) {
      log.error('Failed to regenerate:', err);
      setRegenerateError(err instanceof Error ? err.message : 'Failed to regenerate recovery code');
    } finally {
      setRegenerating(false);
    }
  };

  const performRegenerate = async (secondFactor: { totpCode?: string; webauthnAssertion?: unknown }) => {
    // The code and its hash are generated here, client-side (pure crypto, no
    // server secret needed — lib/crypto/recovery-code.ts), so the new hash
    // and the TOTP secret re-encrypted under it can be submitted together in
    // one request. Refuse outright rather than send a request the server
    // would otherwise have to accept with only half the data: a previous
    // two-step version of this flow could silently invalidate the old
    // recovery code without ever installing a working new one if the TOTP
    // secret wasn't available for the second step.
    const totpSecret = authStore.getTOTPSecret ? authStore.getTOTPSecret() : null;
    if (!totpSecret) {
      throw new Error('TOTP secret unavailable — try again after signing in fresh.');
    }

    const newCode = generateRecoveryCode();
    const recoveryCodeHash = hashRecoveryCode(newCode);
    const encBytes = encryptTOTPSecretForRecovery(totpSecret, newCode);
    const { bytesToHex } = await import('@noble/hashes/utils.js');
    const encryptedTOTPSecretForRecovery = bytesToHex(encBytes);

    const res = await fetch('/api/auth/regenerate-recovery-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relayId: authStore.currentRelayId,
        recoveryCodeHash,
        encryptedTOTPSecretForRecovery,
        ...secondFactor,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to regenerate recovery code');
    }

    setRecoveryCode(formatRecoveryCode(newCode));
    // Reveal it immediately — this is the one moment the code actually
    // exists to show. Nothing server-side ever stores it in reversible
    // form (only a hash — see the hint text above), so a later "Show"
    // click with no code generated this session would otherwise toggle
    // visibility of nothing, which read as broken rather than as "there's
    // nothing to show yet."
    setShowRecoveryCode(true);
  };

  const copyCode = async () => {
    if (!recoveryCode) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {}
  };

  return (
    <div>
      <SectionHeader title="Security" desc="Protect your account and session." />
      <div className="space-y-1">
        {sessionStatus && (
          <SettingRow
            label="Current session"
            hint="Time left before you're asked to re-enter your PIN."
            control={<span className="text-xs text-relay-text-secondary">{sessionStatus}</span>}
          />
        )}
        <SettingRow
          label="Auto-logout"
          hint="Sign out after a period of inactivity."
          control={
            <select
              value={autoLogout === null ? 'off' : String(autoLogout)}
              onChange={(e) => {
                const v = e.target.value;
                const next = v === 'off' ? null : parseInt(v, 10);
                setAutoLogout(next);
                setAutoLogoutSeconds(next);
              }}
              aria-label="Auto-logout"
              className="relay-input text-xs py-1 px-2"
            >
              {AUTO_LOGOUT_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value === null ? 'off' : String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          label="Lock on close"
          hint="Require PIN/biometric when reopening Relay."
          control={<Toggle checked={lockOnClose} ariaLabel="Lock on close" onChange={(v) => {
            setLockOnClose(v);
            try { localStorage.setItem('relay:setting:lock-on-close', v ? '1' : '0'); } catch {}
          }} />}
        />
      </div>

      <Divider />

      <p className="text-sm font-medium text-relay-text-primary mb-1">Recovery code</p>
      <p className="text-[11px] text-relay-text-muted mb-3">Your recovery code is hashed server-side. Generate a new one to replace the old.</p>

      {showRecoveryCode && recoveryCode && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 mb-3">
          <div className="rounded-md bg-relay-surface-hover p-3">
            <p className="text-[11px] text-relay-text-muted mb-1">New recovery code</p>
            <p className="font-mono text-xs text-relay-text-primary break-all select-all">{recoveryCode}</p>
          </div>
          <button onClick={copyCode} className="relay-btn-secondary w-full">
            {codeCopied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy code</>}
          </button>
        </motion.div>
      )}

      <div className="flex gap-2">
        {/* Only shown once a code actually exists this session (right after
            a Regenerate) — nothing is ever retrievable before that (server
            stores only a hash), so a "Show" button with no code generated
            yet would toggle visibility of nothing. */}
        {recoveryCode && (
          <button onClick={() => setShowRecoveryCode((v) => !v)} className="relay-btn-secondary flex-1">
            <Eye size={12} /> {showRecoveryCode ? 'Hide' : 'Show'}
          </button>
        )}
        <button onClick={handleRegenerate} disabled={regenerating} className="relay-btn-primary flex-1 disabled:opacity-40">
          {regenerating ? <><Loader2 size={12} className="animate-spin" /> Generating</> : <><RefreshCw size={12} /> Regenerate</>}
        </button>
      </div>

      {showRegenerateConfirm && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 mt-2">
          <p className="text-[11px] text-relay-text-muted">
            Confirm with your authenticator code to regenerate the recovery code.
          </p>
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit code"
            aria-label="6-digit authenticator code"
            value={regenerateTotpEntry}
            onChange={(e) => setRegenerateTotpEntry(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="relay-input w-full text-xs"
            autoFocus
          />
          {regenerateError && <p className="text-[11px] text-red-500">{regenerateError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => { setShowRegenerateConfirm(false); setRegenerateTotpEntry(''); setRegenerateError(''); }}
              disabled={regenerating}
              className="relay-btn-secondary flex-1 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmRegenerateTotp}
              disabled={regenerating || regenerateTotpEntry.length !== 6}
              className="relay-btn-primary flex-1 disabled:opacity-40"
            >
              {regenerating ? <><Loader2 size={12} className="animate-spin" /> Verifying</> : 'Confirm'}
            </button>
          </div>
        </motion.div>
      )}

      {!keysLoading && twoFactorMethod === 'webauthn' && (
        <>
          <Divider />
          <p className="text-sm font-medium text-relay-text-primary mb-1">Hardware keys</p>
          <p className="text-[11px] text-relay-text-muted mb-3">
            Keys used to sign in instead of an authenticator code. Keep at least one registered or you'll be locked out of normal login (recovery code still works).
          </p>

          {hardwareKeys.length > 0 && (
            <div className="space-y-2 mb-3">
              {hardwareKeys.map((key) => (
                <div key={key.credentialId} className="flex items-center gap-3 rounded-md bg-relay-surface-hover p-3">
                  <KeyRound size={16} className="text-relay-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-relay-text-primary">
                      Added {new Date(key.createdAt).toLocaleDateString()}
                    </p>
                    {key.transports && key.transports.length > 0 && (
                      <p className="text-[11px] text-relay-text-muted">{key.transports.join(', ')}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleRevokeKey(key.credentialId)}
                    disabled={revokingId === key.credentialId}
                    aria-label="Remove hardware key"
                    className="relay-btn-secondary shrink-0 disabled:opacity-40"
                  >
                    {revokingId === key.credentialId ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  </button>
                </div>
              ))}
            </div>
          )}

          {keyError && (
            <p className="text-[11px] text-red-500 mb-3">{keyError}</p>
          )}

          <button onClick={handleAddKey} disabled={addingKey} className="relay-btn-secondary w-full disabled:opacity-40">
            {addingKey ? <><Loader2 size={12} className="animate-spin" /> Waiting for key...</> : <><KeyRound size={12} /> Add hardware key</>}
          </button>
        </>
      )}

      <Divider />

      <p className="text-sm font-medium text-relay-text-primary mb-1">Duress PIN</p>
      <p className="text-[11px] text-relay-text-muted mb-3">
        A second PIN that, if entered at login, silently wipes this device instead of unlocking it —
        the screen looks exactly like a wrong PIN, so no one forcing you to unlock can tell the difference.
      </p>

      {duressMessage && (
        <p className={`text-[11px] mb-3 ${duressMessage.error ? 'text-red-500' : 'text-relay-text-muted'}`}>
          {duressMessage.text}
        </p>
      )}

      {!showDuressForm && (
        <button
          onClick={() => (duressPinSet ? handleClearDuressPin() : setShowDuressForm(true))}
          disabled={duressBusy}
          className="relay-btn-secondary w-full disabled:opacity-40"
        >
          <AlertTriangle size={12} /> {duressPinSet ? 'Remove duress PIN' : 'Set duress PIN'}
        </button>
      )}

      {showDuressForm && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-2 mb-2">
          <input
            type="password"
            inputMode="numeric"
            placeholder="Your real PIN"
            aria-label="Your real PIN"
            value={duressRealPin}
            onChange={(e) => setDuressRealPin(e.target.value)}
            className="relay-input w-full text-xs"
          />
          <input
            type="password"
            inputMode="numeric"
            placeholder="New duress PIN (different from real PIN)"
            aria-label="New duress PIN"
            value={duressNewPin}
            onChange={(e) => setDuressNewPin(e.target.value)}
            className="relay-input w-full text-xs"
          />
          <div className="flex gap-2">
            <button onClick={() => { setShowDuressForm(false); setDuressMessage(null); }} className="relay-btn-secondary flex-1">
              Cancel
            </button>
            <button
              onClick={handleSetDuressPin}
              disabled={duressBusy || !duressRealPin || !duressNewPin}
              className="relay-btn-primary flex-1 disabled:opacity-40"
            >
              {duressBusy ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
            </button>
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ─── Devices ────────────────────────────────────────────────────────────────

function DevicesSection() {
  const authStore = useRelayAuthStoreV2();
  const [paired, setPaired] = useState<ReturnType<typeof getPairedDevices>>([]);
  const [showQRMode, setShowQRMode] = useState<'show' | 'scan' | null>(null);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');

  useEffect(() => { setPaired(getPairedDevices()); }, []);

  const revoke = (id: string) => {
    if (!confirm(
      'Remove this device from your list?\n\n' +
      'This only removes it from the list shown here — it does NOT stop that ' +
      'device from continuing to sign in, decrypt messages, or send as you. ' +
      'If a device is lost or stolen, treat your identity as compromised: ' +
      'contact support about a full account re-key, or set a duress PIN and ' +
      'stop using this account on any device you don\'t fully trust.'
    )) return;
    revokePairedDevice(id);
    setPaired(getPairedDevices());
  };

  const handleIdentityReceived = useCallback((identity: { privateKeyHex: string; publicKeyHex: string; relayId: string; pqPrivateKeyHex?: string; pqPublicKeyHex?: string }) => {
    try {
      authStore.completeApiLogin(
        identity.privateKeyHex,
        identity.publicKeyHex,
        identity.relayId,
        identity.relayId,
        null,
        identity.pqPrivateKeyHex,
        identity.pqPublicKeyHex,
      );
      setImportStatus('success');
      setTimeout(() => setShowQRMode(null), 1500);
    } catch {
      setImportStatus('error');
    }
  }, [authStore]);

  return (
    <div>
      <SectionHeader title="Devices" desc="Paired devices synced with your account." />
      {importStatus === 'success' && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-relay-success/10 text-relay-success text-[11px] font-medium">
          Identity imported — you are now signed in on this device.
        </div>
      )}
      {importStatus === 'error' && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-relay-danger/10 text-relay-danger text-[11px]">
          Import failed. Try scanning again.
        </div>
      )}
      <div className="flex gap-2 mb-4">
        <button onClick={() => setShowQRMode('show')} className="relay-btn-primary flex-1">
          <Smartphone size={14} /> Show QR
        </button>
        <button onClick={() => setShowQRMode('scan')} className="relay-btn-secondary flex-1">
          <Camera size={14} /> Scan QR
        </button>
      </div>

      {showQRMode && (
        <div className="rounded-xl bg-relay-surface-hover p-4 mb-4">
          <DeviceSyncQR mode={showQRMode} onIdentityReceived={handleIdentityReceived} />
          <button onClick={() => setShowQRMode(null)} className="relay-btn-ghost w-full mt-3">Close</button>
        </div>
      )}

      <p className="text-sm font-medium text-relay-text-primary mb-1">Linked devices</p>
      <p className="text-[11px] text-relay-text-muted mb-2">
        This list is local to this device only — it isn't synced or enforced by the server.
        Removing a device from this list does not revoke its access; it can still sign in.
      </p>
      {paired.length === 0 ? (
        <p className="text-[11px] text-relay-text-muted">No devices linked.</p>
      ) : (
        <div className="space-y-1">
          {paired.map((d) => (
            <div key={d.deviceId} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md hover:bg-relay-surface-hover">
              <div className="flex items-center gap-2.5 min-w-0">
                <Smartphone size={14} className="text-relay-text-secondary shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm text-relay-text-primary truncate">{d.deviceName}</p>
                  <p className="text-[11px] text-relay-text-muted">Last sync {new Date(d.lastSyncAt).toLocaleString()}</p>
                </div>
              </div>
              <button onClick={() => revoke(d.deviceId)} className="relay-btn-danger text-xs px-2 py-1">Remove from list</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Data & storage ─────────────────────────────────────────────────────────

function DataSection() {
  const authStore = useRelayAuthStoreV2();
  const [exportPassword, setExportPassword] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleExport = async () => {
    if (!exportPassword) return alert('Enter a password');
    try {
      setExporting(true);
      const pk = toHex(authStore.getPrivateKey()!);
      const blob = await exportEncryptedBackup(pk, exportPassword);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `relay-backup-${new Date().toISOString().split('T')[0]}.relaybk`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportPassword('');
      alert('Backup exported');
    } catch (err) {
      alert('Export failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    } finally { setExporting(false); }
  };

  const handleImport = async () => {
    if (!importFile || !importPassword) return alert('File + password required');
    try {
      setImporting(true);
      const pk = toHex(authStore.getPrivateKey()!);
      await importEncryptedBackup(importFile, importPassword, pk);
      setImportFile(null); setImportPassword('');
      alert('Imported');
    } catch (err) {
      alert('Import failed: ' + (err instanceof Error ? err.message : 'Unknown'));
    } finally { setImporting(false); }
  };

  const clearCache = async () => {
    // Only the compression dictionary is a genuine, safe-to-clear cache
    // (self-heals by re-fetching/rebuilding on next use, per dictionary.ts).
    // Message history and ratchet/session state are NOT included here even
    // though they also live in IndexedDB — this is an E2E system with no
    // server-side re-sync source for either, so "clearing" them would be
    // real, unrecoverable data loss, not a cache clear.
    if (!confirm('Clear local cache? The compression dictionary will be re-downloaded next time you send a message.')) return;
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('relay:cache:')) localStorage.removeItem(k);
      });
      await clearDictionaryCache();
      alert('Cache cleared');
    } catch {
      alert('Failed to clear cache');
    }
  };

  const ready = getStorageReady();

  return (
    <div>
      <SectionHeader title="Data & storage" desc="Backup, import, and manage local data." />

      <div className="flex items-center gap-2 mb-4 text-[11px] text-relay-text-secondary">
        <span className={`w-2 h-2 rounded-full ${ready ? 'bg-relay-success' : 'bg-relay-danger'}`} />
        Storage {ready ? 'ready' : 'error'} — encrypted locally
      </div>

      <div className="flex items-start gap-2 text-[11px] text-relay-text-secondary mb-3">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <p>Backups contain your identity. Store in a password manager or encrypted drive.</p>
      </div>

      <p className="text-sm font-medium text-relay-text-primary mb-2 flex items-center gap-1.5"><Download size={12} /> Export backup</p>
      <div className="space-y-2 mb-4">
        <input type="password" value={exportPassword} onChange={(e) => setExportPassword(e.target.value)} placeholder="Export password" aria-label="Export password" className="relay-input w-full" />
        <button onClick={handleExport} disabled={exporting || !exportPassword} className="relay-btn-primary w-full">
          {exporting ? <><Loader2 size={12} className="animate-spin" /> Exporting</> : <><Download size={12} /> Export</>}
        </button>
      </div>

      <Divider />

      <p className="text-sm font-medium text-relay-text-primary mb-2 flex items-center gap-1.5"><Upload size={12} /> Import backup</p>
      <div className="space-y-2 mb-4">
        <input type="file" accept=".relaybk" onChange={(e) => setImportFile(e.target.files?.[0] || null)} aria-label="Backup file to import" className="relay-input w-full file:bg-relay-surface-hover file:text-relay-text-primary file:border-0 file:rounded file:px-2 file:py-1 file:mr-3 file:text-xs" />
        <input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} placeholder="Backup password" aria-label="Backup password" className="relay-input w-full" />
        <button onClick={handleImport} disabled={importing || !importFile || !importPassword} className="relay-btn-secondary w-full">
          {importing ? <><Loader2 size={12} className="animate-spin" /> Importing</> : <><Upload size={12} /> Import</>}
        </button>
      </div>

      <Divider />

      <button onClick={clearCache} className="relay-btn-danger w-full"><Trash2 size={12} /> Clear local cache</button>
    </div>
  );
}

// ─── Sync (Vault) ───────────────────────────────────────────────────────────

function SyncSection() {
  const authStore = useRelayAuthStoreV2();
  const [enabled, setEnabled] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const en = await isVaultEnabled();
      const ls = await getLastSyncTime();
      if (!cancelled) { setEnabled(en); setLastSync(ls); }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = async (next: boolean) => {
    try {
      if (next) {
        const pk = authStore.getPrivateKey();
        if (!pk) return alert('Missing encryption key.');
        await enableVault(pk);
      } else {
        disableVault();
      }
      setEnabled(next);
    } catch {
      alert('Failed to update vault setting. Try again.');
    }
  };

  const handleSyncNow = async () => {
    const pk = authStore.getPrivateKey();
    if (!pk) return;
    setSyncing(true);
    try {
      await pushToVault(pk);
      const ls = await getLastSyncTime();
      setLastSync(ls);
    } catch {
      alert('Sync failed. Check your connection and try again.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteVault = async () => {
    if (!confirm('Delete vault backup? This cannot be undone.')) return;
    const pk = authStore.getPrivateKey();
    if (!pk) return;
    try {
      await deleteVault(pk);
      setEnabled(false);
      disableVault();
    } catch {
      alert('Failed to delete vault. Try again.');
    }
  };

  return (
    <div>
      <SectionHeader title="Sync (Vault)" desc="Optional encrypted cloud backup." />
      <div className="flex items-start gap-2 text-[11px] text-relay-text-secondary mb-4">
        <Info size={12} className="mt-0.5 shrink-0" />
        <p>Your data is encrypted end-to-end. The server cannot read your content.</p>
      </div>

      <SettingRow
        label="Enable Relay Vault"
        hint="Encrypted cloud backup, auto-sync every 5 minutes."
        control={<Toggle checked={enabled} ariaLabel="Enable Vault" onChange={toggle} />}
      />

      {enabled && (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-[11px] text-relay-text-secondary">
            <Check size={12} className="text-relay-success" />
            Vault enabled {lastSync && `— last sync ${new Date(lastSync).toLocaleString()}`}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={handleSyncNow} disabled={syncing} className="relay-btn-secondary">
              {syncing ? <><Loader2 size={12} className="animate-spin" /> Syncing…</> : <><RefreshCw size={12} /> Sync now</>}
            </button>
            <button onClick={handleDeleteVault} className="relay-btn-danger"><Trash2 size={12} /> Delete vault</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── About ──────────────────────────────────────────────────────────────────

function AboutSection() {
  const version = '1.0.0';
  return (
    <div>
      <SectionHeader title="About" desc="Relay information and legal." />
      <div className="space-y-2 text-xs text-relay-text-secondary">
        <p><span className="text-relay-text-muted">Version</span> — {version}</p>
        <p><span className="text-relay-text-muted">Made by</span> — Arcel</p>
      </div>

      <Divider />

      <div className="space-y-2">
        <a href="https://github.com/" target="_blank" rel="noreferrer" className="relay-btn-secondary w-full">Open source repository</a>
        <a href="/legal/privacy" className="relay-btn-secondary w-full">Privacy policy</a>
        <a href="/legal/terms" className="relay-btn-secondary w-full">Terms of service</a>
      </div>
    </div>
  );
}
