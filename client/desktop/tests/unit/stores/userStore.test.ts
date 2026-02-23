import { useUserStore } from '@/renderer/stores/userStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockUser } from '../../mocks/fixtures';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:8080';

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: () => ({
    disconnect: vi.fn(),
    sendProfileUpdate: vi.fn(),
  }),
  ConnectionState: { CONNECTED: 'connected', DISCONNECTED: 'disconnected' },
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: { clearKeys: vi.fn(), isInitialized: false, initialize: vi.fn() },
}));

vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: { stopWatching: vi.fn(), pushPreferences: vi.fn() },
}));

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('userStore', () => {
  beforeEach(() => {
    resetAllStores();
    useAuthStore.getState().setTokens('mock-token', 'mock-refresh');
  });

  it('starts with null user and not loading', () => {
    resetAllStores();
    const state = useUserStore.getState();
    expect(state.user).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  describe('setUser', () => {
    it('sets the user and clears loading/error', () => {
      useUserStore.setState({ isLoading: true, error: 'old' });
      useUserStore.getState().setUser(mockUser);
      const state = useUserStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
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
      await useUserStore.getState().fetchUser();
      expect(useUserStore.getState().user).not.toBeNull();
      expect(useUserStore.getState().user?.username).toBe(mockUser.username);
      expect(useUserStore.getState().isLoading).toBe(false);
    });

    it('clears auth on 401', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me`, () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
        )
      );
      await useUserStore.getState().fetchUser();
      expect(useUserStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });

    it('sets error on failure', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me`, () =>
          HttpResponse.json({ error: 'Server error' }, { status: 500 })
        )
      );
      await useUserStore.getState().fetchUser();
      expect(useUserStore.getState().error).toBe('Server error');
    });
  });

  describe('updateProfile', () => {
    it('updates profile and sets user', async () => {
      server.use(
        http.patch(`${API_BASE}/api/v1/users/me`, () =>
          HttpResponse.json({ user: { ...mockUser, display_name: 'Updated' } })
        )
      );
      await useUserStore.getState().updateProfile({ display_name: 'Updated' });
      expect(useUserStore.getState().user?.display_name).toBe('Updated');
    });

    it('throws on non-ok response', async () => {
      server.use(
        http.patch(`${API_BASE}/api/v1/users/me`, () =>
          HttpResponse.json({ error: 'Invalid avatar' }, { status: 400 })
        )
      );
      await expect(
        useUserStore.getState().updateProfile({ avatar_url: 'bad' })
      ).rejects.toThrow('Invalid avatar');
    });

    it('clears auth on 401', async () => {
      server.use(
        http.patch(`${API_BASE}/api/v1/users/me`, () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })
        )
      );
      await expect(
        useUserStore.getState().updateProfile({ display_name: 'x' })
      ).rejects.toThrow('Session expired');
      expect(useAuthStore.getState().accessToken).toBeNull();
    });
  });

  describe('logout', () => {
    it('clears user, auth, and calls cleanup', async () => {
      useUserStore.getState().setUser(mockUser);
      await useUserStore.getState().logout();
      expect(useUserStore.getState().user).toBeNull();
      expect(useAuthStore.getState().accessToken).toBeNull();
    });
  });
});
