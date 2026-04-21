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
      // Calling stop again should be idempotent (no double-clear errors)
      expect(() => clientConfigService.stop()).not.toThrow();
    });
  });

  describe('log sanitization', () => {
    it('does not log server-returned SPA URL when SPA update triggers reload', async () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Seed store with a previous spaUrl so the update-reload branch triggers
      useClientConfigStore.setState({ spaUrl: 'https://old.app.test/' });

      mockApiFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            minVersion: '0.3.0',
            featureFlags: { voice: true, video: true, e2ee: true },
            mediaPlaneUrl: 'https://media.test/',
            turn: { host: 'turn.test', realm: 'r' },
            spaUrl: 'https://new.app.test/secret-subdomain/',
            spaIpcContract: 1,
          }),
      } as Response);

      // globalThis.location.reload would navigate; stub it. Capture the
      // original descriptor so we can restore jsdom's full Location object
      // after the test — otherwise the stub leaks into later tests.
      const reloadSpy = vi.fn();
      const originalLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');

      try {
        Object.defineProperty(globalThis, 'location', {
          value: { reload: reloadSpy },
          writable: true,
          configurable: true,
        });

        await clientConfigService.fetch();

        // Sanity check: prove the SPA-update-reload branch was actually entered.
        // Without this, the sanitization asserts below are vacuous — they would
        // pass even if the code leaked nextSpaUrl, because the log line wouldn't
        // be reached. A prior iteration of this test used snake_case keys that
        // didn't match the ServerConfigResponse camelCase contract, making the
        // whole test a no-op.
        expect(reloadSpy).toHaveBeenCalled();

        // Assert NO log call contains the server-returned URL substrings
        for (const call of debugSpy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain('new.app.test');
            expect(String(arg)).not.toContain('secret-subdomain');
            expect(String(arg)).not.toContain('0.3.0');
          }
        }
        for (const call of warnSpy.mock.calls) {
          for (const arg of call) {
            expect(String(arg)).not.toContain('new.app.test');
          }
        }
      } finally {
        // Restore original location descriptor so later tests get jsdom's
        // full Location object back.
        if (originalLocationDescriptor) {
          Object.defineProperty(globalThis, 'location', originalLocationDescriptor);
        }
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('does not pass raw Error object to console.warn on fetch error', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockApiFetch.mockRejectedValue(new Error('boom'));

      await clientConfigService.fetch();

      // Every warn call's arguments must be strings — never an Error instance
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          expect(arg).not.toBeInstanceOf(Error);
        }
      }

      warnSpy.mockRestore();
    });

    it('does not log HTTP status when fetch fails with non-ok response', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockApiFetch.mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      } as Response);

      await clientConfigService.fetch();

      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain('503');
        }
      }

      warnSpy.mockRestore();
    });
  });
});
