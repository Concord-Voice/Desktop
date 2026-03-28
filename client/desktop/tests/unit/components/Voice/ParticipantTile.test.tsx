import React from 'react';
import { render, screen } from '../../../test-utils';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/components/Voice/ParticipantTile.css', () => ({}));
vi.mock('@/renderer/hooks/useUserThemeScope', () => ({
  useUserThemeScope: () => ({ scopeProps: { style: {} } }),
}));

import ParticipantTile from '@/renderer/components/Voice/ParticipantTile';
import type { VoiceParticipant } from '@/renderer/stores/voiceStore';

const makeParticipant = (overrides: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId: 'user-1',
  username: 'testuser',
  displayName: 'Test User',
  isMuted: false,
  isDeafened: false,
  isVideoOn: false,
  isScreenSharing: false,
  isSpeaking: false,
  ...overrides,
});

describe('ParticipantTile', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('renders the display name', () => {
    render(<ParticipantTile participant={makeParticipant()} />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('falls back to username when displayName is undefined', () => {
    render(<ParticipantTile participant={makeParticipant({ displayName: undefined })} />);
    expect(screen.getByText('testuser')).toBeInTheDocument();
  });

  it('shows "(You)" suffix when isLocal is true', () => {
    render(<ParticipantTile participant={makeParticipant()} isLocal />);
    expect(screen.getByText(/Test User/)).toHaveTextContent('Test User (You)');
  });

  it('does not show "(You)" when isLocal is false', () => {
    render(<ParticipantTile participant={makeParticipant()} isLocal={false} />);
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.queryByText(/\(You\)/)).not.toBeInTheDocument();
  });

  it('shows muted icon when participant is muted', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant({ isMuted: true })} />
    );
    expect(container.querySelector('.participant-tile__status--muted')).toBeInTheDocument();
  });

  it('does not show muted icon when not muted', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant({ isMuted: false })} />
    );
    expect(container.querySelector('.participant-tile__status--muted')).not.toBeInTheDocument();
  });

  it('shows screen share icon when participant is screen sharing', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant({ isScreenSharing: true })} />
    );
    expect(container.querySelector('.participant-tile__status--screen')).toBeInTheDocument();
  });

  it('renders compact class when compact prop is true', () => {
    const { container } = render(<ParticipantTile participant={makeParticipant()} compact />);
    expect(container.querySelector('.participant-tile--compact')).toBeInTheDocument();
  });

  it('renders avatar fallback with first character of display name', () => {
    render(<ParticipantTile participant={makeParticipant({ avatarUrl: undefined })} />);
    expect(screen.getByText('T')).toBeInTheDocument();
  });

  it('renders avatar image when avatarUrl is provided', () => {
    render(
      <ParticipantTile
        participant={makeParticipant({ avatarUrl: 'https://example.com/avatar.png' })}
      />
    );
    const img = screen.getByAltText('Test User');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
  });

  it('applies magnification scale when not 1', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant()} magnificationScale={1.12} />
    );
    const tile = container.querySelector('.participant-tile');
    expect(tile?.getAttribute('style')).toContain('scale(1.12)');
  });

  it('does not apply transform when magnificationScale is 1', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant()} magnificationScale={1} />
    );
    const tile = container.querySelector('.participant-tile');
    const style = tile?.getAttribute('style') || '';
    expect(style).not.toContain('scale(');
  });

  it('renders video element when video is on and stream exists', () => {
    const mockStream = {
      id: 'stream-1',
      active: true,
    } as unknown as MediaStream;

    vi.spyOn(HTMLVideoElement.prototype, 'play').mockResolvedValue(undefined);

    const { container } = render(
      <ParticipantTile
        participant={makeParticipant({ isVideoOn: true, videoStream: mockStream })}
      />
    );
    expect(container.querySelector('.participant-tile__video')).toBeInTheDocument();
    expect(container.querySelector('.participant-tile--video')).toBeInTheDocument();
  });

  it('does not render video element when video is off', () => {
    const { container } = render(
      <ParticipantTile participant={makeParticipant({ isVideoOn: false })} />
    );
    expect(container.querySelector('.participant-tile__video')).not.toBeInTheDocument();
  });

  it('resolves user accent colors from member store', () => {
    useMemberStore.setState({
      members: [
        {
          user_id: 'user-1',
          server_id: 'server-1',
          username: 'testuser',
          display_name: 'Test User',
          avatar_url: null,
          role: 'member' as const,
          joined_at: '2025-01-01T00:00:00Z',
          color_scheme: JSON.stringify({ scheme: 'hacker' }),
        },
      ],
    });

    const { container } = render(<ParticipantTile participant={makeParticipant()} />);
    // Should render without crashing with custom colors
    expect(container.querySelector('.participant-tile')).toBeInTheDocument();
  });
});
