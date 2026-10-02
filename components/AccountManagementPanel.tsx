/**
 * Account Management Panel Component
 * Replaces the message thread when account management is active
 * Integrated into the main app layout
 */

'use client';

import React, { useState, useEffect } from 'react';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { copyToClipboard } from '@/lib/utils';
import {
  getAccountProfile,
  refreshAccountProfile,
  claimUsername,
  releaseUsername,
  updateDisplayName,
  updateBio,
  toggleUnlistedStatus,
  getProfileDisplayInfo,
  initializeAccountProfile,
  generateShortCode,
  removeShortCode,
} from '@/lib/auth/account-manager';
import { Copy, Check, Lock, Unlock, Save, X } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { log } from '@/lib/platform/logger';

interface AccountPanelProps {
  onClose?: () => void;
}

export function AccountManagementPanel({ onClose }: AccountPanelProps) {
  const authStore = useRelayAuthStoreV2();
  const relayId = authStore.currentRelayId || '';

  // State
  const [profile, setProfile] = useState(getAccountProfile(relayId) || initializeAccountProfile(relayId));
  const [displayName, setDisplayName] = useState(profile.displayName || '');
  const [bio, setBio] = useState(profile.bio || '');
  const [username, setUsername] = useState('');
  const [copied, setCopied] = useState(false);
  const [claimingUsername, setClaimingUsername] = useState(false);
  const [generatingShortCode, setGeneratingShortCode] = useState(false);
  const [shortCodeCopied, setShortCodeCopied] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<'profile' | 'username' | 'privacy'>('profile');

  const displayInfo = getProfileDisplayInfo(relayId);

  useEffect(() => {
    if (!relayId) return;

    let cancelled = false;
    refreshAccountProfile(relayId).then((updated) => {
      if (!cancelled) {
        setProfile(updated);
        setDisplayName(updated.displayName || '');
        setBio(updated.bio || '');
      }
    }).catch((err) => {
      log.warn('Profile refresh failed:', err);
    });

    return () => {
      cancelled = true;
    };
  }, [relayId]);

  // Copy ID to clipboard
  const handleCopyId = async () => {
    await copyToClipboard(relayId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Update display name and bio
  const handleSaveProfile = async () => {
    setError(null);
    setSuccess(null);
    setSavingProfile(true);

    try {
      const updatedName = await updateDisplayName(relayId, displayName);
      const updated = await updateBio(relayId, bio);
      setProfile(updated);
      setDisplayName(updatedName.displayName || '');
      setSuccess('✓ Profile updated successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setSavingProfile(false);
    }
  };

  // Claim username
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
        const updated = getAccountProfile(relayId);
        if (updated) setProfile(updated);
        setUsername('');
        setSuccess(`✓ Username @${trimmed} claimed successfully!`);
        setTimeout(() => setTab('profile'), 1500);
      } else {
        setError(result.error || 'Failed to claim username');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to claim username');
    } finally {
      setClaimingUsername(false);
    }
  };

  // Release username
  const handleReleaseUsername = async () => {
    if (confirm(`Release @${profile.username}?`)) {
      try {
        setError(null);
        await releaseUsername(relayId);
        const updated = getAccountProfile(relayId);
        if (updated) setProfile(updated);
        setSuccess('✓ Username released');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to release username');
      }
    }
  };

  // Generate short code — server picks + retries on collision, no
  // user-typed value to validate here (unlike username).
  const handleGenerateShortCode = async () => {
    setError(null);
    setSuccess(null);
    setGeneratingShortCode(true);
    try {
      const result = await generateShortCode(relayId);
      if (result.success) {
        const updated = getAccountProfile(relayId);
        if (updated) setProfile(updated);
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
        const updated = getAccountProfile(relayId);
        if (updated) setProfile(updated);
        setSuccess('✓ Short code removed');
      } else {
        setError(result.error || 'Failed to remove short code');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove short code');
    }
  };

  const handleCopyShortCode = async () => {
    if (!profile.shortCode) return;
    await copyToClipboard(profile.shortCode);
    setShortCodeCopied(true);
    setTimeout(() => setShortCodeCopied(false), 2000);
  };

  // Toggle privacy
  const handleTogglePrivacy = async () => {
    try {
      setError(null);
      const updated = await toggleUnlistedStatus(relayId);
      setProfile(updated);
      setSuccess(updated.isUnlisted ? '✓ Privacy mode enabled' : '✓ Privacy mode disabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update privacy settings');
    }
  };

  const hasProfileChanges = displayName !== (profile.displayName || '') || bio !== (profile.bio || '');

  return (
    <div className="flex flex-col h-full bg-relay-bg rounded-xl border border-relay-border overflow-hidden">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-relay-bg/80 backdrop-blur-md border-b border-relay-border px-6 py-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold bg-relay-surface text-relay-text-primary">
          Account Settings
        </h1>
        {onClose && (
          <button
            onClick={onClose}
            className="p-2 bg-relay-surface-hover/60 hover:bg-red-500/20 border border-relay-border-light/60 hover:border-red-500/50 rounded-lg transition-all text-relay-text-secondary hover:text-red-600 dark:text-red-400"
            title="Close"
          >
            <X size={20} />
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Alert Messages */}
        <div className="px-6 pt-4 space-y-2">
          {error && (
            <div className="p-3 bg-red-500/15 border border-red-500/30 rounded-lg text-red-600 dark:text-red-400 text-sm flex items-start gap-2">
              <span className="text-lg mt-0.5" aria-hidden="true">⚠</span>
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="p-3 bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-emerald-600 dark:text-emerald-400 text-sm flex items-start gap-2">
              <span className="text-lg mt-0.5" aria-hidden="true">✓</span>
              <span>{success}</span>
            </div>
          )}
        </div>

        {/* Profile Hero Section */}
        <div className="px-6 py-6 border-b border-relay-border">
          <div className="flex items-start gap-6 mb-6">
            {/* Avatar */}
            <UserAvatar
              emoji={profile.avatarEmoji}
              color={profile.avatarColor}
              size={80}
              className="flex-shrink-0 shadow-lg shadow-relay-accent/20"
            />

            {/* Profile Info */}
            <div className="flex-1 pt-1">
              <h2 className="text-3xl font-bold text-relay-text-primary mb-1">{displayInfo.displayName}</h2>
              <p className="text-lg text-relay-accent font-semibold mb-3">{displayInfo.identifier}</p>

              {/* Status Badges */}
              <div className="flex flex-wrap gap-2">
                {profile.username && !profile.isUnlisted && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/15 border border-emerald-500/30 rounded-full text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    ✓ Username Claimed
                  </div>
                )}
                {profile.isUnlisted && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 border border-amber-500/30 rounded-full text-xs font-semibold text-amber-600 dark:text-amber-400">
                    Privacy Mode
                  </div>
                )}
                {!profile.username && (
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-relay-surface-hover/50 border border-relay-border-light rounded-full text-xs font-semibold text-relay-text-secondary">
                    ○ No Username
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Relay ID Section */}
          <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-lg p-4">
            <p className="text-xs font-semibold text-relay-text-secondary mb-2 uppercase tracking-wider">Your Relay ID</p>
            <div className="flex items-center gap-3">
              <code className="flex-1 text-sm font-mono text-relay-accent break-all">{relayId}</code>
              <button
                onClick={handleCopyId}
                className="p-2.5 hover:bg-relay-surface-hover rounded-lg transition-colors flex-shrink-0"
              >
                {copied ? (
                  <Check size={18} className="text-emerald-500" />
                ) : (
                  <Copy size={18} className="text-relay-text-secondary hover:text-relay-text-primary" />
                )}
              </button>
            </div>
            <p className="text-xs text-relay-text-muted mt-2">
              Your permanent anonymous identity. Share this to connect with friends.
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="sticky top-16 z-10 bg-relay-bg/80 backdrop-blur-md border-b border-relay-border px-6 flex gap-1">
          <button
            onClick={() => setTab('profile')}
            className={`px-4 py-3 font-semibold border-b-2 transition-colors text-sm ${
              tab === 'profile'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            Profile Info
          </button>
          <button
            onClick={() => setTab('username')}
            className={`px-4 py-3 font-semibold border-b-2 transition-colors text-sm ${
              tab === 'username'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            🔤 Username
          </button>
          <button
            onClick={() => setTab('privacy')}
            className={`px-4 py-3 font-semibold border-b-2 transition-colors text-sm ${
              tab === 'privacy'
                ? 'border-relay-accent text-relay-accent'
                : 'border-transparent text-relay-text-secondary hover:text-relay-text-secondary'
            }`}
          >
            Privacy
          </button>
        </div>

        {/* Tab Content */}
        <div className="px-6 py-6 space-y-6">
          {/* Profile Tab */}
          {tab === 'profile' && (
            <div className="space-y-6">
              {/* Display Name */}
              <div>
                <label className="block text-sm font-bold text-relay-text-secondary mb-3 uppercase tracking-wide">
                  Display Name
                </label>
                <div className="space-y-2">
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => {
                      setDisplayName(e.target.value.slice(0, 100));
                      setSuccess(null);
                    }}
                    placeholder="e.g., Alice Smith"
                    maxLength={100}
                    className="w-full px-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent transition-all"
                  />
                  <p className="text-xs text-relay-text-muted">
                    {displayName.length}/100 • Your friendly name shown to contacts
                  </p>
                </div>
              </div>

              {/* Bio */}
              <div>
                <label className="block text-sm font-bold text-relay-text-secondary mb-3 uppercase tracking-wide">
                  📝 Bio
                </label>
                <div className="space-y-2">
                  <textarea
                    value={bio}
                    onChange={(e) => {
                      setBio(e.target.value.slice(0, 500));
                      setSuccess(null);
                    }}
                    placeholder="Tell your contacts about yourself..."
                    maxLength={500}
                    rows={5}
                    className="w-full px-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent transition-all resize-none"
                  />
                  <p className="text-xs text-relay-text-muted">
                    {bio.length}/500 • Optional personal bio
                  </p>
                </div>
              </div>

              {/* Save Button */}
              <button
                onClick={handleSaveProfile}
                disabled={savingProfile || !hasProfileChanges}
                className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={18} />
                {savingProfile ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}

          {/* Username Tab */}
          {tab === 'username' && (
            <div className="space-y-6">
              {profile.username ? (
                <div className="space-y-4">
                  <div className="p-6 bg-emerald-500/15 border border-emerald-500/30 rounded-xl">
                    <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 mb-2">✓ Username Claimed</p>
                    <p className="text-4xl font-bold text-emerald-700 dark:text-emerald-300 my-3">@{profile.username}</p>
                    <p className="text-sm text-emerald-600/80 dark:text-emerald-400/80">
                      Friends can message you using @{profile.username}
                    </p>
                  </div>

                  <button
                    onClick={handleReleaseUsername}
                    className="w-full px-4 py-3 bg-amber-500/15 hover:bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-lg font-semibold transition-all"
                  >
                    📌 Release This Username
                  </button>

                  <p className="text-xs text-relay-text-muted text-center">
                    Released usernames become available for others to claim
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 bg-blue-500/15 border border-blue-500/30 rounded-lg text-sm text-blue-600 dark:text-blue-400">
                    Claim a unique @username so friends can find you easily. Your Relay ID stays forever.
                  </div>

                  <div>
                    <label className="block text-sm font-bold text-relay-text-secondary mb-3 uppercase tracking-wide">
                      Choose Username
                    </label>
                    <div className="flex gap-2">
                      <div className="flex-1 relative">
                        <span className="absolute left-4 top-3 text-relay-text-secondary font-bold text-lg">@</span>
                        <input
                          type="text"
                          value={username}
                          onChange={(e) => {
                            setUsername(e.target.value.toLowerCase());
                            setError(null);
                          }}
                          placeholder="yourname"
                          maxLength={20}
                          className="w-full pl-8 pr-4 py-3 bg-relay-surface-hover/50 border border-relay-border-light rounded-lg text-relay-text-primary placeholder-relay-text-muted focus:outline-none focus:ring-2 focus:ring-relay-accent focus:border-transparent transition-all"
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
                    className="w-full px-4 py-3 bg-relay-accent hover:bg-relay-accent/90 text-relay-accent-foreground rounded-lg font-semibold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {claimingUsername ? 'Claiming...' : '🎯 Claim Username'}
                  </button>
                </div>
              )}

              {/* Short Code — opt-in, server-generated alternative to
                  sharing the full (long, intentionally-obscure) Relay ID. */}
              <div className="pt-2 border-t border-relay-border-light space-y-4">
                <p className="text-sm font-bold text-relay-text-secondary uppercase tracking-wide">Short Code</p>
                <p className="text-xs text-relay-text-muted -mt-2">
                  A short, easy-to-share code so people can add you without typing your full Relay ID. Optional.
                </p>
                {profile.shortCode ? (
                  <div className="space-y-3">
                    <div className="p-4 bg-relay-surface-hover/40 border border-relay-border-light rounded-lg flex items-center gap-3 font-mono text-lg text-relay-accent">
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
                      className="w-full px-4 py-2 bg-amber-500/15 hover:bg-amber-500/15 border border-amber-500/30 text-amber-600 dark:text-amber-400 rounded-lg font-semibold transition-all text-sm"
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
            </div>
          )}

          {/* Privacy Tab */}
          {tab === 'privacy' && (
            <div className="space-y-6">
              {/* Privacy Mode Toggle */}
              <div>
                <label className="block text-sm font-bold text-relay-text-secondary mb-4 uppercase tracking-wide">
                  Privacy Mode
                </label>

                <div className="bg-relay-surface-hover/40 border border-relay-border-light rounded-xl p-6">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex-1">
                      <p className="font-semibold text-relay-text-primary">Unlisted Profile</p>
                      <p className="text-sm text-relay-text-secondary mt-1">
                        Hide your username from directory listings
                      </p>
                    </div>
                    <button
                      onClick={handleTogglePrivacy}
                      className={`px-6 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 ${
                        profile.isUnlisted
                          ? 'bg-amber-500/15 hover:bg-amber-600 text-white'
                          : 'bg-relay-surface-hover/50 hover:bg-relay-surface-hover text-relay-text-secondary'
                      }`}
                    >
                      {profile.isUnlisted ? (
                        <>
                          <Lock size={16} />
                          Enabled
                        </>
                      ) : (
                        <>
                          <Unlock size={16} />
                          Disabled
                        </>
                      )}
                    </button>
                  </div>

                  {profile.isUnlisted && (
                    <div className="mt-4 p-3 bg-amber-500/15 border border-amber-500/30 rounded-lg text-sm text-amber-600 dark:text-amber-400">
                      Your username won't appear in searches or public profiles. Friends can still message you directly
                      using @{profile.username} or your Relay ID.
                    </div>
                  )}

                  {!profile.isUnlisted && profile.username && (
                    <div className="mt-4 p-3 bg-emerald-500/15 border border-emerald-500/30 rounded-lg text-sm text-emerald-600 dark:text-emerald-400">
                      ✓ Your username @{profile.username} is publicly listed and searchable.
                    </div>
                  )}
                </div>
              </div>

              {/* Privacy Info */}
              <div className="space-y-3">
                <p className="text-sm font-bold text-relay-text-secondary uppercase tracking-wide">Privacy Features</p>
                <div className="space-y-2">
                  <div className="flex gap-3 p-3 bg-relay-surface-hover/30 rounded-lg">
                    <span className="text-lg"></span>
                    <div>
                      <p className="text-sm font-semibold text-relay-text-primary">End-to-End Encryption</p>
                      <p className="text-xs text-relay-text-muted">All your messages are encrypted</p>
                    </div>
                  </div>
                  <div className="flex gap-3 p-3 bg-relay-surface-hover/30 rounded-lg">
                    <span className="text-lg"></span>
                    <div>
                      <p className="text-sm font-semibold text-relay-text-primary">Anonymous Identity</p>
                      <p className="text-xs text-relay-text-muted">Your Relay ID is permanent and unchangeable</p>
                    </div>
                  </div>
                  <div className="flex gap-3 p-3 bg-relay-surface-hover/30 rounded-lg">
                    <span className="text-lg">🎯</span>
                    <div>
                      <p className="text-sm font-semibold text-relay-text-primary">Optional Username</p>
                      <p className="text-xs text-relay-text-muted">Username can be claimed, released, or hidden</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
