import { useDMStore, type DMConversation, type DMLastMessage } from '@/renderer/stores/dmStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:8080';

const mockConversation: DMConversation = {
  id: 'conv-1',
  isGroup: false,
  isPersonal: false,
  name: null,
  isEncrypted: false,
  participants: [
    { userId: 'user-1', username: 'alice' },
    { userId: 'user-2', username: 'bob' },
  ],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
};

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
});

describe('dmStore', () => {
  describe('addConversation', () => {
    it('adds a conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      expect(useDMStore.getState().conversations).toHaveLength(1);
      expect(useDMStore.getState().conversations[0].id).toBe('conv-1');
    });

    it('does not duplicate conversations', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation);
      expect(useDMStore.getState().conversations).toHaveLength(1);
    });
  });

  describe('updateConversation', () => {
    it('updates conversation properties', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateConversation('conv-1', { name: 'Renamed' });
      expect(useDMStore.getState().conversations[0].name).toBe('Renamed');
    });
  });

  describe('removeConversation', () => {
    it('removes a conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().removeConversation('conv-1');
      expect(useDMStore.getState().conversations).toHaveLength(0);
    });

    it('clears activeConversationId if removed', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().setActiveConversation('conv-1');
      useDMStore.getState().removeConversation('conv-1');
      expect(useDMStore.getState().activeConversationId).toBeNull();
    });
  });

  describe('updateLastMessage', () => {
    it('updates the last message for a conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      const lastMsg: DMLastMessage = {
        content: 'Hello!',
        userId: 'user-1',
        username: 'alice',
        createdAt: '2025-01-01T12:00:00Z',
        isEncrypted: false,
      };
      useDMStore.getState().updateLastMessage('conv-1', lastMsg);
      expect(useDMStore.getState().conversations[0].lastMessage?.content).toBe('Hello!');
    });
  });

  describe('unread management', () => {
    it('incrementUnread increases count', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().incrementUnread('conv-1');
      useDMStore.getState().incrementUnread('conv-1');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(2);
    });

    it('clearUnread resets count to 0', () => {
      useDMStore.getState().addConversation({ ...mockConversation, unreadCount: 5 });
      useDMStore.getState().clearUnread('conv-1');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(0);
    });
  });

  describe('setActiveConversation', () => {
    it('sets the active conversation', () => {
      useDMStore.getState().setActiveConversation('conv-1');
      expect(useDMStore.getState().activeConversationId).toBe('conv-1');
    });

    it('can set to null', () => {
      useDMStore.getState().setActiveConversation('conv-1');
      useDMStore.getState().setActiveConversation(null);
      expect(useDMStore.getState().activeConversationId).toBeNull();
    });
  });

  describe('DM voice call state', () => {
    it('sets DM call active', () => {
      useDMStore.getState().setDMCallActive(true, 'conv-1');
      expect(useDMStore.getState().dmCallActive).toBe(true);
      expect(useDMStore.getState().dmCallConversationId).toBe('conv-1');
    });

    it('clears DM call state', () => {
      useDMStore.getState().setDMCallActive(true, 'conv-1');
      useDMStore.getState().setDMCallActive(false);
      expect(useDMStore.getState().dmCallActive).toBe(false);
      expect(useDMStore.getState().dmCallConversationId).toBeNull();
    });
  });

  describe('updateParticipantProfile', () => {
    it('updates participant across all conversations', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateParticipantProfile('user-2', { displayName: 'Bobby' });
      const p = useDMStore.getState().conversations[0].participants.find(
        (p) => p.userId === 'user-2'
      );
      expect(p?.displayName).toBe('Bobby');
    });
  });

  describe('clearDMs', () => {
    it('resets all DM state', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().setActiveConversation('conv-1');
      useDMStore.getState().setDMCallActive(true, 'conv-1');

      useDMStore.getState().clearDMs();

      const state = useDMStore.getState();
      expect(state.conversations).toHaveLength(0);
      expect(state.activeConversationId).toBeNull();
      expect(state.dmCallActive).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe('fetchConversations', () => {
    it('fetches and populates conversations', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({
            conversations: [
              {
                id: 'conv-api-1',
                is_group: false,
                is_personal: false,
                name: null,
                is_encrypted: false,
                participants: [
                  { user_id: 'user-1', username: 'alice' },
                  { user_id: 'user-2', username: 'bob' },
                ],
                last_message: null,
                unread_count: 0,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useDMStore.getState().fetchConversations();
      const state = useDMStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.conversations).toHaveLength(1);
    });
  });
});
