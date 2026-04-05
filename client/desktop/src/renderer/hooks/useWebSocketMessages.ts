/**
 * useWebSocketMessages - All WebSocket message handler subscriptions.
 *
 * Extracted from useWebSocket to isolate message routing from connection management.
 * Registers all `wsService.on(...)` handlers in a single useEffect and cleans up on unmount.
 */

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
import type { MessageWithStatus } from '../types/chat';
import { useChannelStore } from '../stores/channelStore';
import { useServerStore } from '../stores/serverStore';
import { useMemberStore, PresenceStatus } from '../stores/memberStore';
import { useUserStore } from '../stores/userStore';
import { useUnreadStore } from '../stores/unreadStore';
import { getWebSocketService, type WebSocketMessage } from '../services/websocketService';
import { e2eeService } from '../services/e2eeService';
import { preferencesSyncService } from '../services/preferencesSync';
import { apiFetch } from '../services/apiClient';
import { useVoiceStore } from '../stores/voiceStore';
import { useConnectionStore } from '../stores/connectionStore';
import { useDMStore } from '../stores/dmStore';
import { useFriendStore } from '../stores/friendStore';
import { speak as ttsSpeak } from '../services/ttsService';
import { notificationSoundService } from '../services/notificationSoundService';
import { indexMessage } from '../services/searchService';
import {
  desktopNotificationService,
  type NotificationType,
} from '../services/desktopNotificationService';

// Debounce timers for re-fetching voice participants after join/leave events.
// Coalesces rapid bursts (e.g. 10 users joining) into a single API call.
const voiceRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** TTS helper: speak message if it's in a voice-linked text channel and not from self */
function speakIfVoiceLinked(text: string, channelId: string, senderId: string, senderName: string) {
  const selfId = useUserStore.getState().user?.id;
  if (senderId === selfId) return;
  const ch = useChannelStore.getState().channels.find((c) => c.id === channelId);
  if (!ch?.linked_voice_channel_id) return;
  const voiceActiveId = useVoiceStore.getState().activeChannelId;
  if (voiceActiveId !== ch.linked_voice_channel_id) return;
  ttsSpeak(text, senderName);
}

// ── Extracted handlers to reduce cognitive complexity ─────────────────────

/** Lookup table for voice participant state updates (avoids nested switch). */
const VOICE_PARTICIPANT_UPDATES: Record<string, Record<string, boolean>> = {
  muted: { isMuted: true },
  unmuted: { isMuted: false },
  video_on: { isVideoOn: true },
  video_off: { isVideoOn: false },
  screen_on: { isScreenSharing: true },
  screen_off: { isScreenSharing: false },
  server_muted: { serverMuted: true },
  server_unmuted: { serverMuted: false },
  server_deafened: { serverDeafened: true, serverMuted: true },
  server_undeafened: { serverDeafened: false, serverMuted: false },
};

/** Returns true if a voice-linked text channel notification should be suppressed. */
function shouldSuppressLinkedTextNotification(channelId: string): boolean {
  const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
  if (!channel?.linked_voice_channel_id) return false;
  return useVoiceStore.getState().activeChannelId !== channel.linked_voice_channel_id;
}

/** Mark a server and optionally its mention state as having unreads. */
function markServerUnreadWithMention(serverId: string, isMentioned: boolean): void {
  const unreadStore = useUnreadStore.getState();
  unreadStore.markServerUnread(serverId);
  if (isMentioned) unreadStore.markServerMention(serverId);
}

/** Handle unread notification from server subscription. */
function handleUnreadNotify(msg: WebSocketMessage): void {
  const { data } = msg;
  const channelId = data.channel_id;
  const serverId = data.server_id;

  if (channelId && shouldSuppressLinkedTextNotification(channelId)) return;

  const isMentioned = data.mentioned === true;
  const activeServerId = useServerStore.getState().activeServerId;

  if (serverId && serverId !== activeServerId) {
    markServerUnreadWithMention(serverId, isMentioned);
    return;
  }

  if (!channelId) return;
  const activeChannelId = useChannelStore.getState().activeChannelId;
  if (channelId === activeChannelId) return;

  useUnreadStore.getState().incrementUnread(channelId);
  if (isMentioned) useUnreadStore.getState().incrementMention(channelId);
  if (serverId) markServerUnreadWithMention(serverId, isMentioned);

  // Notification sound for unfocused-channel messages
  if (isMentioned) {
    notificationSoundService.play('mention');
  } else {
    notificationSoundService.play('message');
  }
}

/** Handle voice state updates — sidebar members + active participants. */
function handleVoiceStateUpdate(msg: WebSocketMessage): void {
  const { data } = msg;
  const channelId = data.channel_id as string | undefined;
  const action = data.action as string | undefined;
  const userId = data.user_id as string | undefined;
  const serverId = data.server_id as string | undefined;
  if (!channelId || !action) return;

  const voiceStore = useVoiceStore.getState();

  // Update channel voice members (sidebar display)
  const localUserId = useUserStore.getState().user?.id;
  const isLocalUserInChannel = voiceStore.activeChannelId === channelId;

  if (action === 'joined' && userId) {
    voiceStore.addChannelVoiceMember(channelId, {
      userId,
      username: (data.username as string) || 'Unknown',
      displayName: data.display_name as string | undefined,
      isMuted: false,
      serverMuted: false,
      serverDeafened: false,
    });
    if (serverId) voiceStore.incrementServerVoiceCount(serverId);
    if (isLocalUserInChannel && userId !== localUserId) {
      notificationSoundService.play('user-join');
    }
  } else if (action === 'left' && userId) {
    voiceStore.removeChannelVoiceMember(channelId, userId);
    if (serverId) voiceStore.decrementServerVoiceCount(serverId);
    if (isLocalUserInChannel && userId !== localUserId) {
      notificationSoundService.play('user-leave');
    }
  } else if (action === 'room_empty') {
    voiceStore.setChannelVoiceMembers(channelId, []);
  }

  // Debounced re-fetch for authoritative state
  if (action === 'joined' || action === 'left') {
    scheduleVoiceRefetch(channelId, voiceStore);
  }

  // Update detailed participants for the active channel
  if (voiceStore.activeChannelId === channelId && userId) {
    const update = VOICE_PARTICIPANT_UPDATES[action];
    if (update) voiceStore.updateParticipant(userId, update);
  }

  // Update sidebar voice members for enforcement changes
  if (
    ['server_muted', 'server_unmuted', 'server_deafened', 'server_undeafened'].includes(action) &&
    userId
  ) {
    const update = VOICE_PARTICIPANT_UPDATES[action];
    if (update) {
      voiceStore.updateChannelVoiceMember(channelId, userId, update);
    }

    // Toast notification when local user is targeted
    if (userId === localUserId) {
      const messages: Record<string, string> = {
        server_muted: 'You have been server-muted by a moderator',
        server_unmuted: 'A moderator has removed your server mute',
        server_deafened: 'You have been server-deafened by a moderator',
        server_undeafened: 'A moderator has removed your server deafen',
      };
      if (messages[action]) {
        console.debug('[Voice]', messages[action]);
      }
    }
  }
}

/** Schedule a debounced re-fetch of voice participants for a channel. */
function scheduleVoiceRefetch(
  channelId: string,
  voiceStore: ReturnType<typeof useVoiceStore.getState>
): void {
  const existing = voiceRefetchTimers.get(channelId);
  if (existing) clearTimeout(existing);
  voiceRefetchTimers.set(
    channelId,
    setTimeout(async () => {
      voiceRefetchTimers.delete(channelId);
      try {
        const res = await apiFetch(`/api/v1/channels/${channelId}/voice/participants`);
        if (!res.ok) return;
        const json = await res.json();
        const members = (json.participants || []).map(
          (p: {
            user_id: string;
            username: string;
            display_name?: string;
            avatar_url?: string;
            is_muted?: boolean;
            server_muted?: boolean;
            server_deafened?: boolean;
          }) => ({
            userId: p.user_id,
            username: p.username,
            displayName: p.display_name,
            avatarUrl: p.avatar_url,
            isMuted: p.is_muted || false,
            serverMuted: p.server_muted || false,
            serverDeafened: p.server_deafened || false,
          })
        );
        voiceStore.setChannelVoiceMembers(channelId, members);
      } catch {
        /* non-critical */
      }
    }, 2000)
  );
}

/** Decrypt and add a message, handling E2EE with version-aware decryption. */
// Encryption flag determines decrypt path; splitting would duplicate the 30-line message pipeline
function addPlaintextMessage(
  channelId: string,
  baseMessage: Omit<MessageWithStatus, 'content'>,
  content: string,
  addMessage: (channelId: string, msg: MessageWithStatus) => void,
  onPlaintext?: (text: string) => void
): void {
  addMessage(channelId, { ...baseMessage, content });
  // Passively index plaintext for search
  indexMessage(baseMessage.id, content, channelId);
  onPlaintext?.(content);
}

function addEncryptedMessage(
  channelId: string,
  baseMessage: Omit<MessageWithStatus, 'content'>,
  ciphertext: string,
  keyVersion: number | undefined,
  addMessage: (channelId: string, msg: MessageWithStatus) => void,
  onPlaintext?: (text: string) => void
): void {
  if (!e2eeService.isInitialized) {
    addMessage(channelId, { ...baseMessage, content: '', decryptFailed: true });
    return;
  }

  const decryptPromise =
    keyVersion && keyVersion > 1
      ? e2eeService.decryptForChannelWithVersion(channelId, ciphertext, keyVersion)
      : e2eeService.decryptForChannel(channelId, ciphertext);

  decryptPromise
    .then((plaintext) => {
      addMessage(channelId, { ...baseMessage, content: plaintext });
      // Passively index decrypted content for search
      indexMessage(baseMessage.id, plaintext, channelId);
      onPlaintext?.(plaintext);
    })
    .catch((err) => {
      const isPending = err instanceof Error && err.message === 'PENDING_KEY';
      addMessage(channelId, {
        ...baseMessage,
        content: '',
        decryptFailed: !isPending,
        pendingKeys: isPending,
      });
    });
}

export function useWebSocketMessages(wsService: ReturnType<typeof getWebSocketService>) {
  const {
    addMessage,
    updateMessage,
    updateMessageStatus,
    updateUserInMessages,
    deleteMessage,
    setTyping,
  } = useChatStore();

  useEffect(() => {
    // Message handler
    const unsubMessage = wsService.on('message', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;

      if (!channelId) {
        console.error('Message missing channel_id:', msg);
        return;
      }

      const isEncrypted = data.is_encrypted || false;
      const keyVersion = data.key_version as number | undefined;
      const baseMessage = {
        id: data.id || crypto.randomUUID(),
        channel_id: channelId,
        user_id: data.user_id,
        username: data.username || 'Unknown',
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
        is_encrypted: isEncrypted,
        key_version: keyVersion,
        reply_to_id: data.reply_to_id || undefined,
        replied_to: data.replied_to || undefined,
        attachments: data.attachments || undefined,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };

      const maybeSpeakTTS = (text: string) =>
        speakIfVoiceLinked(text, channelId, data.user_id, data.display_name || data.username);

      if (isEncrypted) {
        addEncryptedMessage(
          channelId,
          baseMessage,
          data.content,
          keyVersion,
          addMessage,
          maybeSpeakTTS
        );
      } else {
        addPlaintextMessage(channelId, baseMessage, data.content, addMessage, maybeSpeakTTS);
      }

      // Decrypt replied_to content if the original message was encrypted
      const rt = baseMessage.replied_to;
      if (rt?.is_encrypted && rt.content && e2eeService.isInitialized) {
        const rtKv = rt.key_version;
        const decryptFn =
          rtKv && rtKv > 1
            ? e2eeService.decryptForChannelWithVersion(channelId, rt.content, rtKv)
            : e2eeService.decryptForChannel(channelId, rt.content);
        decryptFn
          .then((plaintext) => {
            updateMessage(channelId, baseMessage.id, {
              replied_to: { ...rt, content: plaintext },
            });
          })
          .catch(() => {
            // Leave ciphertext — ReplyPreviewBar will show it as-is
          });
      }

      // NOTE: Unread tracking is handled exclusively by the 'unread_notify' handler
      // (server-level subscription). The 'message' event only arrives for the active
      // channel the user is subscribed to, so no unread increment is needed here.

      // Notification sound for focused-channel messages (from other users)
      const selfId = useUserStore.getState().user?.id;
      if (data.user_id !== selfId) {
        notificationSoundService.play('message', { focused: true });

        // Desktop notification for channel messages (#175)
        const isMentioned = data.mentioned === true;
        const notifType: NotificationType = isMentioned ? 'mention' : 'message';
        const activeChannelId = useChannelStore.getState().activeChannelId;

        if (
          desktopNotificationService.shouldNotify({
            type: notifType,
            isWindowFocused: document.hasFocus(),
            isActiveChannel: channelId === activeChannelId,
          })
        ) {
          const channelName = useChannelStore
            .getState()
            .channels.find((c) => c.id === channelId)?.name;
          desktopNotificationService.notify({
            title: `${data.username || 'Unknown'} in #${channelName || 'channel'}`,
            body: data.content || '',
            isEncrypted: data.is_encrypted,
            targetType: 'channel',
            targetId: channelId,
            serverId: data.server_id,
            senderId: data.user_id,
          });
          desktopNotificationService.incrementBadge();
        }
      }
    });

    // Message update handler
    const unsubUpdate = wsService.on('message_update', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const messageId = data.id;

      if (!channelId || !messageId) {
        console.error('Message update missing channel_id or id:', msg);
        return;
      }

      updateMessage(channelId, messageId, {
        content: data.content,
        edited_at: data.edited_at,
        updated_at: data.updated_at || new Date().toISOString(),
      });
    });

    // Message delete handler
    const unsubDelete = wsService.on('message_delete', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const messageId = data.id;

      if (!channelId || !messageId) {
        console.error('Message delete missing channel_id or id:', msg);
        return;
      }

      deleteMessage(channelId, messageId);
    });

    // Reaction event handler (shared logic for added/removed)
    const applyReactionUpdate = (
      channelId: string,
      messageId: string,
      emoji: string,
      summary: {
        emoji: string;
        count: number;
        users: Array<{ user_id: string; username: string; display_name?: string }>;
        me: boolean;
      } | null
    ) => {
      const messages = useChatStore.getState().messagesByChannel.get(channelId);
      const message = messages?.find((m) => m.id === messageId);
      if (!message) return;

      const currentReactions = message.reactions || [];
      const selfId = useUserStore.getState().user?.id;
      let updatedReactions;

      if (summary && summary.count > 0) {
        const idx = currentReactions.findIndex((r) => r.emoji === emoji);
        updatedReactions = [...currentReactions];
        const withMe = { ...summary, me: summary.users.some((u) => u.user_id === selfId) };
        if (idx >= 0) {
          updatedReactions[idx] = withMe;
        } else {
          updatedReactions.push(withMe);
        }
      } else {
        updatedReactions = currentReactions.filter((r) => r.emoji !== emoji);
      }

      updateMessage(channelId, messageId, { reactions: updatedReactions });
    };

    const unsubReactionAdded = wsService.on('message_reaction_added', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (!data.channel_id || !data.message_id) return;
      applyReactionUpdate(data.channel_id, data.message_id, data.emoji, data.reaction_summary);
    });

    const unsubReactionRemoved = wsService.on(
      'message_reaction_removed',
      (msg: WebSocketMessage) => {
        const { data } = msg;
        if (!data.channel_id || !data.message_id) return;
        applyReactionUpdate(data.channel_id, data.message_id, data.emoji, data.reaction_summary);
      }
    );

    // Pin event handlers
    const unsubMessagePinned = wsService.on('message_pinned', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (!data.channel_id || !data.message_id) return;
      updateMessage(data.channel_id, data.message_id, {
        pinned_at: data.pinned_at,
        pinned_by: data.pinned_by,
      });
    });

    const unsubMessageUnpinned = wsService.on('message_unpinned', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (!data.channel_id || !data.message_id) return;
      updateMessage(data.channel_id, data.message_id, {
        pinned_at: undefined,
        pinned_by: undefined,
      });
    });

    // Typing indicator handler
    const unsubTyping = wsService.on('typing', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const userId = data.user_id;
      const isTyping = data.is_typing;
      const username = data.username;

      if (!channelId || !userId) {
        console.error('Typing indicator missing channel_id or user_id:', msg);
        return;
      }

      setTyping(channelId, userId, isTyping, username);
    });

    // Message acknowledgment handler — maps temp client IDs to server UUIDs
    const unsubAck = wsService.on('message_ack', (msg: WebSocketMessage) => {
      const { data } = msg;
      const nonce = data.nonce;
      const serverId = data.id;
      const channelId = data.channel_id;

      if (nonce && serverId && channelId) {
        updateMessageStatus(channelId, nonce, 'delivered', serverId);
      }
    });

    // Member joined handler — updates member list in real time
    const unsubMemberJoined = wsService.on('member_joined', (msg: WebSocketMessage) => {
      const { data } = msg;
      const activeServerId = useServerStore.getState().activeServerId;

      // Only update if the event is for the currently viewed server
      if (data.server_id && data.server_id === activeServerId) {
        useMemberStore.getState().addMember({
          user_id: data.user_id,
          username: data.username || 'Unknown',
          display_name: data.display_name || undefined,
          avatar_url: data.avatar_url || undefined,
          role: data.role || 'member',
          joined_at: new Date().toISOString(),
          roles: [],
        });
      }
    });

    // Profile updated handler — updates messages and member list
    const unsubProfileUpdated = wsService.on('profile_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const userId = data.user_id;

      if (!userId) return;

      // Update all messages from this user across all channels
      updateUserInMessages(userId, {
        username: data.username,
        display_name: data.display_name,
        avatar_url: data.avatar_url,
      });

      // Update member list if applicable
      useMemberStore.getState().updateMemberProfile(userId, {
        username: data.username,
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
        header_image_url: data.header_image_url || undefined,
        color_scheme: data.color_scheme || undefined,
      });

      // Update DM participant profiles
      useDMStore.getState().updateParticipantProfile(userId, {
        username: data.username,
        displayName: data.display_name || undefined,
        avatarUrl: data.avatar_url || undefined,
        colorScheme: data.color_scheme || undefined,
      });

      // Update friend profiles
      useFriendStore.getState().updateFriendProfile(userId, {
        username: data.username,
        displayName: data.display_name || undefined,
        avatarUrl: data.avatar_url || undefined,
        colorScheme: data.color_scheme || undefined,
      });

      // Update voice participant (active call tiles)
      const voiceState = useVoiceStore.getState();
      if (voiceState.participants[userId]) {
        voiceState.updateParticipant(userId, {
          username: data.username,
          displayName: data.display_name || undefined,
          avatarUrl: data.avatar_url || undefined,
        });
      }

      // Update channel voice members (sidebar)
      for (const [channelId, members] of Object.entries(voiceState.channelVoiceMembers)) {
        const idx = members.findIndex((m) => m.userId === userId);
        if (idx !== -1) {
          const updated = [...members];
          updated[idx] = {
            ...updated[idx],
            username: data.username,
            displayName: data.display_name || undefined,
            avatarUrl: data.avatar_url || undefined,
          };
          voiceState.setChannelVoiceMembers(channelId, updated);
        }
      }

      // Update available screen shares
      if (voiceState.availableScreenShares.some((s) => s.userId === userId)) {
        useVoiceStore.setState({
          availableScreenShares: voiceState.availableScreenShares.map((s) =>
            s.userId === userId
              ? { ...s, username: data.username, displayName: data.display_name || undefined }
              : s
          ),
        });
      }
    });

    // Server updated handler — updates server list for all members
    const unsubServerUpdated = wsService.on('server_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      if (!serverId) return;

      useServerStore.getState().updateServer(serverId, {
        name: data.name,
        icon_url: data.icon_url ?? null,
        banner_url: data.banner_url ?? null,
        allow_embedded_content: data.allow_embedded_content ?? false,
      });
    });

    // Channel updated handler — updates channel list for all server members
    const unsubChannelUpdated = wsService.on('channel_updated', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      if (!channelId) return;

      useChannelStore.getState().updateChannel(channelId, {
        name: data.name,
        type: data.type,
        emoji: data.emoji ?? null,
        group_id: data.group_id ?? null,
      });
    });

    // Channel created handler — adds new channel to the list for all server members
    const unsubChannelCreated = wsService.on('channel_created', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channel = data.channel;
      if (!channel) return;

      const activeServerId = useServerStore.getState().activeServerId;
      if (channel.server_id === activeServerId) {
        useChannelStore.getState().addChannel(channel);
      }
    });

    // Channel deleted handler — removes channel and cascades cleanup
    const unsubChannelDeleted = wsService.on('channel_deleted', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      if (!channelId) return;

      useChannelStore.getState().removeChannel(channelId);
    });

    // Channel group created handler
    const unsubGroupCreated = wsService.on('channel_group_created', (msg: WebSocketMessage) => {
      const group = msg.data.channel_group;
      if (!group) return;
      const activeServerId = useServerStore.getState().activeServerId;
      if (group.server_id === activeServerId) {
        useChannelStore.getState().addChannelGroup(group);
      }
    });

    // Channel group updated handler
    const unsubGroupUpdated = wsService.on('channel_group_updated', (msg: WebSocketMessage) => {
      const group = msg.data.channel_group;
      if (!group) return;
      useChannelStore.getState().updateChannelGroup(group.id, {
        name: group.name,
        position: group.position,
        updated_at: group.updated_at,
      });
    });

    // Channel group deleted handler
    const unsubGroupDeleted = wsService.on('channel_group_deleted', (msg: WebSocketMessage) => {
      const groupId = msg.data.group_id;
      if (!groupId) return;
      useChannelStore.getState().removeChannelGroup(groupId);
    });

    // Channels reordered handler — bulk position/group update
    const unsubChannelsReordered = wsService.on('channels_reordered', (msg: WebSocketMessage) => {
      const channels = msg.data.channels;
      if (!Array.isArray(channels)) return;
      useChannelStore.getState().reorderChannels(
        channels.map((c: { channel_id: string; group_id: string | null; position: number }) => ({
          channel_id: c.channel_id,
          group_id: c.group_id,
          position: c.position,
        }))
      );
    });

    // Server deleted handler — removes server and cascades cleanup
    const unsubServerDeleted = wsService.on('server_deleted', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      if (!serverId) return;

      useServerStore.getState().removeServer(serverId);
    });

    // Member removed handler — handles both kicks and self-leave
    const unsubMemberRemoved = wsService.on('member_removed', (msg: WebSocketMessage) => {
      const { data } = msg;
      const serverId = data.server_id;
      const removedUserId = data.user_id;
      if (!serverId || !removedUserId) return;

      const selfId = useUserStore.getState().user?.id;
      if (removedUserId === selfId) {
        // Current user was removed/left — purge server data entirely
        useServerStore.getState().removeServer(serverId);
      } else {
        // Another member was removed — update the member list
        const activeServerId = useServerStore.getState().activeServerId;
        if (serverId === activeServerId) {
          useMemberStore.getState().removeMember(removedUserId);
        }
      }
    });

    // Lightweight unread notification handler — from server subscription
    const unsubUnreadNotify = wsService.on('unread_notify', (msg: WebSocketMessage) => {
      handleUnreadNotify(msg);
    });

    // Key needed handler — auto-process pending key requests for new members
    const unsubKeyNeeded = wsService.on('key_needed', (msg: WebSocketMessage) => {
      console.debug('[WebSocket] key_needed event received:', msg.data);
      if (e2eeService.isInitialized) {
        e2eeService.processPendingKeyRequests().catch((err) => {
          console.debug('[WebSocket] processPendingKeyRequests failed:', err);
        });
      } else {
        console.debug('[WebSocket] key_needed ignored — E2EE not initialized');
      }
    });

    // Key revocation handler — a channel's key epoch was revoked (member removal or theft)
    const unsubKeyRevocation = wsService.on('key_revocation', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const newEpoch = data.new_epoch;

      if (!channelId) return;
      console.debug(
        '[WebSocket] key_revocation:',
        channelId,
        'new_epoch:',
        newEpoch,
        'reason:',
        data.reason
      );

      // Invalidate cached key for this channel
      e2eeService.invalidateChannelKey(channelId);

      // Dispatch event for rotation coordinator
      globalThis.dispatchEvent(
        new CustomEvent('e2ee-key-rotation', {
          detail: { channelId, newEpoch, removedUserId: data.removed_user_id, reason: data.reason },
        })
      );
    });

    // Key delivered handler — a channel key was distributed to the current user
    const unsubKeyDelivered = wsService.on('key_delivered', (msg: WebSocketMessage) => {
      const { data } = msg;
      const channelId = data.channel_id;
      const targetUserId = data.user_id;
      if (!channelId) return;

      // Only act if this key delivery is for the current user
      const selfId = useUserStore.getState().user?.id;
      if (targetUserId !== selfId) return;

      // Invalidate the cached key so it gets re-fetched
      e2eeService.invalidateChannelKey(channelId);

      // Dispatch event so ChatView can re-fetch and decrypt messages
      globalThis.dispatchEvent(new CustomEvent('e2ee-key-delivered', { detail: { channelId } }));
    });

    // Preferences updated handler — another device pushed new preferences
    const unsubPreferencesUpdated = wsService.on('preferences_updated', () => {
      preferencesSyncService.fetchAndApply();
    });

    // Presence snapshot handler — received on connection with all online users and their statuses
    const unsubPresenceSnapshot = wsService.on('presence_snapshot', (msg: WebSocketMessage) => {
      // Enhanced format: array of { user_id, status } objects
      if (msg.data.users && Array.isArray(msg.data.users)) {
        const users = msg.data.users as Array<{ user_id: string; status: string }>;
        useMemberStore.getState().setPresenceSnapshot(users);

        // Also update DM participant and friend presence
        const dmState = useDMStore.getState();
        const friendState = useFriendStore.getState();
        for (const u of users) {
          dmState.updateParticipantProfile(u.user_id, { status: u.status });
          friendState.updateFriendPresence(u.user_id, u.status as PresenceStatus);
        }
      } else if (msg.data.online_user_ids) {
        // Backward compatibility: simple list of online user IDs
        const userIds = msg.data.online_user_ids as string[];
        useMemberStore.getState().setOnlineUsers(userIds);

        const dmState2 = useDMStore.getState();
        const friendState2 = useFriendStore.getState();
        for (const id of userIds) {
          dmState2.updateParticipantProfile(id, { status: 'online' });
          friendState2.updateFriendPresence(id, 'online');
        }
      }
    });

    // Presence change handler — individual status updates (online/offline/dnd/invisible)
    const unsubPresence = wsService.on('presence', (msg: WebSocketMessage) => {
      const userId = msg.data.user_id as string;
      const status = msg.data.status as PresenceStatus;
      const timestamp = msg.data.timestamp as number | undefined;
      if (!userId) return;

      // Skip overriding self user's status from broadcast — selfStatus is the local source of truth.
      // The server broadcasts "offline" for invisible users, so trusting the broadcast
      // would incorrectly show the self user as offline when they chose invisible.
      const selfId = useUserStore.getState().user?.id;
      if (userId === selfId) return;

      useMemberStore.getState().setUserStatus(userId, status);

      if (status === 'offline' && timestamp) {
        useMemberStore.getState().setUserLastSeen(userId, timestamp);
      }

      // Also update DM participant and friend presence
      useDMStore.getState().updateParticipantProfile(userId, { status });
      useFriendStore.getState().updateFriendPresence(userId, status);
    });

    // Server online counts handler — updates online_count on server objects after presence changes
    const unsubServerOnlineCounts = wsService.on(
      'server_online_counts',
      (msg: WebSocketMessage) => {
        const counts = msg.data.counts as Record<string, number> | undefined;
        if (counts) {
          useServerStore.getState().updateOnlineCounts(counts);
        }
      }
    );

    // Server voice counts handler — updates voice counts for tooltip display
    const unsubServerVoiceCounts = wsService.on('server_voice_counts', (msg: WebSocketMessage) => {
      const counts = msg.data.counts as Record<string, number> | undefined;
      if (counts) {
        useVoiceStore.getState().setServerVoiceCounts(counts);
      }
    });

    // Voice state update handler — from control plane via NATS
    const unsubVoiceState = wsService.on('voice_state_update', (msg: WebSocketMessage) => {
      handleVoiceStateUpdate(msg);
    });

    // ── DM event handlers ──────────────────────────────────────────────

    // DM message handler (mirrors 'message' handler for server channels)
    const unsubDMMessage = wsService.on('dm_message', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id || data.channel_id;

      if (!conversationId) {
        console.error('DM message missing conversation_id:', msg);
        return;
      }

      const isEncrypted = data.is_encrypted || false;
      const dmKeyVersion = data.key_version as number | undefined;
      const baseMessage = {
        id: data.id || crypto.randomUUID(),
        channel_id: conversationId,
        user_id: data.user_id,
        username: data.username || 'Unknown',
        display_name: data.display_name || undefined,
        avatar_url: data.avatar_url || undefined,
        is_encrypted: isEncrypted,
        key_version: dmKeyVersion,
        attachments: data.attachments || undefined,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };

      // Update conversation list preview (keeps thread list in sync)
      const lastMessagePreview = {
        content: data.content || '',
        userId: data.user_id,
        username: data.username || 'Unknown',
        createdAt: data.created_at || new Date().toISOString(),
        isEncrypted,
        ...(data.attachments?.length
          ? { attachmentType: data.attachments[0].file_type as string }
          : {}),
      };

      if (isEncrypted) {
        addEncryptedMessage(conversationId, baseMessage, data.content, dmKeyVersion, addMessage);
      } else {
        addPlaintextMessage(conversationId, baseMessage, data.content, addMessage);
      }

      useDMStore.getState().updateLastMessage(conversationId, lastMessagePreview);

      // Notification sound for DM messages (from other users)
      if (data.user_id !== useUserStore.getState().user?.id) {
        notificationSoundService.play('dm', { focused: true });

        // Desktop notification for DM messages (#175)
        if (
          desktopNotificationService.shouldNotify({
            type: 'dm',
            isWindowFocused: document.hasFocus(),
            isActiveChannel: conversationId === useDMStore.getState().activeConversationId,
          })
        ) {
          desktopNotificationService.notify({
            title: `DM from ${data.display_name || data.username || 'Unknown'}`,
            body: data.content || '',
            isEncrypted: data.is_encrypted || false,
            targetType: 'dm',
            targetId: conversationId,
            senderId: data.user_id,
          });
          desktopNotificationService.incrementBadge();
        }
      }
    });

    // DM message ack handler
    const unsubDMAck = wsService.on('dm_message_ack', (msg: WebSocketMessage) => {
      const { data } = msg;
      const nonce = data.nonce;
      const serverId = data.id;
      const conversationId = data.conversation_id || data.channel_id;

      if (nonce && serverId && conversationId) {
        updateMessageStatus(conversationId, nonce, 'delivered', serverId);
      }
    });

    // DM message update handler
    const unsubDMUpdate = wsService.on('dm_message_update', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id || data.channel_id;
      const messageId = data.id;

      if (conversationId && messageId) {
        updateMessage(conversationId, messageId, {
          content: data.content,
          edited_at: data.edited_at,
          updated_at: data.updated_at || new Date().toISOString(),
        });
      }
    });

    // DM message delete handler
    const unsubDMDelete = wsService.on('dm_message_delete', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id || data.channel_id;
      const messageId = data.id;

      if (conversationId && messageId) {
        deleteMessage(conversationId, messageId);
      }
    });

    // DM typing indicator handler
    const unsubDMTyping = wsService.on('dm_typing', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id || data.channel_id;
      const userId = data.user_id;
      const isTyping = data.is_typing;
      const username = data.username;

      if (conversationId && userId) {
        setTyping(conversationId, userId, isTyping, username);
      }
    });

    // DM unread notification (for conversations the user is NOT subscribed to)
    const unsubDMUnread = wsService.on('dm_unread_notify', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id;
      const isDMMentioned = data.mentioned === true;

      if (conversationId) {
        useDMStore.getState().incrementUnread(conversationId);
        if (isDMMentioned) {
          useUnreadStore.getState().incrementMention(conversationId);
        }
        // Also update last message preview if provided
        if (data.last_message) {
          useDMStore.getState().updateLastMessage(conversationId, {
            content: data.last_message.content || '',
            userId: data.last_message.user_id || data.user_id,
            username: data.last_message.username || '',
            createdAt: data.last_message.created_at || new Date().toISOString(),
            isEncrypted: data.last_message.is_encrypted || false,
          });
        }

        // Notification sound for unfocused DM messages
        notificationSoundService.play('dm');
      }
    });

    // DM conversation created (when another user opens a DM with us)
    const unsubDMConvCreated = wsService.on('dm_conversation_created', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (data.conversation) {
        useDMStore.getState().addConversation({
          id: data.conversation.id,
          isGroup: data.conversation.is_group,
          isPersonal: data.conversation.is_personal ?? false,
          name: data.conversation.name || null,
          isEncrypted: data.conversation.is_encrypted,
          participants: (data.conversation.participants || []).map(
            (p: Record<string, unknown>) => ({
              userId: p.user_id as string,
              username: p.username as string,
              displayName: p.display_name as string | undefined,
              avatarUrl: p.avatar_url as string | undefined,
              colorScheme: p.color_scheme as string | undefined,
              role: p.role as string | undefined,
            })
          ),
          iconUrl: (data.conversation.icon_url as string) || undefined,
          createdBy: (data.conversation.created_by as string) || undefined,
          lastMessage: null,
          unreadCount: 0,
          createdAt: data.conversation.created_at,
        });
      }
    });

    // DM participant added to group
    const unsubDMParticipantAdded = wsService.on(
      'dm_participant_added',
      (msg: WebSocketMessage) => {
        const { data } = msg;
        const conversationId = data.conversation_id;
        if (!conversationId) return;
        // Refetch the full conversation to get updated participant list
        useDMStore.getState().fetchConversations();
      }
    );

    // DM participant removed from group
    const unsubDMParticipantRemoved = wsService.on(
      'dm_participant_removed',
      (msg: WebSocketMessage) => {
        const { data } = msg;
        const conversationId = data.conversation_id;
        const removedUserId = data.user_id;
        if (!conversationId || !removedUserId) return;

        // Check if we were the one removed
        const currentUser = useUserStore.getState().user;
        if (currentUser && removedUserId === currentUser.id) {
          useDMStore.getState().removeConversation(conversationId);
          return;
        }

        // Remove participant from conversation locally
        const dmStore = useDMStore.getState();
        const conv = dmStore.conversations.find((c) => c.id === conversationId);
        if (conv) {
          dmStore.updateConversation(conversationId, {
            participants: conv.participants.filter((p) => p.userId !== removedUserId),
          });
        }
      }
    );

    // DM member role changed
    const unsubDMRoleChanged = wsService.on('dm_role_changed', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id;
      const userId = data.user_id;
      const role = data.role;
      if (!conversationId || !userId || !role) return;

      const dmStore = useDMStore.getState();
      const conv = dmStore.conversations.find((c) => c.id === conversationId);
      if (conv) {
        dmStore.updateConversation(conversationId, {
          participants: conv.participants.map((p) =>
            p.userId === userId ? { ...p, role: role as 'admin' | 'member' } : p
          ),
        });
      }
    });

    // DM group deleted
    const unsubDMGroupDeleted = wsService.on('dm_group_deleted', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (data.conversation_id) {
        useDMStore.getState().removeConversation(data.conversation_id);
      }
    });

    // DM subscribed confirmation
    const unsubDMSubscribed = wsService.on('dm_subscribed', (msg: WebSocketMessage) => {
      console.debug(
        '[WebSocket] Subscribed to DM:',
        msg.data.conversation_id || msg.data.channel_id
      );
    });

    // ── Friend event handlers ────────────────────────────────────────────

    const unsubFriendRequestReceived = wsService.on(
      'friend_request_received',
      (msg: WebSocketMessage) => {
        const { data } = msg;
        useFriendStore.getState().addRequest({
          id: data.id,
          fromUserId: data.from_user_id,
          fromUsername: data.from_username,
          fromDisplayName: data.from_display_name,
          fromAvatarUrl: data.from_avatar_url,
          toUserId: data.to_user_id,
          toUsername: data.to_username,
          toDisplayName: data.to_display_name,
          toAvatarUrl: data.to_avatar_url,
          direction: 'received',
          createdAt: data.created_at,
        });

        // Notification sound for friend request
        notificationSoundService.play('friend-request');
      }
    );

    const unsubFriendRequestAccepted = wsService.on(
      'friend_request_accepted',
      (msg: WebSocketMessage) => {
        const { data } = msg;
        const store = useFriendStore.getState();

        // Remove the pending request (backend sends "id", not "request_id")
        const requestId = data.request_id || data.id;
        if (requestId) {
          store.removeRequest(requestId);
        }

        // Add the new friend — handle both nested and flat payload formats.
        // Backend currently sends flat fields (user_id, username, etc.)
        // for the user who accepted the request.
        if (data.friend) {
          store.addFriend({
            id: data.friend.id,
            userId: data.friend.user_id,
            username: data.friend.username,
            displayName: data.friend.display_name,
            avatarUrl: data.friend.avatar_url,
            colorScheme: data.friend.color_scheme,
            status: data.friend.status || 'offline',
          });
        } else if (data.user_id && data.username) {
          store.addFriend({
            id: requestId || '',
            userId: data.user_id,
            username: data.username,
            displayName: data.display_name,
            avatarUrl: data.avatar_url,
            colorScheme: data.color_scheme,
            status: 'online',
          });
        }
      }
    );

    const unsubFriendRemoved = wsService.on('friend_removed', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (data.user_id) {
        useFriendStore.getState().removeFriendByUserId(data.user_id);
      }
    });

    const unsubFriendCodeClaimed = wsService.on('friend_code_claimed', (msg: WebSocketMessage) => {
      const { data } = msg;
      const store = useFriendStore.getState();

      if (data.status === 'accepted' && data.friend) {
        // Auto-accepted: add directly to friends list
        store.addFriend({
          id: data.friend.id,
          userId: data.friend.user_id,
          username: data.friend.username,
          displayName: data.friend.display_name,
          avatarUrl: data.friend.avatar_url,
          colorScheme: data.friend.color_scheme,
          status: data.friend.status || 'offline',
        });
      } else if (data.status === 'pending' && data.request) {
        // Pending: add to incoming requests
        store.addRequest({
          id: data.request.id,
          fromUserId: data.request.from_user_id,
          fromUsername: data.request.from_username,
          fromDisplayName: data.request.from_display_name,
          fromAvatarUrl: data.request.from_avatar_url,
          toUserId: data.request.to_user_id,
          toUsername: data.request.to_username,
          toDisplayName: data.request.to_display_name,
          toAvatarUrl: data.request.to_avatar_url,
          direction: 'received',
          createdAt: data.request.created_at,
        });
      }

      // Refresh friend code use counts
      store.refreshFriendCodeUseCounts();
    });

    // ── DM voice state update handler ────────────────────────────────────

    const unsubDMVoiceState = wsService.on('dm_voice_state_update', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id;
      const action = data.action; // 'joined' | 'left' | 'room_empty' | enforcement actions
      const userId = data.user_id as string | undefined;

      if (!conversationId) return;

      console.debug('[WebSocket] DM voice state update:', action, conversationId, userId);

      // Handle enforcement actions in DM calls
      if (
        ['server_muted', 'server_unmuted', 'server_deafened', 'server_undeafened'].includes(
          action
        ) &&
        userId
      ) {
        const voiceStore = useVoiceStore.getState();
        const update = VOICE_PARTICIPANT_UPDATES[action];
        if (update) {
          voiceStore.updateParticipant(userId, update);
        }

        const localUserId = useUserStore.getState().user?.id;
        if (userId === localUserId) {
          const messages: Record<string, string> = {
            server_muted: 'You have been server-muted by a moderator',
            server_unmuted: 'A moderator has removed your server mute',
            server_deafened: 'You have been server-deafened by a moderator',
            server_undeafened: 'A moderator has removed your server deafen',
          };
          if (messages[action]) {
            console.debug('[Voice]', messages[action]);
          }
        }
      }

      // DM voice state is handled by voiceStore when the user is in the call
      // and by dmStore for showing call indicators in the conversation list
    });

    // Subscribed confirmation handler
    const unsubSubscribed = wsService.on('subscribed', (msg: WebSocketMessage) => {
      console.debug('[WebSocket] Subscribed to channel:', msg.data.channel_id);
    });

    // Error handler
    const unsubError = wsService.on('error', (msg: WebSocketMessage) => {
      const { data } = msg;
      if (data.code === 'epoch_revoked' && data.channel_id) {
        console.warn('[WebSocket] Epoch revoked for channel', data.channel_id, '→ re-fetching key');
        e2eeService.invalidateChannelKey(data.channel_id as string);
        globalThis.dispatchEvent(
          new CustomEvent('e2ee-key-rotation', {
            detail: {
              channelId: data.channel_id,
              newEpoch: data.current_epoch,
              reason: 'epoch_revoked',
            },
          })
        );
      } else {
        console.error('WebSocket error:', data);
      }
    });

    // Session revoked handler — server forcefully terminated our session.
    // Routes through the recovery system instead of immediately resetting,
    // so the user sees diagnostic info and can restart cleanly.
    const unsubSessionRevoked = wsService.on('session_revoked', () => {
      console.warn('[WebSocket] Session revoked by server');
      wsService.disconnect();
      const store = useConnectionStore.getState();
      store.setDiagnostics({
        internet: true,
        serverReachable: true,
        tokenValid: false,
        sessionRevoked: true,
        rendererStable: true,
      });
      store.enterFatal();
    });

    // Cleanup handlers
    return () => {
      unsubMessage();
      unsubUpdate();
      unsubDelete();
      unsubReactionAdded();
      unsubReactionRemoved();
      unsubMessagePinned();
      unsubMessageUnpinned();
      unsubTyping();
      unsubAck();
      unsubMemberJoined();
      unsubProfileUpdated();
      unsubServerUpdated();
      unsubChannelUpdated();
      unsubChannelCreated();
      unsubChannelDeleted();
      unsubGroupCreated();
      unsubGroupUpdated();
      unsubGroupDeleted();
      unsubChannelsReordered();
      unsubServerDeleted();
      unsubMemberRemoved();
      unsubUnreadNotify();
      unsubKeyNeeded();
      unsubKeyRevocation();
      unsubKeyDelivered();
      unsubPreferencesUpdated();
      unsubPresenceSnapshot();
      unsubPresence();
      unsubServerOnlineCounts();
      unsubServerVoiceCounts();
      unsubVoiceState();
      unsubDMMessage();
      unsubDMAck();
      unsubDMUpdate();
      unsubDMDelete();
      unsubDMTyping();
      unsubDMUnread();
      unsubDMConvCreated();
      unsubDMParticipantAdded();
      unsubDMParticipantRemoved();
      unsubDMRoleChanged();
      unsubDMGroupDeleted();
      unsubDMSubscribed();
      unsubFriendRequestReceived();
      unsubFriendRequestAccepted();
      unsubFriendRemoved();
      unsubFriendCodeClaimed();
      unsubDMVoiceState();
      unsubSubscribed();
      unsubError();
      unsubSessionRevoked();
    };
  }, [
    wsService,
    addMessage,
    updateMessage,
    updateMessageStatus,
    updateUserInMessages,
    deleteMessage,
    setTyping,
  ]);
}
