import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAllStores } from '../../helpers/store-helpers';

const mockGetConsentState = vi.fn();
const mockSetConsentState = vi.fn();
const mockOnConsentChanged = vi.fn(() => vi.fn());

beforeEach(() => {
  resetAllStores();
  globalThis.electron = {
    ...globalThis.electron,
    getConsentState: mockGetConsentState,
    setConsentState: mockSetConsentState,
    onConsentChanged: mockOnConsentChanged,
  } as unknown as typeof globalThis.electron;
  mockGetConsentState.mockReset();
  mockSetConsentState.mockReset();
  mockOnConsentChanged.mockReset().mockReturnValue(vi.fn());
});

describe('useTelemetryConsentStore', () => {
  it('starts with isLoaded=false and telemetryOptIn=false', async () => {
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    const state = useTelemetryConsentStore.getState();
    expect(state.isLoaded).toBe(false);
    expect(state.telemetryOptIn).toBe(false);
    expect(state.firstPromptCompleted).toBe(false);
    expect(state.policyAcknowledgedVersion).toBe(0);
  });

  it('hydrate() reads state from IPC and sets isLoaded', async () => {
    mockGetConsentState.mockResolvedValue({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 1,
      updatedAt: '2026-04-13T12:00:00.000Z',
    });
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().hydrate();
    const state = useTelemetryConsentStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.telemetryOptIn).toBe(true);
    expect(state.firstPromptCompleted).toBe(true);
    expect(state.policyAcknowledgedVersion).toBe(1);
  });

  it('setConsent() calls IPC and updates local state', async () => {
    mockSetConsentState.mockResolvedValue(undefined);
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().setConsent(true, 1);
    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 1,
    });
  });

  it('hydrate() sets defaults when IPC call fails', async () => {
    mockGetConsentState.mockRejectedValue(new Error('IPC unavailable'));
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().hydrate();
    const state = useTelemetryConsentStore.getState();
    expect(state.isLoaded).toBe(true);
    expect(state.telemetryOptIn).toBe(false);
  });

  it('applyRemoteState() updates telemetryOptIn, firstPromptCompleted, and policyAcknowledgedVersion', async () => {
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    useTelemetryConsentStore.getState().applyRemoteState({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 3,
    });
    const state = useTelemetryConsentStore.getState();
    expect(state.telemetryOptIn).toBe(true);
    expect(state.firstPromptCompleted).toBe(true);
    expect(state.policyAcknowledgedVersion).toBe(3);
  });
});
