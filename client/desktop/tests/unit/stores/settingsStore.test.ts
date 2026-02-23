import { useSettingsStore } from '@/renderer/stores/settingsStore';
import { resetAllStores } from '../../helpers/store-helpers';

describe('settingsStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('has default values', () => {
    const { appearance } = useSettingsStore.getState();
    expect(appearance.theme).toBe('dark');
    expect(appearance.colorScheme).toBe('concord');
    expect(appearance.fontSize).toBe('default');
    expect(appearance.compactMode).toBe(false);
    expect(appearance.reduceAnimations).toBe(false);
  });

  it('setTheme updates theme', () => {
    useSettingsStore.getState().setTheme('light');
    expect(useSettingsStore.getState().appearance.theme).toBe('light');
  });

  it('setColorScheme updates scheme', () => {
    useSettingsStore.getState().setColorScheme('morky');
    expect(useSettingsStore.getState().appearance.colorScheme).toBe('morky');
  });

  it('setFontSize updates size', () => {
    useSettingsStore.getState().setFontSize('large');
    expect(useSettingsStore.getState().appearance.fontSize).toBe('large');
  });

  it('setCompactMode toggles compact mode', () => {
    useSettingsStore.getState().setCompactMode(true);
    expect(useSettingsStore.getState().appearance.compactMode).toBe(true);
  });

  it('setReduceAnimations toggles animations', () => {
    useSettingsStore.getState().setReduceAnimations(true);
    expect(useSettingsStore.getState().appearance.reduceAnimations).toBe(true);
  });

  describe('DOM attribute application', () => {
    it('applies theme to data-theme attribute', () => {
      useSettingsStore.getState().setTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
    });

    it('applies color scheme to data-scheme attribute', () => {
      useSettingsStore.getState().setColorScheme('hacker');
      expect(document.documentElement.dataset.scheme).toBe('hacker');
    });

    it('applies font size to data-fontsize attribute', () => {
      useSettingsStore.getState().setFontSize('large');
      expect(document.documentElement.dataset.fontsize).toBe('large');
    });

    it('applies compact mode to data-compact attribute', () => {
      useSettingsStore.getState().setCompactMode(true);
      expect(document.documentElement.dataset.compact).toBe('true');
    });

    it('applies reduce animations to data-reduce-animations attribute', () => {
      useSettingsStore.getState().setReduceAnimations(true);
      expect(document.documentElement.dataset.reduceAnimations).toBe('true');
    });
  });

  describe('persistence', () => {
    it('persists settings to localStorage', () => {
      useSettingsStore.getState().setTheme('light');
      useSettingsStore.getState().setColorScheme('morky');
      const stored = JSON.parse(localStorage.getItem('concord-settings') || '{}');
      expect(stored.state?.appearance?.theme).toBe('light');
      expect(stored.state?.appearance?.colorScheme).toBe('morky');
    });
  });
});
