/**
 * Preferences Sync Service — encrypted cross-device sync for UI settings and layout.
 *
 * Watches settingsStore and layoutStore for changes, encrypts via e2eeService,
 * and pushes to the server. On login (or WebSocket notification from another device),
 * fetches + decrypts + applies remote preferences to local stores.
 */

import { e2eeService } from './e2eeService';
import { apiFetch } from './apiClient';
import { useSettingsStore, type AppearanceSettings } from '../stores/settingsStore';
import { useLayoutStore, type MemberPanelMode, type ServerFolder } from '../stores/layoutStore';

const DEBOUNCE_MS = 2000;

interface PreferencesBlob {
  v: 1;
  settings: AppearanceSettings;
  layout: {
    channelPanelPinned: boolean;
    channelPanelWidth: number;
    memberPanelMode: MemberPanelMode;
    memberPanelWidth: number;
    serverBarHeight: number;
    folderBarHeight: number;
    serverFolders: ServerFolder[];
    serverOrder: string[];
  };
}

class PreferencesSyncService {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: (() => void)[] = [];
  private isApplyingRemote = false;

  /**
   * Fetch preferences from server, decrypt, and apply to local stores.
   * If the server has no preferences yet, pushes current local state as initial sync.
   */
  async fetchAndApply(): Promise<void> {
    if (!e2eeService.isInitialized) return;

    try {
      const res = await apiFetch('/api/v1/users/me/preferences');
      if (!res.ok) {
        console.warn('[PrefsSync] Failed to fetch preferences:', res.status);
        return;
      }

      const data = await res.json();

      if (!data.preferences) {
        // First login — push local state as bootstrap
        console.debug('[PrefsSync] No server preferences, pushing local state');
        await this.pushPreferences();
        return;
      }

      const blob = await e2eeService.decryptPreferences<PreferencesBlob>(
        data.preferences.encrypted_data
      );

      if (blob.v !== 1) {
        console.warn('[PrefsSync] Unknown preferences version:', blob.v);
        return;
      }

      // Apply remote preferences to stores with echo guard
      this.isApplyingRemote = true;
      try {
        // Apply settings
        const settings = useSettingsStore.getState();
        if (blob.settings.theme !== settings.appearance.theme) {
          settings.setTheme(blob.settings.theme);
        }
        // Handle custom colors + color scheme together to avoid flickering
        if (blob.settings.colorScheme === 'custom' && blob.settings.customColors) {
          if (
            JSON.stringify(blob.settings.customColors) !==
            JSON.stringify(settings.appearance.customColors)
          ) {
            settings.setCustomColors(blob.settings.customColors); // also sets colorScheme to 'custom'
          } else if (blob.settings.colorScheme !== settings.appearance.colorScheme) {
            settings.setColorScheme(blob.settings.colorScheme);
          }
        } else if (blob.settings.colorScheme !== settings.appearance.colorScheme) {
          settings.setColorScheme(blob.settings.colorScheme);
        }
        if (blob.settings.fontSize !== settings.appearance.fontSize) {
          settings.setFontSize(blob.settings.fontSize);
        }
        if (blob.settings.compactMode !== settings.appearance.compactMode) {
          settings.setCompactMode(blob.settings.compactMode);
        }

        // Apply layout
        const layout = useLayoutStore.getState();
        if (blob.layout.channelPanelPinned !== layout.channelPanelPinned) {
          useLayoutStore.setState({ channelPanelPinned: blob.layout.channelPanelPinned });
        }
        if (blob.layout.channelPanelWidth !== layout.channelPanelWidth) {
          layout.setChannelPanelWidth(blob.layout.channelPanelWidth);
        }
        if (blob.layout.memberPanelMode !== layout.memberPanelMode) {
          layout.setMemberPanelMode(blob.layout.memberPanelMode);
        }
        if (blob.layout.memberPanelWidth !== layout.memberPanelWidth) {
          layout.setMemberPanelWidth(blob.layout.memberPanelWidth);
        }
        if (blob.layout.serverBarHeight !== layout.serverBarHeight) {
          layout.setServerBarHeight(blob.layout.serverBarHeight);
        }
        if (blob.layout.folderBarHeight !== layout.folderBarHeight) {
          layout.setFolderBarHeight(blob.layout.folderBarHeight);
        }
        if (JSON.stringify(blob.layout.serverFolders) !== JSON.stringify(layout.serverFolders)) {
          useLayoutStore.setState({ serverFolders: blob.layout.serverFolders });
        }
        if (JSON.stringify(blob.layout.serverOrder) !== JSON.stringify(layout.serverOrder)) {
          useLayoutStore.setState({ serverOrder: blob.layout.serverOrder });
        }
      } finally {
        // Clear after microtask so synchronous subscription callbacks see the flag
        setTimeout(() => {
          this.isApplyingRemote = false;
        }, 0);
      }

      console.debug('[PrefsSync] Applied remote preferences v' + data.preferences.version);
    } catch (err) {
      console.warn('[PrefsSync] Failed to fetch/apply preferences:', err);
    }
  }

  /**
   * Start watching local stores for changes and schedule debounced pushes.
   */
  startWatching(): void {
    this.stopWatching();

    // Watch settings store
    const unsubSettings = useSettingsStore.subscribe(
      (state) => state.appearance,
      () => this.schedulePush(),
      { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
    );
    this.unsubscribers.push(unsubSettings);

    // Watch layout store — select only the persisted fields
    const unsubLayout = useLayoutStore.subscribe(
      (state) => ({
        channelPanelPinned: state.channelPanelPinned,
        channelPanelWidth: state.channelPanelWidth,
        memberPanelMode: state.memberPanelMode,
        memberPanelWidth: state.memberPanelWidth,
        serverBarHeight: state.serverBarHeight,
        folderBarHeight: state.folderBarHeight,
        serverFolders: state.serverFolders,
        serverOrder: state.serverOrder,
      }),
      () => this.schedulePush(),
      { equalityFn: (a, b) => JSON.stringify(a) === JSON.stringify(b) }
    );
    this.unsubscribers.push(unsubLayout);
  }

  /**
   * Stop watching stores and clear pending debounce.
   */
  stopWatching(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Collect current state, encrypt, and push to server.
   */
  async pushPreferences(): Promise<void> {
    if (!e2eeService.isInitialized) return;

    try {
      const settings = useSettingsStore.getState().appearance;
      const layout = useLayoutStore.getState();

      const blob: PreferencesBlob = {
        v: 1,
        settings: {
          theme: settings.theme,
          colorScheme: settings.colorScheme,
          fontSize: settings.fontSize,
          compactMode: settings.compactMode,
          reduceAnimations: settings.reduceAnimations,
          customColors: settings.customColors,
        },
        layout: {
          channelPanelPinned: layout.channelPanelPinned,
          channelPanelWidth: layout.channelPanelWidth,
          memberPanelMode: layout.memberPanelMode,
          memberPanelWidth: layout.memberPanelWidth,
          serverBarHeight: layout.serverBarHeight,
          folderBarHeight: layout.folderBarHeight,
          serverFolders: layout.serverFolders,
          serverOrder: layout.serverOrder,
        },
      };

      const encrypted = await e2eeService.encryptPreferences(blob);

      const res = await apiFetch('/api/v1/users/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encrypted_data: encrypted }),
      });

      if (!res.ok) {
        console.warn('[PrefsSync] Push failed:', res.status);
      } else {
        const data = await res.json();
        console.debug('[PrefsSync] Pushed preferences v' + data.version);
      }
    } catch (err) {
      console.warn('[PrefsSync] Push error:', err);
    }
  }

  private schedulePush(): void {
    if (this.isApplyingRemote) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pushPreferences();
    }, DEBOUNCE_MS);
  }
}

// Singleton
export const preferencesSyncService = new PreferencesSyncService();
