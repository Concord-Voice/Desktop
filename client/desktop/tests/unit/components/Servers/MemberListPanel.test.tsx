import { render, screen, fireEvent, act } from '../../../test-utils';
import MemberListPanel from '@/renderer/components/Servers/MemberListPanel';
import { vi } from 'vitest';
import type { ServerMember } from '@/renderer/stores/memberStore';
import type { Role } from '@/renderer/types/server';

const mockRoles: Role[] = [
  {
    id: 'role-default',
    server_id: 's1',
    name: '@everyone',
    color: '#99aab5',
    position: 0,
    permissions: '0',
    is_default: true,
    display_separately: false,
    mentionable: false,
    require_mfa: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
  {
    id: 'role-1',
    server_id: 's1',
    name: 'Moderator',
    color: '#ff0000',
    position: 1,
    permissions: '0',
    is_default: false,
    display_separately: false,
    mentionable: false,
    require_mfa: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  },
];

const assignableRoles = mockRoles.filter((r) => !r.is_default);

const mockMembers: ServerMember[] = [
  {
    user_id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    role: 'member',
    joined_at: '2025-01-01T00:00:00Z',
    roles: [
      {
        role_id: 'role-1',
        role_name: 'Moderator',
        role_color: '#ff0000',
        position: 1,
      },
    ],
  },
  {
    user_id: 'u2',
    username: 'bob',
    role: 'member',
    joined_at: '2025-01-01T00:00:00Z',
    roles: [
      {
        role_id: 'role-default',
        role_name: '@everyone',
        role_color: '#99aab5',
        position: 0,
      },
    ],
  },
];

const defaultProps = {
  members: mockMembers,
  serverRoles: mockRoles,
  assignableRoles,
  onToggleRole: vi.fn(),
};

describe('MemberListPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders member list with names and avatars', () => {
    render(<MemberListPanel {...defaultProps} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    // Avatar divs should exist
    const avatarDivs = document.querySelectorAll('.member-avatar');
    expect(avatarDivs.length).toBe(2);
  });

  it('shows display_name when available, username otherwise', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Alice has display_name -> shows "Alice"
    const aliceName = screen.getByText('Alice');
    expect(aliceName).toHaveClass('member-name');
    // Bob has no display_name -> shows "bob"
    const bobName = screen.getByText('bob');
    expect(bobName).toHaveClass('member-name');
  });

  it('shows @username below display_name', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Alice has display_name, so @username should be shown
    expect(screen.getByText('@alice')).toBeInTheDocument();
    // Bob has no display_name, so no @username shown
    expect(screen.queryByText('@bob')).not.toBeInTheDocument();
  });

  it('shows role badges for non-default roles', () => {
    render(<MemberListPanel {...defaultProps} />);
    const badges = document.querySelectorAll('.role-badge');
    // Only alice has a non-default role (Moderator)
    expect(badges.length).toBe(1);
    expect(badges[0]).toHaveTextContent('Moderator');
    expect(badges[0]).toHaveStyle({ backgroundColor: '#ff0000' });
  });

  it('hides default role badges', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Bob only has @everyone which is default -> no badge
    const badges = document.querySelectorAll('.role-badge');
    const badgeTexts = Array.from(badges).map((b) => b.textContent);
    expect(badgeTexts).not.toContain('@everyone');
  });

  it('shows empty state when no members', () => {
    render(<MemberListPanel {...defaultProps} members={[]} />);
    expect(screen.getByText('No members found.')).toBeInTheDocument();
  });

  it('clicking member expands role assignment', () => {
    render(<MemberListPanel {...defaultProps} />);
    const memberRow = screen.getByText('Alice').closest('.member-row')!;
    const toggle = memberRow.querySelector('.member-row-toggle')!;
    fireEvent.click(toggle);

    expect(memberRow).toHaveClass('expanded');
    expect(document.querySelector('.member-role-assignment')).toBeInTheDocument();
  });

  it('member rows are focusable native buttons (keyboard accessible)', () => {
    render(<MemberListPanel {...defaultProps} />);
    const memberRow = screen.getByText('Alice').closest('.member-row')!;
    const toggle = memberRow.querySelector('.member-row-toggle')! as HTMLButtonElement;
    expect(toggle.tagName).toBe('BUTTON');
    // Native buttons handle Enter/Space keyboard activation automatically
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });

  it('clicking expanded member collapses it', () => {
    render(<MemberListPanel {...defaultProps} />);
    const memberRow = screen.getByText('Alice').closest('.member-row')!;
    const toggle = memberRow.querySelector('.member-row-toggle')!;

    // Expand
    fireEvent.click(toggle);
    expect(memberRow).toHaveClass('expanded');

    // Collapse
    fireEvent.click(toggle);
    expect(memberRow).not.toHaveClass('expanded');
    expect(document.querySelector('.member-role-assignment')).not.toBeInTheDocument();
  });

  it('role assignment shows checkboxes for assignable roles', () => {
    render(<MemberListPanel {...defaultProps} />);
    const memberRow = screen.getByText('Alice').closest('.member-row')!;
    fireEvent.click(memberRow.querySelector('.member-row-toggle')!);

    const checkboxes = document.querySelectorAll('.member-role-assignment input[type="checkbox"]');
    expect(checkboxes.length).toBe(1); // Only Moderator (non-default)
  });

  it('checking a role calls onToggleRole(userId, roleId, false) when user does not have role', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Expand bob (who does NOT have the Moderator role)
    const bobRow = screen.getByText('bob').closest('.member-row')!;
    fireEvent.click(bobRow.querySelector('.member-row-toggle')!);

    const checkbox = document.querySelector(
      '.member-role-assignment input[type="checkbox"]'
    ) as HTMLInputElement;
    fireEvent.click(checkbox);

    // Bob doesn't have role-1, so hasRole = false
    expect(defaultProps.onToggleRole).toHaveBeenCalledWith('u2', 'role-1', false);
  });

  it('unchecking a role calls onToggleRole(userId, roleId, true) when user has role', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Expand alice (who HAS the Moderator role)
    const aliceRow = screen.getByText('Alice').closest('.member-row')!;
    fireEvent.click(aliceRow.querySelector('.member-row-toggle')!);

    const checkbox = document.querySelector(
      '.member-role-assignment input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);

    // Alice has role-1, so hasRole = true
    expect(defaultProps.onToggleRole).toHaveBeenCalledWith('u1', 'role-1', true);
  });

  it('shows "No roles available" when assignableRoles is empty', () => {
    render(<MemberListPanel {...defaultProps} assignableRoles={[]} />);
    const memberRow = screen.getByText('Alice').closest('.member-row')!;
    fireEvent.click(memberRow.querySelector('.member-row-toggle')!);

    expect(
      screen.getByText('No roles available to assign. Create roles in the Roles tab first.')
    ).toBeInTheDocument();
  });

  it('clicking inside role assignment area does not collapse the member row', () => {
    render(<MemberListPanel {...defaultProps} />);
    const aliceRow = screen.getByText('Alice').closest('.member-row')!;
    fireEvent.click(aliceRow.querySelector('.member-row-toggle')!);
    expect(aliceRow).toHaveClass('expanded');

    // Click inside the role assignment area — should NOT collapse
    const assignmentArea = document.querySelector('.member-role-assignment')!;
    fireEvent.click(assignmentArea);
    expect(aliceRow).toHaveClass('expanded');
  });

  it('renders avatar image when avatar_url is provided', () => {
    const memberWithAvatar: ServerMember[] = [
      {
        ...mockMembers[0],
        avatar_url: 'https://example.com/avatar.png',
      },
    ];
    render(<MemberListPanel {...defaultProps} members={memberWithAvatar} />);
    const img = document.querySelector('img.member-avatar') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://example.com/avatar.png');
  });

  it('only one member can be expanded at a time', () => {
    render(<MemberListPanel {...defaultProps} />);
    const aliceRow = screen.getByText('Alice').closest('.member-row')!;
    const bobRow = screen.getByText('bob').closest('.member-row')!;

    // Expand alice
    fireEvent.click(aliceRow.querySelector('.member-row-toggle')!);
    expect(aliceRow).toHaveClass('expanded');

    // Expand bob -> alice should collapse
    fireEvent.click(bobRow.querySelector('.member-row-toggle')!);
    expect(bobRow).toHaveClass('expanded');
    expect(aliceRow).not.toHaveClass('expanded');
  });

  it('member rows contain native button toggle elements', () => {
    render(<MemberListPanel {...defaultProps} />);
    const toggles = document.querySelectorAll('.member-row-toggle');
    expect(toggles.length).toBe(2);
    toggles.forEach((toggle) => {
      expect(toggle.tagName).toBe('BUTTON');
      expect(toggle).toHaveAttribute('type', 'button');
    });
  });
});
