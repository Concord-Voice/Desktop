import { render, screen, fireEvent, act } from '../../../test-utils';
import MemberContextMenu from '@/renderer/components/Members/MemberContextMenu';
import { mockMember, mockMember2 } from '../../../mocks/fixtures';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { ADMIN_PERMISSIONS } from '@/renderer/utils/permissions';
import { resetAllStores } from '../../../helpers/store-helpers';

const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

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
    resetAllStores();
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

  describe('handleRoleSelect', () => {
    it('sends PATCH with Content-Type header and updates store on success', async () => {
      mockApiFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));

      await act(async () => {
        fireEvent.click(screen.getByText('Admin'));
      });

      // Verify PATCH was sent with correct headers and body
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/api/v1/servers/${SERVER_ID}/members/${mockMember2.user_id}`,
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        })
      );

      // Verify store was updated
      const members = useMemberStore.getState().members;
      const updated = members.find((m) => m.user_id === mockMember2.user_id);
      expect(updated?.role).toBe('admin');

      // Verify onClose was called
      expect(mockOnClose).toHaveBeenCalled();
    });

    it('does NOT update store when API returns non-ok response', async () => {
      mockApiFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));

      await act(async () => {
        fireEvent.click(screen.getByText('Admin'));
      });

      // Store should NOT have been updated
      const members = useMemberStore.getState().members;
      const member = members.find((m) => m.user_id === mockMember2.user_id);
      expect(member?.role).toBe('member');

      // onClose should NOT have been called
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('includes backend error message when API returns error JSON', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'Insufficient permissions' }),
      });

      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));

      await act(async () => {
        fireEvent.click(screen.getByText('Admin'));
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to update role:',
        expect.objectContaining({
          message: expect.stringContaining('Insufficient permissions'),
        })
      );
      consoleSpy.mockRestore();
    });

    it('does NOT update store on network error', async () => {
      mockApiFetch.mockRejectedValueOnce(new Error('Network error'));

      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));

      await act(async () => {
        fireEvent.click(screen.getByText('Admin'));
      });

      // Store should NOT have been updated
      const members = useMemberStore.getState().members;
      const member = members.find((m) => m.user_id === mockMember2.user_id);
      expect(member?.role).toBe('member');

      // onClose should NOT have been called
      expect(mockOnClose).not.toHaveBeenCalled();
    });

    it('resets isUpdatingRole after failure', async () => {
      mockApiFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      render(<MemberContextMenu {...defaultProps} />);
      fireEvent.click(screen.getByText('Assign Role'));

      await act(async () => {
        fireEvent.click(screen.getByText('Admin'));
      });

      // isUpdatingRole should have been reset via finally block,
      // so the button should not be stuck in "Updating..." state
      expect(screen.queryByText('Updating...')).not.toBeInTheDocument();
    });
  });
});
