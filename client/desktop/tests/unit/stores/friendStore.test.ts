import { useFriendStore, type Friend, type FriendRequest } from '@/renderer/stores/friendStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:8080';

const mockFriend: Friend = {
  id: 'friendship-1',
  userId: 'user-2',
  username: 'bob',
  displayName: 'Bob',
  status: 'offline',
};

const mockRequest: FriendRequest = {
  id: 'req-1',
  fromUserId: 'user-3',
  fromUsername: 'charlie',
  toUserId: 'user-1',
  toUsername: 'alice',
  direction: 'received',
  createdAt: '2025-01-01T00:00:00Z',
};

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
});

describe('friendStore', () => {
  describe('real-time update actions', () => {
    it('addFriend adds to list', () => {
      useFriendStore.getState().addFriend(mockFriend);
      expect(useFriendStore.getState().friends).toHaveLength(1);
      expect(useFriendStore.getState().friends[0].userId).toBe('user-2');
    });

    it('removeFriendByUserId removes from list', () => {
      useFriendStore.getState().addFriend(mockFriend);
      useFriendStore.getState().removeFriendByUserId('user-2');
      expect(useFriendStore.getState().friends).toHaveLength(0);
    });

    it('addRequest adds to pending list', () => {
      useFriendStore.getState().addRequest(mockRequest);
      expect(useFriendStore.getState().pendingRequests).toHaveLength(1);
    });

    it('removeRequest removes from pending list', () => {
      useFriendStore.getState().addRequest(mockRequest);
      useFriendStore.getState().removeRequest('req-1');
      expect(useFriendStore.getState().pendingRequests).toHaveLength(0);
    });

    it('updateFriendPresence changes status', () => {
      useFriendStore.getState().addFriend(mockFriend);
      useFriendStore.getState().updateFriendPresence('user-2', 'online');
      expect(useFriendStore.getState().friends[0].status).toBe('online');
    });

    it('updateFriendProfile updates display info', () => {
      useFriendStore.getState().addFriend(mockFriend);
      useFriendStore.getState().updateFriendProfile('user-2', { displayName: 'Bobby' });
      expect(useFriendStore.getState().friends[0].displayName).toBe('Bobby');
    });
  });

  describe('fetchFriends', () => {
    it('loads friends from API', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/friends`, () => {
          return HttpResponse.json({
            friends: [
              {
                id: 'f-1',
                user_id: 'user-2',
                username: 'bob',
                display_name: 'Bob',
                color_scheme: null,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useFriendStore.getState().fetchFriends();
      expect(useFriendStore.getState().friends).toHaveLength(1);
      expect(useFriendStore.getState().isLoading).toBe(false);
    });
  });

  describe('fetchRequests', () => {
    it('loads requests from API', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/friends/requests`, () => {
          return HttpResponse.json({
            requests: [
              {
                id: 'req-api-1',
                from_user_id: 'user-3',
                from_username: 'charlie',
                to_user_id: 'user-1',
                to_username: 'alice',
                direction: 'received',
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          });
        })
      );

      await useFriendStore.getState().fetchRequests();
      expect(useFriendStore.getState().pendingRequests).toHaveLength(1);
    });
  });

  describe('sendRequest', () => {
    it('sends a friend request by user ID', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/friends/request`, () => {
          return HttpResponse.json({ id: 'req-new', status: 'pending' }, { status: 201 });
        })
      );

      await useFriendStore.getState().sendRequest('user-5');
      expect(useFriendStore.getState().error).toBeNull();
    });
  });

  describe('blockUser', () => {
    it('blocks a user via API', async () => {
      server.use(
        http.post(`${API_BASE}/api/v1/friends/:userId/block`, () => {
          return HttpResponse.json({ message: 'User blocked' });
        })
      );

      useFriendStore.getState().addFriend(mockFriend);
      await useFriendStore.getState().blockUser('user-2');
      // Friend should be removed from list after blocking
      expect(useFriendStore.getState().friends).toHaveLength(0);
    });
  });

  describe('clearFriends', () => {
    it('resets all friend state', () => {
      useFriendStore.getState().addFriend(mockFriend);
      useFriendStore.getState().addRequest(mockRequest);

      useFriendStore.getState().clearFriends();

      const state = useFriendStore.getState();
      expect(state.friends).toHaveLength(0);
      expect(state.pendingRequests).toHaveLength(0);
      expect(state.error).toBeNull();
    });
  });
});
