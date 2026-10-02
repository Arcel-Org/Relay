'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Phone, Video, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing } from 'lucide-react';
import type { CallHistoryRecord } from '@/lib/calls/use-webrtc-call';
import { UserAvatar } from '@/components/UserAvatar';

interface CallHistoryProps {
  records: CallHistoryRecord[];
  contacts: { relayId?: string; id?: string; name?: string; avatarEmoji?: string; avatarColor?: string; [key: string]: any }[];
  onCallBack: (peerId: string, isVideo: boolean) => void;
}

function formatDuration(sec: number): string {
  if (sec === 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function dateBucket(ms: number): string {
  const now = new Date();
  const d = new Date(ms);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  const diffDays = Math.floor((now.getTime() - ms) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function CallHistory({ records, contacts, onCallBack }: CallHistoryProps) {
  const groups = useMemo(() => {
    const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
    const map = new Map<string, CallHistoryRecord[]>();
    for (const r of sorted) {
      const key = dateBucket(r.startedAt);
      const arr = map.get(key) || [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [records]);

  if (records.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-16 px-4">
        <div className="w-14 h-14 rounded-full bg-relay-surface-hover flex items-center justify-center">
          <Phone className="w-6 h-6 text-relay-text-muted" />
        </div>
        <p className="text-sm text-relay-text-muted text-center">No calls yet</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col overflow-y-auto divide-y divide-relay-border">
      {groups.map(([bucket, items]) => (
        <div key={bucket} className="py-1">
          <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-relay-text-muted">
            {bucket}
          </div>
          {items.map((record, idx) => {
            const contact = contacts.find((c) => c.relayId === record.peerId || c.id === record.peerId);
            const displayName = contact?.name || record.peerId.substring(0, 14) + '…';
            const isMissed = record.outcome === 'missed';
            const isFailed = record.outcome === 'failed';
            const isOutgoing = record.direction === 'outgoing';

            return (
              <motion.button
                key={record.id}
                onClick={() => onCallBack(record.peerId, record.isVideo)}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.02, duration: 0.15 }}
                whileHover={{ x: 2 }}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-relay-surface-hover/50 transition-colors group text-left"
                title={`Call ${displayName} back`}
              >
                <UserAvatar
                  emoji={contact?.avatarEmoji}
                  color={contact?.avatarColor}
                  size={40}
                />

                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isMissed ? 'text-relay-danger' : 'text-relay-text-primary'}`}>
                    {displayName}
                  </p>
                  <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-relay-text-muted">
                    {isMissed ? (
                      <PhoneMissed className="w-3.5 h-3.5 text-relay-danger" />
                    ) : isFailed ? (
                      <PhoneOff className="w-3.5 h-3.5 text-relay-danger" />
                    ) : isOutgoing ? (
                      <PhoneOutgoing className="w-3.5 h-3.5" />
                    ) : (
                      <PhoneIncoming className="w-3.5 h-3.5" />
                    )}
                    <span>{record.isVideo ? 'Video' : 'Voice'}</span>
                    <span>·</span>
                    <span className="font-mono">{formatDuration(record.durationSec)}</span>
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className="text-[11px] text-relay-text-muted font-mono">
                    {formatTime(record.startedAt)}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity text-relay-text-muted">
                    {record.isVideo ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
                  </div>
                </div>
              </motion.button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
