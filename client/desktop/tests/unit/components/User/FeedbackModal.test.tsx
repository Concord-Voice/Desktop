import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { vi } from 'vitest';
import FeedbackModal from '@/renderer/components/User/FeedbackModal';

// Mock the connection store the systemInfoService imports
vi.mock('@/renderer/stores/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ phase: 'stable' }) },
}));

// Mock apiClient — both apiFetch and safeJson
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  safeJson: async <T,>(res: Response): Promise<T> => (await res.json()) as T,
}));

describe('FeedbackModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('does not render when closed', () => {
      render(<FeedbackModal isOpen={false} onClose={vi.fn()} />);
      expect(screen.queryByText('Send Feedback')).not.toBeInTheDocument();
    });

    it('renders the modal title when open', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText('Send Feedback')).toBeInTheDocument();
    });

    it('shows both mode tabs', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByRole('tab', { name: 'Bug Report' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toBeInTheDocument();
    });
  });

  describe('default mode', () => {
    it('defaults to Bug Report mode', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      const bugTab = screen.getByRole('tab', { name: 'Bug Report' });
      expect(bugTab).toHaveAttribute('aria-selected', 'true');
    });

    it('honors initialMode prop', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} initialMode="feature" />);
      const featureTab = screen.getByRole('tab', { name: 'Feature Request' });
      expect(featureTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('mode switching', () => {
    it('switches active tab on click', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      const featureTab = screen.getByRole('tab', { name: 'Feature Request' });
      fireEvent.click(featureTab);
      expect(featureTab).toHaveAttribute('aria-selected', 'true');
    });

    it('shows the real bug form in bug mode and the feature placeholder in feature mode', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      // Bug mode now renders BugReportPanel (#159) — the real form, not a
      // placeholder. The submit button is the stable marker.
      expect(screen.getByRole('button', { name: 'Submit Bug Report' })).toBeInTheDocument();
      expect(screen.queryByText(/#159/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      // Feature mode is still a placeholder until #160.
      expect(screen.getByText(/#160/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Submit Bug Report' })).not.toBeInTheDocument();
    });
  });

  describe('close handling', () => {
    it('calls onClose when Close button clicked', () => {
      const onClose = vi.fn();
      render(<FeedbackModal isOpen={true} onClose={onClose} />);
      fireEvent.click(screen.getByText('Close'));
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('accessibility — WAI-ARIA tabs', () => {
    it('wires each tab to the panel (aria-controls) and the panel to the active tab (aria-labelledby)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      const bugTab = screen.getByRole('tab', { name: 'Bug Report' });
      const panel = screen.getByRole('tabpanel');
      expect(bugTab.id).toBeTruthy();
      expect(panel.id).toBeTruthy();
      expect(bugTab).toHaveAttribute('aria-controls', panel.id);
      expect(panel).toHaveAttribute('aria-labelledby', bugTab.id);
    });

    it('uses roving tabindex (active tab 0, inactive -1)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByRole('tab', { name: 'Bug Report' })).toHaveAttribute('tabindex', '0');
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute(
        'tabindex',
        '-1'
      );
    });

    it('ArrowRight moves to the next tab and wraps', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bug Report' }), { key: 'ArrowRight' });
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      // Wrap back to bug from feature.
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Feature Request' }), {
        key: 'ArrowRight',
      });
      expect(screen.getByRole('tab', { name: 'Bug Report' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('ArrowLeft moves to the previous tab and wraps', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      // From bug, ArrowLeft wraps to feature (last).
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bug Report' }), { key: 'ArrowLeft' });
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('ignores non-navigation keys on a tab (no mode change)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      const bugTab = screen.getByRole('tab', { name: 'Bug Report' });
      fireEvent.keyDown(bugTab, { key: 'a' });
      expect(bugTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute(
        'aria-selected',
        'false'
      );
    });

    it('Home / End jump to the first / last tab', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Bug Report' }), { key: 'End' });
      expect(screen.getByRole('tab', { name: 'Feature Request' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Feature Request' }), { key: 'Home' });
      expect(screen.getByRole('tab', { name: 'Bug Report' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });

    it('exposes a polite live region for the submit status surface', () => {
      const { container } = render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
    });
  });

  describe('mode switch resets the submit surface (#159 review)', () => {
    it('switching tabs after a successful submit returns to a fresh form', async () => {
      mockApiFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      // Drive a success via the feature-mode dev trigger.
      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));
      await waitFor(() =>
        expect(screen.getByText(/Thank you for the feedback/)).toBeInTheDocument()
      );

      // Switching to bug mode must clear the success surface and show the form.
      fireEvent.click(screen.getByRole('tab', { name: 'Bug Report' }));
      expect(screen.queryByText(/Thank you for the feedback/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Submit Bug Report' })).toBeInTheDocument();
    });

    it('preserves an in-flight submitting state when switching tabs mid-submit', async () => {
      // The reset must NOT clobber a submitting state — the pipe is still
      // running and will resolve into success/error on its own.
      let releaseFetch!: (r: Response) => void;
      mockApiFetch.mockReturnValue(
        new Promise<Response>((resolve) => {
          releaseFetch = resolve;
        })
      );
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));
      await waitFor(() => expect(screen.getByText('Submitting…')).toBeInTheDocument());

      // Switch tabs mid-submit — submitting state must survive the mode change.
      // (In bug mode + submitting, "Submitting…" appears both in the modal's
      // status region and on the BugReportPanel submit button — either proves
      // the state was preserved, not reset to idle.)
      fireEvent.click(screen.getByRole('tab', { name: 'Bug Report' }));
      expect(screen.getAllByText('Submitting…').length).toBeGreaterThan(0);

      // Release the request so the component can settle (avoids act() warnings).
      releaseFetch(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      await waitFor(() =>
        expect(screen.getByText(/Thank you for the feedback/)).toBeInTheDocument()
      );
    });
  });

  describe('Modal width', () => {
    it('mounts inside the xlarge modal container (#158 wide layout)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      // The modal wrapper applies `modal-${width}` — xlarge is the new
      // 660px variant added on this branch. Asserting the class catches a
      // regression that changed the size prop without changing the spec.
      expect(document.querySelector('.modal-xlarge')).toBeInTheDocument();
    });
  });

  describe('integration with API client', () => {
    // The submit pipe is wired through the modal but the form fields that
    // call it live in #159 / #160. We assert here that the apiFetch import
    // is reachable and not torn out by a refactor — the test mounts the
    // modal without triggering submit, but the mock above ensures the
    // import path is exercised through TypeScript and bundler resolution.
    it('imports apiFetch without error', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(mockApiFetch).not.toHaveBeenCalled(); // not yet — submit comes in #159/#160
    });
  });

  describe('mock submit pipe (for #159 / #160)', () => {
    // The submit pipe is wired through the modal but the form fields that
    // call it live in #159 / #160. This test just confirms the apiFetch
    // mock is configurable; #159 / #160 inherit it and exercise real flows.
    it('apiFetch mock is configurable for the panel branches to override', async () => {
      mockApiFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(typeof mockApiFetch).toBe('function');
      await waitFor(() => {
        expect(mockApiFetch).not.toHaveBeenCalled();
      });
    });
  });

  // The dev-only "Send Test Submission" smoke trigger is rendered when
  // `import.meta.env.DEV` is true (vitest defaults to DEV mode). Post-#159 it
  // lives in FEATURE mode only — bug mode now has the real BugReportPanel
  // form, so the dev trigger no longer appears there. The whole trigger is
  // removed once #160 wires the real feature form.
  describe('dev-only smoke trigger (feature mode only, post-#159)', () => {
    it('is NOT rendered in bug mode (real form replaced it)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(screen.queryByText('Send Test Submission (dev)')).not.toBeInTheDocument();
    });

    it('renders the Send Test Submission button in feature mode under vitest (DEV)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      expect(screen.getByText('Send Test Submission (dev)')).toBeInTheDocument();
    });

    it('clicking the smoke trigger invokes apiFetch with a feature-type payload', async () => {
      mockApiFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledTimes(1);
      });
      const [path, init] = mockApiFetch.mock.calls[0];
      expect(path).toBe('/api/v1/feedback');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe('feature'); // dev trigger now lives in feature mode
      expect(body.title).toBe('Infrastructure smoke test');
      expect(typeof body.description).toBe('string');
    });

    it('after a successful smoke submission, the success surface renders', async () => {
      mockApiFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));

      await waitFor(() => {
        expect(screen.getByText(/Thank you for the feedback/)).toBeInTheDocument();
      });
      // dev-stub flag surfaces the clarifying note
      expect(screen.getByText(/Stubbed in dev/)).toBeInTheDocument();
    });
  });
});
