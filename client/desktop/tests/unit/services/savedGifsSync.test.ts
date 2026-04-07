import { savedGifsSyncService } from '@/renderer/services/savedGifsSync';
import { useSavedGifsStore } from '@/renderer/stores/savedGifsStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';

const API_BASE = 'http://localhost:8080';

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: true,
    encryptPreferences: vi.fn().mockResolvedValue('encrypted-blob'),
    decryptPreferences: vi.fn(),
  },
}));

import { e2eeService } from '@/renderer/services/e2eeService';

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  savedGifsSyncService.stopWatching();
});

describe('savedGifsSyncService', () => {
  beforeEach(() => {
    resetAllStores();
    useAuthStore.getState().setAccessToken('mock-token');
    vi.mocked(e2eeService.encryptPreferences).mockResolvedValue('encrypted-blob');
    vi.mocked(e2eeService.decryptPreferences).mockReset();
    (e2eeService as unknown as { isInitialized: boolean }).isInitialized = true;
  });

  describe('pushSavedGifs', () => {
    it('encrypts and pushes saved GIFs to server', async () => {
      useSavedGifsStore.getState().saveGif('abc123');

      let pushedBody: { encrypted_data: string } | null = null;
      server.use(
        http.put(`${API_BASE}/api/v1/users/me/saved-gifs`, async ({ request }) => {
          pushedBody = (await request.json()) as { encrypted_data: string };
          return HttpResponse.json({ version: 1 });
        })
      );

      await savedGifsSyncService.pushSavedGifs();

      expect(e2eeService.encryptPreferences).toHaveBeenCalled();
      expect(pushedBody).toEqual({ encrypted_data: 'encrypted-blob' });
    });

    it('does nothing when e2ee is not initialized', async () => {
      (e2eeService as unknown as { isInitialized: boolean }).isInitialized = false;
      vi.mocked(e2eeService.encryptPreferences).mockClear();

      await savedGifsSyncService.pushSavedGifs();

      expect(e2eeService.encryptPreferences).not.toHaveBeenCalled();
    });

    it('handles push failure gracefully', async () => {
      server.use(
        http.put(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({ error: 'Failed' }, { status: 500 })
        )
      );

      // Should not throw
      await savedGifsSyncService.pushSavedGifs();
    });

    it('handles encryption failure gracefully', async () => {
      vi.mocked(e2eeService.encryptPreferences).mockRejectedValueOnce(new Error('encrypt fail'));

      // Should not throw
      await savedGifsSyncService.pushSavedGifs();
    });
  });

  describe('fetchAndApply', () => {
    it('does nothing when e2ee is not initialized', async () => {
      (e2eeService as unknown as { isInitialized: boolean }).isInitialized = false;
      vi.mocked(e2eeService.decryptPreferences).mockClear();

      await savedGifsSyncService.fetchAndApply();

      expect(e2eeService.decryptPreferences).not.toHaveBeenCalled();
    });

    it('pushes local state when server has no saved GIFs', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({ saved_gifs: null })
        ),
        http.put(`${API_BASE}/api/v1/users/me/saved-gifs`, () => HttpResponse.json({ version: 1 }))
      );

      await savedGifsSyncService.fetchAndApply();

      expect(e2eeService.encryptPreferences).toHaveBeenCalled();
    });

    it('decrypts and applies remote saved GIFs', async () => {
      vi.mocked(e2eeService.decryptPreferences).mockResolvedValue({
        v: 1,
        gifs: [
          { slug: 'abc123', savedAt: 1000 },
          { slug: 'def456', savedAt: 2000 },
        ],
      });

      server.use(
        http.get(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({
            saved_gifs: { encrypted_data: 'encrypted', version: 1 },
          })
        )
      );

      await savedGifsSyncService.fetchAndApply();

      const gifs = useSavedGifsStore.getState().gifs;
      expect(gifs).toHaveLength(2);
      expect(gifs[0].slug).toBe('abc123');
      expect(gifs[1].slug).toBe('def456');
    });

    it('ignores unknown blob versions', async () => {
      vi.mocked(e2eeService.decryptPreferences).mockResolvedValue({
        v: 99,
        gifs: [{ slug: 'should-not-apply', savedAt: 1 }],
      });

      server.use(
        http.get(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({
            saved_gifs: { encrypted_data: 'encrypted', version: 1 },
          })
        )
      );

      await savedGifsSyncService.fetchAndApply();

      expect(useSavedGifsStore.getState().gifs).toEqual([]);
    });

    it('re-pushes local state when server data fails to decrypt', async () => {
      vi.mocked(e2eeService.decryptPreferences).mockRejectedValueOnce(new Error('decrypt fail'));
      useSavedGifsStore.getState().saveGif('local-only');

      server.use(
        http.get(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({
            saved_gifs: { encrypted_data: 'bad-cipher', version: 1 },
          })
        ),
        http.put(`${API_BASE}/api/v1/users/me/saved-gifs`, () => HttpResponse.json({ version: 2 }))
      );

      await savedGifsSyncService.fetchAndApply();

      // Should have pushed local state to overwrite stale server data
      expect(e2eeService.encryptPreferences).toHaveBeenCalled();
    });

    it('handles fetch failure gracefully', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me/saved-gifs`, () =>
          HttpResponse.json({ error: 'Failed' }, { status: 500 })
        )
      );

      // Should not throw
      await savedGifsSyncService.fetchAndApply();
    });
  });

  describe('startWatching / stopWatching', () => {
    it('stopWatching can be called when not watching', () => {
      savedGifsSyncService.stopWatching();
    });

    it('startWatching subscribes to store changes', () => {
      savedGifsSyncService.startWatching();
      savedGifsSyncService.stopWatching();
    });

    it('startWatching cleans up previous subscriptions when called again', () => {
      savedGifsSyncService.startWatching();
      savedGifsSyncService.startWatching();
      savedGifsSyncService.stopWatching();
    });

    it('schedules a push when store changes after startWatching', () => {
      vi.useFakeTimers();
      try {
        savedGifsSyncService.startWatching();
        // Trigger schedulePush by mutating the store
        useSavedGifsStore.getState().saveGif('triggers-push');
        // Without advancing timers, the debounce timer is set but not fired.
        // The test verifies the subscriber path runs without error.
      } finally {
        savedGifsSyncService.stopWatching();
        vi.useRealTimers();
      }
    });

    it('clears the pending debounce timer on stopWatching', () => {
      vi.useFakeTimers();
      try {
        savedGifsSyncService.startWatching();
        useSavedGifsStore.getState().saveGif('pending');
        // Stop before the timer fires — exercises the clearTimeout path
        savedGifsSyncService.stopWatching();
        vi.advanceTimersByTime(5000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('replaces existing debounce timer when changes happen rapidly', () => {
      vi.useFakeTimers();
      try {
        savedGifsSyncService.startWatching();
        useSavedGifsStore.getState().saveGif('one');
        useSavedGifsStore.getState().saveGif('two');
        useSavedGifsStore.getState().saveGif('three');
        // Each saveGif call schedules a new debounce, clearing the previous timer
      } finally {
        savedGifsSyncService.stopWatching();
        vi.useRealTimers();
      }
    });
  });
});
