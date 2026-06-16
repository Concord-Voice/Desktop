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

    it('shows the panel-specific placeholder for the active mode', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      // Bug mode placeholder mentions #159
      expect(screen.getByText(/#159/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Feature Request' }));
      // Feature mode placeholder mentions #160
      expect(screen.getByText(/#160/)).toBeInTheDocument();
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
  // `import.meta.env.DEV` is true (vitest defaults to DEV mode). Clicking it
  // calls the shared `submit` pipe with a hard-coded payload — exercising
  // the wire end-to-end before #159 / #160 wire real forms. Removed
  // once the panels arrive.
  describe('dev-only smoke trigger', () => {
    it('renders the Send Test Submission button under vitest (DEV mode)', () => {
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      expect(screen.getByText('Send Test Submission (dev)')).toBeInTheDocument();
    });

    it('clicking the smoke trigger invokes apiFetch with the placeholder payload', async () => {
      mockApiFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ dev: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      render(<FeedbackModal isOpen={true} onClose={vi.fn()} />);
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));

      await waitFor(() => {
        expect(mockApiFetch).toHaveBeenCalledTimes(1);
      });
      const [path, init] = mockApiFetch.mock.calls[0];
      expect(path).toBe('/api/v1/feedback');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe('bug'); // default mode
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
      fireEvent.click(screen.getByText('Send Test Submission (dev)'));

      await waitFor(() => {
        expect(screen.getByText(/Thank you for the feedback/)).toBeInTheDocument();
      });
      // dev-stub flag surfaces the clarifying note
      expect(screen.getByText(/Stubbed in dev/)).toBeInTheDocument();
    });
  });
});
