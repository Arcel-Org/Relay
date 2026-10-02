'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, MoreHorizontal, Edit2, Trash2, ChevronLeft, ChevronRight, Inbox } from 'lucide-react';
import { FOLDER_ICON_MAP } from '@/components/chats/folder-icons';
import {
  ALL_FOLDER,
  ALL_FOLDER_ID,
  type ChatFolder,
  type ChatSummary,
  countUnreadForFolder,
  deleteFolder,
  reorderFolders,
} from '@/lib/features/chat-folders';

interface FolderTabsProps {
  folders: ChatFolder[];
  chats: ChatSummary[];
  activeFolderId: string;
  onChange: (folderId: string) => void;
  onCreate: () => void;
  onEdit: (folder: ChatFolder) => void;
  onFoldersChanged: () => void;
}

function FolderIcon({ icon, className }: { icon?: string; className?: string }) {
  if (!icon) return <Inbox className={className} />;
  // Single-codepoint emoji heuristic: if it's not a letter (a-z / A-Z), treat as emoji.
  if (!/^[A-Za-z]/.test(icon)) {
    return <span className={className} style={{ fontSize: '0.95em', lineHeight: 1 }}>{icon}</span>;
  }
  const Lookup = FOLDER_ICON_MAP[icon];
  if (Lookup) return <Lookup className={className} />;
  return <Inbox className={className} />;
}

export function FolderTabs({
  folders,
  chats,
  activeFolderId,
  onChange,
  onCreate,
  onEdit,
  onFoldersChanged,
}: FolderTabsProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  const allFolders = useMemo(() => [ALL_FOLDER, ...folders], [folders]);
  const unreadByFolder = useMemo(
    () => new Map(allFolders.map((f) => [f.id, countUnreadForFolder(f, chats)])),
    [allFolders, chats],
  );

  useEffect(() => {
    if (!menuFor) return;
    const close = () => setMenuFor(null);
    document.addEventListener('click', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [menuFor]);

  const openMenu = (e: React.MouseEvent, id: string) => {
    if (id === ALL_FOLDER_ID) return;
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuFor(id);
  };

  const handleMove = (id: string, dir: -1 | 1) => {
    const ids = folders.map((f) => f.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    reorderFolders(ids);
    onFoldersChanged();
  };

  const handleDelete = (id: string) => {
    if (!window.confirm('Delete this folder? Chats inside it will not be affected.')) return;
    deleteFolder(id);
    if (activeFolderId === id) onChange(ALL_FOLDER_ID);
    onFoldersChanged();
  };

  const activeMenuFolder = folders.find((f) => f.id === menuFor);

  return (
    <div className="bg-relay-surface/40 pb-1.5">
      <div
        ref={scrollRef}
        className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        <style jsx>{`
          div::-webkit-scrollbar { display: none; }
        `}</style>
        {allFolders.map((f) => {
          const unread = unreadByFolder.get(f.id) ?? 0;
          const isActive = f.id === activeFolderId;
          const folderColor = f.color;
          const activeTextStyle = isActive && folderColor ? { color: folderColor } : undefined;
          const activeBgStyle = isActive && folderColor ? { backgroundColor: `${folderColor}1A` } : undefined;
          return (
            <button
              key={f.id}
              onClick={() => onChange(f.id)}
              onContextMenu={(e) => openMenu(e, f.id)}
              style={{ ...activeTextStyle, ...activeBgStyle }}
              className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors duration-150 ${
                isActive
                  ? folderColor
                    ? ''
                    : 'text-relay-accent bg-relay-accent/10'
                  : 'text-relay-text-secondary hover:text-relay-text-primary hover:bg-relay-surface-hover/60'
              }`}
            >
              <FolderIcon icon={f.icon} className="w-3.5 h-3.5" />
              <span>{f.name}</span>
              {unread > 0 && (
                <span
                  className={`ml-0.5 min-w-[16px] h-[16px] rounded-full text-[10px] font-bold flex items-center justify-center px-1 ${
                    folderColor ? 'text-white' : 'bg-relay-accent text-relay-accent-foreground'
                  }`}
                  style={folderColor ? { backgroundColor: folderColor } : undefined}
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
              {isActive && (
                <motion.div
                  layoutId="folder-underline"
                  className={`absolute left-2 right-2 -bottom-1.5 h-0.5 rounded-full ${folderColor ? '' : 'bg-relay-accent'}`}
                  style={folderColor ? { backgroundColor: folderColor } : undefined}
                  transition={{ duration: 0.15 }}
                />
              )}
            </button>
          );
        })}
        <button
          onClick={onCreate}
          className="flex items-center justify-center w-7 h-7 rounded-md text-relay-text-muted hover:text-relay-accent hover:bg-relay-surface-hover/60 transition-colors shrink-0"
          title="Create folder"
          aria-label="Create folder"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      <AnimatePresence>
        {menuFor && activeMenuFolder && (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.12 }}
            className="fixed z-50 min-w-[160px] rounded-lg bg-relay-surface border border-relay-border shadow-lg py-1"
            style={{ top: menuPos.y, left: menuPos.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => { onEdit(activeMenuFolder); setMenuFor(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover text-left"
            >
              <Edit2 className="w-3 h-3" /> Edit
            </button>
            <button
              onClick={() => { handleMove(activeMenuFolder.id, -1); setMenuFor(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover text-left"
            >
              <ChevronLeft className="w-3 h-3" /> Move left
            </button>
            <button
              onClick={() => { handleMove(activeMenuFolder.id, 1); setMenuFor(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-relay-text-primary hover:bg-relay-surface-hover text-left"
            >
              <ChevronRight className="w-3 h-3" /> Move right
            </button>
            <div className="my-1 h-px bg-relay-border/60" />
            <button
              onClick={() => { handleDelete(activeMenuFolder.id); setMenuFor(null); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 text-left"
            >
              <Trash2 className="w-3 h-3" /> Delete
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Silence unused import lint (re-exported for future expansion).
void MoreHorizontal;
