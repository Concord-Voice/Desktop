import { render, screen, fireEvent } from '../../../test-utils';
import MemberProfileCard from '@/renderer/components/Members/MemberProfileCard';
import { mockMember, mockMember2 } from '../../../mocks/fixtures';

describe('MemberProfileCard', () => {
  const mockOnClose = vi.fn();
  const defaultProps = {
    member: { ...mockMember, bio: undefined },
    status: 'online' as const,
    position: { x: 300, y: 200 },
    onClose: mockOnClose,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders member username and display name', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('@testuser')).toBeInTheDocument();
  });

  it('renders role badge', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('renders status text for online', () => {
    render(<MemberProfileCard {...defaultProps} status="online" />);
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('renders status text for dnd', () => {
    render(<MemberProfileCard {...defaultProps} status="dnd" />);
    expect(screen.getByText('Do Not Disturb')).toBeInTheDocument();
  });

  it('renders "Offline" for invisible status', () => {
    render(<MemberProfileCard {...defaultProps} status="invisible" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('renders avatar initial when no avatar URL', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('renders avatar image when URL provided', () => {
    const memberWithAvatar = { ...mockMember, avatar_url: 'https://example.com/avatar.png' };
    render(<MemberProfileCard {...defaultProps} member={memberWithAvatar} />);
    const img = screen.getByAltText('testuser');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
  });

  it('renders bio when provided', () => {
    const memberWithBio = { ...mockMember, bio: 'Hello, I am a test user' };
    render(<MemberProfileCard {...defaultProps} member={memberWithBio} />);
    expect(screen.getByText('Hello, I am a test user')).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
  });

  it('does not render bio section when bio is absent', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.queryByText('About')).not.toBeInTheDocument();
  });

  it('renders joined date', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.getByText('Joined')).toBeInTheDocument();
    // The exact date depends on timezone (Jan 1, 2025 or Dec 31, 2024)
    const detailRows = document.querySelectorAll('.member-profile-detail-value');
    const joinedValue = detailRows[detailRows.length - 1];
    expect(joinedValue?.textContent).toMatch(/\w+ \d{1,2}, \d{4}/);
  });

  it('closes on Escape key', () => {
    render(<MemberProfileCard {...defaultProps} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('renders "Offline" for offline status with no lastSeen', () => {
    render(<MemberProfileCard {...defaultProps} status="offline" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows lastSeen for offline user with timestamp', () => {
    // 30 minutes ago
    const thirtyMinsAgo = Math.floor(Date.now() / 1000) - 30 * 60;
    render(<MemberProfileCard {...defaultProps} status="offline" lastSeen={thirtyMinsAgo} />);
    expect(screen.getByText('Last seen 30m ago')).toBeInTheDocument();
  });

  it('shows "Just now" for very recent lastSeen', () => {
    const justNow = Math.floor(Date.now() / 1000);
    render(<MemberProfileCard {...defaultProps} status="offline" lastSeen={justNow} />);
    expect(screen.getByText('Last seen Just now')).toBeInTheDocument();
  });

  it('shows hours for lastSeen within 24h', () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    render(<MemberProfileCard {...defaultProps} status="offline" lastSeen={twoHoursAgo} />);
    expect(screen.getByText('Last seen 2h ago')).toBeInTheDocument();
  });

  it('shows days for lastSeen beyond 24h', () => {
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
    render(<MemberProfileCard {...defaultProps} status="offline" lastSeen={threeDaysAgo} />);
    expect(screen.getByText('Last seen 3d ago')).toBeInTheDocument();
  });

  it('renders member role badge', () => {
    render(<MemberProfileCard {...defaultProps} />);
    const badge = document.querySelector('.member-profile-role-badge');
    expect(badge).toBeInTheDocument();
  });

  it('renders member username with @ prefix', () => {
    render(<MemberProfileCard {...defaultProps} />);
    expect(screen.getByText('@testuser')).toBeInTheDocument();
  });
});
