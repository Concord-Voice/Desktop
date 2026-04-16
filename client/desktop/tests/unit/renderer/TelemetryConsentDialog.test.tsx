import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../test-utils';
import { resetAllStores } from '../../helpers/store-helpers';
import { useTelemetryConsentStore } from '../../../src/renderer/stores/telemetryConsentStore';
import { TELEMETRY_POLICY_VERSION } from '../../../src/shared/sentry-policy-version';

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

  it('does NOT render when firstPromptCompleted=true and pendingReConsent=false', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      pendingReConsent: false,
    });
    await renderDialog();
    expect(screen.queryByText('Help improve Concord Voice')).not.toBeInTheDocument();
  });

  it('does NOT render when isLoaded=false', async () => {
    useTelemetryConsentStore.setState({ isLoaded: false, firstPromptCompleted: false });
    await renderDialog();
    expect(screen.queryByText('Help improve Concord Voice')).not.toBeInTheDocument();
  });

  it('"Yes, send crash reports" calls setConsent with optIn=true and bundled policy version', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, send crash reports' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION,
      pendingReConsent: false,
    });
  });

  it('"No thanks" calls setConsent with optIn=false and bundled policy version', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION,
      pendingReConsent: false,
    });
  });

  it('has no close button (non-dismissable)', async () => {
    useTelemetryConsentStore.setState({ isLoaded: true, firstPromptCompleted: false });
    await renderDialog();
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();
  });
});

describe('TelemetryConsentDialog — policy-update mode', () => {
  it('renders when pendingReConsent=true regardless of telemetryOptIn', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: false,
      pendingReConsent: true,
    });
    await renderDialog();
    expect(screen.getByText('Telemetry policy updated')).toBeInTheDocument();
  });

  it('renders when pendingReConsent=true and telemetryOptIn=true', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      pendingReConsent: true,
    });
    await renderDialog();
    expect(screen.getByText('Telemetry policy updated')).toBeInTheDocument();
  });

  it('does NOT render when pendingReConsent=false', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: true,
      pendingReConsent: false,
    });
    await renderDialog();
    expect(screen.queryByText('Telemetry policy updated')).not.toBeInTheDocument();
  });

  it('"Yes, continue" calls setConsent with optIn=true and bundled policy version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: false,
      pendingReConsent: true,
    });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, continue' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: true,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION,
      pendingReConsent: false,
    });
  });

  it('"Opt out" calls setConsent with optIn=false and bundled policy version', async () => {
    useTelemetryConsentStore.setState({
      isLoaded: true,
      firstPromptCompleted: true,
      telemetryOptIn: false,
      pendingReConsent: true,
    });
    await renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Opt out' }));

    expect(mockSetConsentState).toHaveBeenCalledWith({
      telemetryOptIn: false,
      firstPromptCompleted: true,
      policyAcknowledgedVersion: TELEMETRY_POLICY_VERSION,
      pendingReConsent: false,
    });
  });
});
