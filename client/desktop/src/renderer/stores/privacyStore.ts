import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { apiFetch } from '../services/apiClient';

// DM Privacy Levels:
// 0 = Off (no DMs at all)
// 1 = Friends Only
// 2 = Friends + Server Members (default)
// 3 = Allow All
export type DMPrivacyLevel = 0 | 1 | 2 | 3;

export interface PrivacySettings {
  messagesFriendsOnly: boolean;
  messagesServerMembers: boolean;
  dmPrivacyLevel: DMPrivacyLevel;
  dmFriendsOfFriends: boolean;
  autoAcceptFriendCodes: boolean;
  searchableByUsername: boolean;
  searchableByEmail: boolean;
  searchableByPhone: boolean;
}

const defaultSettings: PrivacySettings = {
  messagesFriendsOnly: true,
  messagesServerMembers: true,
  dmPrivacyLevel: 2,
  dmFriendsOfFriends: false,
  autoAcceptFriendCodes: false,
  searchableByUsername: false,
  searchableByEmail: false,
  searchableByPhone: false,
};

interface PrivacyState {
  settings: PrivacySettings;
  isLoading: boolean;
  error: string | null;

  fetchPrivacy: () => Promise<void>;
  updatePrivacy: (updates: Partial<PrivacySettings>) => Promise<void>;
  clearPrivacy: () => void;
}

export const usePrivacyStore = create<PrivacyState>()(
  devtools(
    (set) => ({
      settings: { ...defaultSettings },
      isLoading: false,
      error: null,

      fetchPrivacy: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await apiFetch('/api/v1/users/me/privacy');
          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to load privacy settings');
          }
          const data = await response.json();
          const p = data.privacy;
          set({
            settings: {
              messagesFriendsOnly: p.messages_friends_only ?? true,
              messagesServerMembers: p.messages_server_members ?? true,
              dmPrivacyLevel: (p.dm_privacy_level ?? 2) as DMPrivacyLevel,
              dmFriendsOfFriends: p.dm_friends_of_friends ?? false,
              autoAcceptFriendCodes: p.auto_accept_friend_codes ?? false,
              searchableByUsername: p.searchable_by_username ?? false,
              searchableByEmail: p.searchable_by_email ?? false,
              searchableByPhone: p.searchable_by_phone ?? false,
            },
            isLoading: false,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Failed to load privacy settings',
            isLoading: false,
          });
        }
      },

      updatePrivacy: async (updates: Partial<PrivacySettings>) => {
        const body: Record<string, boolean | number> = {};
        if (updates.messagesFriendsOnly !== undefined)
          body.messages_friends_only = updates.messagesFriendsOnly;
        if (updates.messagesServerMembers !== undefined)
          body.messages_server_members = updates.messagesServerMembers;
        if (updates.dmPrivacyLevel !== undefined) body.dm_privacy_level = updates.dmPrivacyLevel;
        if (updates.dmFriendsOfFriends !== undefined)
          body.dm_friends_of_friends = updates.dmFriendsOfFriends;
        if (updates.autoAcceptFriendCodes !== undefined)
          body.auto_accept_friend_codes = updates.autoAcceptFriendCodes;
        if (updates.searchableByUsername !== undefined)
          body.searchable_by_username = updates.searchableByUsername;
        if (updates.searchableByEmail !== undefined)
          body.searchable_by_email = updates.searchableByEmail;
        if (updates.searchableByPhone !== undefined)
          body.searchable_by_phone = updates.searchableByPhone;

        const response = await apiFetch('/api/v1/users/me/privacy', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to update privacy settings');
        }

        const data = await response.json();
        const p = data.privacy;
        set({
          settings: {
            messagesFriendsOnly: p.messages_friends_only,
            messagesServerMembers: p.messages_server_members,
            dmPrivacyLevel: (p.dm_privacy_level ?? 2) as DMPrivacyLevel,
            dmFriendsOfFriends: p.dm_friends_of_friends ?? false,
            autoAcceptFriendCodes: p.auto_accept_friend_codes,
            searchableByUsername: p.searchable_by_username,
            searchableByEmail: p.searchable_by_email,
            searchableByPhone: p.searchable_by_phone,
          },
        });
      },

      clearPrivacy: () => set({ settings: { ...defaultSettings }, error: null }),
    }),
    { name: 'PrivacyStore' }
  )
);
