import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettingsStore } from '@/renderer/stores/settingsStore';
import { DEFAULT_CLIENT_BEHAVIOR } from '@/shared/clientBehavior';

const { mockSetClientBehavior } = vi.hoisted(() => ({
  mockSetClientBehavior: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = {
    window: { setClientBehavior: mockSetClientBehavior },
  };
  // Reset the clientBehavior slice to defaults
  useSettingsStore.setState({ clientBehavior: DEFAULT_CLIENT_BEHAVIOR });
});

describe('settingsStore — clientBehavior slice', () => {
  it('has default clientBehavior on init', () => {
    const cb = useSettingsStore.getState().clientBehavior;
    expect(cb).toEqual({ toTray: 'close', toToolbar: 'minimize' });
  });

  it('updates clientBehavior when setClientBehavior is called', () => {
    useSettingsStore.getState().setClientBehavior({
      toTray: 'minimize',
      toToolbar: 'close',
    });
    expect(useSettingsStore.getState().clientBehavior).toEqual({
      toTray: 'minimize',
      toToolbar: 'close',
    });
  });

  it('pushes the new value to main via IPC', () => {
    useSettingsStore.getState().setClientBehavior({
      toTray: 'none',
      toToolbar: 'minimize',
    });
    expect(mockSetClientBehavior).toHaveBeenCalledWith({
      toTray: 'none',
      toToolbar: 'minimize',
    });
  });
});
