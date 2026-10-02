'use client';

import { motion } from 'framer-motion';
import { PhoneOff, Mic, MicOff, Video, VideoOff, Maximize2 } from 'lucide-react';
import { UserAvatar } from '@/components/UserAvatar';
import { useVoiceActivity } from '@/lib/calls/use-voice-activity';

interface MiniCallBarProps {
  peerDisplayName: string;
  peerAvatarEmoji?: string;
  peerAvatarColor?: string;
  formattedCallDuration: string;
  isVideo: boolean;
  muted: boolean;
  videoEnabled: boolean;
  remoteStream: MediaStream | null;
  onExpand: () => void;
  onToggleMute: () => void;
  onToggleVideo: () => void;
  onEndCall: () => void;
}

export function MiniCallBar({
  peerDisplayName,
  peerAvatarEmoji,
  peerAvatarColor,
  formattedCallDuration,
  isVideo,
  muted,
  videoEnabled,
  remoteStream,
  onExpand,
  onToggleMute,
  onToggleVideo,
  onEndCall,
}: MiniCallBarProps) {
  const { isSpeaking: remoteSpeaking } = useVoiceActivity({ stream: remoteStream });

  return (
    <motion.div
      initial={{ y: 80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 80, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30, duration: 0.15 }}
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[320px]"
    >
      <div className="flex items-center gap-2 pl-3 pr-2 py-2 rounded-full border border-relay-border bg-relay-surface/95 backdrop-blur-xl shadow-lg">
        <button
          onClick={onExpand}
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left"
        >
          <div className="relative flex-shrink-0">
            <UserAvatar emoji={peerAvatarEmoji} color={peerAvatarColor} size={32} />
            <motion.div
              className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-relay-surface"
              animate={{
                backgroundColor: remoteSpeaking
                  ? 'rgb(var(--relay-accent) / 1)'
                  : 'rgb(var(--relay-success) / 1)',
                scale: remoteSpeaking ? [1, 1.25, 1] : 1,
              }}
              transition={{ duration: 0.5, repeat: remoteSpeaking ? Infinity : 0 }}
            />
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-relay-text-primary truncate leading-tight">
              {peerDisplayName}
            </p>
            <p className="text-[11px] text-relay-text-secondary font-mono leading-tight">
              {formattedCallDuration}
            </p>
          </div>

          <Maximize2 className="w-4 h-4 text-relay-text-muted flex-shrink-0" />
        </button>

        <div className="w-px h-7 bg-relay-border" />

        <div className="flex items-center gap-1 flex-shrink-0">
          <motion.button
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={onToggleMute}
            className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
              muted
                ? 'bg-relay-danger text-relay-accent-foreground'
                : 'text-relay-text-secondary hover:bg-relay-surface-hover'
            }`}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </motion.button>

          {isVideo && (
            <motion.button
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
              onClick={onToggleVideo}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                !videoEnabled
                  ? 'bg-relay-danger text-relay-accent-foreground'
                  : 'text-relay-text-secondary hover:bg-relay-surface-hover'
              }`}
              title={videoEnabled ? 'Camera off' : 'Camera on'}
            >
              {videoEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
            </motion.button>
          )}

          <motion.button
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.92 }}
            onClick={onEndCall}
            className="w-9 h-9 rounded-full bg-relay-danger text-relay-accent-foreground flex items-center justify-center shadow"
            title="End call"
          >
            <PhoneOff className="w-5 h-5" />
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}
