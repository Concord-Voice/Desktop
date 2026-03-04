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

const DEBOUNCE_MS = 3000;

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

      // Apply remote preferences to stores with echo guard.
      // Batch all updates into single setState calls to avoid cascading re-renders.
      this.isApplyingRemote = true;
      try {
        // Batch settings — single state update
        const currentAppearance = useSettingsStore.getState().appearance;
        const newAppearance = { ...currentAppearance };
        let settingsChanged = false;

        if (blob.settings.theme !== currentAppearance.theme) {
          newAppearance.theme = blob.settings.theme;
          settingsChanged = true;
        }
        if (blob.settings.colorScheme === 'custom' && blob.settings.customColors) {
          if (
            JSON.stringify(blob.settings.customColors) !==
            JSON.stringify(currentAppearance.customColors)
          ) {
            newAppearance.customColors = blob.settings.customColors;
            newAppearance.colorScheme = 'custom';
            settingsChanged = true;
          } else if (blob.settings.colorScheme !== currentAppearance.colorScheme) {
            newAppearance.colorScheme = blob.settings.colorScheme;
            settingsChanged = true;
          }
        } else if (blob.settings.colorScheme !== currentAppearance.colorScheme) {
          newAppearance.colorScheme = blob.settings.colorScheme;
          settingsChanged = true;
        }
        if (blob.settings.fontSize !== currentAppearance.fontSize) {
          newAppearance.fontSize = blob.settings.fontSize;
          settingsChanged = true;
        }
        if (blob.settings.compactMode !== currentAppearance.compactMode) {
          newAppearance.compactMode = blob.settings.compactMode;
          settingsChanged = true;
        }

        if (settingsChanged) {
          useSettingsStore.setState({ appearance: newAppearance });
        }

        // Batch layout — single state update
        const currentLayout = useLayoutStore.getState();
        const layoutPatch: Record<string, unknown> = {};

        if (blob.layout.channelPanelPinned !== currentLayout.channelPanelPinned) {
          layoutPatch.channelPanelPinned = blob.layout.channelPanelPinned;
        }
        if (blob.layout.channelPanelWidth !== currentLayout.channelPanelWidth) {
          layoutPatch.channelPanelWidth = Math.max(
            180,
            Math.min(400, blob.layout.channelPanelWidth)
          );
        }
        if (blob.layout.memberPanelMode !== currentLayout.memberPanelMode) {
          layoutPatch.memberPanelMode = blob.layout.memberPanelMode;
        }
        if (blob.layout.memberPanelWidth !== currentLayout.memberPanelWidth) {
          layoutPatch.memberPanelWidth = Math.max(160, Math.min(340, blob.layout.memberPanelWidth));
        }
        if (blob.layout.serverBarHeight !== currentLayout.serverBarHeight) {
          layoutPatch.serverBarHeight = Math.max(36, Math.min(64, blob.layout.serverBarHeight));
        }
        if (blob.layout.folderBarHeight !== currentLayout.folderBarHeight) {
          layoutPatch.folderBarHeight = Math.max(24, Math.min(48, blob.layout.folderBarHeight));
        }
        if (
          JSON.stringify(blob.layout.serverFolders) !== JSON.stringify(currentLayout.serverFolders)
        ) {
          layoutPatch.serverFolders = blob.layout.serverFolders;
        }
        if (JSON.stringify(blob.layout.serverOrder) !== JSON.stringify(currentLayout.serverOrder)) {
          layoutPatch.serverOrder = blob.layout.serverOrder;
        }

        if (Object.keys(layoutPatch).length > 0) {
          useLayoutStore.setState(layoutPatch);
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
