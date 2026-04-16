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
    expect(state.pendingReConsent).toBe(false);
  });

  it('hydrate() reads state from IPC and sets isLoaded including pendingReConsent', async () => {
    mockGetConsentState.mockResolvedValue({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 1,
      pendingReConsent: true,
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
    expect(state.pendingReConsent).toBe(true);
  });

  it('setConsent(true) calls IPC with pendingReConsent=false and updates local state', async () => {
    mockSetConsentState.mockResolvedValue(undefined);
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().setConsent(true, 1);
    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 1,
      pendingReConsent: false,
    });
    expect(useTelemetryConsentStore.getState().pendingReConsent).toBe(false);
  });

  it('setConsent(false) calls IPC with pendingReConsent=false and updates local state', async () => {
    mockSetConsentState.mockResolvedValue(undefined);
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().setConsent(false, 1);
    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 1,
      pendingReConsent: false,
    });
    expect(useTelemetryConsentStore.getState().pendingReConsent).toBe(false);
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

  it('applyRemoteState() propagates pendingReConsent', async () => {
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    useTelemetryConsentStore.getState().applyRemoteState({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 3,
      pendingReConsent: true,
    });
    const state = useTelemetryConsentStore.getState();
    expect(state.telemetryOptIn).toBe(true);
    expect(state.firstPromptCompleted).toBe(true);
    expect(state.policyAcknowledgedVersion).toBe(3);
    expect(state.pendingReConsent).toBe(true);
  });

  it('setConsent(false): IPC rejection still updates local state (fail-closed opt-out)', async () => {
    (globalThis.electron.setConsentState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ipc failure')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    await useTelemetryConsentStore.getState().setConsent(false, 42);

    const state = useTelemetryConsentStore.getState();
    expect(state.telemetryOptIn).toBe(false);
    expect(state.firstPromptCompleted).toBe(true);
    expect(state.policyAcknowledgedVersion).toBe(42);
    expect(state.pendingReConsent).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('setConsent(true): IPC rejection does NOT update local state (fail-closed opt-in)', async () => {
    const { useTelemetryConsentStore } =
      await import('../../../src/renderer/stores/telemetryConsentStore');
    // Arrange: start in opted-out state
    useTelemetryConsentStore.setState({ telemetryOptIn: false, isLoaded: true });

    (globalThis.electron.setConsentState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ipc failure')
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await useTelemetryConsentStore.getState().setConsent(true, 42);

    // Local state must NOT flip on to avoid a phantom-opted-in UX
    expect(useTelemetryConsentStore.getState().telemetryOptIn).toBe(false);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
