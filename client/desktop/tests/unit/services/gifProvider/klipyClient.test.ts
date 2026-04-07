import { klipyClient } from '@/renderer/services/gifProvider/klipyClient';
import { useClientConfigStore } from '@/renderer/stores/clientConfigStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// Mock apiFetch — proxy mode goes through it. Direct mode uses bare fetch.
const apiFetchMock = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Stub global fetch for direct-mode requests
const globalFetchMock = vi.fn();

beforeAll(() => {
  globalThis.fetch = globalFetchMock as unknown as typeof fetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('klipyClient', () => {
  beforeEach(() => {
    resetAllStores();
    apiFetchMock.mockReset();
    globalFetchMock.mockReset();
    // Default: KLIPY API key set in client config
    useClientConfigStore.setState({
      featureFlags: { voice: true, video: true, e2ee: true, klipyApiKey: 'test-app-key' },
    });
    // Fully reset the singleton client (clears cached customer_id between tests)
    (klipyClient as unknown as { _resetForTesting: () => void })._resetForTesting();
    localStorage.clear();
  });

  describe('proxy mode toggle', () => {
    it('uses direct fetch when proxy is OFF', async () => {
      klipyClient.setProxyEnabled(false);
      klipyClient.setPersonalizationEnabled(false); // skip customer_id fetch
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      expect(globalFetchMock).toHaveBeenCalled();
      expect(apiFetchMock).not.toHaveBeenCalled();
      const url = globalFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('https://api.klipy.com/api/v1/test-app-key/gifs/trending');
    });

    it('uses apiFetch (with auth) when proxy is ON', async () => {
      klipyClient.setProxyEnabled(true);
      klipyClient.setPersonalizationEnabled(false);
      apiFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      expect(apiFetchMock).toHaveBeenCalled();
      expect(globalFetchMock).not.toHaveBeenCalled();
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/klipy/gifs/trending');
      // Proxy mode does NOT include the app_key in the URL — the proxy injects it server-side
      expect(url).not.toContain('test-app-key');
    });
  });

  describe('customer_id personalization', () => {
    it('skips customer_id when personalization is OFF', async () => {
      klipyClient.setPersonalizationEnabled(false);
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      const url = globalFetchMock.mock.calls[0][0] as string;
      expect(url).not.toContain('customer_id=');
    });

    it('fetches and caches customer_id from /randomid when personalization is ON', async () => {
      klipyClient.setPersonalizationEnabled(true);
      // First call: /randomid → returns ID. Second call: trending → uses ID.
      globalFetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { random_id: 'cust-abc-123' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      // Two fetches: randomid + trending
      expect(globalFetchMock).toHaveBeenCalledTimes(2);
      expect(globalFetchMock.mock.calls[0][0]).toContain('/randomid');
      expect(globalFetchMock.mock.calls[1][0]).toContain('customer_id=cust-abc-123');
    });

    it('persists customer_id to localStorage and reuses it on subsequent calls', async () => {
      klipyClient.setPersonalizationEnabled(true);
      globalFetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { random_id: 'cust-xyz' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      await klipyClient.trending(2, 25);
      // /randomid only called once
      const randomIdCalls = globalFetchMock.mock.calls.filter((call) =>
        (call[0] as string).includes('/randomid')
      );
      expect(randomIdCalls).toHaveLength(1);
      expect(localStorage.getItem('concord:klipy-customer-id')).toBe('cust-xyz');
    });

    it('reads cached customer_id from localStorage on first use', async () => {
      localStorage.setItem('concord:klipy-customer-id', 'pre-cached-id');
      klipyClient.setPersonalizationEnabled(true);
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      // No /randomid call — used the cached value
      const randomIdCalls = globalFetchMock.mock.calls.filter((call) =>
        (call[0] as string).includes('/randomid')
      );
      expect(randomIdCalls).toHaveLength(0);
      const trendingUrl = globalFetchMock.mock.calls[0][0] as string;
      expect(trendingUrl).toContain('customer_id=pre-cached-id');
    });

    it('handles result envelope variant for /randomid response', async () => {
      klipyClient.setPersonalizationEnabled(true);
      globalFetchMock
        .mockResolvedValueOnce(jsonResponse({ result: { random_id: 'envelope-variant' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      expect(globalFetchMock.mock.calls[1][0]).toContain('customer_id=envelope-variant');
    });

    it('returns null and skips customer_id when /randomid fails', async () => {
      klipyClient.setPersonalizationEnabled(true);
      globalFetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'oops' }, 500))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }));
      await klipyClient.trending(1, 25);
      expect(globalFetchMock.mock.calls[1][0]).not.toContain('customer_id=');
    });
  });

  describe('endpoint methods', () => {
    beforeEach(() => {
      // Skip customer_id for these tests so we have one fetch per call
      klipyClient.setPersonalizationEnabled(false);
    });

    it('search forwards the query, page, per_page, and locale', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.search('cats', 2, 10, 'fr');
      const url = globalFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/gifs/search');
      expect(url).toContain('q=cats');
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=10');
      expect(url).toContain('locale=fr');
      expect(url).toContain('format_filter=mp4%2Cgif%2Cwebp');
    });

    it('search throws on non-OK upstream response', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ error: 'oops' }, 500));
      await expect(klipyClient.search('cats', 1, 25)).rejects.toThrow(/search failed: 500/);
    });

    it('trending throws on non-OK upstream response', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ error: 'oops' }, 500));
      await expect(klipyClient.trending(1, 25)).rejects.toThrow(/trending failed: 500/);
    });

    it('recent returns empty when personalization is OFF (no customer_id)', async () => {
      klipyClient.setPersonalizationEnabled(false);
      const r = await klipyClient.recent(1, 25);
      expect(r.data).toEqual([]);
      expect(r.has_more).toBe(false);
      // No fetch should have been issued
      expect(globalFetchMock).not.toHaveBeenCalled();
    });

    it('recent calls the customer-scoped endpoint when personalization is ON', async () => {
      klipyClient.setPersonalizationEnabled(true);
      globalFetchMock
        .mockResolvedValueOnce(jsonResponse({ data: { random_id: 'recent-customer' } }))
        .mockResolvedValueOnce(jsonResponse({ data: [], has_more: false }));
      await klipyClient.recent(1, 25);
      const recentCall = globalFetchMock.mock.calls[1][0] as string;
      expect(recentCall).toContain('/gifs/recent/recent-customer');
    });

    it('categories optionally forwards locale', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      await klipyClient.categories('en');
      const url = globalFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/gifs/categories?locale=en');
    });

    it('categories without locale omits the query string', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      await klipyClient.categories();
      const url = globalFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/gifs/categories');
      expect(url).not.toContain('?');
    });

    it('getBySlug returns the first item from the items endpoint', async () => {
      globalFetchMock.mockResolvedValue(
        jsonResponse({
          data: [{ slug: 'abc', file: { gif: { url: 'https://media.klipy.com/abc.gif' } } }],
        })
      );
      const item = await klipyClient.getBySlug('abc');
      expect(item).not.toBeNull();
      expect(item?.slug).toBe('abc');
    });

    it('getBySlug returns null on non-OK response', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 404));
      const item = await klipyClient.getBySlug('missing');
      expect(item).toBeNull();
    });

    it('getBySlug returns null when the response has no items', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({ data: [] }));
      const item = await klipyClient.getBySlug('empty');
      expect(item).toBeNull();
    });

    it('notifyShared sends a POST to /gifs/share/{slug}', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({}));
      await klipyClient.notifyShared('test-slug');
      expect(globalFetchMock).toHaveBeenCalled();
      const url = globalFetchMock.mock.calls[0][0] as string;
      const init = globalFetchMock.mock.calls[0][1] as RequestInit;
      expect(url).toContain('/gifs/share/test-slug');
      expect(init?.method).toBe('POST');
    });

    it('notifyShared swallows errors in direct mode', async () => {
      globalFetchMock.mockRejectedValue(new Error('boom'));
      await expect(klipyClient.notifyShared('test-slug')).resolves.toBeUndefined();
    });

    it('report sends a POST to /gifs/report/{slug}', async () => {
      globalFetchMock.mockResolvedValue(jsonResponse({}));
      await klipyClient.report('bad-slug');
      const url = globalFetchMock.mock.calls[0][0] as string;
      const init = globalFetchMock.mock.calls[0][1] as RequestInit;
      expect(url).toContain('/gifs/report/bad-slug');
      expect(init?.method).toBe('POST');
    });
  });

  describe('proxy mode endpoint paths', () => {
    beforeEach(() => {
      klipyClient.setProxyEnabled(true);
      klipyClient.setPersonalizationEnabled(false);
    });

    it('search routes through /api/v1/klipy/gifs/search in proxy mode', async () => {
      apiFetchMock.mockResolvedValue(jsonResponse({ data: [], has_more: false }));
      await klipyClient.search('cats', 1, 25);
      expect(apiFetchMock).toHaveBeenCalled();
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/api/v1/klipy/gifs/search');
      expect(url).not.toContain('test-app-key');
    });

    it('media binaries are not handled by klipyClient — only API calls', async () => {
      // The media proxy is hit directly via <img src> / <video src>, not via klipyClient
      // This test just confirms there's no media-related public method on the client
      // (defensive — if someone adds one in the future, this test breaks and reminds them
      // to update the privacy/proxy reasoning).
      const methods = Object.keys(klipyClient).filter(
        (k) => typeof (klipyClient as Record<string, unknown>)[k] === 'function'
      );
      expect(methods.find((m) => m.toLowerCase().includes('media'))).toBeUndefined();
    });
  });
});
