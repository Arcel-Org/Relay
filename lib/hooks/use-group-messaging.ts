/**
 * Group messaging hook — handles group creation, messaging, file sharing,
 * membership management, and governance (rename, admin, ownership).
 */

import { useCallback, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from '@/components/ToastNotification';
import { toHex, fromHex } from '@/lib/crypto/hex-utils';
import { isSafeDataUrl, stripSuspiciousTextControlChars } from '@/lib/security/sanitize';
import { log } from '@/lib/platform/logger';
import { RelayError } from '@/lib/relay/relay-error';
import { resolveDisplayName } from '@/lib/messaging/relay-display';
import { formatGhostLabel } from '@/lib/messaging/ghost-mode';
import { getBoolSetting, playMessageBeep } from '@/lib/settings/relay-settings';
import { vibrate } from '@/lib/platform/notifications';
import { saveRatchetState } from '@/lib/messaging/contact-key-cache';
import { generateGroupKey, encryptWithGroupKey, decryptWithGroupKey, buildGroupAad } from '@/lib/crypto/group-crypto';
import { getActiveGroupKey, setActiveGroupKey, getKeyHexForEpoch, hydrateGroupKeyCache } from '@/lib/messaging/group-key-cache';
import type { SharedMessagingRefs, SharedMessagingState, GroupConversation, GroupCreateOptions, MessageWithStatus } from './messaging-types';

interface UseGroupMessagingParams {
  shared: SharedMessagingRefs;
  state: SharedMessagingState;
  initiateKeyExchange: (contactRelayId: string, publicKeyHex: string) => void;
}

export function useGroupMessaging({ shared, state, initiateKeyExchange }: UseGroupMessagingParams) {
  const { wsRef, sessionsRef, identityRef, groupsRef } = shared;
  const { contacts, groups, setGroups } = state;

  const groupSaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Guards the persist effect below — stays false until a load has
  // genuinely completed (found nothing, or parsed successfully), so a
  // parse failure can never cascade into overwriting good on-disk data
  // with an empty array (see loadGroupsFromStorage's catch block).
  const groupsHydratedRef = useRef(false);
  // Rate-limits how often we ask a fellow member to resend a group's epoch
  // key we're missing — see requestMissingGroupKey. Keyed by `groupId:epoch`
  // so a still-missing key doesn't get re-requested on every subsequent
  // message under that same epoch while a request is already in flight.
  const keyRequestSentAtRef = useRef(new Map<string, number>());
  const KEY_REQUEST_RATE_LIMIT_MS = 30_000;

  const getGroupsStorageKey = useCallback(() => {
    const currentId = identityRef.current?.relayId;
    if (!currentId) return null;
    return `relay_groups_${currentId}`;
  }, [identityRef]);

  const loadGroupsFromStorage = useCallback(() => {
    if (typeof window === 'undefined') return;
    const key = getGroupsStorageKey();
    if (!key) return;

    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        setGroups([]);
        groupsHydratedRef.current = true;
        return;
      }

      const parsed = JSON.parse(raw) as Array<Partial<GroupConversation>>;
      const myId = identityRef.current?.relayId || 'unknown';
      const hydrated = parsed.map((group) => ({
        ...group,
        id: group.id || `grp_legacy_${Date.now()}`,
        name: group.name || 'Untitled Group',
        memberIds: group.memberIds || [],
        ownerId: group.ownerId || group.memberIds?.[0] || myId,
        adminIds: group.adminIds || [group.ownerId || group.memberIds?.[0] || myId],
        createdAt: group.createdAt || Date.now(),
        updatedAt: group.updatedAt || Date.now(),
        messages: (group.messages || []).map((msg: any) => ({
          ...msg,
          timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp),
          editedAt: msg.editedAt ? (msg.editedAt instanceof Date ? msg.editedAt : new Date(msg.editedAt)) : undefined,
        })),
      })) as GroupConversation[];
      setGroups(hydrated);
      groupsHydratedRef.current = true;
      void hydrateGroupKeyCache(hydrated.map((g) => g.id));
    } catch (err) {
      // Do NOT setGroups([]) here — a corrupted read (or a hydration bug)
      // must never be allowed to look like "this account has no groups",
      // since the debounced persist effect below would then immediately
      // write that empty array over whatever was actually on disk.
      // groupsHydratedRef stays false, so persistence is withheld until a
      // real load succeeds.
      log.error('Failed to load groups from storage:', err);
    }
  }, [getGroupsStorageKey, identityRef, setGroups]);

  // Debounced group persistence
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Never persist before a load has genuinely completed — see
    // groupsHydratedRef's declaration for why.
    if (!groupsHydratedRef.current) return;
    const key = getGroupsStorageKey();
    if (!key || !identityRef.current) return;

    if (groupSaveTimerRef.current) clearTimeout(groupSaveTimerRef.current);
    groupSaveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(groups));
      } catch (err) {
        log.error('Failed to persist groups:', err);
      }
    }, 500);

    return () => {
      if (groupSaveTimerRef.current) clearTimeout(groupSaveTimerRef.current);
    };
  }, [groups, getGroupsStorageKey, identityRef]);

  // Cross-tab sync. The relay only allows one live WS connection per
  // identity (a second tab connecting closes the first tab's socket — see
  // server/relay-node.ts's handleHello), but that doesn't stop a
  // BACKGROUND tab's React state from going stale: it keeps whatever
  // `groups` it last loaded/rendered in memory regardless of its socket
  // being closed, and its OWN debounced persist effect above is still
  // armed. Without this listener, switching back to that background tab
  // and triggering even an unrelated re-render can fire its stale
  // 500ms-debounced write and silently overwrite a foreground tab's newer
  // changes with older data — a real last-writer-wins data loss, not a
  // hypothetical one. The browser's `storage` event fires in every OTHER
  // tab (never the one that wrote) whenever the value actually changes, so
  // this re-hydrates from the fresh value the moment another tab writes it,
  // keeping this tab's in-memory state (and its next debounced write, if
  // any) based on current data instead of stale data.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === getGroupsStorageKey()) loadGroupsFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [getGroupsStorageKey, loadGroupsFromStorage]);

  const appendGroupSystemMessage = useCallback((groupId: string, text: string) => {
    const ownId = identityRef.current?.relayId || 'system';
    const sysMsg: MessageWithStatus = {
      id: `gsys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      senderId: ownId,
      senderName: 'System',
      text,
      timestamp: new Date(),
      isOwn: false,
      read: true,
      delivered: true,
      status: 'sent',
      messageType: 'system',
      reactions: [],
      metadata: {
        compression_ratio: 1,
        original_size: text.length,
        compressed_size: text.length,
        encrypted_size: text.length,
        latency_ms: 0,
        neural_model_score: 1,
      },
    };

    setGroups((prev) =>
      prev.map((group) =>
        group.id === groupId
          ? { ...group, updatedAt: Date.now(), messages: [...group.messages, sysMsg] }
          : group
      )
    );
  }, [identityRef, setGroups]);

  // Send a single envelope to one recipient, waiting (with retries) for a
  // session to become available. Returns true if delivered, false if the
  // session never established within the retry budget.
  const sendEnvelopeToRecipient = useCallback(
    // `envelope` may be pre-serialized bytes (callers with a large, identical
    // payload per recipient — e.g. a file's dataUrl — should serialize once
    // and pass bytes, instead of every recipient redundantly re-running
    // JSON.stringify/TextEncoder over the same multi-MB payload).
    async (recipientId: string, envelope: Record<string, any> | Uint8Array, attempts: number, delayMs: number): Promise<boolean> => {
      const ws = wsRef.current;
      if (!ws || !ws.isReady()) return false;

      let sessionData = sessionsRef.current.get(recipientId);
      if (!sessionData) {
        initiateKeyExchange(recipientId, '');
        for (let i = 0; i < attempts; i++) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          sessionData = sessionsRef.current.get(recipientId);
          if (sessionData) break;
        }
      }
      if (!sessionData) return false;

      try {
        const plaintext = envelope instanceof Uint8Array
          ? envelope
          : new TextEncoder().encode(JSON.stringify(envelope));
        const encrypted = await sessionData.session.encryptAsync(plaintext);
        saveRatchetState(recipientId, sessionData.session.serialize());
        const blob = toHex(encrypted);
        ws.sendMessage(recipientId, blob, uuidv4());
        return true;
      } catch (err) {
        log.warn(`[Group] Failed to encrypt/send envelope to ${recipientId}:`, err);
        return false;
      }
    },
    [wsRef, sessionsRef, initiateKeyExchange]
  );

  const fanoutEncryptedGroupEnvelope = useCallback(
    async (
      group: GroupConversation,
      envelope: Record<string, any>,
      recipientsOverride?: string[]
    ) => {
      const ownId = identityRef.current?.relayId;
      const ws = wsRef.current;
      if (!ownId) throw new Error('Identity not loaded');
      if (!ws || !ws.isReady()) throw new Error('Relay connection not ready');

      const recipients = (recipientsOverride || group.memberIds).filter((id) => id !== ownId);

      // Fan out to every recipient in parallel — one slow/cold recipient's
      // session-establishment retries shouldn't serialize the whole group.
      const results = await Promise.allSettled(
        recipients.map((recipientId) => sendEnvelopeToRecipient(recipientId, envelope, 6, 350))
      );

      const stillPending = recipients.filter((_, i) => {
        const r = results[i];
        return r.status === 'rejected' || r.value !== true;
      });

      if (stillPending.length > 0) {
        log.warn(`[Group] ${stillPending.length} recipient(s) still without a session after initial fan-out — retrying in background:`, stillPending);
        // Governance/message events matter more than a chat message being a
        // few seconds late — keep retrying in the background for up to ~70s
        // (covers slow key-exchange round trips) instead of silently
        // dropping the recipient forever after the initial ~2s window.
        (async () => {
          for (const recipientId of stillPending) {
            const delivered = await sendEnvelopeToRecipient(recipientId, envelope, 8, 2000);
            if (!delivered) {
              log.warn(`[Group] Giving up on envelope delivery to ${recipientId} after extended retry`);
            }
          }
        })();
      }
    },
    [wsRef, identityRef, sendEnvelopeToRecipient]
  );

  /**
   * Resolve the group's current epoch key, bootstrapping one if this group
   * predates the group-key feature (a one-time migration for any group
   * created before this shipped). Only an owner/admin can perform that
   * bootstrap — a plain member sending to a still-unkeyed legacy group gets
   * a clear error instead, until an owner/admin sends first. New groups
   * never hit the bootstrap path at all (createGroup already establishes
   * epoch 1 at creation time).
   */
  const ensureGroupKeyOrThrow = useCallback(
    async (group: GroupConversation, ownId: string): Promise<{ epoch: number; keyHex: string }> => {
      const existing = getActiveGroupKey(group.id);
      if (existing) return existing;

      const isOwnerOrAdmin = group.ownerId === ownId || group.adminIds.includes(ownId);
      if (!isOwnerOrAdmin) {
        throw new Error('This group has not been secured with per-message encryption yet — ask the owner or an admin to send a message first.');
      }

      const key = generateGroupKey();
      const record = { epoch: 1, keyHex: toHex(key) };
      setActiveGroupKey(group.id, record);

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'rotate_key',
        groupId: group.id,
        actorId: ownId,
        epoch: record.epoch,
        groupKeyHex: record.keyHex,
        memberIds: group.memberIds,
        timestamp: new Date().toISOString(),
      }, group.memberIds);

      return record;
    },
    [fanoutEncryptedGroupEnvelope]
  );

  /**
   * Ask the sender of a group_message/group_file we couldn't decrypt (their
   * epoch key isn't in our cache yet) to resend the current key directly to
   * us. Without this, a member offline/slow during removeGroupMember's
   * ~18s fan-out window (see fanoutEncryptedGroupEnvelope) never received
   * the new epoch at all and — since getKeyHexForEpoch only tolerates the
   * current epoch or one behind — would otherwise be PERMANENTLY locked out
   * of the group until some future rotation happens to include them again.
   * Any current member can serve this (not owner/admin-gated — see the
   * key_request/key_share handling below): both requester and responder are
   * already-legitimate co-equal holders of the same shared key by design,
   * so this isn't a privilege a plain member shouldn't have.
   */
  const requestMissingGroupKey = useCallback((groupId: string, epoch: number, fromRelayId: string) => {
    // Keyed by groupId+fromRelayId, NOT the epoch carried in the incoming
    // message — epoch is attacker-controlled (it comes straight from a
    // group_message/group_file we couldn't decrypt), so keying by it would
    // let a malicious member trivially bypass this throttle by simply
    // incrementing the claimed epoch on every message.
    const rateLimitKey = `${groupId}:${fromRelayId}`;
    const now = Date.now();
    const lastSent = keyRequestSentAtRef.current.get(rateLimitKey) || 0;
    if (now - lastSent < KEY_REQUEST_RATE_LIMIT_MS) return;

    // Both directions checked against our OWN local roster — fromRelayId
    // having a live pairwise session with us (required just to reach this
    // handler at all) does not by itself mean they're a member of THIS
    // group; without this check, any contact could learn which groupIds we
    // track by sending a bogus group_message under an unrecognized epoch.
    const currentId = identityRef.current?.relayId;
    const currentGroup = groupsRef.current.find((g) => g.id === groupId);
    if (!currentId || !currentGroup || !currentGroup.memberIds.includes(currentId) || !currentGroup.memberIds.includes(fromRelayId)) {
      return;
    }

    keyRequestSentAtRef.current.set(rateLimitKey, now);
    fanoutEncryptedGroupEnvelope(currentGroup, {
      type: 'group_event',
      action: 'key_request',
      groupId,
      actorId: currentId,
      epoch,
      timestamp: new Date().toISOString(),
    }, [fromRelayId]).catch((err) => log.warn(`[Group] Failed to request missing key for ${groupId} from ${fromRelayId}:`, err));
  }, [identityRef, groupsRef, fanoutEncryptedGroupEnvelope]);

  const createGroup = useCallback((name: string, memberIds: string[], options?: GroupCreateOptions): GroupConversation => {
    const ownId = identityRef.current?.relayId;
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('Group name is required');

    const uniqueMembers = Array.from(new Set([...(memberIds || []), ...(ownId ? [ownId] : [])]));
    if (uniqueMembers.length < 2) throw new Error('Group must have at least 2 members');

    // Every group gets a shared epoch key from creation — distributed
    // pairwise via the same add_members bootstrap event below (already
    // per-recipient-encrypted, so the key rides along confidentially for
    // free). See removeGroupMember for the rotation-on-removal case this
    // exists for.
    const groupKey = generateGroupKey();
    const groupKeyHex = toHex(groupKey);

    const group: GroupConversation = {
      // Random, not derived from Date.now()+Math.random(): a group intended
      // to later go public via the directory endpoint (app/api/groups/
      // directory) is claimed there first-come-first-served by groupId, with
      // no server-side membership record to verify a claimant actually owns
      // it. A guessable ID (ms timestamp + ~31 bits of Math.random) let a
      // non-member brute-force or pre-claim a group's directory listing
      // before its real owner ever published it. uuidv4 is unguessable, so
      // the only way to learn a real groupId is to have actually been sent
      // it (as a genuine current or former member) — the same trust boundary
      // the rest of group membership already relies on.
      id: `grp_${uuidv4()}`,
      name: normalizedName,
      memberIds: uniqueMembers,
      ownerId: ownId || uniqueMembers[0],
      adminIds: [ownId || uniqueMembers[0]],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      avatarEmoji: options?.avatarEmoji,
      avatarColor: options?.avatarColor,
      description: options?.description,
      visibility: options?.visibility || 'private',
      publicHandle: options?.publicHandle,
      joinPolicy: options?.joinPolicy || 'open',
    };

    setGroups((prev) => [group, ...prev]);
    setActiveGroupKey(group.id, { epoch: 1, keyHex: groupKeyHex });

    // Announce full membership to every other member via the same
    // 'add_members' group_event other membership changes use — this is the
    // only path the receive side trusts to bootstrap a brand-new group (see
    // the `canBootstrap` gate in the group_event handler below). Without
    // this, other members never learned the group existed except by
    // inference from a bare group_message, which used to trust whatever
    // ownerId/adminIds/memberIds a chat message claimed with no governance
    // check at all — and even then each member only saw [sender, self],
    // never the real full roster, so everyone's local membership diverged.
    // Fire-and-forget: the group already exists locally: a slow/failed
    // fan-out delays other members finding out, it doesn't break the group.
    if (ownId) {
      fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'add_members',
        groupId: group.id,
        groupName: group.name,
        actorId: ownId,
        addedMemberIds: uniqueMembers.filter((id) => id !== ownId),
        memberIds: uniqueMembers,
        ownerId: group.ownerId,
        adminIds: group.adminIds,
        epoch: 1,
        groupKeyHex,
        timestamp: new Date().toISOString(),
      }, uniqueMembers).catch((err) => log.warn('[Group] Failed to announce new group to members:', err));
    }

    return group;
  }, [identityRef, setGroups, fanoutEncryptedGroupEnvelope]);

  const sendGroupMessage = useCallback(
    async (groupId: string, text: string) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const ws = wsRef.current;
      if (!ws || !ws.isReady()) throw new Error('Relay connection not ready');

      const trimmed = text.trim();
      if (!trimmed) return;

      const targetGroup = groups.find((g) => g.id === groupId);
      if (!targetGroup) throw new Error('Group not found');

      const groupMessageId = `gmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const groupKeyRecord = await ensureGroupKeyOrThrow(targetGroup, ownId);

      // Respect ghost mode on the group thread: if active, stamp the
      // outgoing message with `ghost: true` + `expiresAt` so the receiving
      // UI filters it into the ghost thread and the sweeper can expire it.
      const { computeExpiresAt } = await import('@/lib/messaging/ghost-mode');
      const ghostExpiresAt = computeExpiresAt(groupId) ?? undefined;
      const isGhost = !!ghostExpiresAt;
      // The group's synced disappearAfter setting applies ambiently to every
      // message regardless of whether this device has the ghost thread view
      // open — unlike personal ghost mode, this is a group-wide policy every
      // member agreed to see enforced. `ghost` (the UI ghost-thread flag)
      // stays scoped to the personal setting; only expiresAt is affected.
      const expiresAt = ghostExpiresAt ?? (targetGroup.disappearAfter ? Date.now() + targetGroup.disappearAfter * 1000 : undefined);

      const localMsg: MessageWithStatus = {
        id: groupMessageId,
        senderId: ownId,
        senderName: 'You',
        text: trimmed,
        timestamp: new Date(),
        isOwn: true,
        read: true,
        delivered: true,
        status: 'sending',
        reactions: [],
        ghost: isGhost,
        expiresAt,
        metadata: {
          compression_ratio: 0.5,
          original_size: trimmed.length,
          compressed_size: Math.floor(trimmed.length * 0.5),
          encrypted_size: Math.floor(trimmed.length * 0.6),
          latency_ms: 0,
          neural_model_score: 0.85,
        },
      };

      setGroups((prev) =>
        prev.map((group) =>
          group.id === groupId
            ? { ...group, updatedAt: Date.now(), messages: [...group.messages, localMsg] }
            : group
        )
      );

      // Send to recipients in background. The message content itself is
      // AEAD-encrypted under the group's shared epoch key BEFORE the outer
      // pairwise-session fan-out (which is otherwise unchanged) — a
      // stale-state client that accidentally still fans this out to a
      // just-removed member delivers ciphertext that member's retained
      // (pre-removal) key can no longer open, since removal always rotates
      // the epoch (see removeGroupMember).
      const innerPlaintext = new TextEncoder().encode(JSON.stringify({ text: trimmed }));
      const cipherBytes = encryptWithGroupKey(
        fromHex(groupKeyRecord.keyHex),
        innerPlaintext,
        buildGroupAad(groupId, groupKeyRecord.epoch, ownId)
      );
      const payload = {
        type: 'group_message',
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        ownerId: targetGroup.ownerId,
        adminIds: targetGroup.adminIds,
        groupMessageId,
        epoch: groupKeyRecord.epoch,
        ciphertext: toHex(cipherBytes),
        timestamp: new Date().toISOString(),
      };
      // Re-read membership from the live ref, not the `targetGroup` snapshot
      // captured before the ghost-mode dynamic-import await above — see
      // sendGroupFile's identical fix below for the full reasoning.
      const recipients = (groupsRef.current.find((g) => g.id === groupId) ?? targetGroup).memberIds.filter((id) => id !== ownId);

      (async () => {
        // Parallel fan-out — one cold recipient's session-establishment
        // retries no longer serialize delivery to the rest of the group.
        await Promise.allSettled(
          recipients.map((recipientId) => sendEnvelopeToRecipient(recipientId, payload, 3, 150))
        );
        // Mark as sent
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  messages: g.messages.map((m) =>
                    m.id === groupMessageId ? { ...m, status: 'sent' as const } : m
                  ),
                }
              : g
          )
        );
      })();
    },
    [wsRef, identityRef, groups, setGroups, sendEnvelopeToRecipient, ensureGroupKeyOrThrow]
  );

  const sendGroupFile = useCallback(
    async (groupId: string, file: File) => {
      const MAX_FILE_SIZE = 10 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File is too large (max 10 MB). Selected file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`);
      }

      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const ws = wsRef.current;
      if (!ws || !ws.isReady()) throw new Error('Relay connection not ready');

      const targetGroup = groups.find((g) => g.id === groupId);
      if (!targetGroup) throw new Error('Group not found');
      const groupKeyRecord = await ensureGroupKeyOrThrow(targetGroup, ownId);

      // Read file with canvas metadata stripping for images
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const isImage = file.type.startsWith('image/');
        if (isImage && typeof window !== 'undefined') {
          const objectUrl = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
              const canvas = document.createElement('canvas');
              canvas.width = img.naturalWidth;
              canvas.height = img.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (!ctx) throw new Error('No canvas context');
              ctx.drawImage(img, 0, 0);
              resolve(canvas.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.92));
            } catch {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = () => reject(new Error('Failed to read file'));
              reader.readAsDataURL(file);
            }
          };
          img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Failed to load image')); };
          img.src = objectUrl;
        } else {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(file);
        }
      });

      const groupMessageId = `gmsg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // Only the file bytes themselves are group-key-encrypted (same scope
      // decision as sendGroupMessage — filename/mimeType/size stay in the
      // outer envelope, already confidential via the pairwise session layer).
      const innerPlaintext = new TextEncoder().encode(JSON.stringify({ data: dataUrl }));
      const cipherBytes = encryptWithGroupKey(
        fromHex(groupKeyRecord.keyHex),
        innerPlaintext,
        buildGroupAad(groupId, groupKeyRecord.epoch, ownId)
      );
      const payload = {
        type: 'group_file',
        groupId: targetGroup.id,
        groupName: targetGroup.name,
        ownerId: targetGroup.ownerId,
        adminIds: targetGroup.adminIds,
        groupMessageId,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        epoch: groupKeyRecord.epoch,
        ciphertext: toHex(cipherBytes),
        timestamp: new Date().toISOString(),
      };

      // Re-read membership from the live ref, not the `targetGroup` snapshot
      // captured before the file-read await above (can take real time for a
      // large image going through canvas decode/re-encode) — a member
      // removed from the group while this was in flight must not still
      // receive the file. (sessionsRef is shared with 1:1 DMs, so tearing
      // the session down on group removal isn't the right fix even as
      // defense-in-depth — the same contact may still be a legitimate 1:1
      // conversation partner; the membership recheck here is what matters.)
      const currentGroup = groupsRef.current.find((g) => g.id === groupId) ?? targetGroup;
      const recipients = currentGroup.memberIds.filter((id) => id !== ownId);

      // Add the optimistic local message immediately (matching sendGroupMessage's
      // pattern) instead of only after the whole fan-out completes — a slow/cold
      // recipient shouldn't delay the sender's own UI from showing the file.
      const localMsg: MessageWithStatus = {
        id: groupMessageId,
        senderId: ownId,
        senderName: 'You',
        text: `📎 ${file.name}`,
        timestamp: new Date(),
        isOwn: true,
        read: true,
        delivered: true,
        status: 'sending',
        reactions: [],
        fileShare: {
          filename: file.name,
          original_size: file.size,
          compressed_size: 0,
          compression_ratio: 0,
          type: file.type || 'application/octet-stream',
          dataUrl,
        },
        metadata: {
          compression_ratio: 0,
          original_size: file.size,
          compressed_size: 0,
          encrypted_size: 0,
          latency_ms: 0,
          neural_model_score: 0.85,
        },
      };

      setGroups((prev) =>
        prev.map((group) =>
          group.id === groupId
            ? { ...group, updatedAt: Date.now(), messages: [...group.messages, localMsg] }
            : group
        )
      );

      // Fan out in the background, in parallel — not awaited by the caller.
      // Serialize once (the dataUrl can be several MB) instead of per recipient.
      const plaintext = new TextEncoder().encode(JSON.stringify(payload));
      (async () => {
        await Promise.allSettled(
          recipients.map((recipientId) => sendEnvelopeToRecipient(recipientId, plaintext, 6, 350))
        );
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  messages: g.messages.map((m) =>
                    m.id === groupMessageId ? { ...m, status: 'sent' as const } : m
                  ),
                }
              : g
          )
        );
      })();
    },
    [wsRef, identityRef, groups, setGroups, sendEnvelopeToRecipient, ensureGroupKeyOrThrow]
  );

  const renameGroup = useCallback(
    async (groupId: string, newName: string) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const trimmed = newName.trim();
      if (!trimmed) throw new Error('Group name is required');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (!(group.ownerId === ownId || group.adminIds.includes(ownId))) {
        throw new Error('Only group owner/admin can rename this group');
      }

      const previous = group.name;
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, name: trimmed, updatedAt: Date.now() } : g)));
      appendGroupSystemMessage(groupId, `Group renamed from "${previous}" to "${trimmed}"`);

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'rename',
        groupId,
        groupName: trimmed,
        actorId: ownId,
        previousName: previous,
        timestamp: new Date().toISOString(),
      });
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const setGroupDisappearing = useCallback(
    async (groupId: string, seconds: number) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30 * 86400) {
        throw new Error('Invalid disappearing-messages duration');
      }

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (!(group.ownerId === ownId || group.adminIds.includes(ownId))) {
        throw new Error('Only group owner/admin can change this setting');
      }

      const disappearAfter = seconds > 0 ? seconds : undefined;
      setGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, disappearAfter, updatedAt: Date.now() } : g)));
      appendGroupSystemMessage(
        groupId,
        disappearAfter ? `Disappearing messages set to ${formatGhostLabel(disappearAfter)}` : 'Disappearing messages turned off'
      );

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'set_disappear',
        groupId,
        actorId: ownId,
        disappearAfter,
        timestamp: new Date().toISOString(),
      });
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const addGroupMembers = useCallback(
    async (groupId: string, newMemberIds: string[]) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (!(group.ownerId === ownId || group.adminIds.includes(ownId))) {
        throw new Error('Only group owner/admin can add members');
      }

      const toAdd = Array.from(new Set(newMemberIds.filter((id) => !!id && !group.memberIds.includes(id))));
      if (!toAdd.length) return;

      const updatedMembers = Array.from(new Set([...group.memberIds, ...toAdd]));
      setGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, memberIds: updatedMembers, updatedAt: Date.now() } : g))
      );
      appendGroupSystemMessage(groupId, `${toAdd.length} member(s) added to group`);

      // New members need the CURRENT epoch key to participate (no rotation
      // on add — nothing retroactive is ever sent to a new member anyway,
      // so there's nothing an unrotated key would expose to them). Existing
      // members already hold it and simply ignore these extra fields.
      const activeKey = getActiveGroupKey(groupId);
      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'add_members',
        groupId,
        groupName: group.name,
        actorId: ownId,
        addedMemberIds: toAdd,
        memberIds: updatedMembers,
        ownerId: group.ownerId,
        adminIds: group.adminIds,
        ...(activeKey ? { epoch: activeKey.epoch, groupKeyHex: activeKey.keyHex } : {}),
        timestamp: new Date().toISOString(),
      }, updatedMembers);
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const removeGroupMember = useCallback(
    async (groupId: string, memberId: string) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (!(group.ownerId === ownId || group.adminIds.includes(ownId))) {
        throw new Error('Only group owner/admin can remove members');
      }
      if (memberId === group.ownerId) {
        throw new Error('Owner cannot be removed. Transfer ownership first.');
      }

      const updatedMembers = group.memberIds.filter((id) => id !== memberId);
      const updatedAdmins = group.adminIds.filter((id) => id !== memberId);
      if (updatedMembers.length < 2) throw new Error('Group must keep at least 2 members');

      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? { ...g, memberIds: updatedMembers, adminIds: updatedAdmins, updatedAt: Date.now() }
            : g
        )
      );
      appendGroupSystemMessage(groupId, `Member removed from group`);

      // Rotate the group's shared epoch key so the removed member's
      // confidentiality boundary is "never given the new key" — this is
      // what actually enforces the boundary, independent of whether their
      // still-live pairwise session with a remaining member happens to
      // still deliver an outer envelope during the propagation window (a
      // stale-state race the recipient-list filter alone can't close).
      // previousEpochKeyHex is retained (one epoch back) so a message
      // encrypted just before rotation propagated — a normal race, not an
      // error — can still be decrypted during the transition.
      const currentKey = getActiveGroupKey(groupId);
      const nextEpoch = (currentKey?.epoch ?? 0) + 1;
      const newGroupKeyHex = toHex(generateGroupKey());
      setActiveGroupKey(groupId, {
        epoch: nextEpoch,
        keyHex: newGroupKeyHex,
        previousEpochKeyHex: currentKey?.keyHex,
      });

      const baseEvent = {
        type: 'group_event' as const,
        action: 'remove_member' as const,
        groupId,
        actorId: ownId,
        removedMemberId: memberId,
        memberIds: updatedMembers,
        adminIds: updatedAdmins,
        ownerId: group.ownerId,
        timestamp: new Date().toISOString(),
      };

      // Two separate fan-outs, not one shared payload: remaining members
      // get the notice PLUS the new epoch key; the removed member gets
      // ONLY the notice (so they still learn they were removed, matching
      // today's UX, but gain nothing cryptographically from it).
      await Promise.all([
        fanoutEncryptedGroupEnvelope(group, { ...baseEvent, epoch: nextEpoch, groupKeyHex: newGroupKeyHex }, updatedMembers),
        fanoutEncryptedGroupEnvelope(group, baseEvent, [memberId]),
      ]);
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const setGroupAdmin = useCallback(
    async (groupId: string, memberId: string, isAdmin: boolean) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (group.ownerId !== ownId) throw new Error('Only group owner can change admin roles');
      if (!group.memberIds.includes(memberId)) throw new Error('Member is not in this group');
      if (memberId === group.ownerId) throw new Error('Owner is always admin');

      const nextAdmins = isAdmin
        ? Array.from(new Set([...group.adminIds, memberId]))
        : group.adminIds.filter((id) => id !== memberId);

      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, adminIds: nextAdmins, updatedAt: Date.now() } : g
        )
      );

      appendGroupSystemMessage(groupId, isAdmin ? 'Member promoted to admin' : 'Admin demoted to member');

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'set_admin',
        groupId,
        actorId: ownId,
        targetMemberId: memberId,
        isAdmin,
        ownerId: group.ownerId,
        adminIds: nextAdmins,
        memberIds: group.memberIds,
        timestamp: new Date().toISOString(),
      });
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const transferGroupOwnership = useCallback(
    async (groupId: string, newOwnerId: string) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (group.ownerId !== ownId) throw new Error('Only group owner can transfer ownership');
      if (!group.memberIds.includes(newOwnerId)) throw new Error('New owner must be a current group member');
      if (newOwnerId === ownId) throw new Error('Selected member is already owner');

      const nextAdmins = Array.from(new Set([...group.adminIds, newOwnerId, ownId]));

      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, ownerId: newOwnerId, adminIds: nextAdmins, updatedAt: Date.now() } : g
        )
      );

      appendGroupSystemMessage(groupId, 'Group ownership transferred');

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'transfer_ownership',
        groupId,
        actorId: ownId,
        previousOwnerId: ownId,
        newOwnerId,
        ownerId: newOwnerId,
        adminIds: nextAdmins,
        memberIds: group.memberIds,
        timestamp: new Date().toISOString(),
      });

      // Best-effort: sync the public directory's ownerRelayId too, so the
      // new owner isn't permanently locked out of directory actions
      // (leave-directory, pending-join approval, republish) while the
      // departed old owner keeps sole control there. A failure here doesn't
      // roll back the E2E transfer above — the group itself already
      // transferred correctly; only directory bookkeeping would be stale,
      // recoverable by retrying this call later.
      if (group.visibility === 'public') {
        fetch('/api/groups/transfer-owner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupId, newOwnerRelayId: newOwnerId }),
        })
          .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
          })
          .catch((err) => {
            log.warn('[Group] Failed to sync directory ownership after transfer:', err);
            // The E2E transfer above already succeeded — only this directory
            // bookkeeping is stale. Without a visible warning, the new owner
            // silently loses join-request approval and leave-directory
            // access with no indication anything went wrong until they
            // happen to try one of those actions and get a confusing
            // permission failure.
            toast.warning(
              'Directory sync incomplete',
              'Ownership transferred, but the public group directory could not be updated. Join approvals and leave-directory may not work until this is retried.'
            );
          });
      }
    },
    [identityRef, groups, setGroups, appendGroupSystemMessage, fanoutEncryptedGroupEnvelope]
  );

  const leaveGroup = useCallback(
    async (groupId: string) => {
      const ownId = identityRef.current?.relayId;
      if (!ownId) throw new Error('Identity not loaded');

      const group = groups.find((g) => g.id === groupId);
      if (!group) throw new Error('Group not found');
      if (group.ownerId === ownId) throw new Error('Owner cannot leave group without transferring ownership');

      const updatedMembers = group.memberIds.filter((id) => id !== ownId);
      const updatedAdmins = group.adminIds.filter((id) => id !== ownId);

      setGroups((prev) => prev.filter((g) => g.id !== groupId));

      await fanoutEncryptedGroupEnvelope(group, {
        type: 'group_event',
        action: 'member_left',
        groupId,
        actorId: ownId,
        memberIds: updatedMembers,
        adminIds: updatedAdmins,
        ownerId: group.ownerId,
        timestamp: new Date().toISOString(),
      }, updatedMembers);
    },
    [identityRef, groups, setGroups, fanoutEncryptedGroupEnvelope]
  );

  /** Handle incoming group message/file/event from the receive handler */
  const handleGroupMessage = useCallback(
    (parsed: Record<string, any>, fromRelayId: string, messageId: string, encrypted: Uint8Array) => {
      if (parsed.type === 'group_message' && parsed.groupId) {
        const groupId = parsed.groupId as string;
        const groupName = parsed.groupName as string | undefined;

        let innerText = '';
        if (typeof parsed.ciphertext === 'string' && typeof parsed.epoch === 'number') {
          const keyHex = getKeyHexForEpoch(groupId, parsed.epoch);
          if (!keyHex) {
            // This epoch's key hasn't arrived yet — could be a brief,
            // self-healing race (group_event key distribution and
            // group_message both go through the same fan-out and are
            // typically sent moments apart), or this client was offline/slow
            // during the original rotation's bounded fan-out window and
            // never got it at all. requestMissingGroupKey re-checks that
            // fromRelayId is actually a member of our local view of this
            // group before asking them to resend — this handler runs before
            // that's otherwise verified. Drop this specific message either
            // way rather than show undecryptable content; it (or a later
            // one) recovers once the key arrives.
            requestMissingGroupKey(groupId, parsed.epoch, fromRelayId);
            log.warn(`[Group] Dropped group_message for ${groupId} epoch ${parsed.epoch} from ${fromRelayId} — no matching key on file, requested a resend`);
            return true;
          }
          try {
            const innerBytes = decryptWithGroupKey(fromHex(keyHex), fromHex(parsed.ciphertext), buildGroupAad(groupId, parsed.epoch, fromRelayId));
            innerText = JSON.parse(new TextDecoder().decode(innerBytes)).text || '';
          } catch (err) {
            log.warn(`[Group] Failed to decrypt group_message for ${groupId} from ${fromRelayId}:`, err);
            return true;
          }
        } else {
          // Legacy path: a group that predates the group-key feature and
          // hasn't had its first post-upgrade message sent yet (see
          // ensureGroupKeyOrThrow) — accepted as plaintext-relative-to-
          // the-pairwise-layer, matching behavior before this feature existed.
          innerText = (parsed.text as string) || '';
        }
        // See receive.ts's matching comment — strip bidi-override/Zalgo
        // control characters from peer-supplied text before it enters the
        // client's trusted data model.
        const groupText = stripSuspiciousTextControlChars(innerText);

        const groupMsg: MessageWithStatus = {
          id: parsed.groupMessageId || messageId,
          senderId: fromRelayId,
          senderName: resolveDisplayName(fromRelayId, contacts),
          text: groupText,
          timestamp: new Date(),
          isOwn: false,
          read: false,
          delivered: true,
          status: 'delivered',
          reactions: [],
          metadata: {
            compression_ratio: 0.5,
            original_size: groupText.length,
            compressed_size: Math.floor(groupText.length * 0.5),
            encrypted_size: encrypted.length,
            latency_ms: 0,
            neural_model_score: 0.85,
          },
        };

        let appended = false;
        setGroups((prev) => {
          const idx = prev.findIndex((g) => g.id === groupId);
          if (idx === -1) {
            // Do NOT bootstrap a group from a bare chat message — a
            // group_message carries no governance proof at all, so a
            // fabricated ownerId/adminIds/memberIds used to be trusted
            // outright, letting any contact spin up a fake "group" out of
            // thin air. New groups are only trusted via the group_event
            // 'add_members' path below (see its `canBootstrap` gate), which
            // createGroup() now actually sends. If that event hasn't arrived
            // yet, drop this message rather than fabricate group state for
            // it — the legitimate add_members event should land shortly
            // after (they're sent from the same createGroup call), and once
            // the group exists, subsequent group_message/group_file for it
            // append normally.
            log.warn(`[Group] Dropped group_message for unknown group ${groupId} from ${fromRelayId} — no group_event bootstrapped it yet`);
            return prev;
          }

          const updated = [...prev];
          const existing = updated[idx];
          // Groups have no server-side membership authority — every group
          // message is just a pairwise 1:1-encrypted send, fanned out. A
          // removed member (or anyone else with a live 1:1 session to a
          // current member) could otherwise still get their group_message
          // silently appended to the thread as if from a current member.
          // Reject anything from a sender not in our local roster instead.
          if (!existing.memberIds.includes(fromRelayId)) {
            log.warn(`[Group] Dropped group_message from non-member ${fromRelayId} in group ${groupId}`);
            return prev;
          }
          // Relay can re-deliver a queued message on reconnect — dedup by id
          // (matches the guard already used below for group_file).
          if (existing.messages.some((m) => m.id === groupMsg.id)) return prev;
          updated[idx] = {
            ...existing,
            name: groupName || existing.name,
            updatedAt: Date.now(),
            messages: [...existing.messages, groupMsg],
          };
          appended = true;
          return updated;
        });
        // Settings' "Sound"/"Vibration" toggles — see receive.ts's identical
        // 1:1 handling for why this was previously silent regardless of the
        // setting. Only for genuinely-new messages, not a reconnect
        // redelivery.
        if (appended) {
          playMessageBeep();
          if (getBoolSetting('vibration', true)) vibrate();
        }
        return true;
      }

      if (parsed.type === 'group_file' && parsed.groupId) {
        const { groupId, groupName, mimeType, size, groupMessageId } = parsed;

        let rawFileDataUrl: string | undefined;
        if (typeof parsed.ciphertext === 'string' && typeof parsed.epoch === 'number') {
          const keyHex = getKeyHexForEpoch(groupId, parsed.epoch);
          if (!keyHex) {
            // See the identical group_message branch above for the full
            // reasoning — same missed-rotation recovery path.
            requestMissingGroupKey(groupId, parsed.epoch, fromRelayId);
            log.warn(`[Group] Dropped group_file for ${groupId} epoch ${parsed.epoch} from ${fromRelayId} — no matching key on file, requested a resend`);
            return true;
          }
          try {
            const innerBytes = decryptWithGroupKey(fromHex(keyHex), fromHex(parsed.ciphertext), buildGroupAad(groupId, parsed.epoch, fromRelayId));
            rawFileDataUrl = JSON.parse(new TextDecoder().decode(innerBytes)).data;
          } catch (err) {
            log.warn(`[Group] Failed to decrypt group_file for ${groupId} from ${fromRelayId}:`, err);
            return true;
          }
        } else {
          rawFileDataUrl = parsed.data;
        }

        const fileDataUrl = isSafeDataUrl(rawFileDataUrl) ? rawFileDataUrl : undefined;
        const filename = stripSuspiciousTextControlChars(parsed.filename ?? '');

        const fileMsg: MessageWithStatus = {
          id: groupMessageId || messageId,
          senderId: fromRelayId,
          senderName: resolveDisplayName(fromRelayId, contacts),
          text: `📎 ${filename}`,
          timestamp: new Date(),
          isOwn: false,
          read: false,
          delivered: true,
          status: 'delivered',
          reactions: [],
          fileShare: {
            filename: filename || 'file',
            original_size: size || 0,
            compressed_size: 0,
            compression_ratio: 0,
            type: mimeType || 'application/octet-stream',
            dataUrl: fileDataUrl,
          },
          metadata: {
            compression_ratio: 0,
            original_size: size || 0,
            compressed_size: 0,
            encrypted_size: encrypted.length,
            latency_ms: 0,
            neural_model_score: 0.9,
          },
        };

        setGroups((prev) => {
          const idx = prev.findIndex((g) => g.id === groupId);
          if (idx === -1) {
            // Same reasoning as group_message's idx === -1 branch above —
            // don't fabricate group state from an ungoverned message.
            log.warn(`[Group] Dropped group_file for unknown group ${groupId} from ${fromRelayId} — no group_event bootstrapped it yet`);
            return prev;
          }
          const updated = [...prev];
          const existing = updated[idx];
          // Same membership gate as group_message above — see that comment.
          if (!existing.memberIds.includes(fromRelayId)) {
            log.warn(`[Group] Dropped group_file from non-member ${fromRelayId} in group ${groupId}`);
            return prev;
          }
          if (existing.messages.some((m) => m.id === fileMsg.id)) return prev;
          updated[idx] = { ...existing, updatedAt: Date.now(), messages: [...existing.messages, fileMsg] };
          return updated;
        });
        return true;
      }

      if (parsed.type === 'group_event' && parsed.groupId) {
        const groupId = parsed.groupId as string;
        const action = parsed.action as string;
        const actorId = parsed.actorId as string;
        const groupName = parsed.groupName as string | undefined;
        const senderId = fromRelayId;
        const currentId = identityRef.current?.relayId;

        if (actorId && senderId && actorId !== senderId) {
          log.warn('[Group] Rejected event with actor/sender mismatch', { groupId, action, actorId, senderId });
          return true;
        }

        if (action === 'member_left' && currentId && parsed.actorId === currentId) {
          return true;
        }

        // key_request doesn't mutate any group state — it just triggers a
        // pairwise reply (key_share) with our current epoch key, so it's
        // handled here rather than inside the setGroups updater below
        // (which must stay free of async side effects). Any current member
        // can serve this, not owner/admin-gated: both requester and
        // responder are already-legitimate co-equal holders of the same
        // shared key by design (see requestMissingGroupKey's doc comment).
        if (action === 'key_request') {
          const currentGroup = groupsRef.current.find((g) => g.id === groupId);
          if (currentGroup && currentId && currentGroup.memberIds.includes(currentId) && actorId && currentGroup.memberIds.includes(actorId)) {
            const activeKey = getActiveGroupKey(groupId);
            if (activeKey) {
              fanoutEncryptedGroupEnvelope(currentGroup, {
                type: 'group_event',
                action: 'key_share',
                groupId,
                actorId: currentId,
                epoch: activeKey.epoch,
                groupKeyHex: activeKey.keyHex,
                timestamp: new Date().toISOString(),
              }, [actorId]).catch((err) => log.warn(`[Group] Failed to respond to key_request for ${groupId}:`, err));
            }
          }
          return true;
        }

        setGroups((prev) => {
          const idx = prev.findIndex((g) => g.id === groupId);
          if (idx === -1) {
            const incomingMembers = Array.isArray(parsed.memberIds)
              ? (parsed.memberIds as string[])
              : [actorId].filter(Boolean);

            const canBootstrap =
              action === 'add_members' &&
              !!currentId &&
              incomingMembers.includes(currentId) &&
              (parsed.ownerId === actorId || (Array.isArray(parsed.adminIds) && parsed.adminIds.includes(actorId)));

            if (!canBootstrap) return prev;

            if (typeof parsed.groupKeyHex === 'string' && typeof parsed.epoch === 'number') {
              setActiveGroupKey(groupId, { epoch: parsed.epoch, keyHex: parsed.groupKeyHex });
            }

            const seed: GroupConversation = {
              id: groupId,
              name: groupName || `Group ${groupId.slice(-4)}`,
              memberIds: incomingMembers,
              ownerId: parsed.ownerId || actorId,
              adminIds: parsed.adminIds || [parsed.ownerId || actorId],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: [],
            };
            return [seed, ...prev];
          }

          const updated = [...prev];
          const existing = updated[idx];

          const actorIsOwner = existing.ownerId === actorId;
          const actorIsAdmin = existing.adminIds.includes(actorId);
          const actorIsMember = existing.memberIds.includes(actorId);

          const hasGovernancePermission =
            action === 'rename' || action === 'add_members' || action === 'remove_member' || action === 'set_disappear' || action === 'rotate_key'
              ? actorIsOwner || actorIsAdmin
              : action === 'set_admin' || action === 'transfer_ownership'
                ? actorIsOwner
                : action === 'member_left'
                  ? actorIsMember
                  : actorIsMember;

          if (!hasGovernancePermission) return prev;

          // ownerId/adminIds/memberIds are NEVER applied wholesale from the
          // untrusted payload — each action mutates only the specific field
          // it legitimately governs. Applying `parsed.ownerId`/`adminIds`
          // unconditionally would let a mere admin (permitted to rename/
          // add/remove members) smuggle an ownership/admin-list takeover
          // inside an otherwise-innocuous event.
          const nextGroup: GroupConversation = {
            ...existing,
            name: action === 'rename' ? groupName || existing.name : existing.name,
            updatedAt: Date.now(),
          };

          if (action === 'add_members') {
            const added = Array.isArray(parsed.addedMemberIds) ? (parsed.addedMemberIds as string[]) : [];
            nextGroup.memberIds = Array.from(new Set([...existing.memberIds, ...added]));
          }

          if (action === 'remove_member' && parsed.removedMemberId) {
            const removedId = parsed.removedMemberId as string;
            // The owner can never be removed via this path — matches the
            // guard the sending-side removeGroupMember() helper enforces;
            // without it a crafted remove_member event could eject the
            // owner from every peer's local view of the group.
            if (removedId !== existing.ownerId) {
              nextGroup.memberIds = existing.memberIds.filter((id) => id !== removedId);
              nextGroup.adminIds = existing.adminIds.filter((id) => id !== removedId);
            }
            // Only present on the copy fanned to REMAINING members (see
            // removeGroupMember's split fan-out) — the removed member's own
            // copy of this same action never carries these fields.
            if (typeof parsed.groupKeyHex === 'string' && typeof parsed.epoch === 'number') {
              setActiveGroupKey(groupId, { epoch: parsed.epoch, keyHex: parsed.groupKeyHex });
            }
          }

          if (action === 'rotate_key' && typeof parsed.groupKeyHex === 'string' && typeof parsed.epoch === 'number') {
            setActiveGroupKey(groupId, { epoch: parsed.epoch, keyHex: parsed.groupKeyHex });
          }

          // A fellow member's direct reply to our key_request (see above) —
          // deliberately NOT owner/admin-gated (falls through to the
          // default actorIsMember check), since any current member already
          // legitimately holds the current key.
          if (action === 'key_share' && typeof parsed.groupKeyHex === 'string' && typeof parsed.epoch === 'number') {
            setActiveGroupKey(groupId, { epoch: parsed.epoch, keyHex: parsed.groupKeyHex });
          }

          if (action === 'member_left') {
            nextGroup.memberIds = existing.memberIds.filter((id) => id !== actorId);
            nextGroup.adminIds = existing.adminIds.filter((id) => id !== actorId);
          }

          if (action === 'set_admin' && parsed.targetMemberId) {
            const targetId = parsed.targetMemberId as string;
            const shouldBeAdmin = !!parsed.isAdmin;
            nextGroup.adminIds = shouldBeAdmin
              ? Array.from(new Set([...existing.adminIds, targetId]))
              : existing.adminIds.filter((id) => id !== targetId);
          }

          if (action === 'transfer_ownership' && parsed.newOwnerId) {
            const newOwnerId = parsed.newOwnerId as string;
            nextGroup.ownerId = newOwnerId;
            nextGroup.adminIds = Array.from(new Set([...existing.adminIds, newOwnerId]));
          }

          if (action === 'set_disappear') {
            const seconds = parsed.disappearAfter;
            // Bound + type-check attacker-controlled input rather than trusting
            // it outright — a huge or non-numeric value would otherwise sit in
            // every member's local group state and feed straight into a
            // Date.now() + seconds*1000 expiry computation at send time.
            nextGroup.disappearAfter =
              typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds <= 30 * 86400
                ? seconds
                : undefined;
          }

          const eventText =
            action === 'rename'
              ? `Group renamed to "${groupName || existing.name}"`
              : action === 'add_members'
                ? 'Members added to group'
                : action === 'remove_member'
                  ? 'A member was removed from group'
                  : action === 'member_left'
                    ? 'A member left the group'
                    : action === 'set_admin'
                      ? parsed.isAdmin
                        ? `Member ${(parsed.targetMemberId as string | undefined)?.slice(0, 10) || ''} promoted to admin`
                        : `Admin ${(parsed.targetMemberId as string | undefined)?.slice(0, 10) || ''} demoted to member`
                      : action === 'transfer_ownership'
                        ? `Ownership transferred to ${(parsed.newOwnerId as string | undefined)?.slice(0, 10) || ''}`
                        : action === 'set_disappear'
                          ? nextGroup.disappearAfter
                            ? `Disappearing messages set to ${formatGhostLabel(nextGroup.disappearAfter)}`
                            : 'Disappearing messages turned off'
                          : 'Group updated';

          const eventMsg: MessageWithStatus = {
            id: `gsys_evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            senderId: actorId || 'system',
            senderName: 'System',
            text: eventText,
            timestamp: new Date(),
            isOwn: false,
            read: true,
            delivered: true,
            status: 'sent',
            messageType: 'system',
            reactions: [],
            metadata: {
              compression_ratio: 1,
              original_size: eventText.length,
              compressed_size: eventText.length,
              encrypted_size: eventText.length,
              latency_ms: 0,
              neural_model_score: 1,
            },
          };

          // rotate_key/key_share are purely infrastructural (key rotation/
          // resend plumbing, not a user-facing governance action) — no
          // visible system message, unlike every other action here.
          if (action !== 'rotate_key' && action !== 'key_share') {
            nextGroup.messages = [...nextGroup.messages, eventMsg];
          }
          updated[idx] = nextGroup;
          return updated;
        });
        return true;
      }

      return false;
    },
    [contacts, identityRef, setGroups, groupsRef, fanoutEncryptedGroupEnvelope, requestMissingGroupKey]
  );

  return {
    loadGroupsFromStorage,
    createGroup,
    sendGroupMessage,
    sendGroupFile,
    renameGroup,
    setGroupDisappearing,
    addGroupMembers,
    removeGroupMember,
    setGroupAdmin,
    transferGroupOwnership,
    leaveGroup,
    handleGroupMessage,
  };
}
