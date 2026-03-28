import React from 'react';
import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { useConnectionStore } from '@/renderer/stores/connectionStore';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/components/ui/ConnectionLostOverlay.css', () => ({}));

// Mock dynamic imports for recoveryService and resetService
const mockRunPreflight = vi.fn();
const mockSoftRestart = vi.fn();

vi.mock('@/renderer/services/recoveryService', () => ({
  runPreflight: (...args: unknown[]) => mockRunPreflight(...args),
}));

vi.mock('@/renderer/services/resetService', () => ({
  softRestart: (...args: unknown[]) => mockSoftRestart(...args),
}));

import ConnectionLostOverlay from '@/renderer/components/ui/ConnectionLostOverlay';

describe('ConnectionLostOverlay', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('renders nothing when phase is stable', () => {
    useConnectionStore.setState({ phase: 'stable', diagnostics: null });
    const { container } = render(<ConnectionLostOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when phase is grace_period', () => {
    useConnectionStore.setState({ phase: 'grace_period', diagnostics: null });
    const { container } = render(<ConnectionLostOverlay />);
    expect(container.firstChild).toBeNull();
  });

  it('renders preflight phase with diagnostics message', () => {
    useConnectionStore.setState({ phase: 'preflight', diagnostics: null });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('Running Diagnostics')).toBeInTheDocument();
  });

  it('renders recovery_a phase with No Internet title when internet is false', () => {
    useConnectionStore.setState({
      phase: 'recovery_a',
      diagnostics: {
        internet: false,
        serverReachable: false,
        tokenValid: false,
        sessionRevoked: false,
        rendererStable: true,
      },
    });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('No Internet')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    expect(screen.getByText('Exit App')).toBeInTheDocument();
  });

  it('renders recovery_a phase with Waiting for Server when internet is true', () => {
    useConnectionStore.setState({
      phase: 'recovery_a',
      diagnostics: {
        internet: true,
        serverReachable: false,
        tokenValid: false,
        sessionRevoked: false,
        rendererStable: true,
      },
    });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('Waiting for Server')).toBeInTheDocument();
  });

  it('renders recovery_b phase with Restarting Client title', () => {
    useConnectionStore.setState({ phase: 'recovery_b', diagnostics: null });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('Restarting Client')).toBeInTheDocument();
  });

  it('renders fatal phase with Session Revoked when sessionRevoked is true', () => {
    useConnectionStore.setState({
      phase: 'fatal',
      diagnostics: {
        internet: true,
        serverReachable: true,
        tokenValid: true,
        sessionRevoked: true,
        rendererStable: true,
      },
    });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('Session Revoked')).toBeInTheDocument();
    expect(screen.getByText('Restart')).toBeInTheDocument();
    expect(screen.getByText('Exit App')).toBeInTheDocument();
  });

  it('renders fatal phase with Connection Failed when session not revoked', () => {
    useConnectionStore.setState({
      phase: 'fatal',
      diagnostics: {
        internet: false,
        serverReachable: false,
        tokenValid: false,
        sessionRevoked: false,
        rendererStable: true,
      },
    });
    render(<ConnectionLostOverlay />);
    expect(screen.getByText('Connection Failed')).toBeInTheDocument();
  });

  describe('DiagnosticDisplay', () => {
    it('shows diagnostic checklist with OK/Failed status', () => {
      useConnectionStore.setState({
        phase: 'recovery_a',
        diagnostics: {
          internet: true,
          serverReachable: false,
          tokenValid: true,
          sessionRevoked: false,
          rendererStable: true,
        },
      });
      render(<ConnectionLostOverlay />);
      // Check that diagnostics are displayed
      expect(screen.getByText('Internet')).toBeInTheDocument();
      expect(screen.getByText('Server')).toBeInTheDocument();
      expect(screen.getByText('Token')).toBeInTheDocument();
      expect(screen.getByText('Session')).toBeInTheDocument();

      // Check status values
      const okElements = screen.getAllByText('OK');
      const failedElements = screen.getAllByText('Failed');
      expect(okElements.length).toBe(3); // internet OK, token OK, session OK (not revoked)
      expect(failedElements.length).toBe(1); // server failed
    });
  });

  describe('Retry button behavior', () => {
    it('calls runPreflight on Retry click', async () => {
      mockRunPreflight.mockResolvedValue({
        internet: true,
        serverReachable: true,
        tokenValid: true,
        sessionRevoked: false,
        rendererStable: true,
      });

      useConnectionStore.setState({
        phase: 'recovery_a',
        diagnostics: {
          internet: false,
          serverReachable: false,
          tokenValid: false,
          sessionRevoked: false,
          rendererStable: true,
        },
      });
      render(<ConnectionLostOverlay />);

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(mockRunPreflight).toHaveBeenCalled();
      });
    });

    it('enters fatal phase when session is revoked after retry', async () => {
      mockRunPreflight.mockResolvedValue({
        internet: true,
        serverReachable: true,
        tokenValid: true,
        sessionRevoked: true,
        rendererStable: true,
      });

      useConnectionStore.setState({
        phase: 'recovery_a',
        diagnostics: null,
      });
      render(<ConnectionLostOverlay />);
      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(useConnectionStore.getState().phase).toBe('fatal');
      });
    });

    it('calls softRestart when server is reachable and token is valid', async () => {
      mockRunPreflight.mockResolvedValue({
        internet: true,
        serverReachable: true,
        tokenValid: true,
        sessionRevoked: false,
        rendererStable: true,
      });

      useConnectionStore.setState({
        phase: 'recovery_a',
        diagnostics: null,
      });
      render(<ConnectionLostOverlay />);
      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(mockSoftRestart).toHaveBeenCalled();
      });
    });
  });

  describe('Exit App button', () => {
    it('calls electron.quitApp when available', () => {
      const mockQuitApp = vi.fn();
      (globalThis as any).electron = { ...(globalThis as any).electron, quitApp: mockQuitApp };

      useConnectionStore.setState({
        phase: 'recovery_a',
        diagnostics: {
          internet: false,
          serverReachable: false,
          tokenValid: false,
          sessionRevoked: false,
          rendererStable: true,
        },
      });
      render(<ConnectionLostOverlay />);
      fireEvent.click(screen.getByText('Exit App'));
      expect(mockQuitApp).toHaveBeenCalled();
    });
  });

  describe('Restart button in fatal phase', () => {
    it('calls softRestart when Restart is clicked', async () => {
      useConnectionStore.setState({
        phase: 'fatal',
        diagnostics: {
          internet: true,
          serverReachable: true,
          tokenValid: true,
          sessionRevoked: true,
          rendererStable: true,
        },
      });
      render(<ConnectionLostOverlay />);
      fireEvent.click(screen.getByText('Restart'));

      await waitFor(() => {
        expect(mockSoftRestart).toHaveBeenCalled();
      });
    });
  });
});
