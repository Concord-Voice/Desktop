import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetAllStores } from '../../helpers/store-helpers';

// We need to test apiClient which uses global fetch and authStore
// Import the store directly
import { useAuthStore } from '@/renderer/stores/authStore';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after mocking fetch
const { apiFetch, API_BASE } = await import('@/renderer/services/apiClient');

describe('apiClient', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('injects Authorization header when token exists', async () => {
    useAuthStore.getState().setTokens('test-token', 'test-refresh');
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
    useAuthStore.getState().setTokens('test-token', 'test-refresh');
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await apiFetch('/api/v1/test');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('attempts token refresh on 401', async () => {
    useAuthStore.getState().setTokens('old-token', 'test-refresh');

    // First call: 401
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    // Refresh call: success
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'new-token' }), { status: 200 })
    );
    // Retry call: success
    mockFetch.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

    const response = await apiFetch('/api/v1/test');

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Verify refresh endpoint was called
    expect(mockFetch.mock.calls[1][0]).toBe(`${API_BASE}/api/v1/auth/refresh`);
    // Verify retry has new token
    const retryHeaders = mockFetch.mock.calls[2][1].headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer new-token');
  });

  it('clears tokens when refresh fails', async () => {
    useAuthStore.getState().setTokens('old-token', 'test-refresh');

    // First call: 401
    mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    // Refresh call: failure
    mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));

    const response = await apiFetch('/api/v1/test');

    expect(response.status).toBe(401);
    expect(useAuthStore.getState().accessToken).toBeNull();
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
