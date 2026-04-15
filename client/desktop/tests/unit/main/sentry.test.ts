import { describe, it, expect, beforeEach, vi } from 'vitest';

// Note: tests/setup.ts ensures src/shared/sentry-config.generated.ts exists
// before vite's import-analysis runs, since generate-sentry-config.test.ts
// deletes the file after each of its cases.

// Hoisted mocks — vi.mock factories run before top-level const initialization,
// so any variables referenced inside the factory must be declared via vi.hoisted.
const {
  sentryInit,
  sentryAddBreadcrumb,
  sentrySetUser,
  mockSend,
  mockGetAllWindows,
  mockCompute,
  mockMakeFallbackId,
} = vi.hoisted(() => {
  const send = vi.fn();
  return {
    sentryInit: vi.fn(),
    sentryAddBreadcrumb: vi.fn(),
    sentrySetUser: vi.fn(),
    mockSend: send,
    mockGetAllWindows: vi.fn(() => [{ webContents: { send } }]),
    mockCompute: vi.fn(),
    mockMakeFallbackId: vi.fn(() => 'random-' + 'a'.repeat(32)),
  };
});

vi.mock('@sentry/electron/main', () => ({
  init: (...args: unknown[]) => sentryInit(...args),
  addBreadcrumb: (...args: unknown[]) => sentryAddBreadcrumb(...args),
  setUser: (...args: unknown[]) => sentrySetUser(...args),
}));

// Mock electron app + BrowserWindow (BrowserWindow is resolved via dynamic
// import inside upgradeSentryUserId, so we expose the static getAllWindows
// shape here).
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.20' },
  BrowserWindow: { getAllWindows: mockGetAllWindows },
}));

// Mock clientId
vi.mock('../../../src/main/clientId', () => ({
  computeClientId: (...args: unknown[]) => mockCompute(...args),
  makeFallbackId: () => mockMakeFallbackId(),
  getPlatformRetrievers: vi.fn(() => ({
    disk: vi.fn(),
    mobo: vi.fn(),
  })),
}));

// Mock telemetryConsent
vi.mock('../../../src/main/telemetryConsent', () => ({
  readTelemetryConsent: () => ({
    telemetryOptIn: true,
    firstPromptCompleted: true,
    policyAcknowledgedVersion: 1,
    updatedAt: null,
  }),
}));

// Mock sentry-config.generated
vi.mock('../../../src/shared/sentry-config.generated', () => ({
  SENTRY_DSN: 'https://fake@sentry.io/1',
}));

// Mock scrubbers (trivial)
vi.mock('../../../src/shared/sentry-scrubbers', () => ({
  scrubEvent: (e: unknown) => e,
  scrubBreadcrumb: (b: unknown) => b,
}));

import { initSentry, upgradeSentryUserId, getClientId } from '../../../src/main/sentry';

describe('initSentry', () => {
  beforeEach(() => {
    sentryInit.mockClear();
    sentryAddBreadcrumb.mockClear();
    sentrySetUser.mockClear();
    mockSend.mockClear();
    mockCompute.mockReset();
    mockMakeFallbackId.mockClear();
    process.env.SENTRY_ENABLED = 'true'; // force enabled for test
  });

  it('initializes Sentry with a per-launch random fallback user.id (pre-login)', async () => {
    await initSentry();
    expect(sentryInit).toHaveBeenCalledTimes(1);
    const options = sentryInit.mock.calls[0][0];
    // Format: "random-" + 32 hex chars
    expect(options.initialScope.user.id).toMatch(/^random-[0-9a-f]{32}$/);
    // computeClientId is NOT called at init — the stable hash waits for login
    expect(mockCompute).not.toHaveBeenCalled();
  });

  it('emits init breadcrumb with fallback=true (always fallback pre-login)', async () => {
    await initSentry();
    expect(sentryAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(sentryAddBreadcrumb.mock.calls[0][0].data.fallback).toBe(true);
  });

  it('getClientId returns the random fallback after initSentry', async () => {
    await initSentry();
    const result = getClientId();
    expect(result.kind).toBe('fallback');
    expect(result.id).toMatch(/^random-[0-9a-f]{32}$/);
  });
});

describe('upgradeSentryUserId', () => {
  beforeEach(() => {
    sentryInit.mockClear();
    sentryAddBreadcrumb.mockClear();
    sentrySetUser.mockClear();
    mockSend.mockClear();
    mockCompute.mockReset();
    mockMakeFallbackId.mockClear();
  });

  it('computes the stable hash and calls Sentry.setUser with it', async () => {
    mockCompute.mockResolvedValue({ kind: 'stable', id: 'abc12300000000000000000000000000' });
    await upgradeSentryUserId('user-uuid-1');
    expect(mockCompute).toHaveBeenCalledTimes(1);
    expect(mockCompute.mock.calls[0][0]).toBe('user-uuid-1');
    expect(sentrySetUser).toHaveBeenCalledWith({ id: 'abc12300000000000000000000000000' });
  });

  it('emits a sentry.clientid.upgraded breadcrumb on upgrade', async () => {
    mockCompute.mockResolvedValue({ kind: 'stable', id: 'abc' });
    await upgradeSentryUserId('user-uuid-1');
    expect(sentryAddBreadcrumb).toHaveBeenCalledTimes(1);
    const crumb = sentryAddBreadcrumb.mock.calls[0][0];
    expect(crumb.category).toBe('sentry.clientid.upgraded');
    expect(crumb.data.fallback).toBe(false);
  });

  it('broadcasts sentry:clientIdUpgraded to all renderer webContents', async () => {
    mockCompute.mockResolvedValue({ kind: 'stable', id: 'stable-id-xyz' });
    await upgradeSentryUserId('user-uuid-1');
    expect(mockSend).toHaveBeenCalledWith('sentry:clientIdUpgraded', { clientId: 'stable-id-xyz' });
  });

  it('still emits fallback breadcrumb if hardware retrieval fails during upgrade', async () => {
    mockCompute.mockResolvedValue({ kind: 'fallback', id: 'random-upgrade-fallback' });
    await upgradeSentryUserId('user-uuid-1');
    expect(sentryAddBreadcrumb.mock.calls[0][0].data.fallback).toBe(true);
    expect(sentrySetUser).toHaveBeenCalledWith({ id: 'random-upgrade-fallback' });
  });
});
