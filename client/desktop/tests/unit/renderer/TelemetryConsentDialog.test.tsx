import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../test-utils';
import { resetAllStores } from '../../helpers/store-helpers';
import { useTelemetryConsentStore } from '../../../src/renderer/stores/telemetryConsentStore';
import { useClientConfigStore } from '../../../src/renderer/stores/clientConfigStore';

const mockSetConsentState = vi.fn();
const mockGetConsentState = vi.fn();
const mockOnConsentChanged = vi.fn(() => vi.fn());

beforeEach(() => {
  resetAllStores();
  globalThis.electron = {
    ...globalThis.electron,
    setConsentState: mockSetConsentState,
    getConsentState: mockGetConsentState,
    onConsentChanged: mockOnConsentChanged,
  } as unknown as typeof globalThis.electron;
  mockSetConsentState.mockReset().mockResolvedValue(undefined);
  mockGetConsentState.mockReset();
  mockOnConsentChanged.mockReset().mockReturnValue(vi.fn());
});

// Lazy import so the mocks above are set up before the module loads.
async function renderDialog() {
  const { default: TelemetryConsentDialog } =
    await import('../../../src/renderer/components/TelemetryConsentDialog');
  return render(<TelemetryConsentDialog />);
}

describe('TelemetryConsentDialog — first-launch mode', () => {
  it('renders when firstPromptCompleted=false and isLoaded=true', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    await renderDialog();
    expect(screen.getByText('Help improve Concord Voice')).toBeInTheDocument();
  });

  it('does NOT render when firstPromptCompleted=true', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: false,
      policyAcknowledgedVersion: 1,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 1 });
    await renderDialog();
    expect(screen.queryByText('Help improve Concord Voice')).not.toBeInTheDocument();
  });

  it('does NOT render when isLoaded=false', async () => {
    useTelemetryConsentStore.setState({ isLoaded: false, firstPromptCompleted: false });
    await renderDialog();
    expect(screen.queryByText('Help improve Concord Voice')).not.toBeInTheDocument();
  });

  it('"Yes, send crash reports" calls setConsent with optIn=true and current policy version', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    useClientConfigStore.setState({ telemetryPolicyVersion: 2 });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, send crash reports' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 2,
    });
  });

  it('"No thanks" calls setConsent with optIn=false and current policy version', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    useClientConfigStore.setState({ telemetryPolicyVersion: 2 });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 2,
    });
  });

  it('has no close button (non-dismissable)', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    await renderDialog();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });
});

describe('TelemetryConsentDialog — policy-update mode', () => {
  it('renders when opted in and policy version is ahead of acknowledged version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      policyAcknowledgedVersion: 1,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 2 });
    await renderDialog();
    expect(screen.getByText('Telemetry policy updated')).toBeInTheDocument();
  });

  it('does NOT render for opted-out users even when policy is ahead', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: false,
      policyAcknowledgedVersion: 1,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 2 });
    await renderDialog();
    expect(screen.queryByText('Telemetry policy updated')).not.toBeInTheDocument();
  });

  it('does NOT render when policy version matches acknowledged version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      policyAcknowledgedVersion: 2,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 2 });
    await renderDialog();
    expect(screen.queryByText('Telemetry policy updated')).not.toBeInTheDocument();
  });

  it('"Yes, continue" calls setConsent with optIn=true and current policy version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      policyAcknowledgedVersion: 1,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 3 });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, continue' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 3,
    });
  });

  it('"Opt out" calls setConsent with optIn=false and current policy version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      policyAcknowledgedVersion: 1,
    });
    useClientConfigStore.setState({ telemetryPolicyVersion: 3 });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Opt out' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: 3,
    });
  });
});
