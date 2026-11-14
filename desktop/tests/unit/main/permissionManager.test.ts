// @vitest-environment node
//
// permissionManager — OS permission check, request, settings, and IPC tests.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

// ── Hoisted mocks ──────────────────────────────────────────────────────

const {
  mockGetMediaAccessStatus,
  mockAskForMediaAccess,
  mockSecureStorageAvailable,
  mockIsSupported,
  mockOpenExternal,
  mockGetNotificationSettings,
  mockNotificationShow,
  mockIpcMainHandle,
  mockApp,
} = vi.hoisted(() => ({
  mockGetMediaAccessStatus: vi.fn(),
  mockAskForMediaAccess: vi.fn(),
  mockSecureStorageAvailable: vi.fn(() => true),
  mockIsSupported: vi.fn(() => true),
  mockOpenExternal: vi.fn(),
  mockGetNotificationSettings: vi.fn(() => ({ authorizationStatus: 'authorized' })),
  mockNotificationShow: vi.fn(),
  mockIpcMainHandle: vi.fn(),
  mockApp: { isPackaged: true },
}));

// ── Electron mock ──────────────────────────────────────────────────────

vi.mock('electron', () => {
  // Use a real function constructor so `new Notification(...)` works
  function MockNotification() {
    return { show: mockNotificationShow };
  }
  MockNotification.isSupported = mockIsSupported;

  return {
    app: mockApp,
    BrowserWindow: vi.fn(),
    ipcMain: { handle: mockIpcMainHandle },
    Notification: MockNotification,
    shell: { openExternal: mockOpenExternal },
    systemPreferences: {
      getMediaAccessStatus: mockGetMediaAccessStatus,
      askForMediaAccess: mockAskForMediaAccess,
      getNotificationSettings: mockGetNotificationSettings,
    },
  };
});

// permissionManager only maps the gate's boolean; secureStorage.test.ts covers the gate.
vi.mock('@/main/secureStorage', () => ({
  isSecureStorageAvailable: async () => mockSecureStorageAvailable(),
}));

import {
  checkPermission,
  checkAllPermissions,
  requestPermission,
  openSystemSettings,
  registerIpcHandlers,
} from '@/main/permissionManager';
import { bindTestSender, type BoundSenderFixture } from './ipc/boundSenderFixture';
import { recordFor, refOf } from '@/main/connectionRegistry';
import { _resetIpcRegistryForTesting } from '@/main/ipc/registry';
import type { ConnectionRef } from '@/shared/connectionIdentity';

// ── Helpers ────────────────────────────────────────────────────────────

const originalPlatform = process.platform;
// #86 Task 7B: the handlers run behind registerIpc, so the trusted event is the bound
// FOREGROUND saas primary's main frame, filled in by the IPC suite's beforeEach.
const trustedIpcEvent = {} as IpcMainInvokeEvent;

function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: true,
    configurable: true,
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe('permissionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecureStorageAvailable.mockReturnValue(true);
    mockIsSupported.mockReturnValue(true);
    mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'authorized' });
    mockApp.isPackaged = true;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // ─── checkPermission ──────────────────────────────────────────────

  describe('checkPermission', () => {
    describe('microphone', () => {
      it('returns macOS media access status on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('granted');
        expect(await checkPermission('microphone')).toBe('granted');
        expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('microphone');
      });

      it('returns denied on darwin when denied', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('denied');
        expect(await checkPermission('microphone')).toBe('denied');
      });

      it('returns not-determined on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('not-determined');
        expect(await checkPermission('microphone')).toBe('not-determined');
      });

      it('returns restricted on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('restricted');
        expect(await checkPermission('microphone')).toBe('restricted');
      });

      it('maps unknown status to unavailable on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('unknown');
        expect(await checkPermission('microphone')).toBe('unavailable');
      });

      it('returns granted on win32', async () => {
        setPlatform('win32');
        expect(await checkPermission('microphone')).toBe('granted');
        expect(mockGetMediaAccessStatus).not.toHaveBeenCalled();
      });

      it('returns granted on linux', async () => {
        setPlatform('linux');
        expect(await checkPermission('microphone')).toBe('granted');
      });
    });

    describe('camera', () => {
      it('returns macOS media access status on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('granted');
        expect(await checkPermission('camera')).toBe('granted');
        expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('camera');
      });

      it('returns granted on win32', async () => {
        setPlatform('win32');
        expect(await checkPermission('camera')).toBe('granted');
      });
    });

    describe('screen', () => {
      it('returns macOS media access status on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('denied');
        expect(await checkPermission('screen')).toBe('denied');
        expect(mockGetMediaAccessStatus).toHaveBeenCalledWith('screen');
      });

      it('returns granted on win32', async () => {
        setPlatform('win32');
        expect(await checkPermission('screen')).toBe('granted');
      });

      it('returns granted on linux', async () => {
        setPlatform('linux');
        expect(await checkPermission('screen')).toBe('granted');
      });
    });

    describe('secureStorage', () => {
      it('returns granted when encryption is available', async () => {
        mockSecureStorageAvailable.mockReturnValue(true);
        expect(await checkPermission('secureStorage')).toBe('granted');
      });

      it('returns unavailable when encryption is not available', async () => {
        mockSecureStorageAvailable.mockReturnValue(false);
        expect(await checkPermission('secureStorage')).toBe('unavailable');
      });
    });

    describe('notifications', () => {
      it('returns unavailable when Notification is not supported', async () => {
        mockIsSupported.mockReturnValue(false);
        expect(await checkPermission('notifications')).toBe('unavailable');
      });

      it('returns granted on darwin when authorized', async () => {
        setPlatform('darwin');
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'authorized' });
        expect(await checkPermission('notifications')).toBe('granted');
      });

      it('returns denied on darwin when denied', async () => {
        setPlatform('darwin');
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'denied' });
        expect(await checkPermission('notifications')).toBe('denied');
      });

      it('returns granted on darwin when provisional', async () => {
        setPlatform('darwin');
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'provisional' });
        expect(await checkPermission('notifications')).toBe('granted');
      });

      it('returns not-determined on darwin when not-determined', async () => {
        setPlatform('darwin');
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'not-determined' });
        expect(await checkPermission('notifications')).toBe('not-determined');
      });

      it('returns not-determined on darwin with unknown authorizationStatus', async () => {
        setPlatform('darwin');
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'something-else' });
        expect(await checkPermission('notifications')).toBe('not-determined');
      });

      it('returns granted on win32 when notifications are supported', async () => {
        setPlatform('win32');
        expect(await checkPermission('notifications')).toBe('granted');
      });

      it('returns granted on linux when notifications are supported', async () => {
        setPlatform('linux');
        expect(await checkPermission('notifications')).toBe('granted');
      });
    });

    it('returns unavailable for unknown permission type', async () => {
      // Force an unknown type to test the fallback
      expect(await checkPermission('unknown' as never)).toBe('unavailable');
    });
  });

  // ─── checkAllPermissions ──────────────────────────────────────────

  describe('checkAllPermissions', () => {
    it('returns status for all 5 permission types', async () => {
      setPlatform('win32');
      mockSecureStorageAvailable.mockReturnValue(true);
      mockIsSupported.mockReturnValue(true);

      const result = await checkAllPermissions();

      expect(result).toEqual({
        microphone: 'granted',
        camera: 'granted',
        screen: 'granted',
        secureStorage: 'granted',
        notifications: 'granted',
      });
    });

    it('reflects individual permission states', async () => {
      setPlatform('darwin');
      mockGetMediaAccessStatus.mockImplementation((type: string) => {
        if (type === 'microphone') return 'denied';
        if (type === 'camera') return 'not-determined';
        return 'granted';
      });
      mockSecureStorageAvailable.mockReturnValue(false);
      mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'denied' });

      const result = await checkAllPermissions();

      expect(result.microphone).toBe('denied');
      expect(result.camera).toBe('not-determined');
      expect(result.screen).toBe('granted');
      expect(result.secureStorage).toBe('unavailable');
      expect(result.notifications).toBe('denied');
    });
  });

  // ─── requestPermission ────────────────────────────────────────────

  describe('requestPermission', () => {
    describe('microphone', () => {
      it('returns granted on non-darwin platforms', async () => {
        setPlatform('win32');
        const result = await requestPermission('microphone');
        expect(result).toBe('granted');
      });

      it('returns granted on darwin when already granted', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('granted');
        const result = await requestPermission('microphone');
        expect(result).toBe('granted');
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      });

      it('returns denied on darwin when denied', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('denied');
        const result = await requestPermission('microphone');
        expect(result).toBe('denied');
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      });

      it('returns restricted on darwin when restricted', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('restricted');
        const result = await requestPermission('microphone');
        expect(result).toBe('restricted');
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      });

      it('returns raw status in dev mode (not packaged)', async () => {
        setPlatform('darwin');
        mockApp.isPackaged = false;
        mockGetMediaAccessStatus.mockReturnValue('not-determined');
        const result = await requestPermission('microphone');
        expect(result).toBe('not-determined');
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
      });

      it('asks for media access in production mode on darwin', async () => {
        setPlatform('darwin');
        mockApp.isPackaged = true;
        mockGetMediaAccessStatus.mockReturnValue('not-determined');
        mockAskForMediaAccess.mockResolvedValue(true);
        const result = await requestPermission('microphone');
        expect(result).toBe('granted');
        expect(mockAskForMediaAccess).toHaveBeenCalledWith('microphone');
      });

      it('returns denied when user rejects media access prompt', async () => {
        setPlatform('darwin');
        mockApp.isPackaged = true;
        mockGetMediaAccessStatus.mockReturnValue('not-determined');
        mockAskForMediaAccess.mockResolvedValue(false);
        const result = await requestPermission('microphone');
        expect(result).toBe('denied');
      });
    });

    describe('camera', () => {
      it('returns granted on non-darwin platforms', async () => {
        setPlatform('linux');
        const result = await requestPermission('camera');
        expect(result).toBe('granted');
      });

      it('asks for media access on darwin in production', async () => {
        setPlatform('darwin');
        mockApp.isPackaged = true;
        mockGetMediaAccessStatus.mockReturnValue('not-determined');
        mockAskForMediaAccess.mockResolvedValue(true);
        const result = await requestPermission('camera');
        expect(result).toBe('granted');
        expect(mockAskForMediaAccess).toHaveBeenCalledWith('camera');
      });

      it('returns denied on darwin when denied', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('denied');
        const result = await requestPermission('camera');
        expect(result).toBe('denied');
      });
    });

    describe('screen', () => {
      it('opens system settings and returns status on darwin', async () => {
        setPlatform('darwin');
        mockGetMediaAccessStatus.mockReturnValue('denied');
        const result = await requestPermission('screen');
        expect(result).toBe('denied');
        expect(mockOpenExternal).toHaveBeenCalledWith(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        );
      });

      it('returns granted on non-darwin platforms', async () => {
        setPlatform('win32');
        const result = await requestPermission('screen');
        expect(result).toBe('granted');
        expect(mockOpenExternal).not.toHaveBeenCalled();
      });
    });

    describe('secureStorage', () => {
      it('returns granted when encryption is available', async () => {
        mockSecureStorageAvailable.mockReturnValue(true);
        const result = await requestPermission('secureStorage');
        expect(result).toBe('granted');
      });

      it('returns unavailable when encryption is not available', async () => {
        mockSecureStorageAvailable.mockReturnValue(false);
        const result = await requestPermission('secureStorage');
        expect(result).toBe('unavailable');
      });
    });

    describe('notifications', () => {
      it('shows a notification when supported', async () => {
        setPlatform('win32');
        mockIsSupported.mockReturnValue(true);
        await requestPermission('notifications');
        expect(mockNotificationShow).toHaveBeenCalled();
      });

      it('opens system settings on darwin when notifications not supported', async () => {
        setPlatform('darwin');
        mockIsSupported.mockReturnValue(false);
        await requestPermission('notifications');
        expect(mockNotificationShow).not.toHaveBeenCalled();
        expect(mockOpenExternal).toHaveBeenCalledWith(
          'x-apple.systempreferences:com.apple.preference.notifications'
        );
      });

      it('does not open settings on non-darwin when not supported', async () => {
        setPlatform('linux');
        mockIsSupported.mockReturnValue(false);
        await requestPermission('notifications');
        expect(mockOpenExternal).not.toHaveBeenCalled();
      });

      it('returns the real notification status after the prompt', async () => {
        setPlatform('darwin');
        mockIsSupported.mockReturnValue(true);
        mockGetNotificationSettings.mockReturnValue({ authorizationStatus: 'denied' });
        const result = await requestPermission('notifications');
        expect(result).toBe('denied');
      });
    });

    it('returns unavailable for unknown permission type', async () => {
      const result = await requestPermission('unknown' as never);
      expect(result).toBe('unavailable');
    });
  });

  // ─── openSystemSettings ───────────────────────────────────────────

  describe('openSystemSettings', () => {
    it('opens macOS settings URL on darwin', () => {
      setPlatform('darwin');
      openSystemSettings('microphone');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
      );
    });

    it('opens macOS camera settings on darwin', () => {
      setPlatform('darwin');
      openSystemSettings('camera');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera'
      );
    });

    it('opens macOS screen settings on darwin', () => {
      setPlatform('darwin');
      openSystemSettings('screen');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      );
    });

    it('opens macOS notification settings on darwin', () => {
      setPlatform('darwin');
      openSystemSettings('notifications');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.notifications'
      );
    });

    it('opens macOS secureStorage settings on darwin', () => {
      setPlatform('darwin');
      openSystemSettings('secureStorage');
      expect(mockOpenExternal).toHaveBeenCalledWith(
        'x-apple.systempreferences:com.apple.preference.security?Privacy'
      );
    });

    it('opens Windows settings URL on win32', () => {
      setPlatform('win32');
      openSystemSettings('microphone');
      expect(mockOpenExternal).toHaveBeenCalledWith('ms-settings:privacy-microphone');
    });

    it('opens Windows camera settings on win32', () => {
      setPlatform('win32');
      openSystemSettings('camera');
      expect(mockOpenExternal).toHaveBeenCalledWith('ms-settings:privacy-webcam');
    });

    it('opens Windows notification settings on win32', () => {
      setPlatform('win32');
      openSystemSettings('notifications');
      expect(mockOpenExternal).toHaveBeenCalledWith('ms-settings:notifications');
    });

    it('logs a warning on linux', () => {
      setPlatform('linux');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      openSystemSettings('microphone');
      expect(mockOpenExternal).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[PermissionManager] Linux: open your system settings to manage "microphone" permission'
      );
      warnSpy.mockRestore();
    });
  });

  // ─── mapMacNotificationStatus edge case ───────────────────────────

  describe('notification settings fallback', () => {
    it('returns not-determined when getNotificationSettings is not a function', async () => {
      setPlatform('darwin');
      // Replace the mock with a non-function to simulate missing API
      const original = mockGetNotificationSettings;
      const electron = await import('electron');
      const sp = electron.systemPreferences as Record<string, unknown>;
      sp.getNotificationSettings = undefined;
      const result = await checkPermission('notifications');
      expect(result).toBe('not-determined');
      sp.getNotificationSettings = original;
    });
  });

  // ─── registerIpcHandlers ──────────────────────────────────────────

  describe('registerIpcHandlers', () => {
    it('registers 4 IPC handlers', () => {
      bindTestSender();
      registerIpcHandlers(vi.fn());
      expect(mockIpcMainHandle).toHaveBeenCalledTimes(4);
      const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
      expect(channels).toContain('permission:checkAll');
      expect(channels).toContain('permission:check');
      expect(channels).toContain('permission:request');
      expect(channels).toContain('permission:openSettings');
    });

    describe('IPC handler behavior', () => {
      let handlers: Record<string, (...args: unknown[]) => unknown>;
      let push: ReturnType<typeof vi.fn>;
      let fx: BoundSenderFixture;

      beforeEach(() => {
        mockIpcMainHandle.mockReset();
        handlers = {};
        mockIpcMainHandle.mockImplementation(
          (channel: string, handler: (...args: unknown[]) => unknown) => {
            handlers[channel] = handler;
          }
        );

        fx = bindTestSender();
        Object.assign(trustedIpcEvent, fx.event());
        push = vi.fn();
        registerIpcHandlers(push);
      });

      it.each([
        { senderFrame: { url: 'https://evil.example/', frameTreeNodeId: 99 } },
        { senderFrame: null },
      ])('rejects an untrusted or missing sender before validation or OS work', async (event) => {
        setPlatform('darwin');

        expect(handlers['permission:checkAll'](event)).toBeUndefined();
        expect(handlers['permission:check'](event, 'badtype')).toBeUndefined();
        await expect(handlers['permission:request'](event, 'microphone')).resolves.toBeUndefined();
        await expect(
          handlers['permission:request'](event, 'notifications')
        ).resolves.toBeUndefined();
        expect(handlers['permission:openSettings'](event, 'badtype')).toBeUndefined();

        expect(mockGetMediaAccessStatus).not.toHaveBeenCalled();
        expect(mockGetNotificationSettings).not.toHaveBeenCalled();
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
        expect(mockNotificationShow).not.toHaveBeenCalled();
        expect(mockOpenExternal).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
      });

      it('permission:checkAll returns all permissions', async () => {
        setPlatform('win32');
        const result = await handlers['permission:checkAll'](trustedIpcEvent);
        expect(result).toHaveProperty('microphone');
        expect(result).toHaveProperty('camera');
        expect(result).toHaveProperty('screen');
        expect(result).toHaveProperty('secureStorage');
        expect(result).toHaveProperty('notifications');
      });

      it('permission:check returns status for valid type', async () => {
        setPlatform('win32');
        const result = await handlers['permission:check'](trustedIpcEvent, 'microphone');
        expect(result).toBe('granted');
      });

      it('permission:check throws for unknown type', () => {
        expect(() => handlers['permission:check'](trustedIpcEvent, 'badtype')).toThrow(
          'Unknown permission type: badtype'
        );
      });

      it('permission:request returns status and sends changed event', async () => {
        setPlatform('win32');
        const result = await handlers['permission:request'](trustedIpcEvent, 'microphone');
        expect(result).toBe('granted');
      });

      it('permission:request throws for unknown type', async () => {
        await expect(handlers['permission:request'](trustedIpcEvent, 'badtype')).rejects.toThrow(
          'Unknown permission type: badtype'
        );
      });

      it('permission:openSettings throws for unknown type', () => {
        expect(() => handlers['permission:openSettings'](trustedIpcEvent, 'badtype')).toThrow(
          'Unknown permission type: badtype'
        );
      });

      it('permission:openSettings calls openSystemSettings for valid type', () => {
        setPlatform('darwin');
        handlers['permission:openSettings'](trustedIpcEvent, 'microphone');
        expect(mockOpenExternal).toHaveBeenCalled();
      });

      it('permission:request pushes permission:changed to the requesting connection only', async () => {
        setPlatform('win32');
        await handlers['permission:request'](trustedIpcEvent, 'microphone');
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith(
          expect.objectContaining({ connectionId: fx.connectionId }),
          'permission:changed',
          { type: 'microphone', status: 'granted' }
        );
      });

      it('refuses a background connection: no OS prompt and no push (app-global-mutate)', async () => {
        setPlatform('darwin');
        const background = bindTestSender({
          origin: 'https://voice.example',
          id: 9,
          reset: false,
          foreground: false,
        });
        await expect(
          handlers['permission:request'](background.event(), 'microphone')
        ).resolves.toBeUndefined();
        expect(
          handlers['permission:openSettings'](background.event(), 'microphone')
        ).toBeUndefined();
        expect(mockAskForMediaAccess).not.toHaveBeenCalled();
        expect(mockOpenExternal).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
      });

      describe('capture-lease holder delivery (#87 Task 4)', () => {
        const refFor = (id: string) => {
          const record = recordFor(id);
          if (!record) throw new Error('fixture: no record');
          return refOf(record);
        };
        const register = (holder: () => ConnectionRef | null) => {
          // registerIpc refuses a duplicate channel, so start from a clean IPC registry.
          _resetIpcRegistryForTesting();
          mockIpcMainHandle.mockClear();
          registerIpcHandlers(push, holder);
        };
        const background = (id: number) =>
          bindTestSender({
            origin: `https://bg${id}.example`,
            id,
            reset: false,
            foreground: false,
          });

        it('pushes permission:changed to the requester and to a different holder', async () => {
          setPlatform('win32');
          const holder = background(11);
          const third = background(12);
          const holderRef = refFor(holder.connectionId);
          register(() => holderRef);
          await handlers['permission:request'](trustedIpcEvent, 'microphone');
          const payload = { type: 'microphone', status: 'granted' };
          expect(push).toHaveBeenCalledTimes(2);
          expect(push).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ connectionId: fx.connectionId }),
            'permission:changed',
            payload
          );
          expect(push).toHaveBeenNthCalledWith(2, holderRef, 'permission:changed', payload);
          const targets = push.mock.calls.map(
            (c: unknown[]) => (c[0] as ConnectionRef).connectionId
          );
          expect(targets).not.toContain(third.connectionId);
        });

        it('pushes once when the requester is the holder', async () => {
          setPlatform('win32');
          const own = refFor(fx.connectionId);
          register(() => own);
          await handlers['permission:request'](trustedIpcEvent, 'microphone');
          expect(push).toHaveBeenCalledTimes(1);
        });

        it('pushes once when there is no holder', async () => {
          setPlatform('win32');
          register(() => null);
          await handlers['permission:request'](trustedIpcEvent, 'microphone');
          expect(push).toHaveBeenCalledTimes(1);
        });

        it('R14: a BACKGROUND holder still cannot request or open settings', async () => {
          setPlatform('darwin');
          const holder = background(13);
          const holderRef = refFor(holder.connectionId);
          register(() => holderRef);
          await expect(
            handlers['permission:request'](holder.event(), 'microphone')
          ).resolves.toBeUndefined();
          expect(handlers['permission:openSettings'](holder.event(), 'microphone')).toBeUndefined();
          expect(mockAskForMediaAccess).not.toHaveBeenCalled();
          expect(mockOpenExternal).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
        });
      });
    });
  });
});
