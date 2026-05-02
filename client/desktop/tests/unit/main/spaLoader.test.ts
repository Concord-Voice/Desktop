import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron's `net` module before importing the module under test.
vi.mock('electron', () => {
  const fetch = vi.fn();
  return {
    net: { fetch },
    __mocks__: { fetch },
  };
});

// Mock tokenManager so getPersistedApiBase is controllable per test.
vi.mock('@/main/tokenManager', () => {
  const getPersistedApiBase = vi.fn();
  return { getPersistedApiBase };
});

// Mock IPC contract version to a known value.
vi.mock('@/main/ipcContract', () => ({ IPC_CONTRACT_VERSION: 7 }));

import { net } from 'electron';
import { getPersistedApiBase } from '@/main/tokenManager';
import { resolveSpaSource, isUnexpectedBundled } from '@/main/spaLoader';

const mockNet = net as unknown as { fetch: ReturnType<typeof vi.fn> };
const mockGetApiBase = getPersistedApiBase as unknown as ReturnType<typeof vi.fn>;

function mockConfigResponse(spaUrl: string | undefined, spaIpcContract: number | undefined) {
  const body = { spaUrl, spaIpcContract };
  mockNet.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

describe('spaLoader — defensive /api/v1/spa/ sentinel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApiBase.mockReturnValue('https://api.concordvoice.chat');
  });

  it('rejects spaUrl with /api/v1/spa/ pathname as poisoned sentinel', async () => {
    mockConfigResponse('https://api.concordvoice.chat/api/v1/spa/abc1234/index.html', 7);
    const result = await resolveSpaSource();
    expect(result.mode).toBe('bundled');
    expect(result.reason).toMatch(/poisoned sentinel|legacy \/api\/v1\/spa\//);
  });

  it('does NOT reject adjacent /api/v1/client/config paths (narrow match)', async () => {
    // /api/v1/client/config would never be a legitimate spaUrl, but this confirms
    // the sentinel matches narrowly on /api/v1/spa/ and not on the broader /api/.
    mockConfigResponse('https://api.concordvoice.chat/api/v1/client/config', 7);
    const result = await resolveSpaSource();
    // Not rejected by the sentinel. (Will still fall back to bundled for other
    // reasons, but the reason string must NOT mention the sentinel.)
    expect(result.reason).not.toMatch(/poisoned sentinel|legacy \/api\/v1\/spa\//);
  });

  it('allows legitimate /spa/ pathname past the sentinel', async () => {
    mockConfigResponse('https://api.concordvoice.chat/spa/abc1234/index.html', 7);
    const result = await resolveSpaSource();
    expect(result.mode).toBe('remote');
    expect(result.url).toBe('https://api.concordvoice.chat/spa/abc1234/index.html');
  });
});

describe('isUnexpectedBundled', () => {
  it('treats first-launch reason as expected', () => {
    expect(isUnexpectedBundled('no persisted API base (first launch or logged out)')).toBe(false);
  });

  it('treats no-spaUrl-configured as expected', () => {
    expect(isUnexpectedBundled('server has no spaUrl configured')).toBe(false);
  });

  it('treats spaIpcContract-zero as expected', () => {
    expect(isUnexpectedBundled('server spaIpcContract is zero or absent')).toBe(false);
  });

  it('treats config-fetch-returned as UNEXPECTED', () => {
    expect(isUnexpectedBundled('config fetch returned 500')).toBe(true);
  });

  it('treats config-fetch-failed as UNEXPECTED', () => {
    expect(isUnexpectedBundled('config fetch failed: timeout after 5000ms')).toBe(true);
  });

  it('treats spaUrl-rejected as UNEXPECTED', () => {
    expect(isUnexpectedBundled('spaUrl rejected: non-HTTPS protocol http:')).toBe(true);
    expect(isUnexpectedBundled('spaUrl rejected: invalid URL')).toBe(true);
    expect(
      isUnexpectedBundled('spaUrl rejected: legacy /api/v1/spa/ path (poisoned sentinel)')
    ).toBe(true);
  });

  it('treats IPC-contract-mismatch as UNEXPECTED (shell needs update)', () => {
    expect(isUnexpectedBundled('IPC contract 8 < required 9 — shell update needed')).toBe(true);
  });

  it('treats unknown reasons as UNEXPECTED (fail-loud)', () => {
    expect(isUnexpectedBundled('something we did not anticipate')).toBe(true);
  });
});
