import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@/renderer/services/apiClient', () => ({
  refreshAccessToken: vi.fn(),
}));

import { runPreflight, markRendererCrashed, clearCrashFlag } from '@/renderer/services/recoveryService';
import { refreshAccessToken } from '@/renderer/services/apiClient';

const mockRefresh = vi.mocked(refreshAccessToken);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // Reset navigator.onLine
  Object.defineProperty(navigator, 'onLine', { value: true, writable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recoveryService', () => {
  describe('runPreflight', () => {
    it('returns all-healthy when everything works', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      mockRefresh.mockResolvedValue('new-token');

      const results = await runPreflight();
      expect(results.internet).toBe(true);
      expect(results.serverReachable).toBe(true);
      expect(results.tokenValid).toBe(true);
      expect(results.sessionRevoked).toBe(false);
      expect(results.rendererStable).toBe(true);
    });

    it('returns internet=false when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false });

      const results = await runPreflight();
      expect(results.internet).toBe(false);
      expect(results.serverReachable).toBe(false);
      expect(results.tokenValid).toBe(false);
    });

    it('returns serverReachable=false when health check fails', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true }) // internet check
        .mockResolvedValueOnce({ ok: false }); // health check

      const results = await runPreflight();
      expect(results.internet).toBe(true);
      expect(results.serverReachable).toBe(false);
    });

    it('returns tokenValid=false when refresh fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      mockRefresh.mockResolvedValue(null);

      const results = await runPreflight();
      expect(results.tokenValid).toBe(false);
      expect(results.sessionRevoked).toBe(true);
    });

    it('returns rendererStable=false after crash', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      mockRefresh.mockResolvedValue('new-token');
      markRendererCrashed();

      const results = await runPreflight();
      expect(results.rendererStable).toBe(false);
    });
  });

  describe('markRendererCrashed', () => {
    it('sets sessionStorage crash flag', () => {
      markRendererCrashed();
      expect(sessionStorage.getItem('concord:renderer-crashed')).not.toBeNull();
    });
  });

  describe('clearCrashFlag', () => {
    it('removes sessionStorage crash flag', () => {
      markRendererCrashed();
      clearCrashFlag();
      expect(sessionStorage.getItem('concord:renderer-crashed')).toBeNull();
    });
  });
});
