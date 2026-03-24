import { vi } from 'vitest';
import { useOsPermissionStore, ensureOsPermission } from '@/renderer/stores/osPermissionStore';

beforeEach(() => {
  useOsPermissionStore.setState({
    microphone: 'not-determined',
    camera: 'not-determined',
    screen: 'not-determined',
    secureStorage: 'not-determined',
    notifications: 'not-determined',
    isLoaded: false,
  });
});

describe('osPermissionStore', () => {
  it('has correct initial state', () => {
    const state = useOsPermissionStore.getState();
    expect(state.microphone).toBe('not-determined');
    expect(state.camera).toBe('not-determined');
    expect(state.screen).toBe('not-determined');
    expect(state.secureStorage).toBe('not-determined');
    expect(state.notifications).toBe('not-determined');
    expect(state.isLoaded).toBe(false);
  });

  it('fetchAll updates all permissions from electron', async () => {
    window.electron.checkAllPermissions = vi.fn().mockResolvedValue({
      microphone: 'granted',
      camera: 'denied',
      screen: 'not-determined',
      secureStorage: 'granted',
      notifications: 'granted',
    });

    await useOsPermissionStore.getState().fetchAll();
    const state = useOsPermissionStore.getState();
    expect(state.microphone).toBe('granted');
    expect(state.camera).toBe('denied');
    expect(state.screen).toBe('not-determined');
    expect(state.secureStorage).toBe('granted');
    expect(state.notifications).toBe('granted');
    expect(state.isLoaded).toBe(true);
  });

  it('fetchAll sets unavailable when electron API missing', async () => {
    const original = window.electron.checkAllPermissions;
    window.electron.checkAllPermissions = undefined as unknown as typeof original;

    await useOsPermissionStore.getState().fetchAll();
    const state = useOsPermissionStore.getState();
    expect(state.microphone).toBe('unavailable');
    expect(state.isLoaded).toBe(true);

    window.electron.checkAllPermissions = original;
  });

  it('checkOne updates a single permission', async () => {
    window.electron.checkPermission = vi.fn().mockResolvedValue('granted');

    const result = await useOsPermissionStore.getState().checkOne('microphone');
    expect(result).toBe('granted');
    expect(useOsPermissionStore.getState().microphone).toBe('granted');
    expect(window.electron.checkPermission).toHaveBeenCalledWith('microphone');
  });

  it('requestOne triggers OS permission prompt', async () => {
    window.electron.requestPermission = vi.fn().mockResolvedValue('granted');

    const result = await useOsPermissionStore.getState().requestOne('camera');
    expect(result).toBe('granted');
    expect(useOsPermissionStore.getState().camera).toBe('granted');
    expect(window.electron.requestPermission).toHaveBeenCalledWith('camera');
  });

  it('updateStatus directly sets a permission', () => {
    useOsPermissionStore.getState().updateStatus('microphone', 'denied');
    expect(useOsPermissionStore.getState().microphone).toBe('denied');
  });

  it('openSettings calls electron API', async () => {
    window.electron.openPermissionSettings = vi.fn().mockResolvedValue(undefined);

    await useOsPermissionStore.getState().openSettings('microphone');
    expect(window.electron.openPermissionSettings).toHaveBeenCalledWith('microphone');
  });
});

describe('ensureOsPermission', () => {
  it('returns granted when check returns granted (no request needed)', async () => {
    window.electron.checkPermission = vi.fn().mockResolvedValue('granted');
    window.electron.requestPermission = vi.fn().mockResolvedValue('granted');

    const result = await ensureOsPermission('microphone');
    expect(result).toBe('granted');
    // checkOne always calls checkPermission; requestOne is NOT called since status != not-determined
    expect(window.electron.checkPermission).toHaveBeenCalledWith('microphone');
  });

  it('requests permission if not-determined', async () => {
    window.electron.checkPermission = vi.fn().mockResolvedValue('not-determined');
    window.electron.requestPermission = vi.fn().mockResolvedValue('granted');

    const result = await ensureOsPermission('camera');
    expect(result).toBe('granted');
    expect(window.electron.requestPermission).toHaveBeenCalledWith('camera');
  });
});
