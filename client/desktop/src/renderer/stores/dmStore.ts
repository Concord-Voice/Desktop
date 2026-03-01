import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';
import { apiFetch } from '../services/apiClient';

export interface DMParticipant {
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  status?: string;
}

export interface DMLastMessage {
  content: string;
  userId: string;
  username: string;
  createdAt: string;
  isEncrypted: boolean;
}

export interface DMConversation {
  id: string;
  isGroup: boolean;
  name: string | null;
  isEncrypted: boolean;
  participants: DMParticipant[];
  lastMessage: DMLastMessage | null;
  unreadCount: number;
  createdAt: string;
}

interface DMState {
  conversations: DMConversation[];
  activeConversationId: string | null;
  isLoading: boolean;
  error: string | null;

  // DM voice call state
  dmCallActive: boolean;
  dmCallConversationId: string | null;

  // API actions
  fetchConversations: () => Promise<void>;
  openDM: (userId: string) => Promise<DMConversation>;
  createGroupDM: (userIds: string[], name?: string) => Promise<DMConversation>;
  setActiveConversation: (id: string | null) => void;

  // Real-time updates (called from WebSocket handlers)
  addConversation: (conv: DMConversation) => void;
  updateConversation: (id: string, updates: Partial<DMConversation>) => void;
  removeConversation: (id: string) => void;
  updateLastMessage: (convId: string, message: DMLastMessage) => void;
  incrementUnread: (convId: string) => void;
  clearUnread: (convId: string) => void;

  // DM voice
  setDMCallActive: (active: boolean, conversationId?: string | null) => void;

  clearDMs: () => void;
}

export const useDMStore = create<DMState>()(
  devtools(
    persist(
      (set, get) => ({
        conversations: [],
        activeConversationId: null,
        isLoading: false,
        error: null,
        dmCallActive: false,
        dmCallConversationId: null,

        fetchConversations: async () => {
          if (get().isLoading) return;
          set({ isLoading: true, error: null });

          try {
            const response = await apiFetch('/api/v1/dm/conversations');
            if (!response.ok) {
              const data = await response.json();
              throw new Error(data.error || 'Failed to load conversations');
            }

            const data = await response.json();
            const conversations: DMConversation[] = (data.conversations || []).map(
              (c: Record<string, unknown>) => mapConversation(c)
            );

            // Validate persisted activeConversationId still exists
            const currentActiveId = get().activeConversationId;
            const validActiveId =
              currentActiveId && conversations.some((c) => c.id === currentActiveId)
                ? currentActiveId
                : null;

            set({ conversations, activeConversationId: validActiveId, isLoading: false });
          } catch (error) {
            set({
              error: error instanceof Error ? error.message : 'Failed to load conversations',
              isLoading: false,
            });
          }
        },

        openDM: async (userId: string) => {
          const response = await apiFetch('/api/v1/dm/conversations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId }),
          });

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to open DM');
          }

          const data = await response.json();
          const conv = mapConversation(data.conversation);

          // Add to list if not already present
          set((state) => {
            const exists = state.conversations.some((c) => c.id === conv.id);
            return {
              conversations: exists
                ? state.conversations
                : [conv, ...state.conversations],
              activeConversationId: conv.id,
            };
          });

          return conv;
        },

        createGroupDM: async (userIds: string[], name?: string) => {
          const body: Record<string, unknown> = { user_ids: userIds };
          if (name) body.name = name;

          const response = await apiFetch('/api/v1/dm/conversations/group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to create group DM');
          }

          const data = await response.json();
          const conv = mapConversation(data.conversation);

          set((state) => ({
            conversations: [conv, ...state.conversations],
            activeConversationId: conv.id,
          }));

          return conv;
        },

        setActiveConversation: (id: string | null) =>
          set({ activeConversationId: id }),

        addConversation: (conv: DMConversation) =>
          set((state) => {
            if (state.conversations.some((c) => c.id === conv.id)) return state;
            return { conversations: [conv, ...state.conversations] };
          }),

        updateConversation: (id: string, updates: Partial<DMConversation>) =>
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === id ? { ...c, ...updates } : c
            ),
          })),

        removeConversation: (id: string) =>
          set((state) => ({
            conversations: state.conversations.filter((c) => c.id !== id),
            activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
          })),

        updateLastMessage: (convId: string, message: DMLastMessage) =>
          set((state) => {
            const updated = state.conversations.map((c) =>
              c.id === convId ? { ...c, lastMessage: message } : c
            );
            // Re-sort: most recent message first
            updated.sort((a, b) => {
              const aTime = a.lastMessage?.createdAt || a.createdAt;
              const bTime = b.lastMessage?.createdAt || b.createdAt;
              return new Date(bTime).getTime() - new Date(aTime).getTime();
            });
            return { conversations: updated };
          }),

        incrementUnread: (convId: string) =>
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === convId ? { ...c, unreadCount: c.unreadCount + 1 } : c
            ),
          })),

        clearUnread: (convId: string) =>
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === convId ? { ...c, unreadCount: 0 } : c
            ),
          })),

        setDMCallActive: (active: boolean, conversationId?: string | null) =>
          set({
            dmCallActive: active,
            dmCallConversationId: active ? (conversationId ?? null) : null,
          }),

        clearDMs: () =>
          set({
            conversations: [],
            activeConversationId: null,
            dmCallActive: false,
            dmCallConversationId: null,
          }),
      }),
      {
        name: 'concord:dm-store',
        partialize: (state) => ({
          activeConversationId: state.activeConversationId,
        }),
      }
    ),
    { name: 'DMStore' }
  )
);

// Map API response to DMConversation
function mapConversation(c: Record<string, unknown>): DMConversation {
  const participants: DMParticipant[] = Array.isArray(c.participants)
    ? c.participants.map((p: Record<string, unknown>) => ({
        userId: p.user_id as string,
        username: p.username as string,
        displayName: p.display_name as string | undefined,
        avatarUrl: p.avatar_url as string | undefined,
        status: p.status as string | undefined,
      }))
    : [];

  const lastMsg = c.last_message as Record<string, unknown> | null;

  return {
    id: c.id as string,
    isGroup: c.is_group as boolean,
    name: (c.name as string) || null,
    isEncrypted: c.is_encrypted as boolean,
    participants,
    lastMessage: lastMsg
      ? {
          content: lastMsg.content as string,
          userId: lastMsg.user_id as string,
          username: lastMsg.username as string,
          createdAt: lastMsg.created_at as string,
          isEncrypted: lastMsg.is_encrypted as boolean,
        }
      : null,
    unreadCount: (c.unread_count as number) || 0,
    createdAt: c.created_at as string,
  };
}
