import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { wrapStore } from '../utils/createStore';
import {
  type CustomColors,
  deriveThemeVariables,
  applyCustomThemeVariables,
  clearCustomThemeVariables,
} from '../utils/colorUtils';
import { DEFAULT_CLIENT_BEHAVIOR, type ClientBehavior } from '../../shared/clientBehavior';
import { deriveOverlayColors } from '../utils/overlayColors';
import { useUserStore } from './userStore';
import { useMemberStore } from './memberStore';
let syncSuppressed = false;

/** Called by draftSettingsStore to suppress color-scheme sync during draft mode. */
export function setSyncSuppressed(suppressed: boolean): void {
  syncSuppressed = suppressed;
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  colorScheme:
    | 'concord'
    | 'morky'
    | 'bardic'
    | 'hacker'
    | 'foxden'
    | 'spooky'
    | 'leviathan'
    | 'grassynill'
    | 'cottoncandy'
    | 'driftwood'
    | 'eclipse'
    | 'midnightsky'
    | 'agency'
    | 'defacto'
    | 'custom';
  fontSize: 'small' | 'default' | 'large';
  compactMode: boolean;
  reduceAnimations: boolean;
  customColors: CustomColors | null;
}

export type { CustomColors } from '../utils/colorUtils';

interface SettingsState {
  appearance: AppearanceSettings;
  clientBehavior: ClientBehavior;
  setTheme: (theme: AppearanceSettings['theme']) => void;
  setColorScheme: (scheme: AppearanceSettings['colorScheme']) => void;
  setFontSize: (size: AppearanceSettings['fontSize']) => void;
  setCompactMode: (enabled: boolean) => void;
  setReduceAnimations: (enabled: boolean) => void;
  setCustomColors: (colors: CustomColors) => void;
  setClientBehavior: (value: ClientBehavior) => void;
}

const defaultAppearance: AppearanceSettings = {
  theme: 'dark',
  colorScheme: 'concord',
  fontSize: 'default',
  compactMode: false,
  reduceAnimations: false,
  customColors: null,
};

function resolveTheme(theme: AppearanceSettings['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function applyTheme(theme: AppearanceSettings['theme']) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

function applyColorScheme(scheme: AppearanceSettings['colorScheme']) {
  if (scheme === 'custom') {
    // Clear data-scheme so no CSS scheme block applies; custom vars handled by subscriber
    delete document.documentElement.dataset.scheme;
  } else {
    // Clear any inline custom theme variables from a previous custom scheme
    clearCustomThemeVariables();
    document.documentElement.dataset.scheme = scheme;
  }
}

function applyFontSize(fontSize: AppearanceSettings['fontSize']) {
  document.documentElement.dataset.fontsize = fontSize;
}

function applyCompactMode(enabled: boolean) {
  document.documentElement.dataset.compact = enabled ? 'true' : 'false';
}

function applyReduceAnimations(enabled: boolean) {
  document.documentElement.dataset.reduceAnimations = enabled ? 'true' : 'false';
}

export const useSettingsStore = wrapStore(
  create<SettingsState>()(
    persist(
      subscribeWithSelector((set) => ({
        appearance: defaultAppearance,
        clientBehavior: DEFAULT_CLIENT_BEHAVIOR,

        setTheme: (theme) =>
          set((state) => ({
            appearance: { ...state.appearance, theme },
          })),

        setColorScheme: (colorScheme) =>
          set((state) => ({
            appearance: { ...state.appearance, colorScheme },
          })),

        setFontSize: (fontSize) =>
          set((state) => ({
            appearance: { ...state.appearance, fontSize },
          })),

        setCompactMode: (compactMode) =>
          set((state) => ({
            appearance: { ...state.appearance, compactMode },
          })),

        setReduceAnimations: (reduceAnimations) =>
          set((state) => ({
            appearance: { ...state.appearance, reduceAnimations },
          })),

        setCustomColors: (customColors) =>
          set((state) => ({
            appearance: { ...state.appearance, customColors, colorScheme: 'custom' as const },
          })),

        setClientBehavior: (value: ClientBehavior) => {
          set({ clientBehavior: value });
          // Push to main so the close/minimize intercepts see the new value.
          // Fire-and-forget — the main-side cache is best-effort; on a stale
          // value the worst case is one fallback click before the next renderer
          // mount re-pushes. .catch silences unhandled-rejection if the IPC
          // bridge is absent (e.g. in unit tests that mock partial electron).
          void globalThis.electron?.window?.setClientBehavior?.(value)?.catch?.(() => {});
        },
      })),
      {
        name: 'concord-settings',
        merge: (persisted, current) => {
          const p = persisted as Partial<SettingsState> | undefined;
          return {
            ...current,
            ...p,
            appearance: { ...defaultAppearance, ...p?.appearance },
            clientBehavior: { ...DEFAULT_CLIENT_BEHAVIOR, ...p?.clientBehavior },
          };
        },
      }
    )
  )
);

// Subscribe to theme changes and apply to DOM
let systemThemeCleanup: (() => void) | null = null;

function pushOverlayColorsForTheme(theme: AppearanceSettings['theme']): void {
  // #806 Task 22: keep the per-platform titleBarOverlay color in sync with
  // the user's theme. Resolve 'system' to the OS-reported effective theme.
  // macOS ignores titleBarOverlay (uses native traffic lights) so the IPC
  // is a no-op there, but the push is unconditional — the main handler
  // tolerates the call. Fire-and-forget per internal-reference
  const resolved = resolveTheme(theme);
  void globalThis.electron?.window
    ?.setTitleBarOverlayColor?.(deriveOverlayColors(resolved))
    ?.catch?.(() => {});
}

useSettingsStore.subscribe(
  (state) => state.appearance.theme,
  (theme) => {
    // Clean up previous system theme listener
    if (systemThemeCleanup) {
      systemThemeCleanup();
      systemThemeCleanup = null;
    }

    applyTheme(theme);
    pushOverlayColorsForTheme(theme);

    // If 'system', listen for OS theme changes
    if (theme === 'system') {
      const mediaQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        applyTheme('system');
        pushOverlayColorsForTheme('system');
      };
      mediaQuery.addEventListener('change', handler);
      systemThemeCleanup = () => mediaQuery.removeEventListener('change', handler);
    }
  },
  { fireImmediately: true }
);

// Subscribe to color scheme changes and apply to DOM
useSettingsStore.subscribe(
  (state) => state.appearance.colorScheme,
  (colorScheme) => applyColorScheme(colorScheme),
  { fireImmediately: true }
);

// Subscribe to font size changes and apply to DOM
useSettingsStore.subscribe(
  (state) => state.appearance.fontSize,
  (fontSize) => applyFontSize(fontSize),
  { fireImmediately: true }
);

// Subscribe to compact mode changes and apply to DOM
useSettingsStore.subscribe(
  (state) => state.appearance.compactMode,
  (compactMode) => applyCompactMode(compactMode),
  { fireImmediately: true }
);

// Subscribe to reduce animations changes and apply to DOM
useSettingsStore.subscribe(
  (state) => state.appearance.reduceAnimations,
  (reduceAnimations) => applyReduceAnimations(reduceAnimations),
  { fireImmediately: true }
);

// Subscribe to custom colors + theme changes — derive and apply inline CSS variables
useSettingsStore.subscribe(
  (state) => ({
    colorScheme: state.appearance.colorScheme,
    customColors: state.appearance.customColors,
    theme: state.appearance.theme,
  }),
  ({ colorScheme, customColors, theme }) => {
    if (colorScheme === 'custom' && customColors) {
      const isDark = resolveTheme(theme) === 'dark';
      const vars = deriveThemeVariables(customColors, isDark);
      applyCustomThemeVariables(vars);
      // Cache derived vars for flash-free startup
      try {
        localStorage.setItem('concord-custom-theme-vars', JSON.stringify(vars));
      } catch {
        // Ignore storage errors
      }
    }
  },
  {
    equalityFn: (a, b) =>
      a.colorScheme === b.colorScheme &&
      a.theme === b.theme &&
      JSON.stringify(a.customColors) === JSON.stringify(b.customColors),
    fireImmediately: true,
  }
);

// Sync color scheme + theme mode changes to server profile (debounced, skips initial hydration)
let colorSyncTimer: ReturnType<typeof setTimeout> | null = null;
let colorSyncInitial = true;

/**
 * Build the color_scheme JSON payload, optimistically update memberStore,
 * and sync to server. Called from both the settings subscriber and
 * draftSettingsStore.apply() (since the subscriber is suppressed during draft mode).
 */
export function syncColorSchemeToServer() {
  const { colorScheme, customColors, theme } = useSettingsStore.getState().appearance;
  const themeMode = resolveTheme(theme);
  let payload: string;
  if (colorScheme === 'custom' && customColors) {
    payload = JSON.stringify({
      scheme: 'custom',
      themeMode,
      accentPrimary: customColors.accentPrimary,
      accentSecondary: customColors.accentSecondary,
    });
  } else {
    payload = JSON.stringify({ scheme: colorScheme, themeMode });
  }

  // Optimistically update memberStore so identity components reflect the
  // new scheme immediately (without waiting for the server roundtrip)
  const selfId = useUserStore.getState().user?.id;
  if (selfId) {
    useMemberStore.getState().updateMemberProfile(selfId, { color_scheme: payload });
  }

  // Server sync
  useUserStore
    .getState()
    .updateProfile({ color_scheme: payload })
    .catch(() => {
      // Fire-and-forget — local settings still work if server sync fails
    });
}

useSettingsStore.subscribe(
  (state) => ({
    colorScheme: state.appearance.colorScheme,
    customColors: state.appearance.customColors,
    theme: state.appearance.theme,
  }),
  () => {
    // Skip the initial hydration from localStorage
    if (colorSyncInitial) {
      colorSyncInitial = false;
      return;
    }

    // Suppress server sync during draft mode — sync happens on Apply
    if (syncSuppressed) return;

    // Debounced sync
    if (colorSyncTimer) clearTimeout(colorSyncTimer);
    colorSyncTimer = setTimeout(syncColorSchemeToServer, 500);
  },
  {
    equalityFn: (a, b) =>
      a.colorScheme === b.colorScheme &&
      a.theme === b.theme &&
      JSON.stringify(a.customColors) === JSON.stringify(b.customColors),
    fireImmediately: true,
  }
);
