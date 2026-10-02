/**
 * Small display-only helpers for group avatars — extracted from the legacy
 * lib/features/group-conversations.ts (deleted; its Sender-Keys group model
 * was superseded by lib/hooks/use-group-messaging.ts). These two exports
 * were the only load-bearing pieces of that file.
 */

export const GROUP_AVATAR_COLORS = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#45B7D1', // blue
  '#FFA07A', // coral
  '#98D8C8', // mint
  '#F7DC6F', // yellow
  '#BB8FCE', // purple
  '#85C1E2', // light blue
  '#F8B739', // orange
  '#52C9A8', // green
];

export function getGroupInitials(groupName: string): string {
  return groupName
    .split(/\s+/)
    .map(word => word[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
