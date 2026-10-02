'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRelayAuthStoreV2 } from '@/lib/crypto/relay-auth-store-v2';
import { SettingsPanel } from '@/components/SettingsPanel';
import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';

export default function SettingsPage() {
  const router = useRouter();
  const { flow } = useRelayAuthStoreV2();

  useEffect(() => {
    if (flow !== 'authenticated') {
      router.push('/auth/login');
    }
  }, [flow, router]);

  if (flow !== 'authenticated') return null;

  return (
    <div className="min-h-screen w-screen bg-relay-bg overflow-hidden flex flex-col">
      {/* Top Bar */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="border-b border-relay-border bg-relay-bg/80 backdrop-blur-sm px-6 py-4 flex items-center gap-4"
      >
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => router.back()}
          className="p-2 hover:bg-relay-surface-hover rounded-lg transition-colors"
          title="Back"
        >
          <ChevronLeft className="w-5 h-5 text-relay-text-secondary" />
        </motion.button>
        <h1 className="text-lg font-bold text-relay-text-primary">Settings</h1>
      </motion.div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          className="mx-auto w-full max-w-6xl px-4 md:px-8 py-6"
        >
          <SettingsPanel />
        </motion.div>
      </div>
    </div>
  );
}
