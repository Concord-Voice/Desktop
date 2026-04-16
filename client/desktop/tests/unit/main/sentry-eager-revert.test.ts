// @vitest-environment node
//
// Tests for the eager-revert logic in initSentry — covers the case where a
// user's policyAcknowledgedVersion is stale and they are opted-in, requiring
// telemetryOptIn to be flipped to false BEFORE Sentry.init runs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TELEMETRY_POLICY_VERSION } from '../../../src/shared/sentry-policy-version';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const { sentryInit, sentryAddBreadcrumb, mockReadConsent, mockWriteConsent, mockMakeFallbackId } =
  vi.hoisted(() => ({
    sentryInit: vi.fn(),
    sentryAddBreadcrumb: vi.fn(),
    mockReadConsent: vi.fn(),
    mockWriteConsent: vi.fn(),
    mockMakeFallbackId: vi.fn(() => 'random-' + 'a'.repeat(32)),
  }));

vi.mock('@sentry/electron/main', () => ({
  init: (...args: unknown[]) => sentryInit(...args),
  addBreadcrumb: (...args: unknown[]) => sentryAddBreadcrumb(...args),
  setUser: vi.fn(),
  getClient: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.20' },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../../src/main/telemetryConsent', () => ({
  readTelemetryConsent: (...args: unknown[]) => mockReadConsent(...args),
  writeTelemetryConsent: (...args: unknown[]) => mockWriteConsent(...args),
}));

vi.mock('../../../src/shared/sentry-config.generated', () => ({
  SENTRY_DSN: 'https://fake@sentry.io/1',
}));

vi.mock('../../../src/shared/sentry-scrubbers', () => ({
  scrubEvent: (e: unknown) => e,
  scrubBreadcrumb: (b: unknown) => b,
}));

vi.mock('../../../src/main/clientId', () => ({
  computeClientId: vi.fn(),
  makeFallbackId: () => mockMakeFallbackId(),
  getPlatformRetrievers: vi.fn(() => ({ disk: vi.fn(), mobo: vi.fn() })),
}));

import { initSentry } from '../../../src/main/sentry';

describe('initSentry eager revert on stale acknowledgement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SENTRY_ENABLED = 'true';
  });

  it('reverts telemetryOptIn=false and sets pendingReConsent=true BEFORE Sentry.init runs', async () => {
    const callOrder: string[] = [];

    // First call returns stale opted-in state; subsequent calls return the reverted state
    mockReadConsent
      .mockReturnValueOnce({
        telemetryOptIn: true,
        firstPromptCompleted: true,
        policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION - 1, // stale
        pendingReConsent: false,
        updatedAt: null,
      })
      .mockReturnValue({
        telemetryOptIn: false,
        firstPromptCompleted: true,
        policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION - 1,
        pendingReConsent: true,
        updatedAt: null,
      });

    mockWriteConsent.mockImplementation(() => {
      callOrder.push('writeTelemetryConsent');
    });
    sentryInit.mockImplementation(() => {
      callOrder.push('Sentry.init');
    });

    await initSentry();

    // writeTelemetryConsent must have been called before Sentry.init
    expect(callOrder).toEqual(['writeTelemetryConsent', 'Sentry.init']);

    // Verify the write payload
    const writeCall = mockWriteConsent.mock.calls[0][0] as Record<string, unknown>;
    expect(writeCall).toMatchObject({
      telemetryOptIn: false,
      pendingReConsent: true,
    });
  });

  it('does NOT eager-revert when acknowledgement is current', async () => {
    mockReadConsent.mockReturnValue({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION, // current
      pendingReConsent: false,
      updatedAt: null,
    });

    await initSentry();

    expect(mockWriteConsent).not.toHaveBeenCalled();
    expect(sentryInit).toHaveBeenCalledTimes(1);
  });

  it('does NOT eager-revert when user is already opted out (stale but opted-out)', async () => {
    mockReadConsent.mockReturnValue({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION - 1, // stale, but opted out
      pendingReConsent: false,
      updatedAt: null,
    });

    await initSentry();

    expect(mockWriteConsent).not.toHaveBeenCalled();
  });
});
