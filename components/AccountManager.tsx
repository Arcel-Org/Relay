'use client';

import { useState, useRef, useEffect } from 'react';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { LogOut, Settings, User, ChevronDown } from 'lucide-react';

export const AccountManager = () => {
  const router = useRouter();
  const { currentRelayId, loadAvailableUsers, selectUserForLogin, logout, availableUsers } =
    useRelayAuthStoreV2();
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Escape closes the menu and returns focus to the trigger — previously
  // the only way to close this menu via keyboard was to activate one of
  // its own buttons; a keyboard user who opened it just to look had no way
  // to dismiss it without taking an action.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  const handleLogout = () => {
    logout();
    router.push('/auth/login');
  };

  const handleSwitchAccount = (relayId: string) => {
    selectUserForLogin(relayId);
    setIsOpen(false);
    router.push('/auth/login');
  };

  if (!mounted) return null;

  const displayId = currentRelayId ? currentRelayId.slice(0, 12) + '...' : 'Account';

  return (
    <div className="relative" ref={dropdownRef}>
      <motion.button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="flex items-center gap-2 px-4 py-2 bg-relay-surface-hover/50 hover:bg-relay-surface-hover/50 border border-relay-border-light hover:border-relay-accent/50 rounded-lg transition-all text-sm font-medium text-relay-text-primary"
      >
        <User className="w-4 h-4" />
        <span className="hidden sm:inline">{displayId}</span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15 }}
            role="menu"
            className="absolute right-0 mt-2 w-56 bg-relay-surface border border-relay-border-light rounded-lg shadow-lg z-50 overflow-hidden"
          >
            {/* Current Account */}
            <div className="px-4 py-3 border-b border-relay-border">
              <p className="text-xs text-relay-text-muted uppercase tracking-wide mb-1">Current Account</p>
              <p className="text-sm font-mono text-relay-text-primary">{currentRelayId}</p>
            </div>

            {/* Other Accounts */}
            {availableUsers.length > 1 && (
              <div className="px-2 py-2 border-b border-relay-border max-h-40 overflow-y-auto">
                <p className="px-2 py-1 text-xs text-relay-text-muted uppercase tracking-wide mb-1">
                  Other Accounts
                </p>
                {availableUsers
                  .filter((user) => user.relayId !== currentRelayId)
                  .map((user) => (
                    <motion.button
                      key={user.relayId}
                      role="menuitem"
                      onClick={() => handleSwitchAccount(user.relayId)}
                      whileHover={{ backgroundColor: '#27272a' }}
                      className="w-full px-2 py-2 text-left text-xs text-relay-text-secondary hover:text-relay-text-primary rounded transition-colors"
                    >
                      <div className="font-mono text-relay-text-secondary truncate">{user.relayId}</div>
                      <div className="text-relay-text-muted text-xs">
                        Created {new Date(user.createdAt).toLocaleDateString()}
                      </div>
                    </motion.button>
                  ))}
              </div>
            )}

            {/* Actions */}
            <div className="px-2 py-2 space-y-1">
              <motion.button
                role="menuitem"
                onClick={() => {
                  router.push('/auth/signup?newAccount=true');
                  setIsOpen(false);
                }}
                whileHover={{ backgroundColor: '#27272a' }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-relay-text-secondary hover:text-relay-text-primary rounded transition-colors"
              >
                <User className="w-4 h-4" />
                Create Account
              </motion.button>

              <motion.button
                role="menuitem"
                onClick={handleLogout}
                whileHover={{ backgroundColor: '#7f1d1d' }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:text-red-300 rounded hover:bg-red-950/30 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
