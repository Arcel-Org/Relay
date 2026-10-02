# Relay — Missing Features Plan

Features missing from Relay that modern encrypted messengers (Signal, WhatsApp, Telegram) have. Prioritized by user value and implementation cost.

> **Note:** This plan predates several implemented features. Message search (`MessageSearchModal`), reply/quote (`replyingTo` in `MessageThread`), forwarding (`ForwardModal`), @mentions (`lib/features/mentions.ts`), pinned messages (`lib/features/pinned-messages.ts`), starred/bookmarks (`BookmarksModal`), conversation folders (`lib/features/chat-folders.ts`), and an emoji picker (`EmojiPickerPanel`) are already shipped. Still genuinely missing as of this review: link previews, message scheduling, view-once media, persistent per-conversation drafts, and keyboard shortcuts.
>
> **Platform support:** Web only — the Docker deployment in this repo *is* the product. Native desktop/mobile apps were removed before open-sourcing (see the git history for the Tauri/Capacitor shells if they're ever needed again). The web app runs identically in Chrome/Edge/Firefox/Safari on any OS, including mobile browsers; browser notifications and vibration work natively. There is no push-notification path (it shipped as an Android-FCM stub that never functioned without a native client) and no iOS build.

---

## P0 — Table-stakes messaging features

### 1. Message Search
Full-text search across all conversations and messages in local storage. Users can't find old messages without this. Client-side only (searches decrypted IndexedDB contents).

### 2. Reply / Quote messages
Tap a message, select "Reply", and compose a response that visually quotes the original. Essential for group chats where conversations interleave. The `referencedMessageId` field is already on the Message type but unused.

### 3. Message Forwarding
Select a message and forward to another contact or group. Daily-use feature absent in the current UI.

### 4. @Mentions
Type `@username` in a group chat to tag a specific member. Mentions highlight in the message and trigger a priority notification for the mentioned user.

---

## P1 — Essential polish

### 5. Pinned messages
Pin important messages (addresses, links, decisions) to the top of a conversation. Stored locally; visible in a conversation header drawer.

### 6. Draft messages
Auto-save the text a user is typing per-conversation, so navigating away and back doesn't lose their draft.

### 7. Starred messages
Star messages across conversations to build a personal "favorites" list. Useful for information you want to reference later.

### 8. Keyboard shortcuts
Desktop power-user shortcuts:
- `Ctrl/Cmd+K` — quick switcher (jump to conversation)
- `Ctrl/Cmd+F` — search messages in current conversation
- `Ctrl/Cmd+N` — new conversation
- `Ctrl/Cmd+/` — show shortcut help
- `Esc` — close modals/panels

### 9. Link previews
When a message contains a URL, fetch the Open Graph metadata and show a preview card (title, description, thumbnail). Can be toggled off for privacy.

### 10. Custom status messages
Set a status ("Away", "Busy", "🏖️ Vacation") that shows next to your name. Reduces "why aren't they responding?" friction.

---

## P2 — Valuable additions

### 11. Message scheduling
Compose a message now, schedule it to send at a specific time. Useful for async teams across timezones.

### 12. View-once media
Photos and videos that delete themselves after being viewed once. Signal and Telegram both have this for privacy.

### 13. Archive conversations
Move old conversations out of the main list without deleting them. They reappear when a new message arrives.

### 14. Conversation folders
Group conversations into folders (Work, Family, Groups). Filter the sidebar by folder.

### 15. Emoji picker
A proper emoji picker in the compose area (currently only reactions have emoji). Should include recent + search.

---

## Priority for this session

Given scope, we'll implement these in order:

| # | Feature | Why this one |
|---|---------|--------------|
| 1 | **Message search** | Biggest UX gap. Users literally can't find messages. |
| 2 | **Reply / quote** | Type already exists; just needs UI wiring. High impact. |
| 3 | **Message forwarding** | Daily-use, expected feature. |
| 4 | **@Mentions** | Groups are unusable at scale without this. |
| 5 | **Pinned messages** | Low effort, high value for power users. |
| 6 | **Draft messages** | Tiny change, massive UX improvement. |
| 7 | **Keyboard shortcuts** | Desktop users expect these. |
| 8 | **Custom status** | Low effort, adds personality. |
| 9 | **Archive conversations** | Declutters sidebar. |
| 10 | **Emoji picker** | Composing without emoji feels dated. |

Skipping for later: link previews (needs network fetch + CSP considerations), view-once media (needs platform-level screenshot detection), message scheduling (needs local persistent queue). These are valuable but more involved.
