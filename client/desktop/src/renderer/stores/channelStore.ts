import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { Channel } from '../types/chat';
import { apiFetch } from '../services/apiClient';
import { useChatStore } from './chatStore';
import { useUnreadStore } from './unreadStore';

interface ChannelState {
  channels: Channel[];
  activeChannelId: string | null;
  currentServerId: string | null;
  lastChannelByServer: Record<string, string>;
  isLoading: boolean;
  error: string | null;

  fetchChannels: (serverId: string) => Promise<void>;
  addChannel: (channel: Channel) => void;
  updateChannel: (channelId: string, updates: Partial<Channel>) => void;
  removeChannel: (channelId: string) => void;
  setActiveChannel: (channelId: string | null) => void;
  clearChannels: () => void;
}

export const useChannelStore = create<ChannelState>()(
  devtools(
    persist(
      (set, get) => ({
        channels: [],
        activeChannelId: null,
        currentServerId: null,
        lastChannelByServer: {},
        isLoading: false,
        error: null,

        fetchChannels: async (serverId: string) => {
          const { activeChannelId, currentServerId, lastChannelByServer } = get();

          // Save current channel for the server we're leaving
          const updatedLastChannel = { ...lastChannelByServer };
          if (currentServerId && activeChannelId) {
            updatedLastChannel[currentServerId] = activeChannelId;
          }

          // Clear active channel immediately when switching servers
          if (serverId !== currentServerId) {
            set({
              activeChannelId: null,
              currentServerId: serverId,
              lastChannelByServer: updatedLastChannel,
              isLoading: true,
              error: null,
            });
          } else {
            set({ isLoading: true, error: null });
          }

          try {
            const response = await apiFetch(
              `/api/v1/servers/${serverId}/channels`
            );

            if (!response.ok) {
              const data = await response.json();
              throw new Error(data.error || 'Failed to load channels');
            }

            const data = await response.json();
            const channels: Channel[] = data.channels || [];

            // Restore last-viewed channel for this server, or pick first text channel
            const lastChannel = updatedLastChannel[serverId];
            let nextChannelId: string | null = null;

            if (lastChannel && channels.some((c) => c.id === lastChannel)) {
              nextChannelId = lastChannel;
            } else {
              const firstText = channels.find((c) => c.type === 'text');
              if (firstText) {
                nextChannelId = firstText.id;
              }
            }

            set({
              channels,
              activeChannelId: nextChannelId,
              isLoading: false,
            });
          } catch (error) {
            set({
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to load channels',
              isLoading: false,
            });
          }
        },

        addChannel: (channel: Channel) => {
          set((state) => ({ channels: [...state.channels, channel] }));
        },

        updateChannel: (channelId: string, updates: Partial<Channel>) => {
          // Defense-in-depth: strip is_encrypted — immutable after creation
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { is_encrypted: _, ...safeUpdates } = updates;
          set((state) => ({
            channels: state.channels.map((c) =>
              c.id === channelId ? { ...c, ...safeUpdates } : c
            ),
          }));
        },

        removeChannel: (channelId: string) => {
          const { activeChannelId, lastChannelByServer } = get();

          // Clean up lastChannelByServer references to this channel
          const updatedLastChannel = { ...lastChannelByServer };
          for (const [serverId, chId] of Object.entries(updatedLastChannel)) {
            if (chId === channelId) delete updatedLastChannel[serverId];
          }

          set((state) => ({
            channels: state.channels.filter((c) => c.id !== channelId),
            activeChannelId:
              activeChannelId === channelId ? null : activeChannelId,
            lastChannelByServer: updatedLastChannel,
          }));

          // Cascade: clear messages and unread count for this channel
          useChatStore.getState().clearMessages(channelId);
          useUnreadStore.getState().clearUnread(channelId);
        },

        setActiveChannel: (channelId: string | null) => {
          const { currentServerId, lastChannelByServer } = get();
          const updates: Partial<ChannelState> = { activeChannelId: channelId };

          // Track last-viewed channel per server
          if (currentServerId && channelId) {
            updates.lastChannelByServer = {
              ...lastChannelByServer,
              [currentServerId]: channelId,
            };
          }

          set(updates as ChannelState);
        },

        clearChannels: () => {
          set({
            channels: [],
            activeChannelId: null,
            currentServerId: null,
            isLoading: false,
            error: null,
          });
        },
      }),
      {
        name: 'concord-channels',
        partialize: (state) => ({
          activeChannelId: state.activeChannelId,
          currentServerId: state.currentServerId,
          lastChannelByServer: state.lastChannelByServer,
        }),
      }
    ),
    { name: 'ChannelStore' }
  )
);
