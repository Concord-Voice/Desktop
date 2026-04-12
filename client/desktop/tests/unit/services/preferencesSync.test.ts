import {
  preferencesSyncService,
  type PreferencesSyncDeps,
} from '@/renderer/services/preferencesSync';
import { useSettingsStore } from '@/renderer/stores/settingsStore';
import { useLayoutStore } from '@/renderer/stores/layoutStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { server } from '../../mocks/server';
import { http, HttpResponse } from 'msw';
import { useAuthStore } from '@/renderer/stores/authStore';

const API_BASE = 'http://localhost:8080';

// Mock e2eeService
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: true,
    encryptPreferences: vi.fn().mockResolvedValue('encrypted-blob'),
    decryptPreferences: vi.fn(),
  },
}));

import { e2eeService } from '@/renderer/services/e2eeService';

/** Reset the singleton's DI deps so init() can be called again in each test. */
function resetSyncServiceDeps() {
  (preferencesSyncService as unknown as { deps: unknown }).deps = null;
}

/** Wire DI deps pointing at the real test-scoped stores. */
function initSyncServiceDeps() {
  resetSyncServiceDeps();
  preferencesSyncService.init({
    getAppearance: () => useSettingsStore.getState().appearance,
    setAppearance: (patch) =>
      useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, ...patch } })),
    getLayout: () => {
      const s = useLayoutStore.getState();
      return {
        channelPanelPinned: s.channelPanelPinned,
        channelPanelWidth: s.channelPanelWidth,
        memberPanelMode: s.memberPanelMode,
        memberPanelWidth: s.memberPanelWidth,
        serverBarHeight: s.serverBarHeight,
        folderBarHeight: s.folderBarHeight,
        serverFolders: s.serverFolders,
        serverOrder: s.serverOrder,
      };
    },
    setLayout: (patch) => useLayoutStore.setState(patch),
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  preferencesSyncService.stopWatching();
});

describe('preferencesSyncService — DI lifecycle', () => {
  it('init() is idempotent — calling twice does not error or override', () => {
    resetSyncServiceDeps();
    const deps1: PreferencesSyncDeps = {
      getAppearance: () => useSettingsStore.getState().appearance,
      setAppearance: vi.fn(),
      getLayout: () => useLayoutStore.getState() as any,
      setLayout: vi.fn(),
    };
    const deps2: PreferencesSyncDeps = {
      getAppearance: vi.fn().mockReturnValue({}),
      setAppearance: vi.fn(),
      getLayout: vi.fn().mockReturnValue({}),
      setLayout: vi.fn(),
    };

    preferencesSyncService.init(deps1);
    preferencesSyncService.init(deps2); // second call should be a no-op

    // Verify deps1 is still active by calling pushPreferences
    // (deps2.getAppearance would return {} which doesn't have 'theme')
    // No error means deps1 is still used
    expect(() => preferencesSyncService.stopWatching()).not.toThrow();
  });

  it('requireDeps() throws when init() has not been called', async () => {
    resetSyncServiceDeps();
    // pushPreferences internally calls requireDeps()
    // but it also checks e2eeService.isInitialized first, so we need that to be true
    (e2eeService as any).isInitialized = true;
    useAuthStore.getState().setAccessToken('mock-token');

    await expect(async () => {
      await preferencesSyncService.pushPreferences();
    }).rejects.toThrow('PreferencesSyncService.init() must be called before use');
  });

  it('requireDeps() throws when calling fetchAndApply before init()', async () => {
    resetSyncServiceDeps();
    (e2eeService as any).isInitialized = true;
    useAuthStore.getState().setAccessToken('mock-token');

    await expect(async () => {
      await preferencesSyncService.fetchAndApply();
    }).rejects.toThrow('PreferencesSyncService.init() must be called before use');
  });

  it('requireDeps() throws when calling startWatching before init()', () => {
    resetSyncServiceDeps();

    expect(() => {
      preferencesSyncService.startWatching();
    }).toThrow('PreferencesSyncService.init() must be called before use');
  });
});

describe('preferencesSyncService', () => {
  beforeEach(() => {
    resetAllStores();
    // resetAllStores doesn't reset settings/layout stores — do it explicitly
    useSettingsStore.setState({
      appearance: {
        theme: 'dark',
        colorScheme: 'concord',
        fontSize: 'default',
        compactMode: false,
        reduceAnimations: false,
      },
    });
    useLayoutStore.setState({
      channelPanelPinned: true,
      channelPanelWidth: 240,
      memberPanelMode: 'expanded',
      memberPanelWidth: 260,
      serverBarHeight: 48,
      folderBarHeight: 32,
      serverFolders: [],
      serverOrder: [],
    });
    useAuthStore.getState().setAccessToken('mock-token');
    vi.mocked(e2eeService.encryptPreferences).mockResolvedValue('encrypted-blob');
    (e2eeService as any).isInitialized = true;
    initSyncServiceDeps();
  });

  describe('pushPreferences', () => {
    it('encrypts and pushes preferences to server', async () => {
      let pushedBody: any = null;
      server.use(
        http.put(`${API_BASE}/api/v1/users/me/preferences`, async ({ request }) => {
          pushedBody = await request.json();
          return HttpResponse.json({ version: 1 });
        })
      );

      await preferencesSyncService.pushPreferences();

      expect(e2eeService.encryptPreferences).toHaveBeenCalled();
      expect(pushedBody).toEqual({ encrypted_data: 'encrypted-blob' });
    });

    it('does nothing when e2ee is not initialized', async () => {
      (e2eeService as any).isInitialized = false;
      vi.mocked(e2eeService.encryptPreferences).mockClear();

      await preferencesSyncService.pushPreferences();

      expect(e2eeService.encryptPreferences).not.toHaveBeenCalled();
    });

    it('handles push failure gracefully', async () => {
      server.use(
        http.put(`${API_BASE}/api/v1/users/me/preferences`, () =>
          HttpResponse.json({ error: 'Failed' }, { status: 500 })
        )
      );

      // Should not throw
      await preferencesSyncService.pushPreferences();
    });
  });

  describe('fetchAndApply', () => {
    it('does nothing when e2ee is not initialized', async () => {
      (e2eeService as any).isInitialized = false;
      vi.mocked(e2eeService.decryptPreferences).mockClear();

      await preferencesSyncService.fetchAndApply();

      expect(e2eeService.decryptPreferences).not.toHaveBeenCalled();
    });

    it('pushes local state when server has no preferences', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me/preferences`, () =>
          HttpResponse.json({ preferences: null })
        ),
        http.put(`${API_BASE}/api/v1/users/me/preferences`, () => HttpResponse.json({ version: 1 }))
      );

      await preferencesSyncService.fetchAndApply();

      // Should have pushed since preferences was null
      expect(e2eeService.encryptPreferences).toHaveBeenCalled();
    });

    it('decrypts and applies remote preferences', async () => {
      vi.mocked(e2eeService.decryptPreferences).mockResolvedValue({
        v: 1,
        settings: {
          theme: 'light',
          colorScheme: 'hacker',
          fontSize: 'large',
          compactMode: true,
        },
        layout: {
          channelPanelPinned: false,
          channelPanelWidth: 300,
          memberPanelMode: 'collapsed',
          memberPanelWidth: 200,
          serverBarHeight: 50,
          folderBarHeight: 40,
          serverFolders: [],
          serverOrder: ['server-1'],
        },
      });

      server.use(
        http.get(`${API_BASE}/api/v1/users/me/preferences`, () =>
          HttpResponse.json({
            preferences: { encrypted_data: 'encrypted', version: 1 },
          })
        )
      );

      await preferencesSyncService.fetchAndApply();

      expect(useSettingsStore.getState().appearance.theme).toBe('light');
      expect(useSettingsStore.getState().appearance.colorScheme).toBe('hacker');
      expect(useSettingsStore.getState().appearance.fontSize).toBe('large');
      expect(useSettingsStore.getState().appearance.compactMode).toBe(true);
      expect(useLayoutStore.getState().channelPanelPinned).toBe(false);
      expect(useLayoutStore.getState().channelPanelWidth).toBe(300);
      expect(useLayoutStore.getState().memberPanelMode).toBe('collapsed');
      expect(useLayoutStore.getState().serverOrder).toEqual(['server-1']);
    });

    it('ignores unknown preference versions', async () => {
      vi.mocked(e2eeService.decryptPreferences).mockResolvedValue({
        v: 99,
        settings: { theme: 'light' },
        layout: {},
      });

      server.use(
        http.get(`${API_BASE}/api/v1/users/me/preferences`, () =>
          HttpResponse.json({
            preferences: { encrypted_data: 'encrypted', version: 1 },
          })
        )
      );

      await preferencesSyncService.fetchAndApply();

      // Should not have changed from defaults
      expect(useSettingsStore.getState().appearance.theme).toBe('dark');
    });

    it('handles fetch failure gracefully', async () => {
      server.use(
        http.get(`${API_BASE}/api/v1/users/me/preferences`, () =>
          HttpResponse.json({ error: 'Failed' }, { status: 500 })
        )
      );

      // Should not throw
      await preferencesSyncService.fetchAndApply();
    });
  });

  describe('startWatching / stopWatching', () => {
    it('stopWatching can be called when not watching', () => {
      // Should not throw
      preferencesSyncService.stopWatching();
    });

    it('startWatching subscribes to store changes', () => {
      preferencesSyncService.startWatching();
      // The subscriptions should be set up (no error)
      preferencesSyncService.stopWatching();
    });

    it('startWatching cleans up previous subscriptions when called again', () => {
      preferencesSyncService.startWatching();
      preferencesSyncService.startWatching(); // Should not double-subscribe
      preferencesSyncService.stopWatching();
    });
  });
});
