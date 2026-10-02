'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import {
  getAccountProfile,
  refreshAccountProfile,
  claimUsername,
  releaseUsername,
  toggleUnlistedStatus,
  updateDisplayName,
  updateBio,
  getProfileDisplayInfo,
  initializeAccountProfile,
  generateShortCode,
  removeShortCode,
} from '@/lib/auth/account-manager';
import { Copy, Check, LogOut, ArrowLeft } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { SettingsPanel } from '@/components/SettingsPanel';
import { copyToClipboard } from '@/lib/utils';
import { getShortHash } from '@/lib/messaging/relay-display';
import { log } from '@/lib/platform/logger';

export default function AccountPage() {
  const router = useRouter();
  const authStore = useRelayAuthStoreV2();
  const relayId = authStore.currentRelayId || '';

  const [mounted, setMounted] = useState(false);
  const [profile, setProfile] = useState(() => (relayId ? getAccountProfile(relayId) || initializeAccountProfile(relayId) : null));
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [bio, setBio] = useState(profile?.bio || '');
  const [username, setUsername] = useState('');
  const [copied, setCopied] = useState(false);
  const [claimingUsername, setClaimingUsername] = useState(false);
  const [generatingShortCode, setGeneratingShortCode] = useState(false);
  const [shortCodeCopied, setShortCodeCopied] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'profile' | 'privacy' | 'profile-data'>('profile');

  // Only check authentication after client mount to avoid SSR issues
  useEffect(() => {
    setMounted(true);
    if (!relayId) {
      router.push('/auth/login');
      return;
    }

    let cancelled = false;
    refreshAccountProfile(relayId)
      .then((updated) => {
        if (!cancelled) {
          setProfile(updated);
          setDisplayName(updated.displayName || '');
          setBio(updated.bio || '');
        }
      })
      .catch((err) => {
        log.warn('Failed to refresh account profile:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [relayId, router]);

  // Don't render until mounted and authenticated
  if (!mounted || !relayId || !profile) {
    return null;
  }

  // Refresh profile
  const refreshProfile = () => {
    const updated = getAccountProfile(relayId);
    if (updated) {
      setProfile(updated);
    }
  };

  // Copy ID to clipboard
  const handleCopyId = async () => {
    await copyToClipboard(relayId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle display name update
  const handleUpdateDisplayName = async () => {
    setError(null);
    setSuccess(null);
    setLoadingProfile(true);

    try {
      if (displayName.trim().length > 100) {
        throw new Error('Display name must be 100 characters or less');
      }

      const updated = await updateDisplayName(relayId, displayName);
      setProfile(updated);
      setSuccess('✓ Display name updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update display name');
    } finally {
      setLoadingProfile(false);
    }
  };

  // Handle bio update
  const handleUpdateBio = async () => {
    setError(null);
    setSuccess(null);
    setLoadingProfile(true);

    try {
      if (bio.trim().length > 500) {
        throw new Error('Bio must be 500 characters or less');
      }

      const updated = await updateBio(relayId, bio);
      setProfile(updated);
      setSuccess('✓ Bio updated');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update bio');
    } finally {
      setLoadingProfile(false);
    }
  };

  // Handle username claim
  const handleClaimUsername = async () => {
    const trimmed = username.trim().toLowerCase();
    setError(null);
    setSuccess(null);

    if (!trimmed) {
      setError('Username is required');
      return;
    }

    setClaimingUsername(true);

    try {
      const result = await claimUsername(relayId, trimmed);
      if (result.success) {
        refreshProfile();
        setUsername('');
        setSuccess(`✓ Username @${trimmed} claimed successfully!`);
      } else {
        setError(result.error || 'Failed to claim username');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim username');
    } finally {
      setClaimingUsername(false);
    }
  };

  // Handle release username
  const handleReleaseUsername = async () => {
    if (!profile) return;
    if (confirm(`Release @${profile.username}? You can claim a different one later.`)) {
      try {
        setError(null);
        await releaseUsername(relayId);
        refreshProfile();
        setSuccess('✓ Username released');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to release username');
      }
    }
  };

  // Handle short-code generation — server picks + retries on collision, so
  // there's no user-typed value to validate here (unlike username).
  const handleGenerateShortCode = async () => {
    setError(null);
    setSuccess(null);
    setGeneratingShortCode(true);
    try {
      const result = await generateShortCode(relayId);
      if (result.success) {
        refreshProfile();
        setSuccess('✓ Short code generated');
      } else {
        setError(result.error || 'Failed to generate short code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate short code');
    } finally {
      setGeneratingShortCode(false);
    }
  };

  const handleRemoveShortCode = async () => {
    if (!confirm('Remove your short code? You can generate a new one later.')) return;
    try {
      setError(null);
      const result = await removeShortCode(relayId);
      if (result.success) {
        refreshProfile();
        setSuccess('✓ Short code removed');
      } else {
        setError(result.error || 'Failed to remove short code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove short code');
    }
  };

  const handleCopyShortCode = async () => {
    if (!profile?.shortCode) return;
    await copyToClipboard(profile.shortCode);
    setShortCodeCopied(true);
    setTimeout(() => setShortCodeCopied(false), 2000);
  };

  // Handle privacy toggle
  const handlePrivacyToggle = async () => {
    if (!profile) return;
    try {
      setError(null);
      const updated = await toggleUnlistedStatus(relayId);
      setProfile(updated);
      setSuccess(updated.isUnlisted ? '✓ Privacy enabled - your username is hidden' : '✓ Privacy disabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update privacy settings');
    }
  };

  // Handle logout
  const handleLogout = () => {
    if (confirm('Sign out? You can sign back in anytime.')) {
      authStore.logout();
      router.push('/auth/login');
    }
  };

  const displayInfo = getProfileDisplayInfo(relayId);

  return (
    <div className="min-h-screen bg-relay-bg text-relay-text-primary">
      {/* Header */}
      <div className="sticky top-0 z-40 bg-relay-bg/80 backdrop-blur-md border-b border-relay-border">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-relay-surface-hover rounded-lg transition-colors flex items-center gap-2 text-relay-text-secondary hover:text-relay-text-primary"
          >
            <ArrowLeft size={20} />
            <span className="text-sm">Back to Chat</span>
          </button>
          <h1 className="text-2xl font-bold bg-relay-surface text-relay-text-primary">
            Account Settings
          </h1>
          <button
            onClick={handleLogout}
            aria-label="Sign out"
            title="Sign out"
            className="p-2 hover:bg-red-500/15 rounded-lg transition-colors flex items-center gap-2 text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-300"
          >
            <LogOut size={20} />
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Alert Messages */}
        {error && (
          <div className="mb-6 p-4 bg-red-500/15 border border-red-500/30 rounded-lg text-red-600 dark:text-red-400 text-sm flex items-start gap-3">
            <span className="text-xl mt-0.5" aria-hidden="true">⚠</span>
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="mb-6 p-4 bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-emerald-600 dark:text-emerald-400 text-sm flex items-start gap-3">
            <span className="text-xl mt-0.5">✓</span>
            <span>{success}</span>
          </div>
        )}

        {/* Profile Card */}
        <div className="mb-8 bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-8">
          <div className="flex items-center gap-6 mb-8">
            <UserAvatar
              emoji={profile?.avatarEmoji}
              color={profile?.avatarColor}
              size={96}
            />
            <div className="flex-1">
              <h2 className="text-4xl font-bold text-relay-text-primary mb-2">{displayInfo.displayName}</h2>
              <p className="text-lg text-relay-text-secondary mb-3">{displayInfo.identifier}</p>
              {profile.isUnlisted && (
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-full text-xs font-semibold text-amber-600 dark:text-amber-400">
                  Privacy Mode Enabled
                </div>
              )}
            </div>
          </div>

          {/* Relay ID Section */}
          <div className="border-t border-relay-border-light pt-6">
            <h3 className="text-sm font-semibold text-relay-text-secondary mb-3 uppercase tracking-wide">Your Relay ID</h3>
            <div className="flex items-center gap-3 p-4 bg-relay-surface/50 border border-relay-border-light rounded-lg font-mono text-sm text-relay-accent">
              <code className="flex-1 break-all">{relayId}</code>
              <button
                onClick={handleCopyId}
                className="p-2 hover:bg-relay-surface-hover rounded-lg transition-colors flex-shrink-0"
                title="Copy to clipboard"
              >
                {copied ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
              </button>
            </div>
            <p className="text-xs text-relay-text-muted mt-2">
              Share this ID with friends to connect. This is your permanent anonymous identity.
            </p>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div role="tablist" aria-label="Account settings sections" className="flex gap-2 mb-8 border-b border-relay-border">
          <button
            role="tab"
            id="tab-profile"
            aria-selected={activeSection === 'profile'}
            aria-controls="panel-profile"
            onClick={() => setActiveSection('profile')}
            className={`px-6 py-3 font-semibold border-b-2 transition-colors ${
              activeSection === 'profile'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            Profile Information
          </button>
          <button
            role="tab"
            id="tab-privacy"
            aria-selected={activeSection === 'privacy'}
            aria-controls="panel-privacy"
            onClick={() => setActiveSection('privacy')}
            className={`px-6 py-3 font-semibold border-b-2 transition-colors ${
              activeSection === 'privacy'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            Privacy & Display
          </button>
          <button
            role="tab"
            id="tab-profile-data"
            aria-selected={activeSection === 'profile-data'}
            aria-controls="panel-profile-data"
            onClick={() => setActiveSection('profile-data')}
            className={`px-6 py-3 font-semibold border-b-2 transition-colors ${
              activeSection === 'profile-data'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            Profile Data
          </button>
        </div>

        {/* Profile Information Tab */}
        {activeSection === 'profile' && (
          <div id="panel-profile" role="tabpanel" aria-labelledby="tab-profile" className="space-y-8">
            {/* Display Name */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">Display Name</h3>
              <p className="text-sm text-relay-text-secondary mb-4">
                Set a friendly name that appears to your contacts. Leave blank to use your username or ID.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold text-relay-text-secondary mb-2">Display Name</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value.slice(0, 100))}
                    placeholder="e.g., Alice Smith"
                    maxLength={100}
                    className="w-full px-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent"
                  />
                  <p className="text-xs text-relay-text-muted mt-1">
                    {displayName.length}/100 characters
                  </p>
                </div>
                <button
                  onClick={handleUpdateDisplayName}
                  disabled={loadingProfile || displayName === (profile.displayName || '')}
                  className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingProfile ? 'Updating...' : '✓ Save Display Name'}
                </button>
              </div>
            </div>

            {/* Username Claim */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">🔤 Custom Username</h3>
              <p className="text-sm text-relay-text-secondary mb-4">
                Claim a unique @username that your friends can use to find you. You keep your Relay ID too!
              </p>

              {profile.username ? (
                <div className="space-y-4">
                  <div className="p-4 bg-emerald-500/15 border border-emerald-500/30 rounded-lg">
                    <p className="text-sm text-emerald-600 dark:text-emerald-400 font-semibold">✓ Username Claimed</p>
                    <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300 mt-2">@{profile.username}</p>
                    <p className="text-xs text-emerald-600/70 dark:text-emerald-400/70 mt-2">
                      Your friends can use @{profile.username} to message you.
                    </p>
                  </div>
                  <button
                    onClick={handleReleaseUsername}
                    className="w-full px-4 py-2 bg-amber-500/15 hover:bg-amber-600 text-white rounded-lg font-semibold transition-all text-sm"
                  >
                    📌 Release Username
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-semibold text-relay-text-secondary mb-2">Username</label>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <span className="absolute left-3 top-3 text-relay-text-secondary font-semibold">@</span>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => {
                            setUsername(e.target.value.toLowerCase());
                            setError(null);
                          }}
                          placeholder="myusername"
                          maxLength={20}
                          className="w-full pl-7 pr-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-relay-text-muted mt-2">
                      1-20 characters • Letters, numbers, underscore only
                    </p>
                  </div>
                  <button
                    onClick={handleClaimUsername}
                    disabled={claimingUsername || !username.trim()}
                    className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {claimingUsername ? 'Claiming...' : '🎯 Claim Username'}
                  </button>
                </div>
              )}
            </div>

            {/* Short Code — opt-in, server-generated alternative to sharing
                the full (long, intentionally-obscure) Relay ID. */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">🔢 Short Code</h3>
              <p className="text-sm text-relay-text-secondary mb-4">
                A short, easy-to-share code so people can add you without typing your full Relay ID. Optional.
              </p>

              {profile.shortCode ? (
                <div className="space-y-4">
                  <div className="p-4 bg-relay-surface/50 border border-relay-border-light rounded-lg flex items-center gap-3 font-mono text-lg text-relay-accent">
                    <code className="flex-1">{profile.shortCode}</code>
                    <button
                      onClick={handleCopyShortCode}
                      className="p-2 hover:bg-relay-surface-hover rounded-lg transition-colors flex-shrink-0"
                      title="Copy to clipboard"
                    >
                      {shortCodeCopied ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
                    </button>
                  </div>
                  <button
                    onClick={handleRemoveShortCode}
                    className="w-full px-4 py-2 bg-amber-500/15 hover:bg-amber-600 text-white rounded-lg font-semibold transition-all text-sm"
                  >
                    Remove Short Code
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleGenerateShortCode}
                  disabled={generatingShortCode}
                  className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generatingShortCode ? 'Generating...' : '🔢 Generate Short Code'}
                </button>
              )}
            </div>

            {/* Bio */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">📝 Bio</h3>
              <p className="text-sm text-relay-text-secondary mb-4">
                Add a personal bio to tell your contacts about yourself.
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold text-relay-text-secondary mb-2">Bio</label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value.slice(0, 500))}
                    placeholder="Tell us about yourself..."
                    maxLength={500}
                    rows={4}
                    className="w-full px-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent resize-none"
                  />
                  <p className="text-xs text-relay-text-muted mt-1">
                    {bio.length}/500 characters
                  </p>
                </div>
                <button
                  onClick={handleUpdateBio}
                  disabled={loadingProfile || bio === (profile.bio || '')}
                  className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingProfile ? 'Updating...' : '✓ Save Bio'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Privacy & Display Tab */}
        {activeSection === 'privacy' && (
          <div id="panel-privacy" role="tabpanel" aria-labelledby="tab-privacy" className="space-y-8">
            {/* Unlisted/Privacy Mode */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">Privacy Mode</h3>
              <p className="text-sm text-relay-text-secondary mb-6">
                Enable privacy mode to hide your claimed username. Your friends can still message you using your Relay ID, but your username won't appear in searches.
              </p>

              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-relay-surface-hover/40 border border-relay-border-light rounded-lg hover:bg-relay-surface-hover/60 transition-colors">
                  <div>
                    <label htmlFor="privacy-unlisted" className="block font-semibold text-relay-text-primary cursor-pointer">Unlisted (Privacy Mode)</label>
                    <p id="privacy-unlisted-desc" className="text-sm text-relay-text-muted">Hide your username from listings</p>
                  </div>
                  <input
                    id="privacy-unlisted"
                    type="checkbox"
                    checked={profile.isUnlisted}
                    onChange={handlePrivacyToggle}
                    aria-describedby="privacy-unlisted-desc"
                    className="w-6 h-6 rounded cursor-pointer accent-relay-accent"
                  />
                </div>

                {profile.isUnlisted && (
                  <div className="p-4 bg-amber-500/15 border border-amber-500/30 rounded-lg">
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      <span className="font-semibold">✓ Privacy Enabled</span>
                      <br />
                      Your username won't appear in public listings or searches. Friends can still message you directly with your Relay ID or claimed username.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Display Settings */}
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">How You're Displayed</h3>
              <div className="space-y-4">
                <div className="p-4 bg-relay-surface-hover/30 rounded-lg border border-relay-border-light/30">
                  <p className="text-xs font-semibold text-relay-text-secondary mb-2">PRIMARY DISPLAY NAME:</p>
                  <p className="text-lg font-semibold text-relay-text-primary">
                    {profile.displayName || profile.username || getShortHash(relayId)}
                  </p>
                </div>

                <div className="p-4 bg-relay-surface-hover/30 rounded-lg border border-relay-border-light/30">
                  <p className="text-xs font-semibold text-relay-text-secondary mb-2">IDENTIFIER:</p>
                  <p className="text-lg font-semibold text-relay-accent">
                    {profile.isUnlisted || !profile.username ? relayId : `@${profile.username}`}
                  </p>
                </div>

                {profile.displayName && (
                  <div className="p-4 bg-relay-surface-hover/30 rounded-lg border border-relay-border-light/30">
                    <p className="text-xs font-semibold text-relay-text-secondary mb-2">FALLBACK:</p>
                    <p className="text-sm text-relay-text-muted">Relay ID will be shown if display name is unavailable</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Full settings panel (devices, security, vault, appearance, backup) */}
        <div className="mt-8">
          <SettingsPanel />
        </div>

        {/* Profile Data Tab */}
        {activeSection === 'profile-data' && (
          <div id="panel-profile-data" role="tabpanel" aria-labelledby="tab-profile-data" className="space-y-6">
            <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
              <h3 className="text-lg font-bold text-relay-text-primary mb-4">📊 Profile Data</h3>
              <p className="text-sm text-relay-text-secondary mb-6">
                Your profile information is stored locally and encrypted. Here's what we have on file:
              </p>

              <div className="space-y-4">
                <div className="p-4 bg-relay-surface/50 border border-relay-border-light/30 rounded-lg font-mono text-sm text-relay-text-secondary overflow-auto max-h-96">
                  <pre>{JSON.stringify(profile, null, 2)}</pre>
                </div>

                <div className="p-4 bg-blue-500/15 border border-blue-500/30 rounded-lg text-sm text-blue-600 dark:text-blue-400">
                  Your profile is stored securely in your browser's local storage and is encrypted end-to-end.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
