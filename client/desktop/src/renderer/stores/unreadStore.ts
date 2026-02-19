import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface UnreadState {
  // Channel ID -> unread count (per-channel, active server only)
  unreadCounts: Map<string, number>;

  // Server IDs that have any unread messages (cross-server)
  serverUnreadSet: Set<string>;

  setInitialUnreads: (counts: Map<string, number>) => void;
  setUnreadCount: (channelId: string, count: number) => void;
  incrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  clearAll: () => void;

  setInitialServerUnreads: (serverIds: string[]) => void;
  markServerUnread: (serverId: string) => void;
  clearServerUnread: (serverId: string) => void;
}

export const useUnreadStore = create<UnreadState>()(
  devtools(
    (set) => ({
      unreadCounts: new Map(),
      serverUnreadSet: new Set(),

      setInitialUnreads: (counts: Map<string, number>) =>
        set({ unreadCounts: new Map(counts) }),

      setUnreadCount: (channelId: string, count: number) =>
        set((state) => {
          const next = new Map(state.unreadCounts);
          if (count > 0) {
            next.set(channelId, count);
          } else {
            next.delete(channelId);
          }
          return { unreadCounts: next };
        }),

      incrementUnread: (channelId: string) =>
        set((state) => {
          const current = state.unreadCounts.get(channelId) || 0;
          state.unreadCounts.set(channelId, current + 1);
          return { unreadCounts: new Map(state.unreadCounts) };
        }),

      clearUnread: (channelId: string) =>
        set((state) => {
          if (state.unreadCounts.has(channelId)) {
            state.unreadCounts.delete(channelId);
            return { unreadCounts: new Map(state.unreadCounts) };
          }
          return state;
        }),

      clearAll: () =>
        set({ unreadCounts: new Map() }),

      setInitialServerUnreads: (serverIds: string[]) =>
        set({ serverUnreadSet: new Set(serverIds) }),

      markServerUnread: (serverId: string) =>
        set((state) => {
          if (state.serverUnreadSet.has(serverId)) return state;
          const next = new Set(state.serverUnreadSet);
          next.add(serverId);
          return { serverUnreadSet: next };
        }),

      clearServerUnread: (serverId: string) =>
        set((state) => {
          if (!state.serverUnreadSet.has(serverId)) return state;
          const next = new Set(state.serverUnreadSet);
          next.delete(serverId);
          return { serverUnreadSet: next };
        }),
    }),
    { name: 'UnreadStore' }
  )
);
