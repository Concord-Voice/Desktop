import React from 'react';
import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/components/Members/UserProfileModal.css', () => ({}));
vi.mock('@/renderer/hooks/useUserThemeScope', () => ({
  useUserThemeScope: () => ({ scopeProps: { style: {} } }),
}));

// Mock apiFetch
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import UserProfileModal from '@/renderer/components/Members/UserProfileModal';
import type { ServerMember } from '@/renderer/stores/memberStore';

const mockMember: ServerMember = {
  user_id: 'user-1',
  server_id: 'server-1',
  username: 'testuser',
  display_name: 'Test User',
  avatar_url: null,
  role: 'member',
  joined_at: '2025-01-15T12:00:00Z',
};

describe('UserProfileModal', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            links: ['https://github.com/test'],
            created_at: '2024-06-01T12:00:00Z',
            header_image_url: null,
          },
        }),
    });
  });

  it('renders nothing when isOpen is false', () => {
    const { container } = render(
      <UserProfileModal
        isOpen={false}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders modal content when isOpen is true', async () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('@testuser')).toBeInTheDocument();
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('shows Online status text', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('shows Do Not Disturb status', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="dnd"
      />
    );
    expect(screen.getByText('Do Not Disturb')).toBeInTheDocument();
  });

  it('shows Offline for invisible status', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="invisible"
      />
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows Last seen text for offline status with lastSeen', () => {
    // Set lastSeen to 5 minutes ago
    const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="offline"
        lastSeen={fiveMinutesAgo}
      />
    );
    expect(screen.getByText(/Last seen 5m ago/)).toBeInTheDocument();
  });

  it('shows Offline for offline status without lastSeen', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="offline"
      />
    );
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('shows avatar initial when no avatar URL', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('shows avatar image when avatar URL is present', () => {
    const memberWithAvatar = { ...mockMember, avatar_url: 'https://example.com/avatar.png' };
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={memberWithAvatar}
        presenceStatus="online"
      />
    );
    expect(screen.getByAltText('testuser')).toBeInTheDocument();
  });

  it('capitalizes role label', () => {
    const adminMember = { ...mockMember, role: 'admin' as const };
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={adminMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('shows bio when member has one', () => {
    const memberWithBio = { ...mockMember, bio: 'Hello world!' };
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={memberWithBio}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('About Me')).toBeInTheDocument();
    expect(screen.getByText('Hello world!')).toBeInTheDocument();
  });

  it('does not show About Me section when bio is empty', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.queryByText('About Me')).not.toBeInTheDocument();
  });

  it('fetches extended profile on open', async () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users/user-1/profile');
    });
  });

  it('displays links from profile data', async () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    await waitFor(() => {
      expect(screen.getByText('Links')).toBeInTheDocument();
      expect(screen.getByText('github.com/test')).toBeInTheDocument();
    });
  });

  it('displays Member Since date from profile', async () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    await waitFor(() => {
      expect(screen.getByText('Member Since')).toBeInTheDocument();
      expect(screen.getByText('Jun 1, 2024')).toBeInTheDocument();
    });
  });

  it('displays Server Joined date', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('Server Joined')).toBeInTheDocument();
    expect(screen.getByText('Jan 15, 2025')).toBeInTheDocument();
  });

  it('closes on Escape key', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('closes when clicking overlay background', () => {
    const { container } = render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    const overlay = container.querySelector('.user-profile-overlay');
    fireEvent.click(overlay!);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('does not close when clicking inside the modal', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    fireEvent.click(screen.getByText('Test User'));
    expect(mockOnClose).not.toHaveBeenCalled();
  });

  it('closes when close button is clicked', () => {
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('handles profile fetch failure gracefully', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Not found' }),
    });
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    await waitFor(() => {
      // Should not crash; links section should not appear
      expect(screen.queryByText('Links')).not.toBeInTheDocument();
    });
  });

  it('shows loading indicator while fetching profile', async () => {
    let resolvePromise!: (value: unknown) => void;
    mockApiFetch.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve;
      })
    );
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="online"
      />
    );
    expect(screen.getByText('Loading profile...')).toBeInTheDocument();
    resolvePromise({
      ok: true,
      json: () => Promise.resolve({ user: { links: [], created_at: '' } }),
    });
    await waitFor(() => {
      expect(screen.queryByText('Loading profile...')).not.toBeInTheDocument();
    });
  });

  it('formats last seen as "Just now" for recent times', () => {
    const justNow = Math.floor(Date.now() / 1000);
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="offline"
        lastSeen={justNow}
      />
    );
    expect(screen.getByText(/Just now/)).toBeInTheDocument();
  });

  it('formats last seen in hours', () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="offline"
        lastSeen={twoHoursAgo}
      />
    );
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
  });

  it('formats last seen in days', () => {
    const threeDaysAgo = Math.floor(Date.now() / 1000) - 259200;
    render(
      <UserProfileModal
        isOpen={true}
        onClose={mockOnClose}
        member={mockMember}
        presenceStatus="offline"
        lastSeen={threeDaysAgo}
      />
    );
    expect(screen.getByText(/3d ago/)).toBeInTheDocument();
  });
});
