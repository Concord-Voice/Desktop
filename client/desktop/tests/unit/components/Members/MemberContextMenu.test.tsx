import { render, screen, fireEvent } from '../../../test-utils';
import MemberContextMenu from '@/renderer/components/Members/MemberContextMenu';
import { mockMember, mockMember2 } from '../../../mocks/fixtures';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { ADMIN_PERMISSIONS, BASE_PERMISSIONS } from '@/renderer/utils/permissions';

const SERVER_ID = 'server-1';
const OWNER_USER_ID = 'user-1'; // mockMember.user_id / mockServer.owner_id

describe('MemberContextMenu', () => {
  const mockOnClose = vi.fn();
  const mockOnViewProfile = vi.fn();

  const defaultProps = {
    member: mockMember2, // non-owner member
    position: { x: 100, y: 100 },
    serverId: SERVER_ID,
    ownerUserId: OWNER_USER_ID,
    onClose: mockOnClose,
    onViewProfile: mockOnViewProfile,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Default: owner-level permissions (can assign roles and ban)
    usePermissionStore.setState({
      serverPermissions: { [SERVER_ID]: ADMIN_PERMISSIONS },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders member name in header', () => {
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.getByText('Test User 2')).toBeInTheDocument();
  });

  it('shows View Profile option', () => {
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.getByText('View Profile')).toBeInTheDocument();
  });

  it('shows Send DM option (disabled)', () => {
    render(<MemberContextMenu {...defaultProps} />);
    const dmBtn = screen.getByText('Send DM');
    expect(dmBtn).toBeInTheDocument();
    expect(dmBtn.closest('button')).toBeDisabled();
  });

  it('shows Assign Role for owner targeting non-owner', () => {
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.getByText('Assign Role')).toBeInTheDocument();
  });

  it('hides Assign Role for non-owner user', () => {
    usePermissionStore.setState({ serverPermissions: { [SERVER_ID]: BASE_PERMISSIONS } });
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.queryByText('Assign Role')).not.toBeInTheDocument();
  });

  it('hides Assign Role when targeting owner', () => {
    // Target is the owner user — canAssignRole is always false
    render(<MemberContextMenu {...defaultProps} member={mockMember} />);
    expect(screen.queryByText('Assign Role')).not.toBeInTheDocument();
  });

  it('shows Ban option for owner targeting non-owner', () => {
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.getByText('Ban')).toBeInTheDocument();
  });

  it('shows Ban for admin targeting non-owner', () => {
    // ADMIN_PERMISSIONS already set in beforeEach
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.getByText('Ban')).toBeInTheDocument();
  });

  it('hides Ban for regular member', () => {
    usePermissionStore.setState({ serverPermissions: { [SERVER_ID]: BASE_PERMISSIONS } });
    render(<MemberContextMenu {...defaultProps} />);
    expect(screen.queryByText('Ban')).not.toBeInTheDocument();
  });

  it('calls onViewProfile and onClose when View Profile clicked', () => {
    render(<MemberContextMenu {...defaultProps} />);
    fireEvent.click(screen.getByText('View Profile'));
    expect(mockOnViewProfile).toHaveBeenCalled();
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('opens role picker submenu when Assign Role is clicked', () => {
    render(<MemberContextMenu {...defaultProps} />);
    fireEvent.click(screen.getByText('Assign Role'));
    // Role picker should show Admin and Member options
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('toggles role picker closed on second click', () => {
    vi.useFakeTimers();
    render(<MemberContextMenu {...defaultProps} />);
    fireEvent.click(screen.getByText('Assign Role'));
    expect(screen.getByText('Admin')).toBeInTheDocument();
    // Click again to close
    fireEvent.click(screen.getByText('Assign Role'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
  });

  it('disables current role in role picker', () => {
    render(<MemberContextMenu {...defaultProps} />);
    fireEvent.click(screen.getByText('Assign Role'));
    // mockMember2 has role 'member', so Member option should be disabled
    const memberOption = screen.getByText('Member').closest('button');
    expect(memberOption).toBeDisabled();
  });
});
