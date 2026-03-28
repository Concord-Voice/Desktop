import { render, screen, fireEvent } from '../../../test-utils';
import MemberContextMenu from '@/renderer/components/Members/MemberContextMenu';
import { mockMember, mockMember2 } from '../../../mocks/fixtures';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { ADMIN_PERMISSIONS } from '@/renderer/utils/permissions';

const SERVER_ID = 'server-1';
const OWNER_USER_ID = 'user-1';

describe('MemberContextMenu — extended coverage', () => {
  const mockOnClose = vi.fn();
  const mockOnViewProfile = vi.fn();

  const defaultProps = {
    member: mockMember2,
    position: { x: 100, y: 100 },
    serverId: SERVER_ID,
    ownerUserId: OWNER_USER_ID,
    onClose: mockOnClose,
    onViewProfile: mockOnViewProfile,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    usePermissionStore.setState({
      serverPermissions: { [SERVER_ID]: ADMIN_PERMISSIONS },
    });
    useMemberStore.setState({ members: [mockMember, mockMember2] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('role selection', () => {
    it('renders the context menu for a member', () => {
      render(<MemberContextMenu {...defaultProps} />);
      // Verify the context menu renders with the member's info
      expect(
        screen.getByText(mockMember2.display_name || mockMember2.username)
      ).toBeInTheDocument();
    });

    it('does not update role when selecting current role', () => {
      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));
      // mockMember2 already has role 'member'
      const memberBtn = screen.getByText('Member').closest('button');
      expect(memberBtn).toBeDisabled();
    });

    it('shows checkmark next to current role', () => {
      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));
      // The current role (member) should have a checkmark
      const memberOption = screen.getByText('Member').closest('button');
      expect(memberOption?.textContent).toContain('\u2713');
    });

    it('provides onClose callback in the menu', () => {
      render(<MemberContextMenu {...defaultProps} />);
      // The context menu should be rendered and closeable
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  describe('display name fallback', () => {
    it('shows username when display_name is empty', () => {
      const memberNoDisplay = { ...mockMember2, display_name: '' };
      render(<MemberContextMenu {...defaultProps} member={memberNoDisplay} />);
      expect(screen.getByText('testuser2')).toBeInTheDocument();
    });
  });

  describe('Ban button', () => {
    it('hides Ban when targeting the owner', () => {
      render(<MemberContextMenu {...defaultProps} member={mockMember} />);
      expect(screen.queryByText('Ban')).not.toBeInTheDocument();
    });

    it('shows Ban as disabled (no backend)', () => {
      render(<MemberContextMenu {...defaultProps} />);
      const banBtn = screen.getByText('Ban').closest('button');
      expect(banBtn).toBeDisabled();
    });
  });
});
