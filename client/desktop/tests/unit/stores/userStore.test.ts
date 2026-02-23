import { useUserStore } from '@/renderer/stores/userStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockUser } from '../../mocks/fixtures';
import { server } from '../../mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('userStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  describe('setUser', () => {
    it('sets the user', () => {
      useUserStore.getState().setUser(mockUser);
      expect(useUserStore.getState().user).toEqual(mockUser);
    });
  });

  describe('clearUser', () => {
    it('clears user state', () => {
      useUserStore.getState().setUser(mockUser);
      useUserStore.getState().clearUser();
      expect(useUserStore.getState().user).toBeNull();
    });
  });

  describe('fetchUser', () => {
    it('fetches user from API', async () => {
      // Need auth token for API call
      const { useAuthStore } = await import('@/renderer/stores/authStore');
      useAuthStore.getState().setTokens('mock-token', 'mock-refresh');
      await useUserStore.getState().fetchUser();
      expect(useUserStore.getState().user).not.toBeNull();
      expect(useUserStore.getState().isLoading).toBe(false);
    });
  });

  it('starts with null user and not loading', () => {
    const state = useUserStore.getState();
    expect(state.user).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });
});
