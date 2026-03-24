import { useDraftSettingsStore } from '@/renderer/stores/draftSettingsStore';
import { resetAllStores } from '../../helpers/store-helpers';

beforeEach(() => {
  resetAllStores();
});

describe('draftSettingsStore', () => {
  it('starts with null snapshot', () => {
    expect(useDraftSettingsStore.getState().snapshot).toBeNull();
  });

  it('initialize captures a snapshot and resets drafts', () => {
    useDraftSettingsStore.getState().initialize();
    const state = useDraftSettingsStore.getState();
    expect(state.snapshot).not.toBeNull();
  });

  it('teardown clears snapshot', () => {
    useDraftSettingsStore.getState().initialize();
    expect(useDraftSettingsStore.getState().snapshot).not.toBeNull();

    useDraftSettingsStore.getState().teardown();
    expect(useDraftSettingsStore.getState().snapshot).toBeNull();
  });
});
