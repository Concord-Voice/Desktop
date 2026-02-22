import { create } from 'zustand';
import { persist, subscribeWithSelector } from 'zustand/middleware';

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  colorScheme: 'concord' | 'morky' | 'bardic' | 'hacker' | 'foxden' | 'spooky' | 'leviathan' | 'grassynill' | 'cottoncandy' | 'driftwood' | 'eclipse' | 'midnightsky';
  fontSize: 'small' | 'default' | 'large';
  compactMode: boolean;
  reduceAnimations: boolean;
}

interface SettingsState {
  appearance: AppearanceSettings;
  setTheme: (theme: AppearanceSettings['theme']) => void;
  setColorScheme: (scheme: AppearanceSettings['colorScheme']) => void;
  setFontSize: (size: AppearanceSettings['fontSize']) => void;
  setCompactMode: (enabled: boolean) => void;
  setReduceAnimations: (enabled: boolean) => void;
}

const defaultAppearance: AppearanceSettings = {
  theme: 'dark',
  colorScheme: 'concord',
  fontSize: 'default',
  compactMode: false,
  reduceAnimations: false,
};

function resolveTheme(theme: AppearanceSettings['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function applyTheme(theme: AppearanceSettings['theme']) {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

function applyColorScheme(scheme: AppearanceSettings['colorScheme']) {
  document.documentElement.dataset.scheme = scheme;
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

export const useSettingsStore = create<SettingsState>()(
  persist(
    subscribeWithSelector((set) => ({
      appearance: defaultAppearance,

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
    })),
    {
      name: 'concord-settings',
    }
  )
);

// Subscribe to theme changes and apply to DOM
let systemThemeCleanup: (() => void) | null = null;

useSettingsStore.subscribe(
  (state) => state.appearance.theme,
  (theme) => {
    // Clean up previous system theme listener
    if (systemThemeCleanup) {
      systemThemeCleanup();
      systemThemeCleanup = null;
    }

    applyTheme(theme);

    // If 'system', listen for OS theme changes
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme('system');
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
