import { render, screen, fireEvent } from '../../../test-utils';
import { mockChannel, mockEncryptedChannel } from '../../../mocks/fixtures';
import ChannelContextMenu from '@/renderer/components/Channels/ChannelContextMenu';

describe('ChannelContextMenu', () => {
  const mockOnClose = vi.fn();
  const mockOnEditChannel = vi.fn();
  const mockOnDeleteChannel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderMenu = (role: 'owner' | 'admin' | 'member' = 'owner', channel = mockChannel) => {
    return render(
      <ChannelContextMenu
        channel={channel}
        position={{ x: 100, y: 100 }}
        userRole={role}
        onClose={mockOnClose}
        onEditChannel={mockOnEditChannel}
        onDeleteChannel={mockOnDeleteChannel}
      />,
    );
  };

  it('renders channel name', () => {
    renderMenu();
    expect(screen.getByText('general')).toBeInTheDocument();
  });

  it('shows Mark as Read item', () => {
    renderMenu();
    expect(screen.getByText('Mark as Read')).toBeInTheDocument();
  });

  it('shows Mute Channel item (disabled)', () => {
    renderMenu();
    const muteBtn = screen.getByText('Mute Channel');
    expect(muteBtn).toBeInTheDocument();
    expect(muteBtn.closest('button')).toBeDisabled();
  });

  it('shows Edit/Delete for owner', () => {
    renderMenu('owner');
    expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    expect(screen.getByText('Delete Channel')).toBeInTheDocument();
  });

  it('shows Edit/Delete for admin', () => {
    renderMenu('admin');
    expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    expect(screen.getByText('Delete Channel')).toBeInTheDocument();
  });

  it('hides Edit/Delete for member', () => {
    renderMenu('member');
    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();
  });

  it('calls onEditChannel when Edit clicked', () => {
    renderMenu('owner');
    fireEvent.click(screen.getByText('Edit Channel'));
    expect(mockOnEditChannel).toHaveBeenCalledWith(mockChannel);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onDeleteChannel when Delete clicked', () => {
    renderMenu('owner');
    fireEvent.click(screen.getByText('Delete Channel'));
    expect(mockOnDeleteChannel).toHaveBeenCalledWith(mockChannel);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('shows Copy Link item', () => {
    renderMenu();
    expect(screen.getByText('Copy Link')).toBeInTheDocument();
  });
});
