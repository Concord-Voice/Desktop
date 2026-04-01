import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import PinnedMessagesPanel from '@/renderer/components/Chat/PinnedMessagesPanel';
import { vi } from 'vitest';
import type { MessageWithUser } from '@/renderer/types/chat';

// Mock pin service
const mockGetChannelPins = vi.fn();
const mockUnpinMessage = vi.fn();
vi.mock('@/renderer/services/pinService', () => ({
  getChannelPins: (...args: unknown[]) => mockGetChannelPins(...args),
  unpinMessage: (...args: unknown[]) => mockUnpinMessage(...args),
}));

const mockPins: MessageWithUser[] = [
  {
    id: 'pin-1',
    channel_id: 'channel-1',
    user_id: 'user-1',
    content: 'Pinned message one',
    username: 'testuser',
    display_name: 'Test User',
    is_encrypted: false,
    created_at: '2025-01-01T12:00:00Z',
    updated_at: '2025-01-01T12:00:00Z',
    pinned_at: '2025-01-01T13:00:00Z',
    pinned_by: 'user-1',
  },
  {
    id: 'pin-2',
    channel_id: 'channel-1',
    user_id: 'user-2',
    content: 'Pinned message two',
    username: 'testuser2',
    is_encrypted: false,
    created_at: '2025-01-01T12:01:00Z',
    updated_at: '2025-01-01T12:01:00Z',
    pinned_at: '2025-01-01T13:01:00Z',
    pinned_by: 'user-1',
  },
];

describe('PinnedMessagesPanel', () => {
  const defaultProps = {
    channelId: 'channel-1',
    isOpen: true,
    onClose: vi.fn(),
    onScrollToMessage: vi.fn(),
    canPin: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannelPins.mockResolvedValue(mockPins);
    mockUnpinMessage.mockResolvedValue({ message_id: 'pin-1' });
  });

  it('returns null when not open', () => {
    const { container } = render(<PinnedMessagesPanel {...defaultProps} isOpen={false} />);
    expect(container.querySelector('.pinned-panel-backdrop')).not.toBeInTheDocument();
  });

  it('shows loading state then renders pinned messages', async () => {
    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Pinned message one')).toBeInTheDocument();
      expect(screen.getByText('Pinned message two')).toBeInTheDocument();
    });

    expect(mockGetChannelPins).toHaveBeenCalledWith('channel-1');
  });

  it('shows empty state when no pins', async () => {
    mockGetChannelPins.mockResolvedValue([]);

    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('No pinned messages')).toBeInTheDocument();
    });
  });

  it('calls onScrollToMessage and onClose when Jump is clicked', async () => {
    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText('Jump')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByText('Jump')[0]);
    expect(defaultProps.onScrollToMessage).toHaveBeenCalledWith('pin-1');
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls unpinMessage and removes from list when Unpin is clicked', async () => {
    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getAllByText('Unpin')).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByText('Unpin')[0]);

    await waitFor(() => {
      expect(mockUnpinMessage).toHaveBeenCalledWith('pin-1');
    });
  });

  it('hides Unpin buttons when canPin is false', async () => {
    render(<PinnedMessagesPanel {...defaultProps} canPin={false} />);

    await waitFor(() => {
      expect(screen.getByText('Pinned message one')).toBeInTheDocument();
    });

    expect(screen.queryByText('Unpin')).not.toBeInTheDocument();
  });

  it('calls onClose when backdrop dismiss button is clicked', async () => {
    render(<PinnedMessagesPanel {...defaultProps} />);

    const dismissBtn = document.querySelector('.pinned-panel-backdrop-dismiss') as HTMLElement;
    expect(dismissBtn).toBeInTheDocument();
    fireEvent.click(dismissBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', async () => {
    render(<PinnedMessagesPanel {...defaultProps} />);

    fireEvent.click(screen.getByLabelText('Close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows encrypted message placeholder for encrypted pins', async () => {
    mockGetChannelPins.mockResolvedValue([
      { ...mockPins[0], is_encrypted: true, content: 'ciphertext' },
    ]);

    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Encrypted message')).toBeInTheDocument();
    });
  });

  it('truncates long message content', async () => {
    const longContent = 'A'.repeat(250);
    mockGetChannelPins.mockResolvedValue([{ ...mockPins[0], content: longContent }]);

    render(<PinnedMessagesPanel {...defaultProps} />);

    await waitFor(() => {
      const contentEl = document.querySelector('.pinned-message-content');
      expect(contentEl?.textContent).toHaveLength(203); // 200 + "..."
    });
  });
});
