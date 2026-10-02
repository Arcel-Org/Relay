'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { Message } from '@/lib/mock-data';
import { Check, CheckCheck, Clock, AlertCircle, Shield, Copy, Edit2, Smile, Trash2, Reply, Share2, Pin, Bookmark, Loader2, MoreHorizontal, FileText, Download, File as FileIcon, Ghost } from 'lucide-react';
import { MessageEditModal } from './MessageEditModal';
import { MessageActionMenu } from './MessageActionMenu';
import { copyToClipboard } from '@/lib/utils';
import type { MenuAction } from './MessageActionMenu';
import { ImageLightbox } from './ImageLightbox';
import { log } from '@/lib/platform/logger';
import { parseMentions, renderMentionsToJSX } from '@/lib/features/mentions';
import { pinMessage, unpinMessage } from '@/lib/features/pinned-messages';
import { addBookmark, removeBookmark, isBookmarked } from '@/lib/features/bookmarks';
import { dataUrlMimeType } from '@/lib/security/sanitize';

interface MessageBubbleProps {
  message: any;
  onReaction?: (emoji: string) => Promise<void>;
  onReactionRevoke?: (emoji: string) => Promise<void>;
  onEdit?: (newText: string) => Promise<void>;
  onReply?: (message: any) => void;
  onForward?: (message: any) => void;
  showDetails?: boolean;
  onToggleDetails?: (messageId: string) => void;
  currentUserId?: string;
  /** Members of the conversation for @mention resolution (group chats) */
  mentionMembers?: Array<{ relayId: string; username?: string; displayName?: string }>;
  /** The current user's relayId — used to style self-mentions */
  currentRelayId?: string;
  /** Conversation id — used by the pin/unpin actions */
  conversationId?: string;
  /** Invoked after a pin/unpin action succeeds so parent can refresh */
  onPinChange?: () => void;
  /** Delete this message from local storage. */
  onDelete?: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const MessageBubble = React.memo(function MessageBubbleInner({
  message,
  onReaction,
  onReactionRevoke,
  onEdit,
  onReply,
  onForward,
  showDetails = false,
  onToggleDetails,
  currentUserId = '',
  mentionMembers,
  currentRelayId,
  conversationId,
  onPinChange,
  onDelete,
}: MessageBubbleProps) {
  const [bookmarked, setBookmarked] = useState<boolean>(() => {
    try { return isBookmarked(message.id); } catch { return false; }
  });
  const [timeRemaining, setTimeRemaining] = useState<string>('');
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [showEditModal, setShowEditModal] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  
  const bubbleRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close menu with Escape key
  useEffect(() => {
    if (!showActionMenu) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowActionMenu(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showActionMenu]);

  const reactionOptions = ['👍', '❤️', '😂', '😮', '🙏', ''];

  const getCompressionDot = () => {
    const ratio = message.metadata.compression_ratio;
    if (ratio < 0.5) return 'bg-emerald-500';
    if (ratio < 0.7) return 'bg-amber-400';
    return 'bg-rose-500';
  };

  const getStatusIcon = () => {
    const status = message.status || (message.delivered ? 'delivered' : 'sending');
    switch (status) {
      case 'sending':
        return <span title="Sending..."><div className="w-2 h-2 rounded-full bg-relay-text-muted opacity-50" /></span>;
      case 'delivered':
        return <span title="Delivered"><CheckCheck className="w-3.5 h-3.5 text-relay-text-muted" /></span>;
      case 'read':
        return <span title="Read"><CheckCheck className="w-3.5 h-3.5 text-relay-accent" /></span>;
      case 'pending':
        return <span title="Sending..."><Loader2 className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 animate-spin" /></span>;
      case 'error':
        return <span title="Failed to send"><AlertCircle className="w-3.5 h-3.5 text-rose-500" /></span>;
      case 'received':
        return <span title="Received"><Shield className="w-3.5 h-3.5 text-green-500" /></span>;
      default:
        return message.read ? (
          <span title="Read"><CheckCheck className="w-3.5 h-3.5 text-relay-accent" /></span>
        ) : message.delivered ? (
          <span title="Delivered"><CheckCheck className="w-3.5 h-3.5 text-relay-text-muted" /></span>
        ) : (
          <span title="Sent"><Check className="w-3.5 h-3.5 text-relay-text-muted" /></span>
        );
    }
  };

  const handleReaction = async (emoji: string) => {
    setShowReactionPicker(false);
    try {
      await onReaction?.(emoji);
    } catch (err) {
      log.error('Failed to add reaction:', err);
    }
  };

  const handleEditSave = async (newText: string) => {
    try {
      setIsLoading(true);
      await onEdit?.(newText);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await copyToClipboard(message.text);
    } catch (err) {
      log.error('Failed to copy message:', err);
    }
    setShowActionMenu(false);
  };

  const handleEmojiSelect = async (emoji: string) => {
    await handleReaction(emoji);
    setShowActionMenu(false);
  };

  const handleMenuButtonClick = () => {
    if (menuButtonRef.current) {
      const rect = menuButtonRef.current.getBoundingClientRect();
      // Position menu below and to the right of the button
      setMenuPos({ x: rect.right - 10, y: rect.bottom + 5 });
    }
    setShowActionMenu(true);
  };

  // Build menu actions
  const menuActions: MenuAction[] = [];

  // Reaction Group
  if (onReaction) {
    menuActions.push({
      id: 'emoji',
      label: 'React',
      icon: <Smile className="w-4 h-4" />,
      onClick: () => {
        // This is handled by the emoji picker in the menu
      },
      group: 'reaction',
    });
  }

  // Interact Group (Copy & Edit)
  menuActions.push({
    id: 'copy',
    label: 'Copy',
    icon: <Copy className="w-4 h-4" />,
    onClick: handleCopy,
    group: 'interact',
  });

  if (message.isOwn && onEdit && (!message.fileShare || message.text.trim())) {
    menuActions.push({
      id: 'edit',
      label: 'Edit',
      icon: <Edit2 className="w-4 h-4" />,
      onClick: () => {
        setShowActionMenu(false);
        setShowEditModal(true);
      },
      group: 'interact',
    });
  }

  // Manage Group (Reply, Pin, Bookmark, Delete)
  menuActions.push({
    id: 'reply',
    label: 'Reply',
    icon: <Reply className="w-4 h-4" />,
    onClick: () => {
      setShowActionMenu(false);
      onReply?.(message);
    },
    group: 'manage',
  });

  if (onForward) {
    menuActions.push({
      id: 'forward',
      label: 'Forward',
      icon: <Share2 className="w-4 h-4" />,
      onClick: () => {
        setShowActionMenu(false);
        onForward?.(message);
      },
      group: 'manage',
    });
  }

  menuActions.push({
    id: 'bookmark',
    label: bookmarked ? 'Remove bookmark' : 'Bookmark',
    icon: <Bookmark className="w-4 h-4" />,
    onClick: () => {
      setShowActionMenu(false);
      try {
        if (bookmarked) {
          removeBookmark(message.id);
          setBookmarked(false);
        } else {
          addBookmark({
            id: message.id,
            conversationId: conversationId || message.conversationId || '',
            text: message.text || '',
            senderName: message.senderName || (message.isOwn ? 'You' : undefined),
            senderRelayId: message.senderId,
            timestamp: message.timestamp instanceof Date
              ? message.timestamp.getTime()
              : Number(message.timestamp) || Date.now(),
          });
          setBookmarked(true);
        }
      } catch (err) {
        log.error('Bookmark toggle failed:', err);
      }
    },
    group: 'manage',
  });

  menuActions.push({
    id: 'pin',
    label: message.pinned ? 'Unpin' : 'Pin',
    icon: <Pin className="w-4 h-4" />,
    onClick: async () => {
      setShowActionMenu(false);
      if (!conversationId) {
        log.debug('Pin skipped: no conversationId');
        return;
      }
      try {
        if (message.pinned) {
          await unpinMessage(conversationId, message.id);
        } else {
          await pinMessage(conversationId, message.id);
        }
        onPinChange?.();
      } catch (err) {
        log.error('Failed to pin/unpin message:', err);
      }
    },
    group: 'manage',
  });

  // Delete Group (only for own messages)
  if (message.isOwn) {
    menuActions.push({
      id: 'delete',
      label: 'Delete',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: () => {
        setShowActionMenu(false);
        if (typeof window !== 'undefined' && !window.confirm('Delete this message?')) {
          return;
        }
        onDelete?.();
      },
      group: 'delete',
      isDestructive: true,
    });
  }

  const timeStr = message.timestamp.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const bubbleClass = message.isOwn
    ? 'bg-relay-surface border border-relay-accent/40 backdrop-blur-md'
    : 'bg-relay-surface-hover/50 border border-relay-border-light/40 backdrop-blur-md';

  // Resolve @mentions in the message body. Falls back to currentUserId as the
  // "self" identifier when the caller hasn't supplied an explicit relayId.
  const parsedMentions = React.useMemo(() => {
    if (!message.text || !mentionMembers || mentionMembers.length === 0) return [];
    return parseMentions(message.text, mentionMembers);
  }, [message.text, mentionMembers]);

  const selfId = currentRelayId || currentUserId || '';
  const hasSelfMention =
    !!selfId && parsedMentions.some((m) => m.relayId === selfId);

  useEffect(() => {
    if (!message.expiresAt) return;
    const update = () => {
      const remaining = message.expiresAt! - Date.now();
      if (remaining <= 0) {
        setTimeRemaining('Expired');
      } else {
        const seconds = Math.floor(remaining / 1000);
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        setTimeRemaining(`${minutes}:${secs.toString().padStart(2, '0')}`);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [message.expiresAt]);

  return (
    <div
      data-msg-id={message.id}
      className={`flex ${message.isOwn ? 'justify-end' : 'justify-start'} group/bubble px-2`}
    >
      <div
        ref={bubbleRef}
        className={`max-w-[75%] lg:max-w-md flex flex-col ${message.isOwn ? 'items-end' : 'items-start'}`}
      >
        <div
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuPos({ x: e.clientX, y: e.clientY });
            setShowActionMenu(true);
          }}
          onTouchStart={(e) => {
            const touch = e.touches[0];
            longPressTimer.current = setTimeout(() => {
              setMenuPos({ x: touch.clientX, y: touch.clientY });
              setShowActionMenu(true);
            }, 500);
          }}
          onTouchEnd={() => {
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }}
          onTouchMove={() => {
            if (longPressTimer.current) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }}
          className={`px-3.5 py-2 rounded-xl cursor-default transition-all duration-150 relative group ${
            message.isOwn
              ? 'bg-relay-accent-muted text-relay-text-primary rounded-br-sm'
              : 'bg-relay-surface-hover/90 text-relay-text-primary rounded-bl-sm'
          } ${showDetails ? 'ring-1 ring-relay-accent/60' : ''} ${
            message.status === 'error' ? 'opacity-50' : ''
          } ${hasSelfMention ? 'ring-1 ring-amber-500/40' : ''}`}
        >
          {/* Pinned indicator */}
          {message.pinned && (
            <span
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-amber-500/90 text-white flex items-center justify-center shadow"
              title="Pinned message"
            >
              <Pin className="w-3 h-3" />
            </span>
          )}
          {/* Sender name (group chats) */}
          {!message.isOwn && message.senderName && (
            <p className="text-[11px] font-semibold text-relay-accent/80 mb-0.5 truncate">
              {message.senderName}
            </p>
          )}

          {/* Reply / Quote block */}
          {message.replyTo && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (typeof document !== 'undefined') {
                  const target = document.querySelector(
                    `[data-msg-id="${message.replyTo.messageId}"]`,
                  );
                  target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }}
              className={`block w-full text-left mb-1.5 pl-2 pr-2 py-1 border-l-2 rounded-sm italic text-[11.5px] leading-snug transition-colors ${
                message.isOwn
                  ? 'border-relay-text-primary/40 bg-relay-text-primary/10 hover:bg-relay-text-primary/15'
                  : 'border-relay-accent bg-relay-surface/40 hover:bg-relay-surface/60'
              }`}
              title="Jump to original message"
            >
              <span className={`block font-semibold not-italic ${
                message.isOwn ? 'text-white/90' : 'text-relay-accent/90'
              }`}>
                {message.replyTo.senderName}
              </span>
              <span className={`block truncate ${
                message.isOwn ? 'text-white/80' : 'text-relay-text-secondary'
              }`}>
                {message.replyTo.textPreview.length > 80
                  ? message.replyTo.textPreview.slice(0, 80) + '…'
                  : message.replyTo.textPreview}
              </span>
            </button>
          )}

          {/* Forwarded indicator */}
          {message.forwardedFrom && (
            <p className={`text-[10px] italic mb-0.5 flex items-center gap-1 ${
              message.isOwn ? 'text-white/60' : 'text-relay-text-muted'
            }`}>
              <Share2 className="w-2.5 h-2.5" />
              Forwarded
            </p>
          )}

          {/* Message text */}
          {message.text && (
            <p className={`text-[13.5px] leading-relaxed break-words ${
              message.status === 'error' ? 'line-through opacity-60' : ''
            }`}>
              {parsedMentions.length > 0
                ? renderMentionsToJSX(message.text, parsedMentions, selfId || undefined)
                : message.text}
            </p>
          )}

          {message.status === 'error' && message.errorMessage && (
            <p className="text-[11px] opacity-70 italic mt-0.5">{message.errorMessage}</p>
          )}

          {/* File/Image attachment */}
          {message.fileShare && (() => {
            const fs = message.fileShare;
            // Classify off the MIME type actually embedded in the data: URI
            // (already restricted to a safe allowlist by isSafeDataUrl at
            // receive time), not the peer-supplied `type`/filename labels —
            // those are just UI hints and could otherwise be used to
            // mislabel one safe media type as another.
            const realMime = fs.dataUrl ? dataUrlMimeType(fs.dataUrl) : null;
            const mime: string = (realMime || fs.type || '').toLowerCase();
            const name: string = fs.filename || '';
            const ext = name.toLowerCase().split('.').pop() || '';
            const isImage = mime.startsWith('image/') && fs.dataUrl;
            const isAudio = !!fs.dataUrl && (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'oga', 'm4a'].includes(ext));
            const isVideo = !!fs.dataUrl && (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext));
            const isPdf = !!fs.dataUrl && (mime === 'application/pdf' || ext === 'pdf');
            return (
              <div
                className={`mt-1.5 rounded-lg overflow-hidden text-xs ${
                  message.isOwn
                    ? 'bg-relay-text-primary/10 border border-relay-text-primary/15'
                    : 'bg-relay-surface-hover/50 border border-relay-border-light/30'
                }`}
              >
                {isImage ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={message.fileShare.dataUrl}
                      alt={message.fileShare.filename}
                      className="max-w-full max-h-60 w-auto block cursor-zoom-in"
                      loading="lazy"
                      onClick={(e) => {
                        e.stopPropagation();
                        setLightboxOpen(true);
                      }}
                    />
                    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                      <div className="min-w-0">
                        <span className="truncate opacity-60 text-[11px] block">{message.fileShare.filename}</span>
                        {message.fileShare.original_size != null && (
                          <span className="text-[10px] opacity-40 block">{formatFileSize(message.fileShare.original_size)}</span>
                        )}
                      </div>
                      <a
                        href={message.fileShare.dataUrl}
                        download={message.fileShare.filename}
                        className="flex-shrink-0 px-2 py-0.5 rounded-md bg-relay-text-primary/15 hover:bg-relay-text-primary/20 text-[11px] transition-colors self-start"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Save
                      </a>
                    </div>
                    <ImageLightbox
                      src={message.fileShare.dataUrl}
                      filename={message.fileShare.filename}
                      isOpen={lightboxOpen}
                      onClose={() => setLightboxOpen(false)}
                    />
                  </>
                ) : isAudio ? (
                  <MediaAttachment
                    kind="audio"
                    dataUrl={fs.dataUrl!}
                    mime={mime || 'audio/mpeg'}
                    name={name}
                    sizeLabel={fs.original_size != null ? formatFileSize(fs.original_size) : null}
                  />
                ) : isVideo ? (
                  <MediaAttachment
                    kind="video"
                    dataUrl={fs.dataUrl!}
                    mime={mime || 'video/mp4'}
                    name={name}
                    sizeLabel={fs.original_size != null ? formatFileSize(fs.original_size) : null}
                  />
                ) : isVideo ? (
                  <div className="flex flex-col">
                    <video
                      controls
                      preload="metadata"
                      src={fs.dataUrl}
                      className="rounded-xl block max-w-full"
                      style={{ maxWidth: 320, maxHeight: 240 }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                      <span className="truncate text-[11px] opacity-60">{name}</span>
                      {fs.original_size != null && (
                        <span className="text-[10px] opacity-40 tabular-nums">{formatFileSize(fs.original_size)}</span>
                      )}
                    </div>
                  </div>
                ) : isPdf ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (fs.dataUrl) window.open(fs.dataUrl, '_blank', 'noopener,noreferrer');
                    }}
                    className="w-full p-2.5 flex items-center gap-2.5 text-left hover:bg-relay-accent/5 transition-colors"
                  >
                    <div className="w-9 h-9 rounded-md bg-relay-accent/15 text-relay-accent flex items-center justify-center flex-shrink-0">
                      <FileText className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate text-[12px]">{name || 'Document.pdf'}</p>
                      <p className="text-[11px] opacity-60 mt-0.5">
                        PDF{fs.original_size != null ? ` · ${formatFileSize(fs.original_size)}` : ''} · Open
                      </p>
                    </div>
                  </button>
                ) : (
                  <div className="p-2.5 flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-md bg-relay-text-primary/10 text-relay-text-secondary flex items-center justify-center flex-shrink-0">
                      <FileIcon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate text-[12px]">{name}</p>
                      <p className="text-[11px] opacity-60 mt-0.5">
                        {formatFileSize(fs.original_size)}
                      </p>
                    </div>
                    {fs.dataUrl && (
                      <a
                        href={fs.dataUrl}
                        download={name}
                        className="flex-shrink-0 p-1.5 rounded-md bg-relay-text-primary/10 hover:bg-relay-text-primary/20 transition-colors"
                        onClick={(e) => e.stopPropagation()}
                        title="Download"
                        aria-label="Download"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Timestamp + status row */}
          <div className={`flex items-center gap-1.5 mt-1 text-[11px] ${
            message.isOwn ? 'opacity-60 justify-end' : 'opacity-50 justify-start'
          }`}>
            <span className="font-mono">{timeStr}</span>

            {message.isEdited && (
              <span className="italic">(edited)</span>
            )}

            {timeRemaining && (
              <span className="flex items-center gap-0.5 font-mono text-relay-accent/80" title="Message auto-deletes">
                <Ghost className="w-2.5 h-2.5" />
                {timeRemaining}
              </span>
            )}

            {message.isOwn && getStatusIcon()}

            {/* More options */}
            <button
              ref={menuButtonRef}
              onClick={handleMenuButtonClick}
              className="inline-flex items-center justify-center w-6 h-6 rounded text-relay-text-primary/60 hover:text-relay-text-primary hover:bg-relay-text-primary/10 focus:text-relay-text-primary focus:bg-relay-text-primary/10 transition-colors"
              title="More options"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Reaction badges */}
        {message.reactions && message.reactions.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${message.isOwn ? 'justify-end' : 'justify-start'}`}>
            {message.reactions.map((reaction: any) => {
              const isUserReaction = reaction.senders.includes(currentUserId);
              return (
                <button
                  key={reaction.emoji}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isUserReaction) {
                      onReactionRevoke?.(reaction.emoji);
                    } else {
                      onReaction?.(reaction.emoji);
                    }
                  }}
                  className={`px-1.5 py-0.5 rounded-full text-xs transition-colors ${
                    isUserReaction
                      ? 'bg-relay-accent/30 border border-relay-accent/50 hover:bg-relay-accent/50'
                      : 'bg-relay-surface-hover/60 border border-relay-border-light hover:bg-relay-surface-hover/60'
                  }`}
                  title={`${reaction.senders.join(', ')} reacted`}
                >
                  <span>{reaction.emoji}</span>
                  {reaction.senders.length > 1 && <span className="text-[10px] opacity-70 ml-0.5">{reaction.senders.length}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Action Menu */}
        <AnimatePresence>
          {showActionMenu && (
            <MessageActionMenu
              actions={menuActions}
              onClose={() => setShowActionMenu(false)}
              position={menuPos}
              onEmojiSelect={handleEmojiSelect}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Edit Modal */}
      <MessageEditModal
        isOpen={showEditModal}
        messageText={message.text}
        messageId={message.id}
        onSave={handleEditSave}
        onCancel={() => setShowEditModal(false)}
      />
    </div>
  );
});

/**
 * MediaAttachment — renders audio/video from a data: URL by converting to
 * a Blob URL first, so the browser can seek and report duration properly.
 */
function MediaAttachment({
  kind,
  dataUrl,
  mime,
  name,
  sizeLabel,
}: {
  kind: 'audio' | 'video';
  dataUrl: string;
  mime: string;
  name: string;
  sizeLabel: string | null;
}) {
  const blobUrl = useMemo(() => {
    try {
      // data URL → Uint8Array → Blob → object URL.
      const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/.exec(dataUrl);
      const rawMime = match?.[1] || mime;
      const isB64 = /;base64/.test(dataUrl);
      const body = match?.[2] ?? '';
      if (!body) return null;
      if (isB64) {
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: rawMime }));
      }
      return URL.createObjectURL(new Blob([decodeURIComponent(body)], { type: rawMime }));
    } catch {
      return null;
    }
  }, [dataUrl, mime]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  const src = blobUrl || dataUrl;

  if (kind === 'audio') {
    return (
      <div className="p-2 flex flex-col gap-1.5 min-w-[240px]">
        <audio
          controls
          preload="metadata"
          src={src}
          className="w-full max-w-xs h-9 rounded-md"
          onClick={(e) => e.stopPropagation()}
        />
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="truncate text-[11px] opacity-70">{name}</span>
          {sizeLabel && <span className="text-[10px] opacity-50 tabular-nums">{sizeLabel}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <video
        controls
        preload="metadata"
        src={src}
        className="rounded-xl block max-w-full"
        style={{ maxWidth: 320, maxHeight: 240 }}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <span className="truncate text-[11px] opacity-60">{name}</span>
        {sizeLabel && <span className="text-[10px] opacity-40">{sizeLabel}</span>}
      </div>
    </div>
  );
}
