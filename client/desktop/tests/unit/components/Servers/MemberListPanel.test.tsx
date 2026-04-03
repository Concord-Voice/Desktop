import { render, screen, fireEvent } from '../../../test-utils';
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
  assignableRoles,
  onToggleRole: vi.fn(),
};

describe('MemberListPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders column headers', () => {
    render(<MemberListPanel {...defaultProps} />);
    const header = document.querySelector('.member-list-header');
    expect(header).toBeInTheDocument();
    const spans = document.querySelectorAll('.member-list-header span');
    expect(spans[0]).toHaveTextContent('User');
    expect(spans[1]).toHaveTextContent('Roles');
  });

  it('renders member list with names and avatars', () => {
    render(<MemberListPanel {...defaultProps} />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    const avatarDivs = document.querySelectorAll('.member-avatar');
    expect(avatarDivs.length).toBe(2);
  });

  it('shows display_name when available, username otherwise', () => {
    render(<MemberListPanel {...defaultProps} />);
    const aliceName = screen.getByText('Alice');
    expect(aliceName).toHaveClass('member-name');
    const bobName = screen.getByText('bob');
    expect(bobName).toHaveClass('member-name');
  });

  it('shows @username below display_name', () => {
    render(<MemberListPanel {...defaultProps} />);
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.queryByText('@bob')).not.toBeInTheDocument();
  });

  it('shows roles inline as removable badges without needing to expand', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Alice has Moderator — should be visible immediately as a removable badge
    const removableBadges = document.querySelectorAll('.role-badge--removable');
    expect(removableBadges.length).toBe(1);
    expect(removableBadges[0]).toHaveTextContent('Moderator');
  });

  it('shows empty state when no members', () => {
    render(<MemberListPanel {...defaultProps} members={[]} />);
    expect(screen.getByText('No members found.')).toBeInTheDocument();
  });

  it('shows Add Role button inline for members with unassigned roles', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Bob has no assigned non-default roles -> Add Role button should be visible immediately
    const addBtns = document.querySelectorAll('.member-role-add-btn');
    expect(addBtns.length).toBeGreaterThan(0);
  });

  it('clicking Add Role and selecting a role calls onToggleRole(userId, roleId, false)', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Bob's row should have Add Role button visible inline
    const bobRow = screen.getByText('bob').closest('.member-row')!;
    const addBtn = bobRow.querySelector('.member-role-add-btn');
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);

    // Dropdown should appear with Moderator
    const dropdownItem = document.querySelector('.member-role-dropdown__item');
    expect(dropdownItem).toHaveTextContent('Moderator');
    fireEvent.click(dropdownItem as HTMLElement);

    expect(defaultProps.onToggleRole).toHaveBeenCalledWith('u2', 'role-1', false);
  });

  it('clicking remove button on a role badge calls onToggleRole(userId, roleId, true)', () => {
    render(<MemberListPanel {...defaultProps} />);
    // Alice's remove button is visible inline (no expand needed)
    const removeBtn = document.querySelector('.role-badge__remove');
    expect(removeBtn).toBeInTheDocument();
    fireEvent.click(removeBtn as HTMLElement);

    expect(defaultProps.onToggleRole).toHaveBeenCalledWith('u1', 'role-1', true);
  });

  it('shows "No roles available" when assignableRoles is empty', () => {
    render(<MemberListPanel {...defaultProps} assignableRoles={[]} />);
    // Each member row shows the message, so use getAllByText
    const msgs = screen.getAllByText('No roles available to assign.');
    expect(msgs.length).toBe(2);
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

  it('does not have expand/collapse toggle buttons', () => {
    render(<MemberListPanel {...defaultProps} />);
    const toggles = document.querySelectorAll('.member-row-toggle');
    expect(toggles.length).toBe(0);
  });

  it('all member rows use grid layout with two cells', () => {
    render(<MemberListPanel {...defaultProps} />);
    const rows = document.querySelectorAll('.member-row');
    expect(rows.length).toBe(2);
    rows.forEach((row) => {
      expect(row.querySelector('.member-cell--user')).toBeInTheDocument();
      expect(row.querySelector('.member-cell--roles')).toBeInTheDocument();
    });
  });
});
