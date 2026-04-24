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
import { resolveSpaSource } from '@/main/spaLoader';

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
