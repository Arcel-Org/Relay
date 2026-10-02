/**
 * Contact bookkeeping for the messaging layer — localStorage-backed contact
 * list, current-user tracking, and message-expiry cleanup, complementing
 * the encrypted IndexedDB store in lib/relay-store.ts. Real message
 * send/receive happens via lib/relay-websocket.ts + lib/relay-crypto.ts
 * Sessions in lib/use-relay-messaging.ts — this class does not carry live
 * message traffic.
 */

import { Session, buildDictionary, computeSharedSecret, deriveSessionRole } from '@/lib/crypto/relay-crypto';
import type { Contact, Message, CompressionMetadata } from '@/lib/mock-data';
import { log } from '@/lib/platform/logger';

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  name: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: Date;
  lastLogin: Date;
  isVerified: boolean;
}

export interface StoredContact {
  userId: string;
  contactUserId: string;
  contactName: string;
  contactPublicKey: Uint8Array;
  sharedSecret?: Uint8Array;
  addedAt: Date;
}

export interface StoredMessage {
  id: string;
  fromUserId: string;
  toUserId: string;
  encryptedContent: Uint8Array;
  nonce: Uint8Array;
  timestamp: Date;
  expiresAt: Date; // 20 minutes from now if recipient not verified
  read: boolean;
  delivered: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// STORAGE KEYS
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_PREFIX = 'relay:';
const USERS_KEY = `${STORAGE_PREFIX}users`;
const CONTACTS_KEY = `${STORAGE_PREFIX}contacts`;
const MESSAGES_KEY = `${STORAGE_PREFIX}messages`;
const DICT_KEY = `${STORAGE_PREFIX}dict`;
const CURRENT_USER_KEY = `${STORAGE_PREFIX}currentUserId`;

// ─────────────────────────────────────────────────────────────────────────
// MESSAGE SERVICE (singleton)
// ─────────────────────────────────────────────────────────────────────────

export class RelayMessagingService {
  private static instance: RelayMessagingService;
  private dictionary: Uint8Array | null = null;
  private sessions: Map<string, Session> = new Map(); // userId -> Session
  private currentUserId: string | null = null;

  private constructor() {
    this.loadCurrentUser();
    this.initializeDictionary();
  }

  static getInstance(): RelayMessagingService {
    if (!this.instance) {
      this.instance = new RelayMessagingService();
    }
    return this.instance;
  }

  private getStorage(key: string): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(key);
  }

  private setStorage(key: string, value: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(key, value);
  }

  // ─────────────────────────────────────────────────────────────────────

  private initializeDictionary(): void {
    // Try to load from storage
    const stored = this.getStorage(DICT_KEY);
    if (stored) {
      const arr = JSON.parse(stored);
      this.dictionary = new Uint8Array(arr);
    } else {
      // Build default dictionary from common legal/messaging corpus
      const corpus = [
        'This is a secure message in Relay messenger',
        'End-to-end encryption with compression',
        'Messages expire after 20 minutes if not verified',
        'User authentication and contact management',
        'Real-time synchronization across devices',
        'Encrypted message storage',
      ];
      this.dictionary = buildDictionary(corpus);
      // Store for later use
      this.setStorage(DICT_KEY, JSON.stringify(Array.from(this.dictionary)));
    }
  }

  private loadCurrentUser(): void {
    if (typeof window === 'undefined') return;
    const userId = this.getStorage(CURRENT_USER_KEY);
    if (userId) {
      this.currentUserId = userId;
    }
  }

  private saveCurrentUser(): void {
    if (typeof window === 'undefined') return;
    if (this.currentUserId) {
      this.setStorage(CURRENT_USER_KEY, this.currentUserId);
    }
  }

  setCurrentUserId(userId: string): void {
    this.currentUserId = userId;
    this.saveCurrentUser();
  }

  getCurrentUserId(): string | null {
    return this.currentUserId;
  }

  /**
   * Ensure we have a current user ID, with fallback to auth store
   */
  private async ensureCurrentUserId(): Promise<string | null> {
    // If we already have it, return it
    if (this.currentUserId) {
      return this.currentUserId;
    }

    // Fallback: try to get from auth store
    try {
      const { useRelayAuthStoreV2 } = await import('@/lib/crypto/relay-auth-store-v2');
      const { currentUserId } = useRelayAuthStoreV2.getState();
      if (currentUserId) {
        this.setCurrentUserId(currentUserId);
        log.debug('[MessagingService] Fallback: Set currentUserId from auth store:', currentUserId);
        return currentUserId;
      }
    } catch (err) {
      log.error('[MessagingService] Failed to get userId from auth store:', err);
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // USER MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Get current logged-in user
   */
  getCurrentUser(): User | null {
    if (!this.currentUserId) {
      return null;
    }
    const users = this.getAllUsers();
    return users.find(u => u.id === this.currentUserId) || null;
  }

  /**
   * Get user by ID
   */
  getUserById(userId: string): User | null {
    const users = this.getAllUsers();
    return users.find(u => u.id === userId) || null;
  }

  /**
   * Get all users
   */
  getAllUsers(): User[] {
    const data = this.getStorage(USERS_KEY);
    if (!data) return [];
    return this.deserializeUsers(JSON.parse(data));
  }

  // ─────────────────────────────────────────────────────────────────────
  // CONTACT MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Add a new contact
   */
  async addContact(userId: string, contactName: string, contactPublicKey: Uint8Array): Promise<Contact> {
    // Ensure we have currentUserId from store if not already set
    const currentUserId = await this.ensureCurrentUserId();
    if (!currentUserId) {
      throw new Error('Not logged in');
    }

    const currentUser = this.getCurrentUser();
    if (!currentUser) {
      throw new Error('Current user not found');
    }

    const contactId = this.generateId();

    // Compute shared secret for this contact
    const sharedSecret = computeSharedSecret(currentUser.privateKey, contactPublicKey);

    const storedContact: StoredContact = {
      userId: currentUserId,
      contactUserId: userId,
      contactName,
      contactPublicKey: new Uint8Array(contactPublicKey),
      sharedSecret: new Uint8Array(sharedSecret),
      addedAt: new Date(),
    };

    // Store contact — upsert against the *unfiltered* list so re-adding the
    // same contact replaces the old entry instead of accumulating duplicates,
    // and so other userIds' contacts sharing this browser's storage survive.
    const allContacts = this.getAllStoredContacts().filter(
      c => !(c.userId === currentUserId && c.contactUserId === userId)
    );
    allContacts.push(storedContact);
    this.setStorage(CONTACTS_KEY, JSON.stringify(this.serializeContacts(allContacts)));

    // Create a session for this contact
    if (this.dictionary) {
      const role = deriveSessionRole(currentUser.publicKey, contactPublicKey);
      const session = new Session(sharedSecret, this.dictionary, 1, role);
      this.sessions.set(userId, session);
    }

    // Return as Contact interface
    return this.convertToContact(storedContact, contactId);
  }

  /**
   * Remove a contact
   */
  async removeContact(contactUserId: string): Promise<void> {
    const currentUserId = await this.ensureCurrentUserId();
    if (!currentUserId) {
      throw new Error('Not logged in');
    }

    // Filter against the *unfiltered* list — see addContact() — so this only
    // ever touches the current user's own entry, not other userIds' contacts
    // sharing this browser's storage.
    const allContacts = this.getAllStoredContacts();
    const filtered = allContacts.filter(
      c => !(c.userId === currentUserId && c.contactUserId === contactUserId)
    );
    this.setStorage(CONTACTS_KEY, JSON.stringify(this.serializeContacts(filtered)));

    this.sessions.delete(contactUserId);
  }

  /**
   * Read every stored contact across all userIds sharing this browser's
   * storage. getContacts() (current-user view) and addContact()/removeContact()
   * (writes) all go through this so a write for one userId never clobbers
   * another userId's contacts under the shared CONTACTS_KEY.
   */
  private getAllStoredContacts(): StoredContact[] {
    const data = this.getStorage(CONTACTS_KEY);
    if (!data) return [];
    return this.deserializeContacts(JSON.parse(data));
  }

  /**
   * Get all contacts for current user
   */
  getContacts(): StoredContact[] {
    return this.getAllStoredContacts().filter(c => c.userId === this.currentUserId);
  }

  /**
   * Get all contacts as Contact interface
   */
  getContactsAsInterface(): Contact[] {
    const contacts = this.getContacts();
    if (contacts.length === 0) return [];
    // Load the messages blob once and slice it per-contact in memory instead
    // of letting each convertToContact() call re-parse it from storage — this
    // was an O(n) JSON.parse of the full message store per contact.
    const allMessages = this.getAllMessages();
    return contacts.map((sc) => {
      const conversation = allMessages
        .filter(m =>
          (m.fromUserId === this.currentUserId && m.toUserId === sc.contactUserId) ||
          (m.fromUserId === sc.contactUserId && m.toUserId === this.currentUserId)
        )
        .map(m => this.convertToMessage(m));
      return this.convertToContact(sc, sc.contactUserId, conversation);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // MESSAGE MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Get all messages for conversation
   */
  getConversation(contactUserId: string): Message[] {
    if (!this.currentUserId) {
      return [];
    }

    const stored = this.getAllMessages().filter(m => 
      (m.fromUserId === this.currentUserId && m.toUserId === contactUserId) ||
      (m.fromUserId === contactUserId && m.toUserId === this.currentUserId)
    );

    return stored.map(m => this.convertToMessage(m));
  }

  /**
   * Clean up expired messages
   */
  async cleanupExpiredMessages(): Promise<number> {
    const messages = this.getAllMessages();
    const now = new Date();
    const before = messages.length;
    
    const filtered = messages.filter(m => m.expiresAt > now);
    this.setStorage(MESSAGES_KEY, JSON.stringify(this.serializeMessages(filtered)));
    
    return before - filtered.length;
  }

  // ─────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────

  private getAllMessages(): StoredMessage[] {
    const data = this.getStorage(MESSAGES_KEY);
    if (!data) return [];
    return this.deserializeMessages(JSON.parse(data));
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private createMetadata(originalSize: number, encryptedSize: number): CompressionMetadata {
    const compressionRatio = originalSize > 0 ? encryptedSize / originalSize : 1;
    return {
      compression_ratio: Math.min(compressionRatio, 1.0),
      original_size: originalSize,
      compressed_size: Math.floor(encryptedSize * 0.7),
      encrypted_size: encryptedSize,
      latency_ms: Math.floor(Math.random() * 200 + 50),
      neural_model_score: Math.random() * 0.4 + 0.6,
    };
  }

  private convertToContact(stored: StoredContact, id: string, conversation?: Message[]): Contact {
    return {
      id,
      name: stored.contactName,
      avatar: stored.contactName.substring(0, 2).toUpperCase(),
      // Real-time presence arrives over the WS 'presence' event
      // (connection.ts), which patches isOnline into contact state directly
      // once the socket connects — this initial value is just the
      // pre-connection default, matching the other contact-loading paths
      // in contacts.ts. A random placeholder here made every contact
      // flicker online/offline on every reload before presence arrived.
      isOnline: false,
      lastSeen: new Date(),
      messages: conversation ?? this.getConversation(stored.contactUserId),
      relayId: stored.contactUserId, // Pass the actual relayId
      addedAt: stored.addedAt instanceof Date ? stored.addedAt.getTime() : Number(stored.addedAt) || undefined,
    };
  }

  private convertToMessage(stored: StoredMessage): Message {
    const sender = this.getUserById(stored.fromUserId);
    return {
      id: stored.id,
      senderId: stored.fromUserId,
      senderName: sender?.name || 'Unknown',
      text: '(Encrypted message)', // In real app, would decrypt
      timestamp: stored.timestamp,
      isOwn: stored.fromUserId === this.currentUserId,
      read: stored.read,
      delivered: stored.delivered,
      metadata: {
        compression_ratio: 0.5,
        original_size: 0,
        compressed_size: 0,
        encrypted_size: stored.encryptedContent.length,
        latency_ms: 100,
        neural_model_score: 0.8,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // SERIALIZATION
  // ─────────────────────────────────────────────────────────────────────

  private serializeUsers(users: User[]): any[] {
    return users.map(u => ({
      ...u,
      publicKey: Array.from(u.publicKey),
      privateKey: Array.from(u.privateKey),
      createdAt: u.createdAt.toISOString(),
      lastLogin: u.lastLogin.toISOString(),
    }));
  }

  private deserializeUsers(data: any[]): User[] {
    return data.map(u => ({
      ...u,
      publicKey: new Uint8Array(u.publicKey),
      privateKey: new Uint8Array(u.privateKey),
      createdAt: new Date(u.createdAt),
      lastLogin: new Date(u.lastLogin),
    }));
  }

  private serializeContacts(contacts: StoredContact[]): any[] {
    return contacts.map(c => ({
      ...c,
      contactPublicKey: Array.from(c.contactPublicKey),
      sharedSecret: c.sharedSecret ? Array.from(c.sharedSecret) : undefined,
      addedAt: c.addedAt.toISOString(),
    }));
  }

  private deserializeContacts(data: any[]): StoredContact[] {
    return data.map(c => ({
      ...c,
      contactPublicKey: new Uint8Array(c.contactPublicKey),
      sharedSecret: c.sharedSecret ? new Uint8Array(c.sharedSecret) : undefined,
      addedAt: new Date(c.addedAt),
    }));
  }

  private serializeMessages(messages: StoredMessage[]): any[] {
    return messages.map(m => ({
      ...m,
      encryptedContent: Array.from(m.encryptedContent),
      nonce: Array.from(m.nonce),
      timestamp: m.timestamp.toISOString(),
      expiresAt: m.expiresAt.toISOString(),
    }));
  }

  private deserializeMessages(data: any[]): StoredMessage[] {
    return data.map(m => ({
      ...m,
      encryptedContent: new Uint8Array(m.encryptedContent),
      nonce: new Uint8Array(m.nonce),
      timestamp: new Date(m.timestamp),
      expiresAt: new Date(m.expiresAt),
    }));
  }
}

// Export singleton getter
export function getMessagingService(): RelayMessagingService {
  return RelayMessagingService.getInstance();
}
