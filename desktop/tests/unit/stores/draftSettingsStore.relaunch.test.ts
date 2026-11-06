import { useDraftSettingsStore } from '@/renderer/stores/ui/draftSettingsStore';
import { resetAllStores } from '../../helpers/store-helpers';

// Separate file: the main draftSettingsStore suite's `typeof import()` mock
// generics are a Semgrep partial-parse error, which fails the community scan
// for any PR that touches that file.
describe('draftSettingsStore apply: hardware acceleration', () => {
  beforeEach(() => {
    resetAllStores();
    useDraftSettingsStore.getState().teardown();
    vi.useFakeTimers();
  });

  afterEach(() => {
    useDraftSettingsStore.getState().teardown();
    vi.useRealTimers();
  });

  it('saves the hardware acceleration draft, then relaunches', async () => {
    const setHardwareAcceleration = vi.fn().mockResolvedValue(undefined);
    const relaunchApp = vi.fn().mockResolvedValue(undefined);
    Object.assign(globalThis.electron, { setHardwareAcceleration, relaunchApp });

    useDraftSettingsStore.getState().initialize();
    const next = !useDraftSettingsStore.getState().snapshot!.video.hardwareAcceleration;
    useDraftSettingsStore.getState().setVideoDraft('hardwareAcceleration', next);
    await useDraftSettingsStore.getState().apply();
    expect(relaunchApp).not.toHaveBeenCalled();

    vi.advanceTimersByTime(150);
    expect(setHardwareAcceleration).toHaveBeenCalledWith(next);
    expect(relaunchApp).toHaveBeenCalledTimes(1);
  });
});
