import { render, screen, fireEvent, act } from '../../../test-utils';
import { mockServer } from '../../../mocks/fixtures';
import ServerContextMenu from '@/renderer/components/Servers/ServerContextMenu';

describe('ServerContextMenu', () => {
  const mockOnClose = vi.fn();
  const mockOnEditServer = vi.fn();
  const mockOnDeleteServer = vi.fn();
  const mockOnLeaveServer = vi.fn();
  const mockOnInvite = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const renderMenu = (serverOverrides = {}) => {
    const server = { ...mockServer, ...serverOverrides };
    return render(
      <ServerContextMenu
        server={server}
        position={{ x: 100, y: 100 }}
        onClose={mockOnClose}
        onEditServer={mockOnEditServer}
        onDeleteServer={mockOnDeleteServer}
        onLeaveServer={mockOnLeaveServer}
        onInvite={mockOnInvite}
      />,
    );
  };

  it('renders server name and role', () => {
    renderMenu();
    expect(screen.getByText('Test Server')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
  });

  it('shows Mark All as Read', () => {
    renderMenu();
    expect(screen.getByText('Mark All as Read')).toBeInTheDocument();
  });

  it('shows Server Settings for owner', () => {
    renderMenu({ role: 'owner' });
    expect(screen.getByText('Server Settings')).toBeInTheDocument();
  });

  it('shows Server Settings for admin', () => {
    renderMenu({ role: 'admin' });
    expect(screen.getByText('Server Settings')).toBeInTheDocument();
  });

  it('hides Server Settings for member', () => {
    renderMenu({ role: 'member' });
    expect(screen.queryByText('Server Settings')).not.toBeInTheDocument();
  });

  it('shows Delete Server for owner', () => {
    renderMenu({ role: 'owner' });
    expect(screen.getByText('Delete Server')).toBeInTheDocument();
    expect(screen.queryByText('Leave Server')).not.toBeInTheDocument();
  });

  it('shows Leave Server for member (not Delete)', () => {
    renderMenu({ role: 'member' });
    expect(screen.getByText('Leave Server')).toBeInTheDocument();
    expect(screen.queryByText('Delete Server')).not.toBeInTheDocument();
  });

  it('shows Invite to Server for all roles', () => {
    renderMenu({ role: 'member' });
    expect(screen.getByText('Invite to Server')).toBeInTheDocument();
  });

  it('calls onEditServer when Server Settings clicked', () => {
    renderMenu({ role: 'owner' });
    fireEvent.click(screen.getByText('Server Settings'));
    expect(mockOnEditServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onDeleteServer when Delete Server clicked', () => {
    renderMenu({ role: 'owner' });
    fireEvent.click(screen.getByText('Delete Server'));
    expect(mockOnDeleteServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onLeaveServer when Leave Server clicked', () => {
    renderMenu({ role: 'member' });
    fireEvent.click(screen.getByText('Leave Server'));
    expect(mockOnLeaveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }));
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('calls onInvite when Invite to Server clicked', () => {
    renderMenu();
    fireEvent.click(screen.getByText('Invite to Server'));
    expect(mockOnInvite).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }));
    expect(mockOnClose).toHaveBeenCalled();
  });
});
