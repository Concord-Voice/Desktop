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
});
