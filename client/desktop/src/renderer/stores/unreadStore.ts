import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface UnreadState {
  // Channel ID -> unread count
  unreadCounts: Map<string, number>;

  incrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  clearAll: () => void;
}

export const useUnreadStore = create<UnreadState>()(
  devtools(
    (set) => ({
      unreadCounts: new Map(),

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
    }),
    { name: 'UnreadStore' }
  )
);
