/**
 * Feature: MESSAGE SEARCH
 *
 * Searches all locally stored messages in IndexedDB (via relay-store).
 * Returns results ranked by recency (most recent first), with a highlighted
 * snippet around the first case-insensitive substring match on `message.text`.
 */

import {
  getAllConversations,
  getAllMessagesForConversation,
  type StoredMessage,
  type StoredConversation,
} from '@/lib/db/relay-store';
import { log } from '@/lib/platform/logger';

export interface SearchResult {
  messageId: string;
  conversationId: string;
  conversationName: string;
  text: string;
  timestamp: number;
  snippet: string;
}

export interface SearchOptions {
  conversationId?: string;
  limit?: number;
}

const SNIPPET_CONTEXT = 30;

/**
 * Build a short preview centred around the matched term, with ±SNIPPET_CONTEXT
 * characters of surrounding context. Preserves the original casing.
 */
function buildSnippet(text: string, matchIndex: number, queryLength: number): string {
  if (matchIndex < 0) {
    return text.length <= SNIPPET_CONTEXT * 2
      ? text
      : text.slice(0, SNIPPET_CONTEXT * 2) + '…';
  }

  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT);
  const end = Math.min(text.length, matchIndex + queryLength + SNIPPET_CONTEXT);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

/**
 * Search all locally stored messages. Case-insensitive substring match on text.
 * Results are sorted by timestamp descending (most recent first).
 */
export async function searchMessages(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 50;
  const needle = trimmed.toLowerCase();

  let conversations: StoredConversation[] = [];
  try {
    const all = await getAllConversations();
    conversations = options.conversationId
      ? all.filter((c) => c.id === options.conversationId)
      : all;
  } catch (err) {
    log.warn('[message-search] Failed to load conversations:', err);
    return [];
  }

  const results: SearchResult[] = [];

  for (const conv of conversations) {
    let messages: StoredMessage[] = [];
    try {
      messages = await getAllMessagesForConversation(conv.id);
    } catch (err) {
      log.warn(`[message-search] Failed to load messages for ${conv.id}:`, err);
      continue;
    }

    for (const msg of messages) {
      if (!msg.text) continue;
      const haystack = msg.text.toLowerCase();
      const idx = haystack.indexOf(needle);
      if (idx < 0) continue;

      results.push({
        messageId: msg.id,
        conversationId: conv.id,
        conversationName: conv.name,
        text: msg.text,
        timestamp: msg.timestamp,
        snippet: buildSnippet(msg.text, idx, trimmed.length),
      });
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  return results.slice(0, limit);
}
