import { render, screen, fireEvent } from '../../../test-utils';
import MessageAvatar from '@/renderer/components/Chat/MessageAvatar';
import { mockMessage, mockMessage2, mockMember } from '../../../mocks/fixtures';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { useFriendStore } from '@/renderer/stores/friendStore';
import { resetAllStores } from '../../../helpers/store-helpers';

describe('MessageAvatar', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('renders avatar image when avatar_url is present', () => {
    const messageWithAvatar = { ...mockMessage, avatar_url: 'https://example.com/avatar.png' };
    render(
      <MessageAvatar
        message={messageWithAvatar}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const img = document.querySelector('.avatar-image') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.src).toBe('https://example.com/avatar.png');
  });

  it('renders initials circle when no avatar_url', () => {
    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const circle = document.querySelector('.avatar-circle');
    expect(circle).toBeInTheDocument();
    expect(circle!.textContent).toBe('T'); // "Test User" → "T"
  });

  it('applies sender gradient colors to avatar circle', () => {
    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={{ gradient: 'linear-gradient(135deg, #ff0000, #00ff00)' }}
      />
    );

    const circle = document.querySelector('.avatar-circle') as HTMLElement;
    expect(circle).toBeInTheDocument();
    expect(circle.style.background).toContain('linear-gradient');
  });

  it('renders gutter timestamp when showAvatar is false', () => {
    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={false}
        senderColors={null}
      />
    );

    const gutter = document.querySelector('.message-gutter');
    expect(gutter).toBeInTheDocument();
    expect(document.querySelector('.message-avatar')).not.toBeInTheDocument();
  });

  it('opens profile card on avatar click with server member data', () => {
    useMemberStore.getState().addMember(mockMember);

    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const avatarButton = screen.getByLabelText('View user profile');
    fireEvent.click(avatarButton);

    expect(document.querySelector('.member-profile-card')).toBeInTheDocument();
  });

  it('closes profile card on re-click (toggle)', () => {
    useMemberStore.getState().addMember(mockMember);

    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const avatarButton = screen.getByLabelText('View user profile');

    // First click opens
    fireEvent.click(avatarButton);
    expect(document.querySelector('.member-profile-card')).toBeInTheDocument();

    // Second click closes (toggle)
    fireEvent.click(avatarButton);
    expect(document.querySelector('.member-profile-card')).not.toBeInTheDocument();
  });

  it('falls back to friend store when member not found', () => {
    // Don't add member to memberStore — force friend store fallback
    useFriendStore.setState({
      friends: [
        {
          odId: 'od-1',
          odStatus: 'accepted',
          odTimestamp: '2025-01-01T00:00:00Z',
          userId: 'user-1',
          username: 'testuser',
          displayName: 'Test User',
          avatarUrl: null,
          colorScheme: undefined,
        },
      ],
    });

    render(
      <MessageAvatar
        message={mockMessage}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const avatarButton = screen.getByLabelText('View user profile');
    fireEvent.click(avatarButton);

    expect(avatarButton).toBeInTheDocument();
  });

  it('falls back to message data as last resort', () => {
    // Neither member store nor friend store has this user
    render(
      <MessageAvatar
        message={mockMessage2}
        currentUserId="user-1"
        showAvatar={true}
        senderColors={null}
      />
    );

    const avatarButton = screen.getByLabelText('View user profile');
    fireEvent.click(avatarButton);

    expect(avatarButton).toBeInTheDocument();
  });

  it('uses username initial when no display_name', () => {
    const messageNoDisplay = {
      ...mockMessage,
      display_name: undefined as unknown as string,
      username: 'foobar',
    };
    render(
      <MessageAvatar
        message={messageNoDisplay}
        currentUserId="user-2"
        showAvatar={true}
        senderColors={null}
      />
    );

    const circle = document.querySelector('.avatar-circle');
    expect(circle!.textContent).toBe('F'); // "foobar" → "F"
  });
});
