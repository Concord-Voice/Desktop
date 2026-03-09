import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetAllStores } from '../../helpers/store-helpers';

// We need to test apiClient which uses global fetch and authStore
// Import the store directly
import { useAuthStore } from '@/renderer/stores/authStore';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after mocking fetch
const { apiFetch, API_BASE, _resetRefreshState } = await import('@/renderer/services/apiClient');

describe('apiClient', () => {
  beforeEach(() => {
    resetAllStores();
    _resetRefreshState();
    vi.clearAllMocks();
  });

  it('injects Authorization header when token exists', async () => {
    useAuthStore.getState().setAccessToken('test-token');
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await apiFetch('/api/v1/test');

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/test`,
      expect.objectContaining({
        headers: expect.any(Headers),
        credentials: 'include',
      })
    );

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer test-token');
  });

  it('does not inject Authorization header when no token', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await apiFetch('/api/v1/test');

    const headers = mockFetch.mock.calls[0][1].headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });

  it('returns response as-is for non-401 status', async () => {
    useAuthStore.getState().setAccessToken('test-token');
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await apiFetch('/api/v1/test');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('attempts token refresh on 401 via IPC', async () => {
    useAuthStore.getState().setAccessToken('old-token');

    // Mock the electron IPC refresh — returns a new access token
    window.electron = {
      refreshToken: vi.fn().mockResolvedValue({ status: 'ok', accessToken: 'new-token' }),
    } as any;

    // First call: 401
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    // Retry call after IPC refresh: success
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await apiFetch('/api/v1/test');

    expect(response.status).toBe(200);
    expect(window.electron!.refreshToken).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Verify retry has new token
    const retryHeaders = mockFetch.mock.calls[1][1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-token');
    // Verify new token is stored in authStore
    expect(useAuthStore.getState().accessToken).toBe('new-token');
  });

  it('clears disk tokens when IPC refresh fails and rememberMe is off', async () => {
    useAuthStore.getState().setAccessToken('old-token');
    useAuthStore.getState().setRememberMe(false);

    // Mock the electron IPC refresh — returns failure
    const mockClearTokens = vi.fn();
    window.electron = {
      refreshToken: vi.fn().mockResolvedValue({ status: 'error' }),
      clearTokens: mockClearTokens,
    } as any;

    // First call: 401
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    const response = await apiFetch('/api/v1/test');

    expect(response.status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBeNull();
    // nuclearReset calls clearTokens internally
    expect(mockClearTokens).toHaveBeenCalledTimes(1);
    // Should not retry — only the original fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves disk tokens when IPC refresh fails and rememberMe is on', async () => {
    useAuthStore.getState().setAccessToken('old-token');
    useAuthStore.getState().setRememberMe(true);

    // Mock the electron IPC refresh — returns failure
    const mockClearTokens = vi.fn();
    window.electron = {
      refreshToken: vi.fn().mockResolvedValue({ status: 'error' }),
      clearTokens: mockClearTokens,
    } as any;

    // First call: 401
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));

    const response = await apiFetch('/api/v1/test');

    expect(response.status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBeNull();
    // gracefulReset preserves disk tokens for Remember Me session restore
    expect(mockClearTokens).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes through request init options', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await apiFetch('/api/v1/test', {
      method: 'POST',
      body: JSON.stringify({ data: 'test' }),
    });

    expect(mockFetch.mock.calls[0][1].method).toBe('POST');
    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ data: 'test' }));
  });

  it('always includes credentials', async () => {
    mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await apiFetch('/api/v1/test');

    expect(mockFetch.mock.calls[0][1].credentials).toBe('include');
  });
});
