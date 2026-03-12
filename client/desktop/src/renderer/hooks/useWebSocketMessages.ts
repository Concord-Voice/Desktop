/**
 * useWebSocketMessages - All WebSocket message handler subscriptions.
 *
 * Extracted from useWebSocket to isolate message routing from connection management.
 * Registers all `wsService.on(...)` handlers in a single useEffect and cleans up on unmount.
 */

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore';
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
import { speak as ttsSpeak } from '../services/ttsService';

// Debounce timers for re-fetching voice participants after join/leave events.
// Coalesces rapid bursts (e.g. 10 users joining) into a single API call.
const voiceRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };

      // TTS helper: speak message if it's in a voice-linked text channel and not from self
      const maybeSpeakTTS = (text: string) => {
        const selfId = useUserStore.getState().user?.id;
        if (data.user_id === selfId) return;
        const ch = useChannelStore.getState().channels.find((c) => c.id === channelId);
        if (!ch?.linked_voice_channel_id) return;
        const voiceActiveId = useVoiceStore.getState().activeChannelId;
        if (voiceActiveId !== ch.linked_voice_channel_id) return;
        ttsSpeak(text, data.display_name || data.username);
      };

      if (isEncrypted && e2eeService.isInitialized) {
        // Decrypt asynchronously with version-aware decryption
        const decryptPromise =
          keyVersion && keyVersion > 1
            ? e2eeService.decryptForChannelWithVersion(channelId, data.content, keyVersion)
            : e2eeService.decryptForChannel(channelId, data.content);

        decryptPromise
          .then((plaintext) => {
            addMessage(channelId, { ...baseMessage, content: plaintext });
            maybeSpeakTTS(plaintext);
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
      } else if (isEncrypted) {
        // E2EE service not initialized — can't decrypt
        addMessage(channelId, { ...baseMessage, content: '', decryptFailed: true });
      } else {
        addMessage(channelId, { ...baseMessage, content: data.content });
        maybeSpeakTTS(data.content);
      }

      // NOTE: Unread tracking is handled exclusively by the 'unread_notify' handler
      // (server-level subscription). The 'message' event only arrives for the active
      // channel the user is subscribed to, so no unread increment is needed here.
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
      import('../stores/dmStore').then(({ useDMStore }) => {
        useDMStore.getState().updateParticipantProfile(userId, {
          username: data.username,
          displayName: data.display_name || undefined,
          avatarUrl: data.avatar_url || undefined,
          colorScheme: data.color_scheme || undefined,
        });
      });

      // Update friend profiles
      import('../stores/friendStore').then(({ useFriendStore }) => {
        useFriendStore.getState().updateFriendProfile(userId, {
          username: data.username,
          displayName: data.display_name || undefined,
          avatarUrl: data.avatar_url || undefined,
          colorScheme: data.color_scheme || undefined,
        });
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
      const { data } = msg;
      const channelId = data.channel_id;
      const serverId = data.server_id;
      const activeServerId = useServerStore.getState().activeServerId;

      // Voice-linked text channels: only notify when user is in the parent voice channel
      if (channelId) {
        const channel = useChannelStore.getState().channels.find((c) => c.id === channelId);
        if (channel?.linked_voice_channel_id) {
          const voiceActiveChannelId = useVoiceStore.getState().activeChannelId;
          if (voiceActiveChannelId !== channel.linked_voice_channel_id) {
            return; // User not in voice — suppress notification entirely
          }
        }
      }

      if (serverId && serverId !== activeServerId) {
        // Non-active server: just mark the server icon as having unreads
        useUnreadStore.getState().markServerUnread(serverId);
      } else if (channelId) {
        // Active server: increment per-channel unread count
        const activeChannelId = useChannelStore.getState().activeChannelId;
        if (channelId !== activeChannelId) {
          useUnreadStore.getState().incrementUnread(channelId);
          // Also mark the server so the dot persists if the user switches away.
          // The dot won't show while this server is active (ServerList filters it).
          if (serverId) {
            useUnreadStore.getState().markServerUnread(serverId);
          }
        }
      }
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
      window.dispatchEvent(
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
      window.dispatchEvent(new CustomEvent('e2ee-key-delivered', { detail: { channelId } }));
    });

    // Preferences updated handler — another device pushed new preferences
    const unsubPreferencesUpdated = wsService.on('preferences_updated', () => {
      preferencesSyncService.fetchAndApply();
    });

    // Presence snapshot handler — received on connection with all online users and their statuses
    const unsubPresenceSnapshot = wsService.on('presence_snapshot', (msg: WebSocketMessage) => {
      // Enhanced format: array of { user_id, status } objects
      if (msg.data.users && Array.isArray(msg.data.users)) {
        useMemberStore
          .getState()
          .setPresenceSnapshot(msg.data.users as Array<{ user_id: string; status: string }>);
      } else if (msg.data.online_user_ids) {
        // Backward compatibility: simple list of online user IDs
        const userIds = msg.data.online_user_ids as string[];
        useMemberStore.getState().setOnlineUsers(userIds);
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
      const { data } = msg;
      const channelId = data.channel_id as string | undefined;
      const action = data.action as string | undefined;
      const userId = data.user_id as string | undefined;
      const serverId = data.server_id as string | undefined;
      if (!channelId || !action) return;

      const voiceStore = useVoiceStore.getState();

      // Update channel voice members (sidebar display) for ALL channels
      switch (action) {
        case 'joined':
          if (userId) {
            voiceStore.addChannelVoiceMember(channelId, {
              userId,
              username: (data.username as string) || 'Unknown',
              displayName: data.display_name as string | undefined,
              isMuted: false,
            });
            if (serverId) voiceStore.incrementServerVoiceCount(serverId);
          }
          break;
        case 'left':
          if (userId) {
            voiceStore.removeChannelVoiceMember(channelId, userId);
            if (serverId) voiceStore.decrementServerVoiceCount(serverId);
          }
          break;
        case 'room_empty':
          // Safety net: server confirmed the room is empty — clear all members
          voiceStore.setChannelVoiceMembers(channelId, []);
          break;
      }

      // Re-fetch authoritative voice members to correct any drift
      if (action === 'joined' || action === 'left') {
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
                }) => ({
                  userId: p.user_id,
                  username: p.username,
                  displayName: p.display_name,
                  avatarUrl: p.avatar_url,
                  isMuted: p.is_muted || false,
                })
              );
              voiceStore.setChannelVoiceMembers(channelId, members);
            } catch {
              /* non-critical */
            }
          }, 2000)
        );
      }

      // Update detailed participants only for the channel we're connected to
      if (voiceStore.activeChannelId === channelId && userId) {
        switch (action) {
          case 'muted':
            voiceStore.updateParticipant(userId, { isMuted: true });
            break;
          case 'unmuted':
            voiceStore.updateParticipant(userId, { isMuted: false });
            break;
          case 'video_on':
            voiceStore.updateParticipant(userId, { isVideoOn: true });
            break;
          case 'video_off':
            voiceStore.updateParticipant(userId, { isVideoOn: false });
            break;
          case 'screen_on':
            voiceStore.updateParticipant(userId, { isScreenSharing: true });
            break;
          case 'screen_off':
            voiceStore.updateParticipant(userId, { isScreenSharing: false });
            break;
        }
      }
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
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString(),
      };

      if (isEncrypted && e2eeService.isInitialized) {
        const decryptPromise =
          dmKeyVersion && dmKeyVersion > 1
            ? e2eeService.decryptForChannelWithVersion(conversationId, data.content, dmKeyVersion)
            : e2eeService.decryptForChannel(conversationId, data.content);

        decryptPromise
          .then((plaintext) => {
            addMessage(conversationId, { ...baseMessage, content: plaintext });
          })
          .catch((err) => {
            const isPending = err instanceof Error && err.message === 'PENDING_KEY';
            addMessage(conversationId, {
              ...baseMessage,
              content: '',
              decryptFailed: !isPending,
              pendingKeys: isPending,
            });
          });
      } else if (isEncrypted) {
        addMessage(conversationId, { ...baseMessage, content: '', decryptFailed: true });
      } else {
        addMessage(conversationId, { ...baseMessage, content: data.content });
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
    const unsubDMUnread = wsService.on('dm_unread_notify', async (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id;

      if (conversationId) {
        const { useDMStore } = await import('../stores/dmStore');
        useDMStore.getState().incrementUnread(conversationId);
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
      }
    });

    // DM conversation created (when another user opens a DM with us)
    const unsubDMConvCreated = wsService.on(
      'dm_conversation_created',
      async (msg: WebSocketMessage) => {
        const { data } = msg;
        if (data.conversation) {
          const { useDMStore } = await import('../stores/dmStore');
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
              })
            ),
            lastMessage: null,
            unreadCount: 0,
            createdAt: data.conversation.created_at,
          });
        }
      }
    );

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
      async (msg: WebSocketMessage) => {
        const { data } = msg;
        const { useFriendStore } = await import('../stores/friendStore');
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
      }
    );

    const unsubFriendRequestAccepted = wsService.on(
      'friend_request_accepted',
      async (msg: WebSocketMessage) => {
        const { data } = msg;
        const { useFriendStore } = await import('../stores/friendStore');
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
            status: data.friend.status || 'offline',
          });
        } else if (data.user_id && data.username) {
          store.addFriend({
            id: requestId || '',
            userId: data.user_id,
            username: data.username,
            displayName: data.display_name,
            avatarUrl: data.avatar_url,
            status: 'online',
          });
        }
      }
    );

    const unsubFriendRemoved = wsService.on('friend_removed', async (msg: WebSocketMessage) => {
      const { data } = msg;
      if (data.user_id) {
        const { useFriendStore } = await import('../stores/friendStore');
        useFriendStore.getState().removeFriendByUserId(data.user_id);
      }
    });

    const unsubFriendCodeClaimed = wsService.on(
      'friend_code_claimed',
      async (msg: WebSocketMessage) => {
        const { data } = msg;
        const { useFriendStore } = await import('../stores/friendStore');
        const store = useFriendStore.getState();

        if (data.status === 'accepted' && data.friend) {
          // Auto-accepted: add directly to friends list
          store.addFriend({
            id: data.friend.id,
            userId: data.friend.user_id,
            username: data.friend.username,
            displayName: data.friend.display_name,
            avatarUrl: data.friend.avatar_url,
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
      }
    );

    // ── DM voice state update handler ────────────────────────────────────

    const unsubDMVoiceState = wsService.on('dm_voice_state_update', (msg: WebSocketMessage) => {
      const { data } = msg;
      const conversationId = data.conversation_id;
      const action = data.action; // 'joined' | 'left' | 'room_empty'

      if (!conversationId) return;

      console.debug('[WebSocket] DM voice state update:', action, conversationId, data.user_id);
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
        window.dispatchEvent(
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
