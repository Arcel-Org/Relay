export interface CompressionMetadata {
  compression_ratio: number; // 0.3-0.9
  original_size: number; // bytes
  compressed_size: number; // bytes
  encrypted_size: number; // bytes
  latency_ms: number;
  neural_model_score: number; // 0-1
}

export interface Reaction {
  emoji: string;
  senders: string[]; // senderId or senderName
}

export interface Message {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: Date;
  isOwn: boolean;
  read: boolean;
  delivered: boolean;
  metadata: CompressionMetadata;
  fileShare?: {
    filename: string;
    originalFilename?: string;
    original_size: number;
    compressed_size: number;
    compression_ratio: number;
    type: string;
    /** Base64 data-URL for the file content — present on received files so they can be downloaded */
    dataUrl?: string;
  };
  reactions?: Reaction[];
  messageType?: 'normal' | 'reaction' | 'system';
  referencedMessageId?: string;
  replyTo?: {
    messageId: string;
    senderName: string;
    textPreview: string;
  };
  forwardedFrom?: string;
  isEdited?: boolean;
  editedAt?: Date;
  editCount?: number;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'error' | 'pending';
  /** True when this message has been pinned in its conversation */
  pinned?: boolean;
  /** True when this message was sent in ghost mode — lives in the ghost thread,
   *  separate from normal messages, and carries an `expiresAt`. */
  ghost?: boolean;
  /** Expiry time in ms since epoch, set for ghost-mode messages */
  expiresAt?: number;
  /** Error message to display alongside a failed send. */
  errorMessage?: string;
  /** Sender's public key in hex (for key exchange visualization) */
  publicKeyHex?: string;
  /** Encrypted message blob in hex (contains ephemeral nonce in header) */
  encryptedBlob?: string;
}

export interface Contact {
  id: string;
  name: string;
  avatar: string;
  isOnline: boolean;
  lastSeen?: Date;
  messages: Message[];
  relayId?: string; // The actual relay identifier (bare xxxx-xxxx-...-xxxx format)
  displayName?: string; // User's display name
  username?: string; // User's @username
  bio?: string; // User's bio
  avatarEmoji?: string; // Permanently assigned emoji avatar
  avatarColor?: string; // Permanently assigned background color (random hex)
  publicKeyHex?: string; // Public key hex for key exchange
  /** True when the user has archived this conversation — hidden from the main sidebar */
  archived?: boolean;
  /** True when the user has blocked this contact — see lib/features/block.ts for enforcement points */
  blocked?: boolean;
  /** Millis timestamp of when this contact was added locally. */
  addedAt?: number;
}
