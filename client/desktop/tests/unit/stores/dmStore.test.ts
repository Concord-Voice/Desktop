import { useDMStore, type DMConversation, type DMLastMessage } from '@/renderer/stores/dmStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    getChannelKey: vi.fn(),
    createChannelKeys: vi.fn(),
    clearKeys: vi.fn(),
  },
}));

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

const mockConversation2: DMConversation = {
  id: 'conv-2',
  isGroup: true,
  isPersonal: false,
  name: 'Group Chat',
  isEncrypted: false,
  participants: [
    { userId: 'user-1', username: 'alice' },
    { userId: 'user-2', username: 'bob' },
    { userId: 'user-3', username: 'charlie' },
  ],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-02T00:00:00Z',
};

const mockPersonalConv: DMConversation = {
  id: 'conv-personal',
  isGroup: false,
  isPersonal: true,
  name: null,
  isEncrypted: false,
  participants: [{ userId: 'user-1', username: 'alice' }],
  lastMessage: null,
  unreadCount: 0,
  createdAt: '2025-01-03T00:00:00Z',
};

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
});

describe('dmStore', () => {
  // ── Initial state ─────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with empty state', () => {
      const state = useDMStore.getState();
      expect(state.conversations).toEqual([]);
      expect(state.activeConversationId).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.dmCallActive).toBe(false);
      expect(state.dmCallConversationId).toBeNull();
    });
  });

  // ── addConversation ───────────────────────────────────────────────────

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

    it('prepends new conversation to list', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation2);
      expect(useDMStore.getState().conversations[0].id).toBe('conv-2');
      expect(useDMStore.getState().conversations[1].id).toBe('conv-1');
    });
  });

  // ── updateConversation ────────────────────────────────────────────────

  describe('updateConversation', () => {
    it('updates conversation properties', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateConversation('conv-1', { name: 'Renamed' });
      expect(useDMStore.getState().conversations[0].name).toBe('Renamed');
    });

    it('does not affect other conversations', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation2);
      useDMStore.getState().updateConversation('conv-1', { name: 'Renamed' });
      expect(useDMStore.getState().conversations.find((c) => c.id === 'conv-2')?.name).toBe(
        'Group Chat'
      );
    });

    it('can update multiple fields at once', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateConversation('conv-1', {
        name: 'New Name',
        unreadCount: 5,
      });
      const conv = useDMStore.getState().conversations[0];
      expect(conv.name).toBe('New Name');
      expect(conv.unreadCount).toBe(5);
    });

    it('is a no-op for non-existent conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateConversation('conv-999', { name: 'Ghost' });
      expect(useDMStore.getState().conversations).toHaveLength(1);
      expect(useDMStore.getState().conversations[0].name).toBeNull();
    });
  });

  // ── removeConversation ────────────────────────────────────────────────

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

    it('preserves activeConversationId when different conversation is removed', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation2);
      useDMStore.getState().setActiveConversation('conv-1');
      useDMStore.getState().removeConversation('conv-2');
      expect(useDMStore.getState().activeConversationId).toBe('conv-1');
    });

    it('only removes the targeted conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation2);
      useDMStore.getState().removeConversation('conv-1');
      expect(useDMStore.getState().conversations).toHaveLength(1);
      expect(useDMStore.getState().conversations[0].id).toBe('conv-2');
    });
  });

  // ── updateLastMessage ─────────────────────────────────────────────────

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

    it('re-sorts conversations by most recent message', () => {
      useDMStore.getState().addConversation(mockConversation); // created 2025-01-01
      useDMStore.getState().addConversation(mockConversation2); // created 2025-01-02 (prepended first)

      // Send a newer message to conv-1 (which is currently second/last in list)
      const lastMsg: DMLastMessage = {
        content: 'Newer message',
        userId: 'user-1',
        username: 'alice',
        createdAt: '2025-06-01T00:00:00Z',
        isEncrypted: false,
      };
      useDMStore.getState().updateLastMessage('conv-1', lastMsg);

      // conv-1 should now be first (most recent)
      expect(useDMStore.getState().conversations[0].id).toBe('conv-1');
    });

    it('sorts using createdAt as fallback when no lastMessage', () => {
      useDMStore.getState().addConversation(mockConversation); // 2025-01-01
      useDMStore.getState().addConversation(mockConversation2); // 2025-01-02

      // Send message only to conv-1
      const msg: DMLastMessage = {
        content: 'early',
        userId: 'user-1',
        username: 'alice',
        createdAt: '2024-01-01T00:00:00Z', // older than conv-2's createdAt
        isEncrypted: false,
      };
      useDMStore.getState().updateLastMessage('conv-1', msg);

      // conv-2 (no lastMessage, createdAt=2025-01-02) should sort before conv-1 (lastMessage=2024)
      expect(useDMStore.getState().conversations[0].id).toBe('conv-2');
    });
  });

  // ── Unread management ─────────────────────────────────────────────────

  describe('unread management', () => {
    it('incrementUnread increases count', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().incrementUnread('conv-1');
      useDMStore.getState().incrementUnread('conv-1');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(2);
    });

    it('incrementUnread is a no-op for non-existent conversation', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().incrementUnread('conv-999');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(0);
    });

    it('clearUnread resets count to 0', () => {
      useDMStore.getState().addConversation({ ...mockConversation, unreadCount: 5 });
      useDMStore.getState().clearUnread('conv-1');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(0);
    });

    it('clearUnread on already-zero is a no-op', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().clearUnread('conv-1');
      expect(useDMStore.getState().conversations[0].unreadCount).toBe(0);
    });
  });

  // ── setActiveConversation ─────────────────────────────────────────────

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

    it('can switch between conversations', () => {
      useDMStore.getState().setActiveConversation('conv-1');
      useDMStore.getState().setActiveConversation('conv-2');
      expect(useDMStore.getState().activeConversationId).toBe('conv-2');
    });
  });

  // ── DM voice call state ───────────────────────────────────────────────

  describe('DM voice call state', () => {
    it('sets DM call active with conversation', () => {
      useDMStore.getState().setDMCallActive(true, 'conv-1');
      expect(useDMStore.getState().dmCallActive).toBe(true);
      expect(useDMStore.getState().dmCallConversationId).toBe('conv-1');
    });

    it('clears DM call state when set inactive', () => {
      useDMStore.getState().setDMCallActive(true, 'conv-1');
      useDMStore.getState().setDMCallActive(false);
      expect(useDMStore.getState().dmCallActive).toBe(false);
      expect(useDMStore.getState().dmCallConversationId).toBeNull();
    });

    it('handles setDMCallActive(true) without conversationId', () => {
      useDMStore.getState().setDMCallActive(true);
      expect(useDMStore.getState().dmCallActive).toBe(true);
      expect(useDMStore.getState().dmCallConversationId).toBeNull();
    });

    it('clears conversationId when deactivating regardless of passed id', () => {
      useDMStore.getState().setDMCallActive(true, 'conv-1');
      useDMStore.getState().setDMCallActive(false, 'conv-1');
      expect(useDMStore.getState().dmCallConversationId).toBeNull();
    });
  });

  // ── updateParticipantProfile ──────────────────────────────────────────

  describe('updateParticipantProfile', () => {
    it('updates participant across all conversations', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().addConversation(mockConversation2); // also has user-2
      useDMStore.getState().updateParticipantProfile('user-2', { displayName: 'Bobby' });

      const conv1 = useDMStore.getState().conversations.find((c) => c.id === 'conv-1');
      const conv2 = useDMStore.getState().conversations.find((c) => c.id === 'conv-2');
      expect(conv1?.participants.find((p) => p.userId === 'user-2')?.displayName).toBe('Bobby');
      expect(conv2?.participants.find((p) => p.userId === 'user-2')?.displayName).toBe('Bobby');
    });

    it('does not affect other participants', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateParticipantProfile('user-2', { displayName: 'Bobby' });
      const alice = useDMStore
        .getState()
        .conversations[0].participants.find((p) => p.userId === 'user-1');
      expect(alice?.displayName).toBeUndefined();
    });

    it('updates multiple profile fields', () => {
      useDMStore.getState().addConversation(mockConversation);
      useDMStore.getState().updateParticipantProfile('user-2', {
        displayName: 'Bobby',
        avatarUrl: 'https://example.com/new.png',
        colorScheme: 'hacker',
        status: 'dnd',
      });
      const bob = useDMStore
        .getState()
        .conversations[0].participants.find((p) => p.userId === 'user-2');
      expect(bob?.displayName).toBe('Bobby');
      expect(bob?.avatarUrl).toBe('https://example.com/new.png');
      expect(bob?.colorScheme).toBe('hacker');
      expect(bob?.status).toBe('dnd');
    });
  });

  // ── fetchConversations ────────────────────────────────────────────────

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
      expect(state.conversations[0].id).toBe('conv-api-1');
      expect(state.conversations[0].participants).toHaveLength(2);
    });

    it('maps last_message from API response', async () => {
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
                participants: [],
                last_message: {
                  content: 'Hi!',
                  user_id: 'user-1',
                  username: 'alice',
                  created_at: '2025-01-01T12:00:00Z',
                  is_encrypted: false,
                },
                unread_count: 3,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useDMStore.getState().fetchConversations();
      const conv = useDMStore.getState().conversations[0];
      expect(conv.lastMessage?.content).toBe('Hi!');
      expect(conv.lastMessage?.userId).toBe('user-1');
      expect(conv.lastMessage?.isEncrypted).toBe(false);
      expect(conv.unreadCount).toBe(3);
    });

    it('sets error on API failure', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
        })
      );

      await useDMStore.getState().fetchConversations();
      expect(useDMStore.getState().error).toBe('Forbidden');
      expect(useDMStore.getState().isLoading).toBe(false);
    });

    it('uses generic error message when none provided', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({}, { status: 500 });
        })
      );

      await useDMStore.getState().fetchConversations();
      expect(useDMStore.getState().error).toBe('Failed to load conversations');
    });

    it('validates persisted activeConversationId against fetched conversations', async () => {
      // Set an active conversation that will not be in the API response
      useDMStore.setState({ activeConversationId: 'conv-gone' });

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
                participants: [],
                last_message: null,
                unread_count: 0,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useDMStore.getState().fetchConversations();
      // Since 'conv-gone' is not in the response, activeConversationId should be cleared
      expect(useDMStore.getState().activeConversationId).toBeNull();
    });

    it('preserves activeConversationId when it exists in fetched conversations', async () => {
      useDMStore.setState({ activeConversationId: 'conv-api-1' });

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
                participants: [],
                last_message: null,
                unread_count: 0,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useDMStore.getState().fetchConversations();
      expect(useDMStore.getState().activeConversationId).toBe('conv-api-1');
    });

    it('handles network error', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.error();
        })
      );

      await useDMStore.getState().fetchConversations();
      // Network errors produce the native fetch error message
      expect(useDMStore.getState().error).toBe('Failed to fetch');
    });

    it('handles empty conversations list', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({ conversations: [] });
        })
      );

      await useDMStore.getState().fetchConversations();
      expect(useDMStore.getState().conversations).toEqual([]);
    });

    it('does not fetch if already loading', async () => {
      let callCount = 0;
      server.use(
        http.get(`${API_BASE}/api/v1/dm/conversations`, () => {
          callCount++;
          return HttpResponse.json({ conversations: [] });
        })
      );

      useDMStore.setState({ isLoading: true });
      await useDMStore.getState().fetchConversations();
      expect(callCount).toBe(0);
    });
  });

  // ── openDM ────────────────────────────────────────────────────────────

  describe('openDM', () => {
    it('opens a DM and sets it as active', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({
            conversation: {
              id: 'conv-new',
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
          });
        })
      );

      const conv = await useDMStore.getState().openDM('user-2');
      expect(conv.id).toBe('conv-new');
      expect(useDMStore.getState().activeConversationId).toBe('conv-new');
      expect(useDMStore.getState().conversations).toHaveLength(1);
    });

    it('does not duplicate conversation if already present', async () => {
      useDMStore.getState().addConversation(mockConversation);

      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({
            conversation: {
              id: 'conv-1', // same as mockConversation
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
          });
        })
      );

      await useDMStore.getState().openDM('user-2');
      expect(useDMStore.getState().conversations).toHaveLength(1);
      expect(useDMStore.getState().activeConversationId).toBe('conv-1');
    });

    it('throws privacy error for dm_disabled', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({ error: 'dm_disabled' }, { status: 403 });
        })
      );

      await expect(useDMStore.getState().openDM('user-2')).rejects.toThrow(
        "This user isn't accepting DMs right now"
      );
    });

    it('throws privacy error for privacy_blocked', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({ error: 'privacy_blocked' }, { status: 403 });
        })
      );

      await expect(useDMStore.getState().openDM('user-2')).rejects.toThrow(
        "This user isn't accepting DMs right now"
      );
    });

    it('throws generic error for other API failures', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({ error: 'Server error' }, { status: 500 });
        })
      );

      await expect(useDMStore.getState().openDM('user-2')).rejects.toThrow('Server error');
    });

    it('uses generic error when none provided', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations`, () => {
          return HttpResponse.json({}, { status: 500 });
        })
      );

      await expect(useDMStore.getState().openDM('user-2')).rejects.toThrow('Failed to open DM');
    });
  });

  // ── createGroupDM ─────────────────────────────────────────────────────

  describe('createGroupDM', () => {
    it('creates a group DM and sets it as active', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/group`, () => {
          return HttpResponse.json({
            conversation: {
              id: 'conv-group-new',
              is_group: true,
              is_personal: false,
              name: 'My Group',
              is_encrypted: false,
              participants: [
                { user_id: 'user-1', username: 'alice' },
                { user_id: 'user-2', username: 'bob' },
                { user_id: 'user-3', username: 'charlie' },
              ],
              last_message: null,
              unread_count: 0,
              created_at: '2025-01-01T00:00:00Z',
            },
          });
        })
      );

      const conv = await useDMStore.getState().createGroupDM(['user-2', 'user-3'], 'My Group');
      expect(conv.id).toBe('conv-group-new');
      expect(conv.isGroup).toBe(true);
      expect(conv.name).toBe('My Group');
      expect(useDMStore.getState().activeConversationId).toBe('conv-group-new');
    });

    it('sends correct body to API', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/group`, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            conversation: {
              id: 'conv-group-new',
              is_group: true,
              is_personal: false,
              name: null,
              is_encrypted: false,
              participants: [],
              last_message: null,
              unread_count: 0,
              created_at: '2025-01-01T00:00:00Z',
            },
          });
        })
      );

      await useDMStore.getState().createGroupDM(['user-2', 'user-3']);
      expect(capturedBody).toEqual({ user_ids: ['user-2', 'user-3'] });
    });

    it('includes name when provided', async () => {
      let capturedBody: Record<string, unknown> | null = null;
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/group`, async ({ request }) => {
          capturedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({
            conversation: {
              id: 'conv-group-new',
              is_group: true,
              is_personal: false,
              name: 'Team Chat',
              is_encrypted: false,
              participants: [],
              last_message: null,
              unread_count: 0,
              created_at: '2025-01-01T00:00:00Z',
            },
          });
        })
      );

      await useDMStore.getState().createGroupDM(['user-2'], 'Team Chat');
      expect(capturedBody).toEqual({ user_ids: ['user-2'], name: 'Team Chat' });
    });

    it('throws on API error', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/group`, () => {
          return HttpResponse.json({ error: 'Too many members' }, { status: 400 });
        })
      );

      await expect(useDMStore.getState().createGroupDM(['user-2', 'user-3'])).rejects.toThrow(
        'Too many members'
      );
    });
  });

  // ── openPersonalThread ────────────────────────────────────────────────

  describe('openPersonalThread', () => {
    it('opens a personal thread and sets it active', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/personal`, () => {
          return HttpResponse.json({
            conversation: {
              id: 'conv-personal-new',
              is_group: false,
              is_personal: true,
              name: null,
              is_encrypted: false,
              participants: [{ user_id: 'user-1', username: 'alice' }],
              last_message: null,
              unread_count: 0,
              created_at: '2025-01-01T00:00:00Z',
            },
          });
        })
      );

      const conv = await useDMStore.getState().openPersonalThread();
      expect(conv.id).toBe('conv-personal-new');
      expect(conv.isPersonal).toBe(true);
      expect(useDMStore.getState().activeConversationId).toBe('conv-personal-new');
    });

    it('does not duplicate personal thread if already in list', async () => {
      useDMStore.getState().addConversation(mockPersonalConv);

      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/personal`, () => {
          return HttpResponse.json({
            conversation: {
              id: 'conv-personal', // same ID
              is_group: false,
              is_personal: true,
              name: null,
              is_encrypted: false,
              participants: [{ user_id: 'user-1', username: 'alice' }],
              last_message: null,
              unread_count: 0,
              created_at: '2025-01-03T00:00:00Z',
            },
          });
        })
      );

      await useDMStore.getState().openPersonalThread();
      expect(useDMStore.getState().conversations).toHaveLength(1);
    });

    it('throws on API error', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/personal`, () => {
          return HttpResponse.json({ error: 'Personal threads disabled' }, { status: 403 });
        })
      );

      await expect(useDMStore.getState().openPersonalThread()).rejects.toThrow(
        'Personal threads disabled'
      );
    });

    it('uses generic error when none provided', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/dm/conversations/personal`, () => {
          return HttpResponse.json({}, { status: 500 });
        })
      );

      await expect(useDMStore.getState().openPersonalThread()).rejects.toThrow(
        'Failed to open personal thread'
      );
    });
  });

  // ── clearDMs ──────────────────────────────────────────────────────────

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
      expect(state.dmCallConversationId).toBeNull();
    });
  });
});
