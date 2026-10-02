'use client';

import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageBubble } from './MessageBubble';
import { CompressionDetails } from './CompressionDetails';
import { Send, Paperclip, Shield, Phone, Video, PhoneOff, Mic, MicOff, X, Reply, Ghost, Key, Copy, Image as ImageIcon, StopCircle, Flame } from 'lucide-react';
import { startVoiceRecording } from '@/lib/messaging/voice-recording';
import { useGhostMode, useGhostModeActive, GHOST_OPTIONS, formatGhostLabel, filterExpired } from '@/lib/messaging/ghost-mode';
import { UserAvatar } from './UserAvatar';
import { toast } from './ToastNotification';
import { ForwardModal } from './ForwardModal';
import type { Contact, Message } from '@/lib/mock-data';
import { upsertContact } from '@/lib/db/relay-store';
import { isEphemeralContact } from '@/lib/messaging/ephemeral-contacts';
import type { CallDiagnosticEvent, CallHistoryRecord, CallQualityMetrics } from '@/lib/calls/use-webrtc-call';
import { log } from '@/lib/platform/logger';
import { getPinnedMessages, type PinnableStoredMessage } from '@/lib/features/pinned-messages';
import { Pin, ChevronDown, ChevronUp } from 'lucide-react';
import { TypingIndicator } from './TypingIndicator';
import { useAppStore } from '@/lib/app-store';
import { getBoolSetting } from '@/lib/settings/relay-settings';
import { copyToClipboard } from '@/lib/utils';

function extractNonce(encryptedBlobHex?: string): string | null {
  if (!encryptedBlobHex || encryptedBlobHex.length < 50) return null;
  try {
    const nonceStart = 13 * 2;
    const nonceEnd = (13 + 12) * 2;
    return encryptedBlobHex.substring(nonceStart, nonceEnd);
  } catch (err) {
    log.debug('Failed to extract nonce:', err);
    return null;
  }
}

interface MessageThreadProps {
  contact: Contact;
  contacts?: Contact[];
  onClose?: () => void;
  onSendMessage?: (toContactId: string, text: string, replyTo?: { messageId: string; senderName: string; textPreview: string }) => Promise<any>;
  onSendReaction?: (toContactId: string, messageId: string, emoji: string) => Promise<void>;
  onSendReactionRevoke?: (toContactId: string, messageId: string, emoji: string) => Promise<void>;
  onSendMessageEdit?: (toContactId: string, messageId: string, newText: string) => Promise<void>;
  onSendFile?: (toContactId: string, file: File) => Promise<any>;
  onStartVoiceCall?: (toContactId: string) => Promise<void>;
  onStartVideoCall?: (toContactId: string) => Promise<void>;
  onAcceptIncomingCall?: () => Promise<void>;
  onDeclineIncomingCall?: () => void;
  onEndCall?: () => void;
  onRetryConnectionNow?: () => Promise<boolean>;
  onToggleMute?: () => void;
  callPhase?: 'idle' | 'calling' | 'ringing' | 'connecting' | 'in_call' | 'ended' | 'failed';
  callDirection?: 'incoming' | 'outgoing';
  callPeerId?: string | null;
  callQuality?: CallQualityMetrics | null;
  callDiagnostics?: CallDiagnosticEvent[];
  callHistory?: CallHistoryRecord[];
  isMuted?: boolean;
  allowCalls?: boolean;
  disableContactEditing?: boolean;
  /** True when there's an active group call you haven't joined */
  activeGroupCall?: boolean;
  onDeleteMessage?: (contactId: string, messageId: string) => void;
  onTyping?: (contactId: string) => void;
  /**
   * Called when the user confirms forwarding a message. The implementation
   * should send the original message text to each of the target contactIds.
   */
  onForwardMessage?: (contactIds: string[], message: Message) => void | Promise<void>;
  /** Contacts available as forward targets. Defaults to the `contacts` prop. */
  forwardContacts?: Contact[];
  /** Called to open the contact profile viewer (e.g. when the header name is clicked). */
  onOpenProfile?: (contact: Contact) => void;
  /** Mutually burns this conversation — clears it here and asks the peer to clear their copy too. */
  onBurnConversation?: (contactId: string) => void;
}

export const MessageThread = React.memo(function MessageThreadInner({
  contact,
  contacts = [],
  onClose,
  onSendMessage,
  onSendReaction,
  onSendReactionRevoke,
  onSendMessageEdit,
  onSendFile,
  onStartVoiceCall,
  onStartVideoCall,
  onAcceptIncomingCall,
  onDeclineIncomingCall,
  onEndCall,
  onRetryConnectionNow,
  onToggleMute,
  callPhase = 'idle',
  callDirection,
  callPeerId,
  callQuality,
  callDiagnostics = [],
  callHistory = [],
  isMuted = false,
  allowCalls = true,
  disableContactEditing = false,
  activeGroupCall = false,
  onDeleteMessage,
  onTyping,
  onForwardMessage,
  forwardContacts,
  onOpenProfile,
  onBurnConversation,
}: MessageThreadProps) {
  const [message, setMessage] = useState('');
  const [showEncryptionDetails, setShowEncryptionDetails] = useState<string | null>(null);

  // Pinned-messages bar state
  const [pinnedMessages, setPinnedMessages] = useState<PinnableStoredMessage[]>([]);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const [pinnedRefreshCounter, setPinnedRefreshCounter] = useState(0);

  // Load pinned messages whenever the conversation or refresh key changes
  useEffect(() => {
    const convId = contact.relayId || contact.id;
    let cancelled = false;
    (async () => {
      try {
        const pinned = await getPinnedMessages(convId);
        if (!cancelled) setPinnedMessages(pinned);
      } catch (err) {
        // Expected before storage is initialized — log at debug level.
        log.debug('[pinned] Failed to load pinned messages:', err);
        if (!cancelled) setPinnedMessages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contact.id, contact.relayId, pinnedRefreshCounter]);

  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState(contact.name);
  const [stagedFile, setStagedFile] = useState<File | null>(null);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSecs, setRecordingSecs] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef<number>(0);

  // Reply / quote state: set when the user picks "Reply" from a message menu
  const [replyingTo, setReplyingTo] = useState<{
    messageId: string;
    senderName: string;
    textPreview: string;
  } | null>(null);

  // Forward modal state
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);

  // Ghost-mode state: interval + whether the ghost thread is currently in view
  const ghostConvId = contact.relayId || contact.id;
  const ghost = useGhostMode(ghostConvId);
  const ghostView = useGhostModeActive(ghostConvId);
  const [showGhostMenu, setShowGhostMenu] = useState(false);
  const ghostBtnRef = useRef<HTMLButtonElement>(null);
  const [ghostMenuPos, setGhostMenuPos] = useState<{ top: number; right: number } | null>(null);

  // Measure ghost button and position the menu in viewport space
  useEffect(() => {
    if (!showGhostMenu || !ghostBtnRef.current) return;
    const r = ghostBtnRef.current.getBoundingClientRect();
    setGhostMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  }, [showGhostMenu]);

  // Close ghost menu on outside click / escape
  useEffect(() => {
    if (!showGhostMenu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('[data-ghost-menu]') || t.closest('[data-ghost-btn]'))) return;
      setShowGhostMenu(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowGhostMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showGhostMenu]);

  // Drag-and-drop overlay state for the compose container
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleReply = useCallback((msg: Message) => {
    const preview = msg.text?.trim()
      || (msg.fileShare ? `📎 ${msg.fileShare.filename}` : '');
    setReplyingTo({
      messageId: msg.id,
      senderName: msg.isOwn ? 'You' : (msg.senderName || contact.displayName || contact.name),
      textPreview: preview,
    });
  }, [contact.displayName, contact.name]);

  const handleForwardRequest = useCallback((msg: Message) => {
    setForwardingMessage(msg);
  }, []);

  const handleForwardConfirm = useCallback(async (contactIds: string[], msg: Message) => {
    if (onForwardMessage) {
      await onForwardMessage(contactIds, msg);
    }
    setForwardingMessage(null);
  }, [onForwardMessage]);

  // Clear reply state when switching conversations
  useEffect(() => {
    setReplyingTo(null);
  }, [contact.id, contact.relayId]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // reset so the same file can be re-selected
    e.target.value = '';
    // Stage the file for confirmation instead of sending immediately
    setStagedFile(file);
  };

  const handleCancelStagedFile = () => {
    setStagedFile(null);
  };

  const startRecording = async () => {
    try {
      const rec = await startVoiceRecording();
      mediaRecorderRef.current = rec.mediaRecorder;
      audioStreamRef.current = rec.stream;
      recordingStartRef.current = Date.now();
      setRecordingSecs(0);
      setIsRecording(true);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSecs(Math.floor((Date.now() - recordingStartRef.current) / 1000));
      }, 500);
      rec.mediaRecorder.start();
      rec.onStop(async (blob: Blob, durationMs: number) => {
        if (blob.size > 0) {
          const contactId = contact.relayId || contact.id;
          const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' });
          try { await onSendFile?.(contactId, file); } catch { /* ignore send errors */ }
        }
      });
    } catch {
      toast.error('Microphone error', 'Could not access microphone. Check permissions.');
    }
  };

  const stopRecording = () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    mediaRecorderRef.current?.stop();
    audioStreamRef.current?.getTracks().forEach((t) => t.stop());
    setIsRecording(false);
    setRecordingSecs(0);
  };

  // This component remounts via `key={selectedContactId}` when the user
  // switches conversations — without this, an in-progress voice recording
  // (live mic stream + MediaRecorder) started in the OLD conversation just
  // keeps running forever with no UI left to stop it, since isRecording's
  // stop button belongs to the unmounted instance.
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, []);

  const handleSend = async () => {
    // Send file if one is staged, then send message if one is typed
    const contactId = contact.relayId || contact.id;

    try {
      if (stagedFile) {
        await onSendFile?.(contactId, stagedFile);
        setStagedFile(null);
      }

      if (message.trim()) {
        const pendingText = message;
        const pendingReplyTo = replyingTo;
        setMessage('');
        setReplyingTo(null);
        if (onSendMessage) {
          try {
            await onSendMessage(contactId, pendingText, pendingReplyTo ?? undefined);
          } catch (err) {
            // Restore the drafted text and reply context so it isn't lost —
            // the user shouldn't have to retype a message just because the
            // send failed (e.g. WS disconnected, session not yet established).
            setMessage(pendingText);
            setReplyingTo(pendingReplyTo);
            throw err;
          }
        }
      }
    } catch (err) {
      log.error('Failed to send:', err);
      toast.error('Failed to send', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  const handleReaction = useCallback(async (messageId: string, emoji: string) => {
    try {
      await onSendReaction?.(contact.relayId || contact.id, messageId, emoji);
    } catch (err) {
      log.error('Failed to add reaction:', err);
    }
  }, [contact.id, contact.relayId, onSendReaction]);

  const handleReactionRevoke = useCallback(async (messageId: string, emoji: string) => {
    if (onSendReactionRevoke) {
      await onSendReactionRevoke(contact.relayId || contact.id, messageId, emoji);
    }
  }, [onSendReactionRevoke, contact.relayId, contact.id]);

  // Derive current user ID from messages
  const currentUserId = contact.messages.find(m => m.isOwn)?.senderId || '';
  const keyStats = useMemo(() => {
    let latest: Message | undefined;
    for (const msg of contact.messages) {
      if (!msg.encryptedBlob) continue;
      if (!latest || msg.timestamp.getTime() > latest.timestamp.getTime()) {
        latest = msg;
      }
    }
    return {
      publicKeyHex: contact.publicKeyHex || latest?.publicKeyHex,
      latestEncryptedBlob: latest?.encryptedBlob,
      latestMessageTime: latest?.timestamp,
    };
  }, [contact.messages, contact.publicKeyHex]);

  const latestNonce = useMemo(
    () => extractNonce(keyStats.latestEncryptedBlob),
    [keyStats.latestEncryptedBlob]
  );

  const latestNonceShort = useMemo(() => {
    if (!latestNonce) return null;
    if (latestNonce.length <= 18) return latestNonce;
    return `${latestNonce.slice(0, 8)}…${latestNonce.slice(-6)}`;
  }, [latestNonce]);

  const handleCopyKey = useCallback(async (label: string, value?: string | null) => {
    if (!value) return;
    try {
      await copyToClipboard(value);
      toast.success('Copied', label);
    } catch (err) {
      log.error('Copy failed:', err);
      toast.error('Copy failed', 'Unable to copy to clipboard.');
    }
  }, []);

  const handleEdit = useCallback(async (messageId: string, newText: string) => {
    try {
      await onSendMessageEdit?.(contact.relayId || contact.id, messageId, newText);
    } catch (err) {
      log.error('Failed to edit message:', err);
    }
  }, [contact.id, contact.relayId, onSendMessageEdit]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [contact.messages, ghostView.active]);

  const currentContactId = contact.relayId || contact.id;
  const canControlCurrentCall = !!callPeerId && callPeerId === currentContactId;
  const isIncomingForCurrent = canControlCurrentCall && callPhase === 'ringing' && callDirection === 'incoming';
  const isOngoingForCurrent = canControlCurrentCall && ['calling', 'ringing', 'connecting', 'in_call'].includes(callPhase);

  const callStatusText = (() => {
    if (!canControlCurrentCall) return null;
    if (callPhase === 'calling') return 'Calling…';
    if (callPhase === 'ringing') return callDirection === 'incoming' ? 'Incoming call' : 'Ringing…';
    if (callPhase === 'connecting') return 'Connecting call…';
    if (callPhase === 'in_call') return 'In call';
    if (callPhase === 'failed') return 'Call failed';
    if (callPhase === 'ended') return 'Call ended';
    return null;
  })();

  const qualityLevel = (() => {
    if (!callQuality) return null;
    if (callQuality.packetLossPct > 7 || callQuality.roundTripTimeMs > 450) return 'Poor';
    if (callQuality.packetLossPct > 3 || callQuality.roundTripTimeMs > 220) return 'Fair';
    return 'Good';
  })();

  const qualityColor =
    qualityLevel === 'Good' ? 'text-emerald-700 dark:text-emerald-300 border-emerald-500/30 bg-emerald-500/15'
    : qualityLevel === 'Fair' ? 'text-amber-700 dark:text-amber-300 border-amber-500/30 bg-amber-500/15'
    : 'text-rose-700 dark:text-rose-300 border-rose-500/30 bg-rose-500/15';

  const recentCallHistory = useMemo(
    () => callHistory.filter((item) => item.peerId === currentContactId).slice(0, 3),
    [callHistory, currentContactId]
  );

  const callAnalytics30d = useMemo(() => {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const scoped = callHistory.filter((item) => item.endedAt >= since);
    if (!scoped.length) return null;

    const completed = scoped.filter((item) => item.outcome === 'completed').length;
    const failed = scoped.filter((item) => item.outcome === 'failed').length;
    const missed = scoped.filter((item) => item.outcome === 'missed').length;
    const declined = scoped.filter((item) => item.outcome === 'declined').length;

    const successRate = (completed / scoped.length) * 100;
    const avgDurationSec = scoped.reduce((sum, item) => sum + item.durationSec, 0) / scoped.length;
    const avgReconnects = scoped.reduce((sum, item) => sum + item.reconnectAttempts, 0) / scoped.length;

    const setupSamples = scoped.filter((item) => typeof item.setupMs === 'number') as Array<CallHistoryRecord & { setupMs: number }>;
    const avgSetupMs = setupSamples.length
      ? setupSamples.reduce((sum, item) => sum + item.setupMs, 0) / setupSamples.length
      : null;

    return {
      total: scoped.length,
      completed,
      failed,
      missed,
      declined,
      successRate,
      avgDurationSec,
      avgReconnects,
      avgSetupMs,
    };
  }, [callHistory]);

  // Disappearing messages previously stayed visibly rendered (showing an
  // "Expired" label — see MessageBubble's own countdown) for up to 10s past
  // their expiresAt, since the only thing that ever removed them was
  // useGhostSweeper's 10s IndexedDB-delete interval. Ticking `now` here and
  // filtering with the same expiresAt check hides an expired message from
  // view within ~1s, independent of when the next sweep happens to run.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Filter messages by ghost-thread mode. When viewing the ghost thread we
  // show only messages marked `ghost: true`; otherwise we show only non-ghost
  // messages. This guarantees no overlap between the two tracks.
  const visibleMessages = useMemo(() => {
    const filtered = contact.messages.filter((m) => {
      const isGhost = !!(m as Message).ghost;
      return ghostView.active ? isGhost : !isGhost;
    });
    return filterExpired(filtered, now);
  }, [contact.messages, ghostView.active, now]);

  // Group consecutive messages from the same sender within 2 minutes
  const messageGroups = useMemo(() => {
    const msgs = visibleMessages;
    if (msgs.length === 0) return [];
    const groups: typeof msgs[] = [];
    let current = [msgs[0]];
    for (let i = 1; i < msgs.length; i++) {
      const prev = msgs[i - 1];
      const curr = msgs[i];
      const gap = Math.abs(curr.timestamp.getTime() - prev.timestamp.getTime());
      if (curr.isOwn === prev.isOwn && gap < 2 * 60 * 1000) {
        current.push(curr);
      } else {
        groups.push(current);
        current = [curr];
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }, [visibleMessages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      const h = Math.min(Math.max(inputRef.current.scrollHeight, 42), 140);
      inputRef.current.style.height = `${h}px`;
    }
  }, [message]);

  const [showCallDetails, setShowCallDetails] = useState(false);

  // Track call events to show inline system messages
  const [callEvents, setCallEvents] = useState<Array<{ id: string; text: string; timestamp: Date; icon: string }>>([]);
  const prevCallPhaseRef = useRef(callPhase);
  useEffect(() => {
    const prev = prevCallPhaseRef.current;
    prevCallPhaseRef.current = callPhase;
    if (!canControlCurrentCall && callPhase === 'idle') return;

    if (prev === 'idle' && (callPhase === 'calling' || callPhase === 'ringing')) {
      const dir = callDirection === 'incoming' ? 'Incoming' : 'Outgoing';
      setCallEvents((e) => [...e, { id: `ce_${Date.now()}`, text: `${dir} call`, timestamp: new Date(), icon: '📞' }]);
    }
    if ((prev === 'in_call' || prev === 'connecting' || prev === 'calling' || prev === 'ringing') && (callPhase === 'ended' || callPhase === 'idle')) {
      setCallEvents((e) => [...e, { id: `ce_${Date.now()}`, text: 'Call ended', timestamp: new Date(), icon: '📵' }]);
    }
    if (prev !== 'failed' && callPhase === 'failed') {
      setCallEvents((e) => [...e, { id: `ce_${Date.now()}`, text: 'Call failed', timestamp: new Date(), icon: '❌' }]);
    }
  }, [callPhase, callDirection, canControlCurrentCall]);

  return (
    <div className={`relative flex flex-col h-full bg-relay-bg transition-colors duration-300 ${
      ghostView.active ? 'bg-relay-accent/5 border-t-2 border-relay-accent/30' : ''
    }`}>
      {ghostView.active && (
        <>
          {/* Subtle ghost watermark in the corner */}
          <Ghost className="pointer-events-none absolute top-14 right-6 w-16 h-16 text-relay-accent/10 z-0" />
        </>
      )}
      {/* ── Header ── */}
      <div className="relative flex-shrink-0 bg-relay-bg/90 backdrop-blur-lg">
        <div className="absolute left-0 right-0 bottom-0 h-px bg-relay-border" />
        <div className="px-4 sm:px-5 py-3 flex items-center gap-3">
          {/* Back (mobile only) */}
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 -ml-1 rounded-lg text-relay-text-muted hover:text-relay-text-primary hover:bg-relay-surface-hover/60 transition-colors lg:hidden"
              aria-label="Back"
            >
              <X className="w-4 h-4" />
            </button>
          )}

          {/* Contact identity */}
          <UserAvatar
            emoji={contact.avatarEmoji}
            color={contact.avatarColor}
            size={36}
            online={contact.isOnline}
          />
          <div className="flex-1 min-w-0">
            {editingName && !disableContactEditing ? (
              <input
                type="text"
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                onBlur={() => {
                  setEditingName(false);
                  const contactId = contact.relayId || contact.id;
                  if (editNameValue !== contact.name && !isEphemeralContact(contactId)) {
                    upsertContact(contactId, {
                      name: editNameValue,
                      displayName: editNameValue,
                    }).catch((err) => {
                      log.warn('Failed to update contact name:', err);
                    });
                  }
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                className="bg-relay-surface-hover border border-relay-border-light rounded-lg px-2 py-1 text-sm text-white w-full focus:outline-none focus:border-relay-accent"
                autoFocus
              />
            ) : (
              <h2
                className={`text-sm font-semibold text-relay-text-primary truncate ${disableContactEditing ? '' : 'cursor-pointer hover:underline decoration-relay-accent/60 underline-offset-2'}`}
                onClick={() => {
                  if (disableContactEditing) return;
                  if (onOpenProfile) onOpenProfile(contact);
                  else setEditingName(true);
                }}
                title={onOpenProfile ? 'View profile' : 'Rename contact'}
              >
                {contact.displayName || contact.name}
              </h2>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3 h-3 text-emerald-500" />
                <p className="text-[11px] text-relay-text-muted truncate">{contact.relayId || contact.id}</p>
              </div>
              <span className="text-relay-text-muted/50">•</span>
              <div
                className="flex items-center gap-1.5 rounded-full border border-relay-border/60 bg-relay-surface/60 px-2 py-0.5"
                title={latestNonce ? `Message key: ${latestNonce}` : 'Waiting for first message key'}
              >
                <Key className="w-3 h-3 text-relay-accent/80" />
                <span className="text-[10px] font-mono text-relay-text-primary">
                  {latestNonceShort || 'key pending'}
                </span>
                {latestNonce && (
                  <button
                    onClick={() => handleCopyKey('Message key copied', latestNonce)}
                    className="p-0.5 rounded hover:bg-relay-surface-hover text-relay-text-muted hover:text-relay-text-primary transition-colors"
                    title="Copy message key"
                    aria-label="Copy message key"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Call action buttons */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {onBurnConversation && (
              <button
                onClick={() => {
                  if (confirm(`Burn this conversation with ${contact.displayName || contact.name}? This clears it here and asks them to clear their copy too — it can't be undone.`)) {
                    onBurnConversation(contact.relayId || contact.id);
                  }
                }}
                className="p-2 rounded-xl text-relay-text-secondary hover:bg-red-500/10 hover:text-red-500 transition-all duration-200"
                title="Burn conversation (mutual, irreversible)"
                aria-label="Burn conversation"
              >
                <Flame className="w-5 h-5" />
              </button>
            )}
            <button
              ref={ghostBtnRef}
              data-ghost-btn
              onClick={() => {
                if (!ghost.isOn) {
                  setShowGhostMenu(true);
                  return;
                }
                ghostView.toggle();
              }}
              onContextMenu={(e) => { e.preventDefault(); setShowGhostMenu((v) => !v); }}
              className={`p-2 rounded-xl transition-all duration-200 ${
                ghostView.active
                  ? 'bg-relay-accent text-relay-accent-foreground'
                  : ghost.isOn
                    ? 'bg-relay-accent/15 text-relay-accent'
                    : 'text-relay-text-secondary hover:bg-relay-surface-hover'
              }`}
              title={
                ghostView.active
                  ? `Viewing ghost thread · ${ghost.label}. Click to return.`
                  : ghost.isOn
                    ? `Ghost mode: ${ghost.label} — click to open ghost thread`
                    : 'Ghost mode (right-click to configure interval)'
              }
              aria-label="Ghost mode"
            >
              <Ghost className="w-5 h-5" />
            </button>
            {typeof document !== 'undefined' && showGhostMenu && ghostMenuPos && createPortal(
              <AnimatePresence>
                <motion.div
                  data-ghost-menu
                  key="ghost-menu"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  style={{ position: 'fixed', top: ghostMenuPos.top, right: ghostMenuPos.right, zIndex: 9999 }}
                  className="w-44 rounded-xl border border-relay-border bg-relay-surface shadow-xl py-1"
                >
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-relay-text-muted">
                    Ghost mode
                  </div>
                  <button
                    onClick={() => { ghostView.toggle(); setShowGhostMenu(false); }}
                    disabled={!ghost.isOn}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors border-b border-relay-border ${
                      !ghost.isOn
                        ? 'text-relay-text-muted cursor-not-allowed'
                        : ghostView.active
                          ? 'bg-relay-accent/15 text-relay-accent'
                          : 'text-relay-text-primary hover:bg-relay-surface-hover'
                    }`}
                  >
                    {ghostView.active ? '← Return to normal thread' : '→ Open ghost thread'}
                  </button>
                  {GHOST_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => { ghost.setSeconds(opt.value); setShowGhostMenu(false); }}
                      className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                        ghost.seconds === opt.value
                          ? 'bg-relay-accent/15 text-relay-accent'
                          : 'text-relay-text-primary hover:bg-relay-surface-hover'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </motion.div>
              </AnimatePresence>,
              document.body,
            )}
            {allowCalls && !isOngoingForCurrent && (
              <>
                <button
                  onClick={async () => {
                    if (!onStartVoiceCall) { toast.error('Call unavailable', 'Voice calling is not configured'); return; }
                    try {
                      await onStartVoiceCall(currentContactId);
                    } catch (err) {
                      log.error('[Call] Voice call failed:', err);
                      toast.error('Call failed', err instanceof Error ? err.message : 'Failed to start voice call');
                    }
                  }}
                  className="p-2 rounded-xl text-relay-text-secondary hover:bg-emerald-500/15 hover:text-emerald-600 dark:text-emerald-400 transition-all duration-200"
                  title="Voice call"
                  aria-label="Start voice call"
                >
                  <Phone className="w-4.5 h-4.5" />
                </button>
                <button
                  onClick={async () => {
                    if (!onStartVideoCall) { toast.error('Call unavailable', 'Video calling is not configured'); return; }
                    try {
                      await onStartVideoCall(currentContactId);
                    } catch (err) {
                      log.error('[Call] Video call failed:', err);
                      toast.error('Call failed', err instanceof Error ? err.message : 'Failed to start video call');
                    }
                  }}
                  className="p-2 rounded-xl text-relay-text-secondary hover:bg-blue-500/15 hover:text-blue-600 dark:text-blue-400 transition-all duration-200"
                  title="Video call"
                  aria-label="Start video call"
                >
                  <Video className="w-4.5 h-4.5" />
                </button>
              </>
            )}
            {isOngoingForCurrent && (
              <div className="flex items-center gap-1.5">
                {callPhase === 'in_call' && (
                  <button
                    onClick={() => onToggleMute?.()}
                    className={`p-2 rounded-xl transition-all duration-200 ${isMuted ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'text-relay-text-secondary hover:bg-relay-surface-hover'}`}
                    title={isMuted ? 'Unmute' : 'Mute'}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                )}
                <button
                  onClick={() => onEndCall?.()}
                  className="p-2 rounded-xl bg-red-500/15 text-red-600 dark:text-red-400 hover:bg-red-500/15 transition-all duration-200"
                  title="End call"
                  aria-label="End call"
                >
                  <PhoneOff className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Key info is inline in the header row */}

        {/* Compact in-call status banner */}
        <AnimatePresence>
          {callStatusText && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="px-4 sm:px-5 py-2 border-t border-relay-border/40 bg-relay-surface/50 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${
                    callPhase === 'in_call' ? 'bg-emerald-500 animate-pulse' :
                    callPhase === 'failed' ? 'bg-red-500' :
                    'bg-amber-500 animate-pulse'
                  }`} />
                  <span className="text-xs text-relay-text-secondary font-medium">{callStatusText}</span>
                  {callQuality && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${qualityColor}`}>
                      {qualityLevel} · {callQuality.roundTripTimeMs}ms
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {canControlCurrentCall && ['connecting', 'failed'].includes(callPhase) && (
                    <button
                      onClick={() => { void onRetryConnectionNow?.(); }}
                      className="px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[11px] font-medium transition-colors"
                    >
                      Retry
                    </button>
                  )}
                  {isIncomingForCurrent && (
                    <>
                      <button onClick={() => onAcceptIncomingCall?.().catch((err) => {
                        toast.error('Call failed', err instanceof Error ? err.message : 'Could not accept the call');
                      })} className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium">Accept</button>
                      <button onClick={() => onDeclineIncomingCall?.()} className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-600 text-white text-[11px] font-medium">Decline</button>
                    </>
                  )}
                  {(callDiagnostics.length > 0 || callQuality) && (
                    <button
                      onClick={() => setShowCallDetails(!showCallDetails)}
                      className="text-[11px] text-relay-text-muted hover:text-relay-text-secondary transition-colors px-1"
                    >
                      {showCallDetails ? 'Hide' : 'Details'}
                    </button>
                  )}
                </div>
              </div>

              {/* Expandable call details */}
              <AnimatePresence>
                {showCallDetails && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden px-4 sm:px-5 pb-2 space-y-2"
                  >
                    {canControlCurrentCall && callQuality && (
                      <div className="grid grid-cols-4 gap-2 text-[11px] text-relay-text-secondary bg-relay-surface/80 rounded-lg p-2">
                        <div>RTT <span className="text-relay-text-primary block">{callQuality.roundTripTimeMs}ms</span></div>
                        <div>Jitter <span className="text-relay-text-primary block">{callQuality.jitterMs}ms</span></div>
                        <div>Loss <span className="text-relay-text-primary block">{callQuality.packetLossPct}%</span></div>
                        <div>Rate <span className="text-relay-text-primary block">{callQuality.bitrateKbps}kbps</span></div>
                      </div>
                    )}
                    {canControlCurrentCall && callDiagnostics.length > 0 && (
                      <div className="space-y-0.5 max-h-20 overflow-y-auto text-[11px]">
                        {callDiagnostics.slice(-4).map((event) => (
                          <div key={event.id} className="flex items-center gap-1.5 text-relay-text-secondary">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              event.level === 'error' ? 'bg-red-400' : event.level === 'warn' ? 'bg-amber-400' : 'bg-emerald-400'
                            }`} />
                            <span className="truncate">{event.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Pinned messages bar */}
      {pinnedMessages.length > 0 && (
        <div className="relative flex-shrink-0 bg-relay-surface/80 backdrop-blur-sm">
          <div className="absolute left-0 right-0 bottom-0 h-px bg-relay-border" />
          <button
            onClick={() => setPinnedExpanded((v) => !v)}
            className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-relay-surface-hover transition-colors"
            title={pinnedExpanded ? 'Collapse pinned messages' : 'Expand pinned messages'}
            aria-label={pinnedExpanded ? 'Collapse pinned messages' : 'Expand pinned messages'}
          >
            <Pin className="w-3.5 h-3.5 text-relay-accent" />
            <span className="text-xs font-medium text-relay-text-primary">
              📌 {pinnedMessages.length} pinned {pinnedMessages.length === 1 ? 'message' : 'messages'}
            </span>
            <span className="ml-auto text-relay-text-muted">
              {pinnedExpanded ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </span>
          </button>
          <AnimatePresence>
            {pinnedExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="max-h-48 overflow-y-auto px-2 pb-2 space-y-1">
                  {pinnedMessages.map((pm) => (
                    <button
                      key={pm.id}
                      onClick={() => {
                        scrollToMessage(pm.id);
                        setPinnedExpanded(false);
                      }}
                      className="w-full text-left px-3 py-2 rounded-relay-sm bg-relay-surface hover:bg-relay-surface-hover border border-relay-border transition-colors"
                    >
                      <p className="text-xs text-relay-text-secondary truncate">{pm.text}</p>
                      <p className="text-[10px] text-relay-text-muted mt-0.5">
                        {new Date(pm.timestamp).toLocaleString([], {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Active call banner */}
      {/* Case 1: You're in the call — show "Leave" button */}
      {isOngoingForCurrent && (callPhase === 'in_call' || callPhase === 'connecting') && (
        <div className="flex-shrink-0 px-4 py-2.5 bg-emerald-950/40 border-b border-emerald-500/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Call in progress</span>
          </div>
          <button
            onClick={() => onEndCall?.()}
            className="px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/15 text-red-700 dark:text-red-300 text-[11px] font-medium transition-colors"
          >
            Leave
          </button>
        </div>
      )}
      {/* Case 2: There's an active group call you haven't joined — show "Join" */}
      {activeGroupCall && callPhase === 'idle' && (
        <div className="flex-shrink-0 px-4 py-2.5 bg-emerald-950/40 border-b border-emerald-500/30 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Group call active</span>
          </div>
          <button
            onClick={async () => {
              if (!onStartVoiceCall) return;
              try { await onStartVoiceCall(currentContactId); } catch (err) {
                log.error('[Call] Join failed:', err);
              }
            }}
            className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-medium transition-colors"
          >
            Join Call
          </button>
        </div>
      )}

      {/* ── Messages area ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-3 sm:px-4 py-4">
          {contact.messages.length === 0 && callEvents.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="space-y-4"
              >
                <div className="relative mx-auto w-20 h-20">
                  <motion.div
                    className="absolute inset-0 rounded-xl bg-relay-surface border border-relay-accent/20"
                    animate={{ rotate: [0, 6, -6, 0] }}
                    transition={{ duration: 5, repeat: Infinity }}
                  />
                  <div className="relative w-full h-full rounded-xl bg-relay-surface border border-relay-border flex items-center justify-center">
                    <UserAvatar emoji={contact.avatarEmoji} color={contact.avatarColor} size={40} />
                  </div>
                </div>
                <div>
                  <h3 className="text-base font-semibold text-relay-text-primary">{contact.displayName || contact.name}</h3>
                  <p className="text-xs text-relay-text-muted mt-1 max-w-[240px] mx-auto leading-relaxed">
                    Start your encrypted conversation. Messages are secured with ChaCha20-Poly1305.
                  </p>
                </div>
                <div className="flex items-center gap-1.5 justify-center text-emerald-500/70">
                  <Shield className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-medium">End-to-end encrypted</span>
                </div>
              </motion.div>
            </div>
          ) : (
            /* Grouped messages */
            <div className="space-y-1">
              {messageGroups.map((group, groupIdx) => {
                // Add date separator between groups with different days
                const prevGroup = groupIdx > 0 ? messageGroups[groupIdx - 1] : null;
                const currentDate = group[0].timestamp.toDateString();
                const prevDate = prevGroup ? prevGroup[prevGroup.length - 1].timestamp.toDateString() : null;
                const showDateSep = groupIdx === 0 || currentDate !== prevDate;

                return (
                  <div key={`grp-${groupIdx}`}>
                    {showDateSep && (
                      <div className="flex items-center gap-3 py-3">
                        <div className="flex-1 h-px bg-relay-surface-hover/60" />
                        <span className="text-[11px] text-relay-text-muted font-medium uppercase tracking-[0.08em]">
                          {group[0].timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: currentDate.slice(-4) !== new Date().getFullYear().toString() ? 'numeric' : undefined })}
                        </span>
                        <div className="flex-1 h-px bg-relay-surface-hover/60" />
                      </div>
                    )}
                    <div className={groupIdx > 0 && !showDateSep ? 'mt-3' : ''}>
                      {group.map((msg, msgIdx) => (
                        <motion.div
                          key={msg.id}
                          data-message-id={msg.id}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.15 }}
                          className={msgIdx > 0 ? 'mt-0.5' : ''}
                        >
                          <MessageBubble
                            message={msg}
                            showDetails={showEncryptionDetails === msg.id}
                            currentUserId={currentUserId}
                            conversationId={contact.relayId || contact.id}
                            onPinChange={() => setPinnedRefreshCounter((n) => n + 1)}
                            onToggleDetails={(id) =>
                              setShowEncryptionDetails(showEncryptionDetails === id ? null : id)
                            }
                            onReaction={(emoji) => handleReaction(msg.id, emoji)}
                            onReactionRevoke={(emoji) => handleReactionRevoke(msg.id, emoji)}
                            onEdit={(newText) => handleEdit(msg.id, newText)}
                            onReply={handleReply}
                            onForward={onForwardMessage ? handleForwardRequest : undefined}
                            onDelete={
                              onDeleteMessage
                                ? () => onDeleteMessage(contact.relayId || contact.id, msg.id)
                                : undefined
                            }
                          />
                        </motion.div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {/* Call event system messages */}
          {callEvents.map((event) => (
            <div key={event.id} className="flex items-center justify-center gap-2 py-2">
              <div className="h-px flex-1 bg-relay-surface-hover/40" />
              <span className="text-[11px] text-relay-text-muted flex items-center gap-1.5 px-2">
                <span>{event.icon}</span>
                <span>{event.text}</span>
                <span className="text-relay-text-muted">
                  {event.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
              <div className="h-px flex-1 bg-relay-surface-hover/40" />
            </div>
          ))}
          <PeerTypingIndicator contactId={contact.relayId || contact.id} senderName={contact.displayName || contact.name} />
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Encryption Details Modal */}
      <AnimatePresence>
        {showEncryptionDetails && (() => {
          const detailsMessage = contact.messages.find(m => m.id === showEncryptionDetails);
          // The message can disappear (deleted, ghost-swept) while this modal
          // is open — don't crash CompressionDetails on an undefined message.
          if (!detailsMessage) return null;
          return (
            <CompressionDetails
              message={detailsMessage}
              onClose={() => setShowEncryptionDetails(null)}
            />
          );
        })()}
      </AnimatePresence>

      {/* ── Staged File Preview ── */}
      <AnimatePresence>
        {stagedFile && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            className="flex-shrink-0 border-t border-relay-border/60 bg-relay-surface/60 backdrop-blur-sm px-4 py-3"
          >
            <div className="flex items-center gap-3">
              {stagedFile.type.startsWith('image/') ? (
                <img
                  src={URL.createObjectURL(stagedFile)}
                  alt="Preview"
                  className="w-14 h-14 rounded-lg object-cover border border-relay-border-light"
                />
              ) : (
                <div className="w-14 h-14 rounded-lg bg-relay-surface-hover border border-relay-border-light flex items-center justify-center">
                  <Paperclip className="w-5 h-5 text-relay-text-muted" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-relay-text-primary font-medium truncate">{stagedFile.name}</p>
                <p className="text-xs text-relay-text-muted">{(stagedFile.size / 1024).toFixed(1)} KB</p>
              </div>
              <button
                onClick={handleCancelStagedFile}
                className="p-1.5 rounded-lg hover:bg-relay-surface-hover text-relay-text-muted hover:text-red-600 dark:text-red-400 transition-colors"
                title="Remove"
                aria-label="Remove attached file"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Reply banner ── */}
      <AnimatePresence>
        {replyingTo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="flex-shrink-0 overflow-hidden border-t border-relay-border/60 bg-relay-surface/60 backdrop-blur-sm"
          >
            <div className="px-4 py-2 flex items-center gap-2 border-l-2 border-relay-accent">
              <Reply className="w-3.5 h-3.5 text-relay-accent flex-shrink-0" />
              <div className="flex-1 min-w-0 text-xs">
                <span className="text-relay-text-secondary">Replying to </span>
                <span className="font-semibold text-relay-text-primary">{replyingTo.senderName}</span>
                <span className="text-relay-text-secondary">: </span>
                <span className="italic text-relay-text-muted truncate inline-block align-bottom max-w-[60%]">
                  {replyingTo.textPreview.length > 80
                    ? replyingTo.textPreview.slice(0, 80) + '…'
                    : replyingTo.textPreview}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                className="p-1 rounded-lg hover:bg-relay-surface-hover text-relay-text-muted hover:text-relay-text-primary transition-colors flex-shrink-0"
                title="Cancel reply"
                aria-label="Cancel reply"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Forward modal ── */}
      <ForwardModal
        isOpen={!!forwardingMessage}
        message={forwardingMessage}
        contacts={forwardContacts || contacts}
        onClose={() => setForwardingMessage(null)}
        onConfirm={handleForwardConfirm}
      />

      {/* ── Compose Area ── */}
      <div
        className="relative flex-shrink-0 bg-relay-bg/90 backdrop-blur-lg px-3 sm:px-4 py-3"
        onDragEnter={(e) => {
          if (!e.dataTransfer?.types?.includes('Files')) return;
          e.preventDefault();
          dragCounterRef.current += 1;
          setIsDragOver(true);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer?.types?.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!e.dataTransfer?.types?.includes('Files')) return;
          dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
          if (dragCounterRef.current === 0) setIsDragOver(false);
        }}
        onDrop={async (e) => {
          if (!e.dataTransfer?.files?.length) return;
          e.preventDefault();
          dragCounterRef.current = 0;
          setIsDragOver(false);
          const contactId = contact.relayId || contact.id;
          const files = Array.from(e.dataTransfer.files);
          for (const f of files) {
            try { await onSendFile?.(contactId, f); }
            catch (err) { log.error('Drop send failed:', err); }
          }
        }}
      >
        {isDragOver && (
          <div className="absolute inset-0 z-20 bg-relay-accent/10 border-2 border-dashed border-relay-accent/40 pointer-events-none flex items-center justify-center">
            <span className="text-sm font-medium text-relay-accent bg-relay-bg/90 px-3 py-1 rounded-full border border-relay-accent/40">
              Drop to attach
            </span>
          </div>
        )}
        <div className="absolute left-0 right-0 top-0 h-px bg-relay-border" />
        {ghostView.active && (
          <div className="mb-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-relay-accent text-relay-accent-foreground text-[11px] font-medium">
            <Ghost className="w-3 h-3" />
            <span>Ghost thread · {ghost.label}</span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="relay-icon-btn flex-shrink-0 mb-0.5"
            title="Attach file"
            aria-label="Attach file"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <button
            onClick={() => imageInputRef.current?.click()}
            className="relay-icon-btn flex-shrink-0 mb-0.5"
            title="Send image"
            aria-label="Send image"
          >
            <ImageIcon className="w-4 h-4" />
          </button>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) { e.target.value = ''; setStagedFile(file); }
            }}
          />

          <div className="flex-1 flex items-end gap-2 bg-relay-surface/80 rounded-xl focus-within:ring-2 focus-within:ring-relay-accent/40 transition-all px-3.5 py-2">
            <textarea
              ref={inputRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                // Queue the first pasted file as stagedFile so the user
                // can add a caption and explicitly press Send.
                for (let i = 0; i < items.length; i++) {
                  const it = items[i];
                  if (it.kind === 'file') {
                    const f = it.getAsFile();
                    if (f) {
                      e.preventDefault();
                      setStagedFile(f);
                      return;
                    }
                  }
                }
              }}
              placeholder={stagedFile ? 'Add a caption...' : ghostView.active ? 'Ghost message…' : 'Message...'}
              className="flex-1 bg-transparent text-sm text-relay-text-primary placeholder-relay-text-muted resize-none focus:outline-none leading-normal py-0.5"
              style={{ minHeight: '24px', maxHeight: '140px' }}
              rows={1}
            />
          </div>

          {isRecording ? (
            <div className="flex items-center gap-2 flex-shrink-0 mb-0.5">
              <span className="text-xs text-relay-danger font-mono tabular-nums">
                {Math.floor(recordingSecs / 60)}:{String(recordingSecs % 60).padStart(2, '0')}
              </span>
              <button
                onClick={stopRecording}
                className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-relay-danger text-white hover:bg-relay-danger/90 transition-colors"
                title="Stop recording and send"
                aria-label="Stop recording and send"
              >
                <StopCircle className="w-4 h-4" />
              </button>
            </div>
          ) : message.trim() || stagedFile ? (
            <button
              onClick={() => void handleSend()}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0 mb-0.5 bg-relay-accent text-relay-accent-foreground hover:bg-relay-accent/90 transition-colors"
              title="Send"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={startRecording}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md flex-shrink-0 mb-0.5 bg-relay-surface-hover/60 text-relay-text-muted hover:bg-relay-accent/20 hover:text-relay-accent transition-colors"
              title="Record voice message"
              aria-label="Record voice message"
            >
              <Mic className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

function PeerTypingIndicator({ contactId, senderName }: { contactId: string; senderName: string }) {
  const indicator = useAppStore((s) => s.typingIndicators.get(contactId));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!indicator) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [indicator]);
  if (!getBoolSetting('typing-indicators', true)) return null;
  const visible = !!indicator && indicator.showUntil > now;
  if (!visible) return null;
  return <TypingIndicator senderName={senderName} isVisible />;
}