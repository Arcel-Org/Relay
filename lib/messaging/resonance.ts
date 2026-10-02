/**
 * Resonance score — a rough "how compressible/familiar" signal derived from
 * recent message compression ratios for a contact. Read-only over live
 * `messages` state, no writes.
 */

import { useCallback } from 'react';
import type { MessageWithStatus } from '@/lib/hooks/messaging-types';

export function useResonanceScore(messages: Map<string, MessageWithStatus[]>) {
  const calculateResonanceScore = useCallback((contactId: string): number => {
    const contactMsgs = messages.get(contactId) || [];
    const totalMessages = contactMsgs.length;

    if (totalMessages < 20) return 0; // "Calibrating..."

    // Get last 20 messages
    const lastMessages = contactMsgs.slice(-20);
    const compressionRatios = lastMessages.map((m) => m.metadata?.compression_ratio || 0.5);
    const avgCompressionRatio = compressionRatios.reduce((a, b) => a + b, 0) / compressionRatios.length;

    // Calculate resonance
    const resonance = Math.round(
      (1 - avgCompressionRatio) * 100 * Math.min(totalMessages / 50, 1)
    );

    return Math.max(0, Math.min(100, resonance));
  }, [messages]);

  return calculateResonanceScore;
}
