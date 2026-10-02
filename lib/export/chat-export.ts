/**
 * Plain-text export of a conversation.
 */

import { getAllMessagesForConversation, getContact } from '@/lib/db/relay-store';

export async function exportConversationAsText(
  conversationId: string,
  title: string
): Promise<Blob> {
  const allMessages = await getAllMessagesForConversation(conversationId);
  // Ghost-mode and already-expired messages must never leave the device via
  // an export — the whole point of ghost mode is that they're gone once
  // their TTL passes (or were never meant to be durably readable at all);
  // an unfiltered export would let a plain-text copy outlive that promise.
  const messages = allMessages.filter(
    (m) => !m.ghost && (m.expiresAt === undefined || m.expiresAt > Date.now())
  );
  const senderCache = new Map<string, string>();

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push(`# Conversation: ${conversationId}`);
  lines.push(`# Exported: ${new Date().toISOString()}`);
  lines.push(`# Messages: ${messages.length}`);
  lines.push('');

  for (const msg of messages) {
    let senderName = senderCache.get(msg.senderId);
    if (!senderName) {
      try {
        const contact = await getContact(msg.senderId);
        senderName = contact?.displayName || contact?.name || contact?.username || msg.senderId;
      } catch {
        senderName = msg.senderId;
      }
      senderCache.set(msg.senderId, senderName);
    }
    const ts = new Date(msg.timestamp).toISOString();
    const pinned = msg.pinned ? '[PINNED] ' : '';
    const text = (msg.text ?? '').replace(/\r?\n/g, ' ');
    lines.push(`[${ts}] ${pinned}<${senderName}>: ${text}`);
  }

  return new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
}

export function triggerDownload(blob: Blob, filename: string): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
