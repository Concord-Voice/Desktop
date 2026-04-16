import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/electron/renderer';

// Mock @sentry/electron/renderer before any imports that pull it in
vi.mock('@sentry/electron/renderer', () => ({
  init: vi.fn(),
  getClient: vi.fn(() => undefined),
  setUser: vi.fn(),
}));

// Mock the shared scrubbers via relative path so Istanbul tracks correctly
vi.mock('../../../src/shared/sentry-scrubbers', () => ({
  scrubEvent: vi.fn((e: unknown) => e),
  scrubBreadcrumb: vi.fn((b: unknown) => b),
}));

describe('renderer sentry consent lifecycle', () => {
  // Save the original window.electron set up by tests/setup.ts so we can restore it
  const originalElectron = globalThis.window.electron;

  let revokedCallback: (() => void) | null = null;
  let restoredCallback: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    revokedCallback = null;
    restoredCallback = null;

    // Stub globalThis.electron with the bridge methods the renderer reads
    globalThis.window.electron = {
      ...originalElectron,
      sentry: {
        dsn: 'https://example@sentry.io/1',
        environment: 'production',
        enabled: true,
      },
      getClientId: vi.fn().mockResolvedValue('abc123'),
      getVersion: vi.fn().mockResolvedValue('0.1.20'),
      onClientIdUpgraded: vi.fn(),
      onConsentChanged: vi.fn(),
      onConsentRevoked: vi.fn((cb: () => void) => {
        revokedCallback = cb;
        return () => {};
      }),
      onConsentRestored: vi.fn((cb: () => void) => {
        restoredCallback = cb;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    globalThis.window.electron = originalElectron;
  });

  it('calls Sentry.getClient().close(0) when consent is revoked', async () => {
    const mockClose = vi.fn().mockResolvedValue(true);
    vi.spyOn(Sentry, 'getClient').mockReturnValue({ close: mockClose } as any);
    await import('../../../src/renderer/sentry');

    if (revokedCallback === null) throw new Error('onConsentRevoked was not registered');
    revokedCallback();

    // Allow the .catch() on the close promise to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(mockClose).toHaveBeenCalledWith(0);
  });

  it('calls Sentry.init when consent is restored', async () => {
    const initSpy = vi.spyOn(Sentry, 'init');
    await import('../../../src/renderer/sentry');
    // Clear the initial Sentry.init call that happens on module load
    initSpy.mockClear();

    if (restoredCallback === null) throw new Error('onConsentRestored was not registered');
    restoredCallback();

    expect(initSpy).toHaveBeenCalledTimes(1);
    const opts = initSpy.mock.calls[0][0];
    expect(opts?.dsn).toBe('https://example@sentry.io/1');
    expect(opts?.sampleRate).toBe(1);
    expect(opts?.tracesSampleRate).toBe(0);
  });

  it('calls Sentry.init AND re-fetches metadata when consent is restored', async () => {
    const initSpy = vi.spyOn(Sentry, 'init');
    await import('../../../src/renderer/sentry');

    // Clear call counts accumulated during initial module setup
    initSpy.mockClear();
    const getClientIdSpy = (globalThis as any).window.electron.getClientId as ReturnType<
      typeof vi.fn
    >;
    const getVersionSpy = (globalThis as any).window.electron.getVersion as ReturnType<
      typeof vi.fn
    >;
    getClientIdSpy.mockClear();
    getVersionSpy.mockClear();

    if (restoredCallback === null) throw new Error('onConsentRestored was not registered');
    restoredCallback();

    // init re-fires and metadata helpers are re-invoked
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(getClientIdSpy).toHaveBeenCalledTimes(1);
    expect(getVersionSpy).toHaveBeenCalledTimes(1);
  });

  it('does not register revoke/restore handlers when SENTRY_ENABLED override is active', async () => {
    // Simulate the SENTRY_ENABLED env override being set
    const originalEnv = process.env.SENTRY_ENABLED;
    process.env.SENTRY_ENABLED = 'true';

    await import('../../../src/renderer/sentry');

    expect(globalThis.window.electron.onConsentRevoked).not.toHaveBeenCalled();
    expect(globalThis.window.electron.onConsentRestored).not.toHaveBeenCalled();

    // Restore env
    if (originalEnv === undefined) {
      delete process.env.SENTRY_ENABLED;
    } else {
      process.env.SENTRY_ENABLED = originalEnv;
    }
  });
});
