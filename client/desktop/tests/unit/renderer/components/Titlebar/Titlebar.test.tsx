import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Titlebar } from '@/renderer/components/Titlebar/Titlebar';

const mockGet = vi.fn();
const mockOnChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = {
    version: {
      get: mockGet,
      onChange: mockOnChange,
    },
  };
});

describe('Titlebar', () => {
  it('renders the centered "CONCORD VOICE" brand text', () => {
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: 'abc123' });
    mockOnChange.mockReturnValue(() => {});
    render(<Titlebar />);
    expect(screen.getByText('CONCORD VOICE')).toBeInTheDocument();
  });

  it('fetches and displays the version + SPA hash', async () => {
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: 'abc123' });
    mockOnChange.mockReturnValue(() => {});
    render(<Titlebar />);
    await waitFor(() => {
      expect(screen.getByText(/v0\.1\.40-abc123/)).toBeInTheDocument();
    });
  });

  it('displays just the version (no hash) when SPA is in bundled mode', async () => {
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: null });
    mockOnChange.mockReturnValue(() => {});
    render(<Titlebar />);
    await waitFor(() => {
      expect(screen.getByText('v0.1.40')).toBeInTheDocument();
    });
  });

  it('subscribes to version changes and updates on receipt', async () => {
    let changeListener: ((data: { spaHash: string | null }) => void) | undefined;
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: 'abc123' });
    mockOnChange.mockImplementation((cb) => {
      changeListener = cb;
      return () => {};
    });
    render(<Titlebar />);
    await waitFor(() => {
      expect(screen.getByText(/v0\.1\.40-abc123/)).toBeInTheDocument();
    });
    changeListener!({ spaHash: 'def456' });
    await waitFor(() => {
      expect(screen.getByText(/v0\.1\.40-def456/)).toBeInTheDocument();
    });
  });

  it('marks the titlebar as a drag region via CSS class', () => {
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: null });
    mockOnChange.mockReturnValue(() => {});
    const { container } = render(<Titlebar />);
    expect(container.querySelector('.titlebar')).not.toBeNull();
  });

  // Coverage additions during SonarQube reconcile — exercise the catch branch
  // and the defensive early-return when the electron bridge is absent.
  it('logs error to console.error when version.get() rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error('IPC bridge unavailable'));
    mockOnChange.mockReturnValue(() => {});
    render(<Titlebar />);
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        '[Titlebar] failed to fetch version:',
        'IPC bridge unavailable'
      );
    });
    errorSpy.mockRestore();
  });

  it('renders just the brand text when window.electron.version is undefined (partial bridge)', () => {
    // Partial bridge: electron exists but no version namespace (e.g. brief
    // mount-order race in dev HMR). The defensive `?.version` early-return
    // in Titlebar's useEffect should skip the fetch + subscription.
    (window as unknown as { electron: unknown }).electron = {};
    const { container } = render(<Titlebar />);
    expect(screen.getByText('CONCORD VOICE')).toBeInTheDocument();
    // No version label rendered because formatVersionText(null) returns ''
    expect(container.querySelector('.titlebar-version')).toBeNull();
  });

  it('cleans up the onChange subscription on unmount', () => {
    const unsubscribe = vi.fn();
    mockGet.mockResolvedValue({ appVersion: '0.1.40', spaHash: 'abc' });
    mockOnChange.mockReturnValue(unsubscribe);
    const { unmount } = render(<Titlebar />);
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
