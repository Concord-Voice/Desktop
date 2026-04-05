import { render, screen } from '../../../test-utils';
import { ParticipantContextMenu } from '@/renderer/components/Voice/ParticipantContextMenu';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import type { VoiceParticipant } from '@/renderer/stores/voiceStore';

vi.mock('@/renderer/components/ui/ContextMenu.css', () => ({}));
vi.mock('@/renderer/components/ui/EnforcementMenuItems.css', () => ({}));
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

const baseParticipant: VoiceParticipant = {
  userId: 'user-1',
  username: 'alice',
  isMuted: false,
  isDeafened: false,
  isVideoOn: false,
  isScreenSharing: false,
  isSpeaking: false,
  serverMuted: false,
  serverDeafened: false,
};

describe('ParticipantContextMenu', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
  });

  it('renders participant username as header', () => {
    useVoiceStore.setState({ activeServerId: 'srv-1', isDMCall: false, effectivePermissions: 0n });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 100, y: 100 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('shows display name when available', () => {
    useVoiceStore.setState({ activeServerId: 'srv-1', isDMCall: false, effectivePermissions: 0n });
    render(
      <ParticipantContextMenu
        participant={{ ...baseParticipant, displayName: 'Alice W' }}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Alice W')).toBeInTheDocument();
  });

  it('shows enforcement items when user has mute permission in server context', () => {
    // PermMuteMembers = 1 << 18
    useVoiceStore.setState({
      activeServerId: 'srv-1',
      isDMCall: false,
      effectivePermissions: 1n << 18n,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Mute')).toBeInTheDocument();
    expect(screen.getByText('Server Mute')).toBeInTheDocument();
  });

  it('shows deafen items when user has deafen permission in server context', () => {
    // PermDeafenMembers = 1 << 19
    useVoiceStore.setState({
      activeServerId: 'srv-1',
      isDMCall: false,
      effectivePermissions: 1n << 19n,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Deafen')).toBeInTheDocument();
    expect(screen.getByText('Server Deafen')).toBeInTheDocument();
  });

  it('shows no enforcement items without permissions', () => {
    useVoiceStore.setState({ activeServerId: 'srv-1', isDMCall: false, effectivePermissions: 0n });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.queryByText('Mute')).not.toBeInTheDocument();
    expect(screen.queryByText('Server Mute')).not.toBeInTheDocument();
    expect(screen.queryByText('Deafen')).not.toBeInTheDocument();
    expect(screen.queryByText('Server Deafen')).not.toBeInTheDocument();
  });

  it('shows mute only in 1:1 DM context', () => {
    useVoiceStore.setState({
      isDMCall: true,
      isGroupDM: false,
      activeChannelId: 'conv-1',
      activeServerId: null,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Mute')).toBeInTheDocument();
    expect(screen.queryByText('Server Mute')).not.toBeInTheDocument();
  });

  it('shows full enforcement for group DM admin', () => {
    useVoiceStore.setState({
      isDMCall: true,
      isGroupDM: true,
      callerDMRole: 'admin',
      activeChannelId: 'conv-1',
      activeServerId: null,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Mute')).toBeInTheDocument();
    expect(screen.getByText('Server Mute')).toBeInTheDocument();
    expect(screen.getByText('Server Deafen')).toBeInTheDocument();
  });

  it('shows mute only for group DM non-admin', () => {
    useVoiceStore.setState({
      isDMCall: true,
      isGroupDM: true,
      callerDMRole: 'member',
      activeChannelId: 'conv-1',
      activeServerId: null,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Mute')).toBeInTheDocument();
    expect(screen.queryByText('Server Mute')).not.toBeInTheDocument();
  });

  it('renders no enforcement when not in server and not in DM', () => {
    useVoiceStore.setState({
      isDMCall: false,
      activeServerId: null,
      activeChannelId: null,
      effectivePermissions: 0,
    });
    render(
      <ParticipantContextMenu
        participant={baseParticipant}
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
      />
    );
    // Should still show the header
    expect(screen.getByText('alice')).toBeInTheDocument();
    // But no enforcement items
    expect(screen.queryByText('Mute')).not.toBeInTheDocument();
    expect(screen.queryByText('Server Mute')).not.toBeInTheDocument();
  });
});
