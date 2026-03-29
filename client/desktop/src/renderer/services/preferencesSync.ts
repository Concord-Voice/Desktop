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

/** Diff and apply remote appearance settings to the local settings store. */
function applyRemoteAppearance(remote: AppearanceSettings): void {
  const current = useSettingsStore.getState().appearance;
  const patched = { ...current };
  let changed = false;

  if (remote.theme !== current.theme) {
    patched.theme = remote.theme;
    changed = true;
  }
  if (remote.fontSize !== current.fontSize) {
    patched.fontSize = remote.fontSize;
    changed = true;
  }
  if (remote.compactMode !== current.compactMode) {
    patched.compactMode = remote.compactMode;
    changed = true;
  }

  // Color scheme: handle 'custom' with customColors specially
  if (remote.colorScheme === 'custom' && remote.customColors) {
    if (JSON.stringify(remote.customColors) !== JSON.stringify(current.customColors)) {
      patched.customColors = remote.customColors;
      patched.colorScheme = 'custom';
      changed = true;
    } else if (remote.colorScheme !== current.colorScheme) {
      patched.colorScheme = remote.colorScheme;
      changed = true;
    }
  } else if (remote.colorScheme !== current.colorScheme) {
    patched.colorScheme = remote.colorScheme;
    changed = true;
  }

  if (changed) {
    useSettingsStore.setState({ appearance: patched });
  }
}

/** Diff and apply remote layout preferences to the local layout store. */
function applyRemoteLayout(remote: PreferencesBlob['layout']): void {
  const current = useLayoutStore.getState();
  const patch: Record<string, unknown> = {};

  // Scalar fields with min/max clamping
  const clampedFields: { key: keyof typeof remote; min: number; max: number }[] = [
    { key: 'channelPanelWidth', min: 180, max: 400 },
    { key: 'memberPanelWidth', min: 160, max: 340 },
    { key: 'serverBarHeight', min: 36, max: 64 },
    { key: 'folderBarHeight', min: 24, max: 48 },
  ];
  for (const { key, min, max } of clampedFields) {
    if (remote[key] !== current[key]) {
      patch[key] = Math.max(min, Math.min(max, remote[key] as number));
    }
  }

  // Boolean / enum fields
  if (remote.channelPanelPinned !== current.channelPanelPinned) {
    patch.channelPanelPinned = remote.channelPanelPinned;
  }
  if (remote.memberPanelMode !== current.memberPanelMode) {
    patch.memberPanelMode = remote.memberPanelMode;
  }

  // Deep-compared fields
  if (JSON.stringify(remote.serverFolders) !== JSON.stringify(current.serverFolders)) {
    patch.serverFolders = remote.serverFolders;
  }
  if (JSON.stringify(remote.serverOrder) !== JSON.stringify(current.serverOrder)) {
    patch.serverOrder = remote.serverOrder;
  }

  if (Object.keys(patch).length > 0) {
    useLayoutStore.setState(patch);
  }
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

      let blob: PreferencesBlob;
      try {
        blob = await e2eeService.decryptPreferences<PreferencesBlob>(
          data.preferences.encrypted_data
        );
      } catch {
        // Preferences encrypted with a different key (e.g., after PBKDF2→Argon2id migration).
        // Push current local state to overwrite stale server data.
        console.warn(
          '[PrefsSync] Cannot decrypt server preferences, re-encrypting with current key'
        );
        await this.pushPreferences();
        return;
      }

      if (blob.v !== 1) {
        console.warn('[PrefsSync] Unknown preferences version:', blob.v);
        return;
      }

      // Apply remote preferences to stores with echo guard.
      // Batch all updates into single setState calls to avoid cascading re-renders.
      this.isApplyingRemote = true;
      try {
        applyRemoteAppearance(blob.settings);
        applyRemoteLayout(blob.layout);
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

      if (res.ok) {
        const data = await res.json();
        console.debug('[PrefsSync] Pushed preferences v' + data.version);
      } else {
        console.warn('[PrefsSync] Push failed:', res.status);
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
