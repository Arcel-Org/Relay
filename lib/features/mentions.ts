/**
 * Feature: @Mentions in Groups
 *
 * Parses `@username` tokens from message text and resolves them to relayIds
 * using the current conversation's member list. Renders highlighted spans,
 * with a distinct color for self-mentions so the current user notices them.
 */

import React from 'react';

export interface MentionMember {
  relayId: string;
  username?: string;
  displayName?: string;
}

export interface ParsedMention {
  relayId: string;
  /** Start offset of the mention in the original text (including `@`) */
  start: number;
  /** End offset (exclusive) in the original text */
  end: number;
}

// Username: letters, digits, underscore, dash, dot (1-32 chars).
// Must be preceded by start-of-string or a non-word char (so "email@foo" is ignored).
const MENTION_REGEX = /(^|[^\w])@([A-Za-z0-9_.\-]{1,32})/g;

function normalize(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^@/, '').toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Find `@username` occurrences in `text` and resolve each to a relayId using
 * the provided members list. Matches against `username` first, then falls
 * back to `displayName` (whitespace removed, lowercased).
 */
export function parseMentions(
  text: string,
  members: Array<MentionMember>,
): Array<ParsedMention> {
  if (!text || !members || members.length === 0) return [];

  // Build a lookup map keyed by normalized username / displayName.
  const byKey = new Map<string, string>(); // normalized key -> relayId
  for (const m of members) {
    if (!m || !m.relayId) continue;
    const uname = normalize(m.username);
    if (uname) byKey.set(uname, m.relayId);
    const dname = normalize(m.displayName);
    if (dname) {
      const stripped = dname.replace(/\s+/g, '');
      if (stripped) byKey.set(stripped, m.relayId);
    }
  }

  const results: ParsedMention[] = [];
  MENTION_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const uname = match[2];
    if (!uname) continue;

    const key = uname.toLowerCase();
    const relayId = byKey.get(key);
    if (!relayId) continue;

    // Position of the '@' character in `text`
    const atIndex = match.index + prefix.length;
    const end = atIndex + 1 + uname.length;
    results.push({ relayId, start: atIndex, end });
  }

  return results;
}

/**
 * Render `text` with each mention highlighted. Returns a React fragment
 * containing alternating plain text and styled `<span>` elements.
 *
 * @param text          Original message text
 * @param mentions      Result of `parseMentions` (or a subset thereof)
 * @param currentRelayId When provided, mentions resolving to this relayId are
 *                      styled in amber so the user notices being pinged.
 */
export function renderMentionsToJSX(
  text: string,
  mentions: Array<ParsedMention>,
  currentRelayId?: string,
): React.ReactNode {
  if (!text) return null;
  if (!mentions || mentions.length === 0) return text;

  // Ensure the mentions are sorted by start offset and non-overlapping.
  const sorted = [...mentions]
    .filter((m) => m.start >= 0 && m.end > m.start && m.end <= text.length)
    .sort((a, b) => a.start - b.start);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  sorted.forEach((m, idx) => {
    if (m.start < cursor) return; // skip overlapping mentions
    if (m.start > cursor) {
      nodes.push(text.slice(cursor, m.start));
    }
    const slice = text.slice(m.start, m.end);
    const isSelf = !!currentRelayId && m.relayId === currentRelayId;
    const cls = isSelf
      ? 'inline-block px-1 rounded-sm bg-amber-500/25 text-amber-200 font-medium'
      : 'inline-block px-1 rounded-sm bg-relay-accent/20 text-relay-accent font-medium';
    nodes.push(
      React.createElement(
        'span',
        {
          key: `mention-${idx}-${m.start}`,
          className: cls,
          'data-relay-id': m.relayId,
        },
        slice,
      ),
    );
    cursor = m.end;
  });

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return React.createElement(React.Fragment, null, ...nodes);
}
