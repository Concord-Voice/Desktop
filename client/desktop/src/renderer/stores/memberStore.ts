import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface ServerMember {
  user_id: string;
  username: string;
  display_name?: string;
  bio?: string;
  avatar_url?: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}

interface MemberState {
  members: ServerMember[];
  onlineUserIds: Set<string>;
  isLoading: boolean;
  error: string | null;

  fetchMembers: (serverId: string, accessToken: string) => Promise<void>;
  setOnlineUsers: (userIds: string[]) => void;
  setUserOnline: (userId: string) => void;
  setUserOffline: (userId: string) => void;
  clearMembers: () => void;
}

export const useMemberStore = create<MemberState>()(
  devtools(
    (set) => ({
      members: [],
      onlineUserIds: new Set<string>(),
      isLoading: false,
      error: null,

      fetchMembers: async (serverId: string, accessToken: string) => {
        set({ isLoading: true, error: null });

        try {
          const response = await fetch(
            `http://localhost:8080/api/v1/servers/${serverId}/members`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            }
          );

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to load members');
          }

          const data = await response.json();
          set({ members: data.members || [], isLoading: false });
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to load members',
            isLoading: false,
          });
        }
      },

      setOnlineUsers: (userIds: string[]) => {
        set({ onlineUserIds: new Set(userIds) });
      },

      setUserOnline: (userId: string) => {
        set((state) => {
          const next = new Set(state.onlineUserIds);
          next.add(userId);
          return { onlineUserIds: next };
        });
      },

      setUserOffline: (userId: string) => {
        set((state) => {
          const next = new Set(state.onlineUserIds);
          next.delete(userId);
          return { onlineUserIds: next };
        });
      },

      clearMembers: () => {
        set({
          members: [],
          onlineUserIds: new Set<string>(),
          isLoading: false,
          error: null,
        });
      },
    }),
    { name: 'MemberStore' }
  )
);
