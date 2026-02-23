import { render, screen, fireEvent, waitFor, act } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { mockServer, mockChannel } from '../../../mocks/fixtures';

// Mock apiFetch to avoid timing issues in jsdom
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: true,
    createChannelKeys: vi.fn(),
  },
}));

// Mock emoji picker
vi.mock('emoji-picker-react', () => ({
  default: () => <div data-testid="emoji-picker" />,
}));

import { apiFetch } from '@/renderer/services/apiClient';
import CreateChannelModal from '@/renderer/components/Channels/CreateChannelModal';

const mockedApiFetch = vi.mocked(apiFetch);

describe('CreateChannelModal', () => {
  const mockOnClose = vi.fn();
  const mockOnSuccess = vi.fn();

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useServerStore.getState().addServer(mockServer);
    useServerStore.getState().setActiveServer(mockServer.id);
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <CreateChannelModal isOpen={false} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    expect(container.querySelector('.modal-overlay')).not.toBeInTheDocument();
  });

  it('renders form when open', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    expect(screen.getByPlaceholderText('general-chat')).toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByText('Bulletin')).toBeInTheDocument();
  });

  it('shows validation error for empty name', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    fireEvent.click(screen.getByText('Create Channel', { selector: 'button[type="submit"]' }));
    expect(screen.getByText('Channel name is required')).toBeInTheDocument();
  });

  it('shows validation error for short name', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    fireEvent.change(screen.getByPlaceholderText('general-chat'), {
      target: { value: 'ab' },
    });
    fireEvent.click(screen.getByText('Create Channel', { selector: 'button[type="submit"]' }));
    expect(screen.getByText('Channel name must be at least 3 characters')).toBeInTheDocument();
  });

  it('submits valid form', async () => {
    vi.useFakeTimers();

    mockedApiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ channel: { ...mockChannel, name: 'new-channel' } }),
    } as Response);

    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );

    fireEvent.change(screen.getByPlaceholderText('general-chat'), {
      target: { value: 'new-channel' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Create Channel', { selector: 'button[type="submit"]' }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('Channel created successfully!')).toBeInTheDocument();
    expect(useChannelStore.getState().channels).toHaveLength(1);

    vi.useRealTimers();
  });

  it('shows error on API failure', async () => {
    mockedApiFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Duplicate name' }),
    } as Response);

    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );

    fireEvent.change(screen.getByPlaceholderText('general-chat'), {
      target: { value: 'new-channel' },
    });

    await act(async () => {
      fireEvent.click(screen.getByText('Create Channel', { selector: 'button[type="submit"]' }));
    });

    await waitFor(() => {
      expect(screen.getByText('Duplicate name')).toBeInTheDocument();
    });
  });

  it('toggles encryption setting', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    // Server e2ee_default is false, so initially disabled
    expect(screen.getByText('Encryption Disabled')).toBeInTheDocument();
    const toggleBtn = screen.getByText('Encryption Disabled').closest('button')!;
    fireEvent.click(toggleBtn);
    expect(screen.getByText('Encryption Enabled')).toBeInTheDocument();
  });

  it('selects voice channel type', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    const voiceBtn = screen.getByText('Voice').closest('button');
    fireEvent.click(voiceBtn!);
    expect(voiceBtn).toHaveClass('selected');
  });

  it('calls onClose when Cancel is clicked', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('shows character count', () => {
    render(
      <CreateChannelModal isOpen={true} onClose={mockOnClose} onSuccess={mockOnSuccess} />,
    );
    expect(screen.getByText('0/100 characters')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('general-chat'), {
      target: { value: 'Test' },
    });
    expect(screen.getByText('4/100 characters')).toBeInTheDocument();
  });
});
