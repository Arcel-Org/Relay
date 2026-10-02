'use client';

import { motion } from 'framer-motion';
import type { MenuAction } from '../MessageActionMenu';

interface MessageActionSheetProps {
  actions: MenuAction[];
  onClose: () => void;
}

// Hide reaction-group entries (they're handled by the ReactionBar).
const GROUP_ORDER: Array<MenuAction['group'] | undefined> = ['interact', 'manage', 'delete', undefined];

export function MessageActionSheet({ actions, onClose }: MessageActionSheetProps) {
  const visible = actions.filter((a) => a.group !== 'reaction' && a.id !== 'emoji');

  const groups = GROUP_ORDER
    .map((g) => visible.filter((a) => (a.group ?? undefined) === g))
    .filter((arr) => arr.length > 0);

  if (groups.length === 0) return null;

  return (
    <motion.div
      role="menu"
      initial={{ opacity: 0, scale: 0.96, y: -4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -4 }}
      transition={{ duration: 0.15 }}
      className="bg-relay-surface rounded-xl border border-relay-border shadow-lg min-w-[180px] overflow-hidden"
    >
      {groups.map((group, gi) => (
        <div key={gi}>
          {gi > 0 && <div className="h-px bg-relay-border" />}
          <div className="py-1">
            {group.map((action) => {
              const destructive = action.isDestructive || action.group === 'delete';
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  disabled={action.isLoading}
                  onClick={() => {
                    action.onClick();
                    onClose();
                  }}
                  className={`w-full px-3 py-2 flex items-center gap-2.5 text-sm hover:bg-relay-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    destructive ? 'text-relay-danger' : 'text-relay-text-primary'
                  }`}
                >
                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                    {action.icon}
                  </span>
                  <span className="flex-1 text-left">{action.label}</span>
                  {action.isLoading && (
                    <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </motion.div>
  );
}
