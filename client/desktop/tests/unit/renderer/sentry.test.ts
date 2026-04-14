import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Sentry from '@sentry/electron/renderer';

// Mock @sentry/electron/renderer before any imports that pull it in
const mockOptions: Record<string, unknown> = {};
vi.mock('@sentry/electron/renderer', () => ({
  init: vi.fn(),
  getClient: vi.fn(() => ({
    getOptions: vi.fn(() => mockOptions),
  })),
}));

// Mock the shared scrubbers via relative path so Istanbul tracks correctly
vi.mock('../../../src/shared/sentry-scrubbers', () => ({
  scrubEvent: vi.fn((e: unknown) => e),
  scrubBreadcrumb: vi.fn((b: unknown) => b),
}));

describe('renderer/sentry.ts', () => {
  // Save the original window.electron set up by tests/setup.ts so we can restore it
  const originalElectron = globalThis.window.electron;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // Reset mock options between tests
    for (const key of Object.keys(mockOptions)) delete mockOptions[key];
    // Restore the default electron mock before each test
    globalThis.window.electron = originalElectron;
  });

  afterEach(() => {
    globalThis.window.electron = originalElectron;
  });

  it('does not call Sentry.init when no DSN is configured', async () => {
    globalThis.window.electron = {
      ...originalElectron,
      sentry: { dsn: '', environment: 'development', enabled: false },
    };

    await import('../../../src/renderer/sentry');

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('calls Sentry.init immediately and sets release after version fetch', async () => {
    const mockGetVersion = vi.fn().mockResolvedValue('1.0.0');
    globalThis.window.electron = {
      ...originalElectron,
      sentry: { dsn: 'https://test@sentry.io/123', environment: 'production', enabled: true },
      getVersion: mockGetVersion,
    };

    await import('../../../src/renderer/sentry');

    // Init is called immediately (phase 1) without release
    expect(Sentry.init).toHaveBeenCalledOnce();
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://test@sentry.io/123',
        environment: 'production',
        enabled: true,
        sampleRate: 1,
        tracesSampleRate: 0,
      }),
    );
    // Phase 1 init should NOT have a release field
    const callArgs = vi.mocked(Sentry.init).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('release');

    // Allow the getVersion().then() callback to resolve
    await new Promise((r) => setTimeout(r, 0));

    // Version is fetched and release is set on the client options
    expect(mockGetVersion).toHaveBeenCalled();
    expect(mockOptions.release).toBe('concord-desktop@1.0.0');
  });

  it('logs warning and continues without release when getVersion rejects', async () => {
    const mockGetVersion = vi.fn().mockRejectedValue(new Error('IPC failed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.window.electron = {
      ...originalElectron,
      sentry: { dsn: 'https://test@sentry.io/123', environment: 'production', enabled: true },
      getVersion: mockGetVersion,
    };

    await import('../../../src/renderer/sentry');

    // Allow the .catch() callback to resolve
    await new Promise((r) => setTimeout(r, 0));

    // Init was still called once (phase 1, no release)
    expect(Sentry.init).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(Sentry.init).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('release');

    // Version fetch failure was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[sentry] Failed to fetch app version'),
      expect.any(Error),
    );

    // Release was NOT set on client options
    expect(mockOptions.release).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('does not call Sentry.init when globalThis.electron is undefined', async () => {
    // globalThis.electron is writable (setup.ts uses writable:true) but not configurable,
    // so assign undefined to simulate the preload bridge being absent
    (globalThis as unknown as Record<string, unknown>).electron = undefined;

    await import('../../../src/renderer/sentry');

    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(Sentry.init).not.toHaveBeenCalled();
  });
});
