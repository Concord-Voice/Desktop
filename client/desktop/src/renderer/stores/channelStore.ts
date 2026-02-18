import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { Channel } from '../types/chat';

interface ChannelState {
  channels: Channel[];
  activeChannelId: string | null;
  isLoading: boolean;
  error: string | null;

  fetchChannels: (serverId: string, accessToken: string) => Promise<void>;
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
        isLoading: false,
        error: null,

        fetchChannels: async (serverId: string, accessToken: string) => {
          set({ isLoading: true, error: null });

          try {
            const response = await fetch(
              `http://localhost:8080/api/v1/servers/${serverId}/channels`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              }
            );

            if (!response.ok) {
              const data = await response.json();
              throw new Error(data.error || 'Failed to load channels');
            }

            const data = await response.json();
            set({ channels: data.channels || [], isLoading: false });
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
          set((state) => ({
            channels: state.channels.map((c) =>
              c.id === channelId ? { ...c, ...updates } : c
            ),
          }));
        },

        removeChannel: (channelId: string) => {
          const { activeChannelId } = get();
          set((state) => ({
            channels: state.channels.filter((c) => c.id !== channelId),
            activeChannelId:
              activeChannelId === channelId ? null : activeChannelId,
          }));
        },

        setActiveChannel: (channelId: string | null) => {
          set({ activeChannelId: channelId });
        },

        clearChannels: () => {
          set({
            channels: [],
            activeChannelId: null,
            isLoading: false,
            error: null,
          });
        },
      }),
      {
        name: 'concord-channels',
        partialize: (state) => ({ activeChannelId: state.activeChannelId }),
      }
    ),
    { name: 'ChannelStore' }
  )
);
