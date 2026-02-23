import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';

describe('authStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('starts with null tokens', () => {
    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('setTokens stores both tokens', () => {
    useAuthStore.getState().setTokens('access-123', 'refresh-456');
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('access-123');
    expect(state.refreshToken).toBe('refresh-456');
  });

  it('setTokens with undefined refreshToken keeps it null', () => {
    useAuthStore.getState().setTokens('access-123', undefined);
    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('access-123');
    expect(state.refreshToken).toBeNull();
  });

  it('clearTokens removes both tokens', () => {
    useAuthStore.getState().setTokens('access', 'refresh');
    useAuthStore.getState().clearTokens();
    const state = useAuthStore.getState();
    expect(state.accessToken).toBeNull();
    expect(state.refreshToken).toBeNull();
  });

  it('setRememberMe updates the flag', () => {
    expect(useAuthStore.getState().rememberMe).toBe(true);
    useAuthStore.getState().setRememberMe(false);
    expect(useAuthStore.getState().rememberMe).toBe(false);
  });

  it('persists tokens to localStorage', () => {
    useAuthStore.getState().setTokens('access', 'refresh');
    const stored = JSON.parse(localStorage.getItem('concord-auth') || '{}');
    expect(stored.state?.accessToken).toBe('access');
  });

  it('clearTokens clears persisted state', () => {
    useAuthStore.getState().setTokens('access', 'refresh');
    useAuthStore.getState().clearTokens();
    const stored = JSON.parse(localStorage.getItem('concord-auth') || '{}');
    expect(stored.state?.accessToken).toBeNull();
  });
});
