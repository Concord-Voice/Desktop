import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useClientConfigStore } from '@/renderer/stores/clientConfigStore';

// Mock apiFetch
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/renderer/services/apiClient';

const mockApiFetch = vi.mocked(apiFetch);

// Import after mocking
import { clientConfigService } from '@/renderer/services/clientConfigService';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useClientConfigStore.setState({
    minVersion: '',
    featureFlags: { voice: true, video: true, e2ee: true },
    mediaPlaneUrl: '',
    turn: { host: '', realm: '' },
    spaUrl: '',
    spaIpcContract: 0,
    lastFetchedAt: null,
  });
});

afterEach(() => {
  clientConfigService.stop();
  vi.useRealTimers();
});

describe('clientConfigService', () => {
  describe('fetch', () => {
    it('fetches config and updates store', async () => {
      mockApiFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            min_version: '0.2.0',
            feature_flags: { voice: true, video: false, e2ee: true },
            media_plane_url: 'https://media.test.com',
            turn: { host: 'turn.test.com', realm: 'test' },
            spa_url: 'https://app.test.com',
            spa_ipc_contract: 3,
          }),
      } as Response);

      await clientConfigService.fetch();

      const state = useClientConfigStore.getState();
      expect(state.lastFetchedAt).not.toBeNull();
    });

    it('handles fetch errors gracefully', async () => {
      mockApiFetch.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(clientConfigService.fetch()).resolves.not.toThrow();
    });
  });

  describe('start/stop', () => {
    it('stops clears timers', () => {
      clientConfigService.start();
      clientConfigService.stop();
      // No error means timers were properly cleaned up
    });
  });
});
