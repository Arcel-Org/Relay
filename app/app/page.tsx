'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { loadSession } from '@/lib/auth/session-persistence';
import { hexToBytes, bytesToHex as toHex } from '@noble/hashes/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { MessagingProvider, useMessagingData, useMessagingActions, useMessagingConnection } from '@/lib/messaging/messaging-context';
import { useWebRTCCall } from '@/lib/calls/use-webrtc-call';
import { initStorage, isOnboardingComplete, setOnboardingComplete } from '@/lib/db/relay-store';
import dynamic from 'next/dynamic';
import { ConnectionStatus } from '@/components/ConnectionStatus';
import { ContactSidebar } from '@/components/ContactSidebar';
import { ResizableSidebar } from '@/components/ResizableSidebar';
import { MessageThread } from '@/components/MessageThread';
import { toast } from '@/components/ToastNotification';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Settings, Menu, X, User, Lock, Copy, Check, Users, MessageCircle, Phone, Shield, Search, Bookmark } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { MessageSearchModal } from '@/components/MessageSearchModal';
import { BookmarksModal } from '@/components/BookmarksModal';
import { SafetyNumberModal } from '@/components/SafetyNumberModal';
import type { Message } from '@/lib/mock-data';

// Lazy-load non-critical UI components (modals, settings, overlays)
const OnboardingFlow = dynamic(() => import('@/components/OnboardingFlow').then(m => ({ default: m.OnboardingFlow })), { ssr: false });
const EncryptionBadge = dynamic(() => import('@/components/EncryptionBadge').then(m => ({ default: m.EncryptionBadge })), { ssr: false });
const AccountManager = dynamic(() => import('@/components/AccountManager').then(m => ({ default: m.AccountManager })), { ssr: false });
const AddContactModal = dynamic(() => import('@/components/AddContactModal').then(m => ({ default: m.AddContactModal })), { ssr: false });
const AddGroupModal = dynamic(() => import('@/components/AddGroupModal').then(m => ({ default: m.AddGroupModal })), { ssr: false });
const GroupDiscoveryModal = dynamic(() => import('@/components/GroupDiscoveryModal').then(m => ({ default: m.GroupDiscoveryModal })), { ssr: false });
const GroupManageModal = dynamic(() => import('@/components/GroupManageModal').then(m => ({ default: m.GroupManageModal })), { ssr: false });
const AccountManagementPanel = dynamic(() => import('@/components/AccountManagementPanel').then(m => ({ default: m.AccountManagementPanel })), { ssr: false });
const ContactProfileViewer = dynamic(() => import('@/components/ContactProfileViewer').then(m => ({ default: m.ContactProfileViewer })), { ssr: false });
const CallOverlay = dynamic(() => import('@/components/CallOverlay'), { ssr: false });
const MiniCallBar = dynamic(() => import('@/components/MiniCallBar').then(m => ({ default: m.MiniCallBar })), { ssr: false });
const IncomingCallBanner = dynamic(() => import('@/components/IncomingCallBanner').then(m => ({ default: m.IncomingCallBanner })), { ssr: false });
const CallHistory = dynamic(() => import('@/components/CallHistory').then(m => ({ default: m.CallHistory })), { ssr: false });
import { getAccountProfile, refreshAccountProfile } from '@/lib/auth/account-manager';
import { log } from '@/lib/platform/logger';
import { useGhostSweeper } from '@/lib/messaging/ghost-mode';
import { useAutoLogout } from '@/lib/auth/auto-logout';

export default function AppPage() {
  return (
    <MessagingProvider>
      <AppPageInner />
    </MessagingProvider>
  );
}

function AppPageInner() {
  const router = useRouter();
  const { flow, currentRelayId, currentUsername } = useRelayAuthStoreV2();
  const authStore = useRelayAuthStoreV2();

  // Pull from split messaging contexts instead of destructuring useRelayMessaging() directly
  const { contacts, groups } = useMessagingData();
  const {
    loadContacts,
    addContact: onAddContact,
    sendMessage: onSendMessage,
    sendFile: onSendFile,
    sendReaction: onSendReaction,
    sendReactionRevoke: onSendReactionRevoke,
    sendMessageEdit: onSendMessageEdit,
    markConversationAsRead,
    sendTypingIndicator,
    deleteMessage: onDeleteMessage,
    removeMessageLocal,
    burnConversation,
    createGroup,
    sendGroupMessage,
    sendGroupFile,
    renameGroup,
    setGroupDisappearing,
    addGroupMembers,
    removeGroupMember,
    setGroupAdmin,
    transferGroupOwnership,
    leaveGroup,
    sendCallOffer,
    sendCallAnswer,
    sendCallIce,
    sendCallRing,
    sendCallHangup,
    sendCallPeers,
  } = useMessagingActions();
  const { connectionStatus, reconnect, callSignals, consumeCallSignals } = useMessagingConnection();
  const [mounted, setMounted] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showGroupDiscovery, setShowGroupDiscovery] = useState(false);
  const [showGroupManage, setShowGroupManage] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [syncStatus, setSyncStatus] = useState<'ready' | 'syncing' | 'error'>('ready');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [storageInitialized, setStorageInitialized] = useState(false);
  const [activeView, setActiveView] = useState<'chat' | 'account'>('chat');
  const [chatTab, setChatTab] = useState<'chats' | 'calls'>('chats');
  const [callMinimised, setCallMinimised] = useState(false);
  const [callFullScreen, setCallFullScreen] = useState(false);
  // Track which group has an active call (so non-participants can see the join banner)
  const [activeGroupCallId, setActiveGroupCallId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedUsername, setCopiedUsername] = useState(false);
  const [userAvatarEmoji, setUserAvatarEmoji] = useState<string | undefined>(undefined);
  const [userAvatarColor, setUserAvatarColor] = useState<string | undefined>(undefined);
  const [selfProfileOpen, setSelfProfileOpen] = useState(false);
  const [contactProfile, setContactProfile] = useState<{ relayId: string; displayName?: string; publicKeyHex?: string; addedAt?: number; messageCount?: number; isOnline?: boolean } | null>(null);
  const [safetyNumberContact, setSafetyNumberContact] = useState<{ relayId: string; publicKeyHex: string; name: string } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const {
    activeCall,
    callPhase,
    remoteStream,
    remoteStreams,
    connectedPeerIds,
    callQuality,
    callDiagnostics,
    callHistory,
    muted,
    localStream,
    videoEnabled,
    isScreenSharing,
    isHeld,
    speakerPhone,
    formattedCallDuration,
    canAcceptIncoming,
    startVoiceCall,
    startVideoCall,
    startGroupCall,
    acceptIncomingCall,
    declineIncomingCall,
    endCall,
    retryConnectionNow,
    toggleMute,
    toggleVideo,
    toggleScreenShare,
    toggleHold,
    toggleSpeakerPhone,
  } = useWebRTCCall({
    localRelayId: currentRelayId,
    callSignals,
  consumeCallSignals,
    sendCallOffer,
    sendCallAnswer,
    sendCallIce,
    sendCallRing,
    sendCallHangup,
    sendCallPeers,
    // Group calls send call_offer directly to every group member, not just
    // 1:1 contacts — checking only `contacts` here rejected the very first
    // offer of a legitimate group call for any member who hadn't separately
    // been added as a direct contact. A caller is "known" if they're either
    // a 1:1 contact or share a group with the local user.
    // A blocked 1:1 contact is deliberately excluded here even though they're
    // still technically "a contact" — but if they also share a group, the
    // groups.some() branch below still lets their call through. Blocking
    // does not remove group membership or filter group traffic (see
    // lib/features/block.ts) — that's a known, documented scope limit, not
    // an oversight.
    isKnownCaller: useCallback(
      (relayId: string) =>
        contacts.some((c) => (c.relayId || c.id) === relayId && !c.blocked) ||
        groups.some((g) => g.memberIds.includes(relayId)),
      [contacts, groups]
    ),
  });

  // Reset minimised / full-screen state on every new call phase change
  useEffect(() => {
    if (callPhase === 'idle' || callPhase === 'ended') {
      setCallMinimised(false);
      setCallFullScreen(false);
      setActiveGroupCallId(null);
    }
    if (callPhase === 'ringing' && activeCall?.direction === 'incoming') {
      setCallFullScreen(false);
    }
    // When a call starts (incoming or outgoing), find which group the peer belongs to
    if (callPhase !== 'idle' && callPhase !== 'ended' && activeCall?.peerId) {
      const peerId = activeCall.peerId;
      const matchingGroup = groups.find((g) =>
        g.memberIds.some((id) => id === peerId || peerId.includes(id))
      );
      if (matchingGroup) {
        setActiveGroupCallId(matchingGroup.id);
      }
    }
    if (callPhase === 'in_call') {
      setCallFullScreen(true);
    }
  }, [callPhase, activeCall?.direction, activeCall?.peerId, groups]);

  // Load current user's avatar from their account profile
  useEffect(() => {
    if (!currentRelayId) return;
    const cached = getAccountProfile(currentRelayId);
    if (cached?.avatarEmoji) {
      setUserAvatarEmoji(cached.avatarEmoji);
      setUserAvatarColor(cached.avatarColor);
    }
    refreshAccountProfile(currentRelayId).then((profile) => {
      if (profile.avatarEmoji) {
        setUserAvatarEmoji(profile.avatarEmoji);
        setUserAvatarColor(profile.avatarColor);
      }
    }).catch(() => { /* non-critical */ });
  }, [currentRelayId]);

  // Play ALL remote audio streams (supports group calls with multiple peers)
  useEffect(() => {
    // Clean up audio elements for peers that are no longer connected
    for (const [peerId, el] of remoteAudioElementsRef.current) {
      if (!remoteStreams.has(peerId)) {
        el.srcObject = null;
        el.remove();
        remoteAudioElementsRef.current.delete(peerId);
      }
    }
    // Create/update audio elements for each remote stream
    for (const [peerId, stream] of remoteStreams) {
      let el = remoteAudioElementsRef.current.get(peerId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        (el as any).playsInline = true;
        el.style.display = 'none';
        document.body.appendChild(el);
        remoteAudioElementsRef.current.set(peerId, el);
      }
      if (el.srcObject !== stream) {
        el.srcObject = stream;
        el.play().catch((err) => log.warn('Remote audio autoplay blocked:', err));
      }
    }
  }, [remoteStreams]);

  const handleCopyId = async () => {
    if (!currentRelayId) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(currentRelayId);
      } else {
        const el = document.createElement('textarea');
        el.value = currentRelayId;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch (error) {
      log.error('Failed to copy ID:', error);
    }
  };

  const handleCopyUsername = async () => {
    if (!currentUsername) return;
    try {
      const textToCopy = `@${currentUsername}`;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const el = document.createElement('textarea');
        el.value = textToCopy;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.focus();
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      setCopiedUsername(true);
      setTimeout(() => setCopiedUsername(false), 2000);
    } catch (error) {
      log.error('Failed to copy username:', error);
    }
  };

  // Initialize storage and check onboarding on mount
  useEffect(() => {
    const initializeApp = async () => {
      setMounted(true);

      if (flow !== 'authenticated') {
        // Before redirecting, check if we can restore the session.
        // 1) Check if the in-memory private key is already set (HMR case)
        const existingKey = authStore.getPrivateKey();
        const session = loadSession();

        if (existingKey && session) {
          // Key is in memory but flow got reset (HMR) — just re-authenticate
          log.debug('[App] Private key in memory, re-authenticating');
          const { bytesToHex } = require('@noble/hashes/utils.js');
          const existingPqKey = authStore.getPqPrivateKey();
          authStore.completeApiLogin(
            bytesToHex(existingKey),
            session.publicKeyHex,
            session.userId,
            session.relayId,
            session.username || null,
            existingPqKey ? bytesToHex(existingPqKey) : undefined,
          );
          return;
        }

        // 2) Check if the session has a saved private key
        if (session?.privateKeyHex) {
          log.debug('[App] Restoring from session privateKeyHex');
          authStore.completeApiLogin(
            session.privateKeyHex,
            session.publicKeyHex,
            session.userId,
            session.relayId,
            session.username || null,
            session.pqPrivateKeyHex,
          );
          return;
        }

        log.debug('[App] Not authenticated, redirecting to login');
        router.push('/auth/login');
        return;
      }

      try {
        // Initialize storage with private key
        // Fall back to session storage if in-memory key isn't available yet
        // (race condition: useInitializeAuthV2 async restore may not have completed)
        let privateKey = authStore.getPrivateKey();
        if (!privateKey) {
          const session = loadSession();
          if (session?.privateKeyHex) {
            privateKey = hexToBytes(session.privateKeyHex);
          }
        }
        if (privateKey) {
          await initStorage(privateKey);
          setStorageInitialized(true);

          // Only show onboarding to new users (coming from signup) or if a
          // page refresh happened mid-onboarding before they completed it.
          const isNewUser = sessionStorage.getItem('relay_new_user') === 'true';
          const isOnboardingInProgress = sessionStorage.getItem('relay_onboarding_in_progress') === 'true';
          const completed = await isOnboardingComplete();

          if (isNewUser) {
            sessionStorage.removeItem('relay_new_user');
            if (!completed) {
              sessionStorage.setItem('relay_onboarding_in_progress', 'true');
              setShowOnboarding(true);
            }
          } else if (isOnboardingInProgress && !completed) {
            setShowOnboarding(true);
          }
        } else {
          // Private key not in memory — this happens when the page is refreshed
          // (the key is never persisted to storage for security). Send the user
          // back to the login page so they can re-derive it from their PIN.
          log.warn('[App] Private key not in memory — redirecting to login for re-auth');
          router.push('/auth/login');
        }
      } catch (err) {
        log.error('Failed to initialize storage:', err);
        setStorageInitialized(false);
      }
    };

    initializeApp();
  }, [flow, router, authStore]);

  const handleOnboardingComplete = async () => {
    sessionStorage.removeItem('relay_onboarding_in_progress');
    try {
      await setOnboardingComplete();
      setShowOnboarding(false);
    } catch (err) {
      log.error('Failed to mark onboarding as complete:', err);
      setShowOnboarding(false);
    }
  };

  const handleAddContact = async (userId: string, displayName: string, options?: { ephemeral?: boolean }) => {
    try {
      // Pass displayName as string so the hook uses it directly instead of deriving from ID
      await onAddContact(userId, displayName, options);
      toast.success(`Contact "${displayName}" added successfully!`);
    } catch (err) {
      log.error('Failed to add contact:', err);
      throw new Error(`Failed to add contact: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  // Auto-mark as read when new messages arrive in the open conversation
  useEffect(() => {
    if (selectedContactId) {
      markConversationAsRead(selectedContactId);
    }
  }, [contacts, selectedContactId, markConversationAsRead]);

  const ghostConvIds = React.useMemo(() => {
    const ids: string[] = [];
    for (const c of contacts) ids.push(c.relayId || c.id);
    for (const g of groups) ids.push(g.id);
    return ids;
  }, [contacts, groups]);
  // onDeleted keeps an already-open thread's rendered messages in sync with
  // the sweep — without it, an expired ghost message was removed from
  // IndexedDB but stayed visible until the page reloaded and re-fetched.
  useGhostSweeper(storageInitialized ? ghostConvIds : [], removeMessageLocal);

  // Auto-logout: inactivity timer — only runs when authenticated
  useAutoLogout(flow === 'authenticated');

  // Ctrl/Cmd+F — toggle the message search modal. Prevents browser's find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isFind = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F');
      if (isFind) {
        e.preventDefault();
        setShowSearch((prev) => !prev);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // After navigating to a conversation from search, scroll to the target message
  useEffect(() => {
    if (!pendingScrollMessageId) return;
    const id = pendingScrollMessageId;
    // Give the thread a moment to render, then locate and scroll into view.
    const t = setTimeout(() => {
      const el =
        document.querySelector(`[data-msg-id="${id}"]`) ||
        document.querySelector(`[data-message-id="${id}"]`);
      if (el && 'scrollIntoView' in el) {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setPendingScrollMessageId(null);
    }, 180);
    return () => clearTimeout(t);
  }, [pendingScrollMessageId, selectedContactId, selectedGroupId]);

  const handleBlockContact = async (relayId: string) => {
    const { blockContact } = await import('@/lib/features/block');
    await blockContact(relayId);
    await loadContacts();
    toast.success('Contact blocked', 'They can no longer message or call you.');
  };

  const handleUnblockContact = async (relayId: string) => {
    const { unblockContact } = await import('@/lib/features/block');
    await unblockContact(relayId);
    await loadContacts();
    toast.success('Contact unblocked');
  };

  const handleSearchResultClick = (conversationId: string, messageId: string) => {
    // Match the conversation to a contact or group and open it
    const asContact = contacts.find(
      (c) => c.id === conversationId || c.relayId === conversationId,
    );
    const asGroup = groups.find((g) => g.id === conversationId);
    if (asContact) {
      setSelectedGroupId(null);
      setSelectedContactId(asContact.id);
    } else if (asGroup) {
      setSelectedContactId(null);
      setSelectedGroupId(asGroup.id);
    }
    setPendingScrollMessageId(messageId);
  };

  // Forward a message's text to one or more contacts
  const handleForwardMessage = async (contactIds: string[], message: Message) => {
    const text = message.text || (message.fileShare ? `📎 ${message.fileShare.filename}` : '');
    if (!text) return;
    for (const contactId of contactIds) {
      try {
        await onSendMessage(contactId, text);
      } catch (err) {
        log.error('[Forward] Failed to forward message to', contactId, err);
      }
    }
    toast.success(`Message forwarded to ${contactIds.length} contact${contactIds.length === 1 ? '' : 's'}`);
  };

  // Show loading state while initializing
  if (!mounted) {
    return (
      <div className="w-screen h-screen bg-relay-bg flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-full border-2 border-relay-accent/20 border-t-relay-accent animate-spin" />
          <p className="text-relay-text-muted text-xs tracking-widest uppercase">Loading</p>
        </div>
      </div>
    );
  }

  // Redirect handled by the useEffect above — just render nothing while it runs.
  if (flow !== 'authenticated') {
    return null;
  }

  // Show error if storage initialization failed
  if (!storageInitialized) {
    return (
      <div className="w-screen h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-6 max-w-md">
          <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/50 flex items-center justify-center">
            <span className="text-2xl"></span>
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-white mb-2">Unable to Initialize Messaging</h2>
            <p className="text-sm text-relay-text-secondary mb-4">
              The encrypted messaging system couldn't be initialized. This may happen if you're using a recovery login.
            </p>
            <p className="text-xs text-relay-text-muted">
              Try logging out and logging back in to restore your messaging keys.
            </p>
          </div>
          <button
            onClick={() => router.push('/auth/login')}
            className="px-4 py-2 rounded-lg bg-relay-accent hover:bg-relay-accent/80 text-relay-accent-foreground text-sm font-medium transition-colors mt-2"
          >
            Return to Login
          </button>
        </div>
      </div>
    );
  }

  if (showOnboarding && currentRelayId) {
    // Get public key from session store
    const sessionData = sessionStorage.getItem('relay_session');
    let pubKeyHex = '';
    if (sessionData) {
      try {
        const session = JSON.parse(sessionData);
        if (session.publicKey) {
          pubKeyHex = session.publicKey;
        }
      } catch (err) {
        log.error('Failed to get public key from session:', err);
      }
    }
    
    return (
      <OnboardingFlow
        relayId={currentRelayId}
        publicKeyHex={pubKeyHex}
        onComplete={handleOnboardingComplete}
      />
    );
  }

  const selectedContact = contacts.find((c) => c.id === selectedContactId);
  const selectedGroup = groups.find((g) => g.id === selectedGroupId);

  const handleVerifySafetyNumbers = (relayId: string) => {
    const contact = contacts.find((c) => c.relayId === relayId);
    if (!contact?.publicKeyHex) {
      toast.warning('Cannot verify', "This contact's public key isn't available yet.");
      return;
    }
    setSafetyNumberContact({ relayId, publicKeyHex: contact.publicKeyHex, name: contact.name || relayId.slice(0, 11) });
  };
  // Get the logged-in user's display name from their claimed username
  const userDisplayName = currentUsername ? `@${currentUsername}` : `@${currentRelayId?.substring(3, 8)}` || 'You';
  
  const userDisplay = currentRelayId ? currentRelayId.substring(0, 12) + '...' : 'User';

  const selectedGroupAsContact = selectedGroup
    ? {
        id: selectedGroup.id,
        relayId: selectedGroup.id,
        name: selectedGroup.name,
        displayName: selectedGroup.name,
        avatar: 'GR',
        isOnline: true,
        messages: selectedGroup.messages,
      }
    : null;

  return (
    <div className="flex h-screen w-screen bg-relay-bg overflow-hidden flex-col">
      {/* Top Bar */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="relative z-50 bg-relay-bg px-4 sm:px-6 py-3 flex items-center justify-between gap-2 sm:gap-4"
      >
        <div className="absolute left-0 right-0 bottom-0 h-px bg-relay-border" />
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="relay-icon-btn lg:hidden flex-shrink-0"
            title={sidebarOpen ? 'Close sidebar' : 'Open sidebar'}
          >
            {sidebarOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
          </button>
          
          <button
            onClick={() => setSelfProfileOpen(true)}
            className="rounded-full hover:ring-2 hover:ring-relay-accent/40 transition"
            title="View your profile"
          >
            <UserAvatar
              emoji={userAvatarEmoji}
              color={userAvatarColor}
              size={32}
            />
          </button>
          
          <div className="flex flex-col min-w-0 flex-1">
            <button
              onClick={handleCopyUsername}
              title={copiedUsername ? 'Copied!' : `Click to copy @${currentUsername}`}
              className="flex items-center gap-1 group w-fit max-w-full"
            >
              <h1 className="text-xs text-relay-text-primary font-semibold truncate group-hover:text-white transition-colors">
                {copiedUsername ? 'Copied!' : userDisplayName}
              </h1>
              {copiedUsername
                ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                : <Copy className="w-3 h-3 text-relay-text-muted opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />}
            </button>
            <button
              onClick={handleCopyId}
              title={copiedId ? `${currentRelayId?.slice(0, 10)}... copied!` : 'Click to copy your Relay ID'}
              className="flex items-center gap-1 group w-fit max-w-full hover:text-relay-text-secondary transition-colors"
            >
              <p className="text-[11px] tracking-tight text-relay-text-muted font-mono truncate group-hover:text-relay-text-secondary">
                {copiedId ? `${currentRelayId?.slice(0, 10)}... copied!` : currentRelayId}
              </p>
              {copiedId
                ? <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                : <Copy className="w-3 h-3 text-relay-text-muted opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
          <button
            onClick={() => setShowSearch(true)}
            className="relay-icon-btn"
            title="Search messages (Ctrl+F)"
          >
            <Search className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowBookmarks(true)}
            className="relay-icon-btn"
            title="Bookmarks"
          >
            <Bookmark className="w-4 h-4" />
          </button>
          <EncryptionBadge />
          <button
            onClick={() => router.push('/vault')}
            className="relay-icon-btn"
            title="Vault (2FA, Notes)"
          >
            <Shield className="w-4 h-4" />
          </button>
          <button
            onClick={() => setActiveView('account')}
            className={`inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors ${
              activeView === 'account'
                ? 'bg-relay-accent/15 text-relay-accent'
                : 'text-relay-text-secondary hover:text-relay-text-primary hover:bg-relay-surface-hover'
            }`}
            title="Account Settings"
          >
            <User className="w-4 h-4" />
          </button>
          <button
            onClick={() => router.push('/app/settings')}
            className="relay-icon-btn"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
          <AccountManager />
          {/* Lock — always last / rightmost */}
          <button
            onClick={() => {
              authStore.lock();
              router.push('/auth/login');
            }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-relay-text-secondary hover:text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Lock — require PIN to re-enter"
          >
            <Lock className="w-4 h-4" />
          </button>
        </div>
      </motion.div>

      {/* Connection Status Banner */}
      <div className="px-4 sm:px-6">
        <ConnectionStatus status={connectionStatus} onRetry={reconnect} />
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Sidebar */}
        <AnimatePresence mode="wait">
          {sidebarOpen && (
            <motion.div
              key="sidebar"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15 }}
              className="relative flex h-full"
            >
              <ResizableSidebar
                collapsedRail={
                  <ContactSidebar
                    compact
                    contacts={contacts}
                    groups={groups}
                    onSelectContact={(contactId) => {
                      setSelectedGroupId(null);
                      setSelectedContactId(contactId);
                      markConversationAsRead(contactId);
                    }}
                    onSelectGroup={(groupId) => {
                      setSelectedContactId(null);
                      setSelectedGroupId(groupId);
                    }}
                    selectedContactId={selectedContactId}
                    selectedGroupId={selectedGroupId}
                    onNewContact={() => setShowAddContact(true)}
                    onArchiveChange={loadContacts}
                  />
                }
              >
                {() => (
                  <div className="flex flex-col h-full">
              {/* Sidebar Header — Chats vs Calls */}
              <div className="p-3 pb-0">
                <div className="flex items-center gap-1 p-1 rounded-lg bg-relay-surface-hover">
                  <button
                    onClick={() => setChatTab('chats')}
                    className={`flex-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                      chatTab === 'chats' ? 'bg-relay-accent/15 text-relay-accent' : 'text-relay-text-secondary hover:text-relay-text-primary'
                    }`}
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    Chats
                  </button>
                  <button
                    onClick={() => setChatTab('calls')}
                    className={`flex-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${
                      chatTab === 'calls' ? 'bg-relay-accent/15 text-relay-accent' : 'text-relay-text-secondary hover:text-relay-text-primary'
                    }`}
                  >
                    <Phone className="w-3.5 h-3.5" />
                    Calls
                  </button>
                </div>
              </div>

              {/* Chats / Calls content */}
              <div className="flex-1 overflow-y-auto">
                {chatTab === 'chats' ? (
                  <ContactSidebar
                    contacts={contacts}
                    groups={groups}
                    onSelectContact={(contactId) => {
                      setSelectedGroupId(null);
                      setSelectedContactId(contactId);
                      markConversationAsRead(contactId);
                    }}
                    onSelectGroup={(groupId) => {
                      setSelectedContactId(null);
                      setSelectedGroupId(groupId);
                    }}
                    selectedContactId={selectedContactId}
                    selectedGroupId={selectedGroupId}
                    onNewContact={() => setShowAddContact(true)}
                    onNewGroup={() => setShowAddGroup(true)}
                    onManageGroup={(groupId) => {
                      setSelectedContactId(null);
                      setSelectedGroupId(groupId);
                      setShowGroupManage(true);
                    }}
                    displayName={currentUsername ? `@${currentUsername}` : currentRelayId?.slice(0, 12) || ''}
                    userAvatarEmoji={userAvatarEmoji}
                    userAvatarColor={userAvatarColor}
                    onArchiveChange={loadContacts}
                  />
                ) : (
                  <CallHistory
                    records={callHistory}
                    contacts={contacts}
                    onCallBack={(peerId, isVideo) => {
                      if (isVideo) startVideoCall(peerId);
                      else startVoiceCall(peerId);
                    }}
                  />
                )}
              </div>
                  </div>
                )}
              </ResizableSidebar>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Chat Area */}
        {activeView === 'account' ? (
          <motion.div
            key="account"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="flex-1 overflow-hidden flex flex-col p-4 sm:p-6"
          >
            <AccountManagementPanel onClose={() => setActiveView('chat')} />
          </motion.div>
        ) : selectedContact || selectedGroupAsContact ? (
          <motion.div
            key={selectedContactId || selectedGroupId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="flex-1 overflow-hidden flex flex-col"
          >
            {selectedGroup && (
              <div className="px-4 py-1 flex items-center justify-between">
                <span className="text-sm font-semibold text-relay-text-primary truncate">
                  {selectedGroup.name}
                </span>
                <button
                  onClick={() => setShowGroupManage(true)}
                  className="relay-icon-btn"
                  title={`${selectedGroup.memberIds.length} members · Manage`}
                  aria-label={`${selectedGroup.memberIds.length} members · Manage`}
                >
                  <Users className="w-4 h-4" />
                </button>
              </div>
            )}
            <MessageThread
              contact={(selectedContact || selectedGroupAsContact)!}
              contacts={contacts}
              forwardContacts={contacts}
              onClose={() => { setSelectedContactId(null); setSelectedGroupId(null); }}
              onForwardMessage={handleForwardMessage}
              onSendMessage={selectedGroup ? async (_to, text) => sendGroupMessage(selectedGroup.id, text) : onSendMessage}
              onSendFile={selectedGroup ? async (_to, file) => sendGroupFile(selectedGroup.id, file) : onSendFile}
              onSendReaction={onSendReaction}
              onSendReactionRevoke={onSendReactionRevoke}
              onSendMessageEdit={onSendMessageEdit}
              onDeleteMessage={onDeleteMessage}
              onTyping={sendTypingIndicator}
              onBurnConversation={selectedGroup ? undefined : burnConversation}
              allowCalls={true}
              disableContactEditing={!!selectedGroup}
              onStartVoiceCall={selectedGroup
                ? async () => {
                    const members = selectedGroup.memberIds.filter(id => id !== currentRelayId);
                    if (members.length === 0) { toast.error('No members', 'No other members in this group'); return; }
                    setActiveGroupCallId(selectedGroup.id);
                    // Notify all members via group message so they see the call banner
                    sendGroupMessage(selectedGroup.id, '📞 Group call started').catch(() => {});
                    await startGroupCall(members, false);
                  }
                : startVoiceCall}
              onStartVideoCall={selectedGroup
                ? async () => {
                    const members = selectedGroup.memberIds.filter(id => id !== currentRelayId);
                    if (members.length === 0) { toast.error('No members', 'No other members in this group'); return; }
                    setActiveGroupCallId(selectedGroup.id);
                    sendGroupMessage(selectedGroup.id, '📞 Group video call started').catch(() => {});
                    await startGroupCall(members, true);
                  }
                : startVideoCall}
              activeGroupCall={selectedGroup ? activeGroupCallId === selectedGroup.id : false}
              onAcceptIncomingCall={acceptIncomingCall}
              onDeclineIncomingCall={declineIncomingCall}
              onEndCall={endCall}
              onRetryConnectionNow={retryConnectionNow}
              onToggleMute={toggleMute}
              callPhase={callPhase}
              callDirection={activeCall?.direction}
              callPeerId={activeCall?.peerId || null}
              callQuality={callQuality}
              callDiagnostics={callDiagnostics}
              callHistory={callHistory}
              isMuted={muted}
              onOpenProfile={(c) => {
                if (selectedGroup) return;
                setContactProfile({
                  relayId: c.relayId || c.id,
                  displayName: c.displayName || c.name,
                  publicKeyHex: c.publicKeyHex,
                  addedAt: c.addedAt,
                  messageCount: c.messages?.length ?? 0,
                  isOnline: !!c.isOnline,
                });
              }}
            />
          </motion.div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="text-center space-y-5 px-6 max-w-sm"
            >
              <div className="relative mx-auto w-20 h-20">
                <motion.div
                  className="absolute inset-0 rounded-xl bg-relay-surface border border-relay-accent/15"
                  animate={{ rotate: [0, 5, -5, 0] }}
                  transition={{ duration: 6, repeat: Infinity }}
                />
                <div className="relative w-full h-full rounded-xl bg-relay-surface flex items-center justify-center">
                  <Shield className="w-8 h-8 text-relay-accent/60" />
                </div>
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-relay-text-primary">
                  {contacts.length === 0 ? 'Welcome to Relay' : 'Select a conversation'}
                </h2>
                <p className="text-relay-text-muted text-sm leading-relaxed">
                  {contacts.length === 0
                    ? 'Add a contact to start messaging with end-to-end encryption powered by ChaCha20-Poly1305.'
                    : 'Choose a contact from the sidebar to start chatting.'}
                </p>
              </div>
              <div className="flex gap-2 justify-center">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => setShowAddContact(true)}
                  className="px-5 py-2.5 bg-relay-accent hover:bg-relay-accent/90 rounded-xl font-medium text-relay-accent-foreground text-sm shadow-lg shadow-relay-accent/20 transition-all duration-200"
                >
                  {contacts.length === 0 ? 'Add First Contact' : 'New Message'}
                </motion.button>
                {contacts.length === 0 && (
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setShowGroupDiscovery(true)}
                    className="px-5 py-2.5 rounded-xl font-medium text-sm border border-relay-border text-relay-text-primary hover:bg-relay-surface-hover transition-all duration-200"
                  >
                    Join public group
                  </motion.button>
                )}
              </div>
            </motion.div>
          </div>
        )}
      </div>

      {/* Add Contact Modal */}
      <AddContactModal
        isOpen={showAddContact}
        onClose={() => setShowAddContact(false)}
        onAdd={handleAddContact}
        existingContacts={contacts}
      />

      <AddGroupModal
        isOpen={showAddGroup}
        onClose={() => setShowAddGroup(false)}
        contacts={contacts}
        onCreate={async (name, memberIds, options) => {
          const created = createGroup(name, memberIds, options);
          if (options?.visibility === 'public' && options.publicHandle && currentRelayId) {
            try {
              await fetch('/api/groups/directory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  groupId: created.id,
                  publicHandle: options.publicHandle,
                  name,
                  description: options.description,
                  avatarEmoji: options.avatarEmoji,
                  avatarColor: options.avatarColor,
                  memberCount: created.memberIds.length,
                  ownerRelayId: currentRelayId,
                  joinPolicy: options.joinPolicy || 'open',
                }),
              });
            } catch {}
          }
          setChatTab('chats');
          setSelectedContactId(null);
          setSelectedGroupId(created.id);
        }}
      />

      <GroupDiscoveryModal
        isOpen={showGroupDiscovery}
        relayId={currentRelayId}
        onClose={() => setShowGroupDiscovery(false)}
        // Joining just records a pending-membership request server-side —
        // the group itself only appears once the host's add_members
        // group_event arrives (see use-group-messaging.ts's canBootstrap
        // gate), so there's no local groups/contacts state to refresh here
        // synchronously. This is purely user feedback that the request went
        // through, previously given none at all once the modal closed.
        onJoined={(rec) => toast.success('Join request sent', `You'll be added to ${rec.name} once the host is back online.`)}
      />

      <GroupManageModal
        isOpen={showGroupManage && !!selectedGroup}
        group={selectedGroup || null}
        contacts={contacts}
        currentUserId={currentRelayId || ''}
        onClose={() => setShowGroupManage(false)}
        onRename={renameGroup}
        onSetDisappearingMessages={setGroupDisappearing}
        onAddMembers={addGroupMembers}
        onRemoveMember={removeGroupMember}
        onSetAdmin={setGroupAdmin}
        onTransferOwnership={transferGroupOwnership}
        onLeave={async (groupId) => {
          await leaveGroup(groupId);
          setSelectedGroupId(null);
          setShowGroupManage(false);
        }}
      />

      {/* Message Search Modal (Ctrl/Cmd+F) */}
      <MessageSearchModal
        open={showSearch}
        onClose={() => setShowSearch(false)}
        onResultClick={handleSearchResultClick}
      />

      {/* Contact profile viewer (opened from thread header) */}
      {contactProfile && (
        <ContactProfileViewer
          relayId={contactProfile.relayId}
          displayName={contactProfile.displayName}
          publicKeyHex={contactProfile.publicKeyHex}
          addedAt={contactProfile.addedAt}
          messageCount={contactProfile.messageCount}
          isOnline={contactProfile.isOnline}
          isOpen={!!contactProfile}
          onClose={() => setContactProfile(null)}
          onVerifySafetyNumbers={handleVerifySafetyNumbers}
          isBlocked={!!contacts.find((c) => (c.relayId || c.id) === contactProfile.relayId)?.blocked}
          onBlock={handleBlockContact}
          onUnblock={handleUnblockContact}
        />
      )}

      {/* Safety number verification */}
      {safetyNumberContact && currentRelayId && (() => {
        const privateKey = authStore.getPrivateKey();
        if (!privateKey) return null;
        const myPublicKeyHex = toHex(x25519.getPublicKey(privateKey));
        return (
          <SafetyNumberModal
            myPublicKeyHex={myPublicKeyHex}
            myRelayId={currentRelayId}
            contactPublicKeyHex={safetyNumberContact.publicKeyHex}
            contactRelayId={safetyNumberContact.relayId}
            contactName={safetyNumberContact.name}
            onClose={() => setSafetyNumberContact(null)}
          />
        );
      })()}

      {/* Self profile viewer */}
      {selfProfileOpen && currentRelayId && (
        <ContactProfileViewer
          relayId={currentRelayId}
          displayName={userDisplayName}
          isOpen={selfProfileOpen}
          onClose={() => setSelfProfileOpen(false)}
          isSelf
          onEditProfile={() => {
            setSelfProfileOpen(false);
            setActiveView('account');
          }}
        />
      )}

      {/* Bookmarks Modal */}
      <BookmarksModal
        isOpen={showBookmarks}
        onClose={() => setShowBookmarks(false)}
        onJump={(conversationId, messageId) => handleSearchResultClick(conversationId, messageId)}
      />

      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Incoming call banner (non-blocking, shown before full-screen takeover) */}
      {callPhase === 'ringing' && activeCall?.direction === 'incoming' && !callFullScreen && (
        <IncomingCallBanner
          peerDisplayName={
            contacts.find((c) => c.relayId === activeCall?.peerId)?.name ||
            activeCall?.peerId ||
            'Unknown'
          }
          peerAvatarEmoji={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarEmoji}
          peerAvatarColor={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarColor}
          isVideo={activeCall?.isVideo ?? false}
          onAccept={() => {
            acceptIncomingCall().catch((err) => {
              toast.error('Call failed', err instanceof Error ? err.message : 'Could not accept the call');
            });
            setCallFullScreen(true);
          }}
          onDecline={declineIncomingCall}
          onExpand={() => setCallFullScreen(true)}
        />
      )}

      {/* Mini call bar (minimised active call) */}
      <AnimatePresence>
        {callPhase === 'in_call' && callMinimised && (
          <MiniCallBar
            peerDisplayName={
              contacts.find((c) => c.relayId === activeCall?.peerId)?.name ||
              activeCall?.peerId ||
              'Unknown'
            }
            peerAvatarEmoji={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarEmoji}
            peerAvatarColor={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarColor}
            formattedCallDuration={formattedCallDuration}
            isVideo={activeCall?.isVideo ?? false}
            muted={muted}
            videoEnabled={videoEnabled}
            remoteStream={remoteStream}
            onExpand={() => setCallMinimised(false)}
            onToggleMute={toggleMute}
            onToggleVideo={toggleVideo}
            onEndCall={endCall}
          />
        )}
      </AnimatePresence>

      {/* Full-screen call overlay */}
      {!callMinimised && callPhase !== 'idle' && callPhase !== 'ended' && (
        callFullScreen || !(callPhase === 'ringing' && activeCall?.direction === 'incoming')
      ) && (
        <CallOverlay
          callPhase={callPhase}
          peerId={activeCall?.peerId || ''}
          peerDisplayName={contacts.find((c) => c.relayId === activeCall?.peerId)?.name}
          peerAvatarEmoji={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarEmoji}
          peerAvatarColor={contacts.find((c) => c.relayId === activeCall?.peerId)?.avatarColor}
          direction={activeCall?.direction || 'outgoing'}
          isVideo={activeCall?.isVideo ?? false}
          muted={muted}
          videoEnabled={videoEnabled}
          isScreenSharing={isScreenSharing}
          isHeld={isHeld}
          speakerPhone={speakerPhone}
          formattedCallDuration={formattedCallDuration}
          callQuality={callQuality}
          callDiagnostics={callDiagnostics}
          localStream={localStream}
          remoteStream={remoteStream}
          connectedPeers={connectedPeerIds.map((id) => {
            const c = contacts.find((ct) => ct.relayId === id || ct.id === id);
            return {
              id,
              displayName: c?.name || c?.displayName,
              avatarEmoji: c?.avatarEmoji,
              avatarColor: c?.avatarColor,
            };
          })}
          canAcceptIncoming={canAcceptIncoming}
          onAccept={() => acceptIncomingCall().catch((err) => {
            toast.error('Call failed', err instanceof Error ? err.message : 'Could not accept the call');
          })}
          onDecline={declineIncomingCall}
          onEndCall={endCall}
          onToggleMute={toggleMute}
          onToggleVideo={toggleVideo}
          onToggleScreenShare={toggleScreenShare}
          onToggleHold={toggleHold}
          onToggleSpeakerPhone={toggleSpeakerPhone}
          onRetryConnection={retryConnectionNow}
          onMinimise={() => setCallMinimised(true)}
        />
      )}
    </div>
  );
}
