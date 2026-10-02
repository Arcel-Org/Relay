/**
 * The fixed, bounded set of icons a chat folder can be assigned (picked in
 * FolderEditModal, resolved by name in FolderTabs). Named imports instead of
 * FolderTabs' previous `import * as Icons from 'lucide-react'` — the
 * wildcard import pulled in every one of lucide-react's ~1600+ icons
 * (~230KB gzip) into the bundle just to look up one of these 11 by name at
 * render time, when only these 11 are ever actually choosable.
 */
import { Inbox, Users, Briefcase, Star, Heart, Home, Globe, MessageSquare, Hash, Mail, Pin } from 'lucide-react';
import type { ComponentType } from 'react';

export type FolderIconComponent = ComponentType<{ className?: string }>;

export const FOLDER_ICON_OPTIONS: Array<{ name: string; Comp: FolderIconComponent }> = [
  { name: 'Inbox', Comp: Inbox },
  { name: 'Users', Comp: Users },
  { name: 'Briefcase', Comp: Briefcase },
  { name: 'Star', Comp: Star },
  { name: 'Heart', Comp: Heart },
  { name: 'Home', Comp: Home },
  { name: 'Globe', Comp: Globe },
  { name: 'MessageSquare', Comp: MessageSquare },
  { name: 'Hash', Comp: Hash },
  { name: 'Mail', Comp: Mail },
  { name: 'Pin', Comp: Pin },
];

export const FOLDER_ICON_MAP: Record<string, FolderIconComponent> = Object.fromEntries(
  FOLDER_ICON_OPTIONS.map(({ name, Comp }) => [name, Comp])
);
