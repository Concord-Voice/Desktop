import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { apiFetch } from '../services/apiClient';
import type { PresenceStatus } from './memberStore';

export interface Friend {
  id: string; // friendship ID
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  status: PresenceStatus;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName?: string;
  fromAvatarUrl?: string;
  toUserId: string;
  toUsername: string;
  toDisplayName?: string;
  toAvatarUrl?: string;
  direction: 'sent' | 'received';
  createdAt: string;
}

interface FriendState {
  friends: Friend[];
  pendingRequests: FriendRequest[];
  blockedUserIds: string[];
  isLoading: boolean;
  error: string | null;

  fetchFriends: () => Promise<void>;
  fetchRequests: () => Promise<void>;
  sendRequest: (userIdOrUsername: string, byUsername?: boolean) => Promise<void>;
  acceptRequest: (requestId: string) => Promise<void>;
  declineRequest: (requestId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  blockUser: (userId: string) => Promise<void>;

  // Real-time updates (called from WebSocket handlers)
  addFriend: (friend: Friend) => void;
  removeFriendByUserId: (userId: string) => void;
  addRequest: (request: FriendRequest) => void;
  removeRequest: (requestId: string) => void;
  updateFriendPresence: (userId: string, status: PresenceStatus) => void;
  clearFriends: () => void;
}

export const useFriendStore = create<FriendState>()(
  devtools(
    (set, get) => ({
      friends: [],
      pendingRequests: [],
      blockedUserIds: [],
      isLoading: false,
      error: null,

      fetchFriends: async () => {
        if (get().isLoading) return;
        set({ isLoading: true, error: null });

        try {
          const response = await apiFetch('/api/v1/friends');
          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to load friends');
          }

          const data = await response.json();
          const friends: Friend[] = (data.friends || []).map((f: Record<string, unknown>) => ({
            id: f.id,
            userId: f.user_id,
            username: f.username,
            displayName: f.display_name,
            avatarUrl: f.avatar_url,
            status: (f.status as PresenceStatus) || 'offline',
          }));

          set({ friends, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load friends',
            isLoading: false,
          });
        }
      },

      fetchRequests: async () => {
        try {
          const response = await apiFetch('/api/v1/friends/requests');
          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to load friend requests');
          }

          const data = await response.json();
          const requests: FriendRequest[] = (data.requests || []).map((r: Record<string, unknown>) => ({
            id: r.id,
            fromUserId: r.from_user_id,
            fromUsername: r.from_username,
            fromDisplayName: r.from_display_name,
            fromAvatarUrl: r.from_avatar_url,
            toUserId: r.to_user_id,
            toUsername: r.to_username,
            toDisplayName: r.to_display_name,
            toAvatarUrl: r.to_avatar_url,
            direction: r.direction as 'sent' | 'received',
            createdAt: r.created_at as string,
          }));

          set({ pendingRequests: requests });
        } catch (error) {
          console.error('Failed to fetch friend requests:', error);
        }
      },

      sendRequest: async (userIdOrUsername: string, byUsername = false) => {
        const body = byUsername
          ? { username: userIdOrUsername }
          : { user_id: userIdOrUsername };

        const response = await apiFetch('/api/v1/friends/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to send friend request');
        }
      },

      acceptRequest: async (requestId: string) => {
        const response = await apiFetch(`/api/v1/friends/request/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'accept' }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to accept friend request');
        }

        // Remove from pending, server will send WS event to add to friends list
        set((state) => ({
          pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
        }));
      },

      declineRequest: async (requestId: string) => {
        const response = await apiFetch(`/api/v1/friends/request/${requestId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'decline' }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to decline friend request');
        }

        set((state) => ({
          pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
        }));
      },

      removeFriend: async (userId: string) => {
        const response = await apiFetch(`/api/v1/friends/${userId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to remove friend');
        }

        set((state) => ({
          friends: state.friends.filter((f) => f.userId !== userId),
        }));
      },

      blockUser: async (userId: string) => {
        const response = await apiFetch(`/api/v1/friends/${userId}/block`, {
          method: 'POST',
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to block user');
        }

        set((state) => ({
          friends: state.friends.filter((f) => f.userId !== userId),
          blockedUserIds: [...state.blockedUserIds, userId],
        }));
      },

      // Real-time WebSocket updates
      addFriend: (friend: Friend) =>
        set((state) => {
          if (state.friends.some((f) => f.userId === friend.userId)) return state;
          return { friends: [...state.friends, friend] };
        }),

      removeFriendByUserId: (userId: string) =>
        set((state) => ({
          friends: state.friends.filter((f) => f.userId !== userId),
        })),

      addRequest: (request: FriendRequest) =>
        set((state) => {
          if (state.pendingRequests.some((r) => r.id === request.id)) return state;
          return { pendingRequests: [...state.pendingRequests, request] };
        }),

      removeRequest: (requestId: string) =>
        set((state) => ({
          pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
        })),

      updateFriendPresence: (userId: string, status: PresenceStatus) =>
        set((state) => ({
          friends: state.friends.map((f) =>
            f.userId === userId ? { ...f, status } : f
          ),
        })),

      clearFriends: () =>
        set({ friends: [], pendingRequests: [], blockedUserIds: [] }),
    }),
    { name: 'FriendStore' }
  )
);
