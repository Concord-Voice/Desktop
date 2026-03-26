import { render, screen } from '../../../test-utils';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { mockServer, mockChannel } from '../../../mocks/fixtures';

// Mock all child components to prevent complex rendering
vi.mock('@/renderer/components/Layout/AppLayout', () => ({
  default: ({
    serverBar,
    folderBar,
    channelPanel,
    chatArea,
    memberSpace,
  }: {
    serverBar: React.ReactNode;
    folderBar: React.ReactNode;
    channelPanel: React.ReactNode;
    chatArea: React.ReactNode;
    memberSpace: React.ReactNode;
  }) => (
    <div data-testid="app-layout">
      <div data-testid="server-bar">{serverBar}</div>
      <div data-testid="folder-bar">{folderBar}</div>
      <div data-testid="channel-panel">{channelPanel}</div>
      <div data-testid="chat-area">{chatArea}</div>
      <div data-testid="member-space">{memberSpace}</div>
    </div>
  ),
}));

vi.mock('@/renderer/components/Layout/ServerBar', () => ({
  default: () => <div>ServerBar</div>,
}));
vi.mock('@/renderer/components/Layout/FolderBar', () => ({
  default: () => <div>FolderBar</div>,
}));
vi.mock('@/renderer/components/Layout/ChannelPanel', () => ({
  default: ({ header, children }: { header: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock('@/renderer/components/Layout/MemberFlexSpace', () => ({
  default: () => <div>MemberFlexSpace</div>,
}));
vi.mock('@/renderer/components/Chat', () => ({
  ChatView: () => <div data-testid="chat-view">ChatView</div>,
}));
vi.mock('@/renderer/components/Voice/VoiceView', () => ({
  default: () => <div data-testid="voice-view">VoiceView</div>,
}));
vi.mock('@/renderer/components/Voice/PersistentVoiceBar', () => ({
  default: () => <div data-testid="persistent-voice-bar">PersistentVoiceBar</div>,
}));
vi.mock('@/renderer/components/Voice/VoiceTextChat', () => ({
  default: () => <div data-testid="voice-text-chat">VoiceTextChat</div>,
}));
vi.mock('@/renderer/components/Voice/ParticipantGrid', () => ({
  AudioOutputs: () => <div data-testid="audio-outputs">AudioOutputs</div>,
}));
vi.mock('@/renderer/services/pipSignalingProxy', () => ({
  // Regular function (not arrow) so `new PipSignalingProxy(...)` works.
  // Returns the mock object so proxy.dispose() is callable.
  PipSignalingProxy: vi.fn(function MockPipProxy() {
    return { dispose: vi.fn(), onPipClosed: vi.fn() };
  }),
}));
vi.mock('@/renderer/services/voiceService', () => ({
  voiceService: {},
}));
vi.mock('@/renderer/components/Channels/ChannelList', () => ({
  default: () => <div>ChannelList</div>,
}));
vi.mock('@/renderer/components/Channels/ServerActionBar', () => ({
  default: () => <div>ServerActionBar</div>,
}));
vi.mock('@/renderer/components/ConnectionStatus/ConnectionStatus', () => ({
  default: () => <div>ConnectionStatus</div>,
}));
vi.mock('@/renderer/hooks/useServerChannelSubscriptions', () => ({
  useServerChannelSubscriptions: vi.fn(),
}));

// Mock all modals to prevent rendering
vi.mock('@/renderer/components/Servers/ServerContextMenu', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/ServerSettingsModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/DeleteServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/LeaveServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/CreateServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/ServerActionModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/JoinServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Servers/InviteToServerModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Channels/ChannelContextMenu', () => ({ default: () => null }));
vi.mock('@/renderer/components/Channels/CreateChannelModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Channels/EditChannelModal', () => ({ default: () => null }));
vi.mock('@/renderer/components/Channels/DeleteChannelModal', () => ({ default: () => null }));

// Mock apiFetch
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  API_BASE: 'http://localhost:8080',
}));

import MainView from '@/renderer/components/MainView/MainView';

describe('MainView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useServerStore.setState({
      servers: [mockServer],
      activeServerId: 'server-1',
    });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
    });
    // Reset voice state so voice-persistence tests start from a known baseline
    useVoiceStore.setState({
      activeChannelId: null,
      connectionState: 'disconnected',
    });
  });

  it('renders the app layout', () => {
    render(<MainView />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('renders server bar section', () => {
    render(<MainView />);
    expect(screen.getByTestId('server-bar')).toBeInTheDocument();
    expect(screen.getByText('ServerBar')).toBeInTheDocument();
  });

  it('renders folder bar section', () => {
    render(<MainView />);
    expect(screen.getByTestId('folder-bar')).toBeInTheDocument();
    expect(screen.getByText('FolderBar')).toBeInTheDocument();
  });

  it('renders channel panel with header', () => {
    render(<MainView />);
    // Server name should appear in the channel header
    expect(screen.getByText(mockServer.name)).toBeInTheDocument();
    expect(screen.getByText('ConnectionStatus')).toBeInTheDocument();
  });

  it('renders chat view when active channel exists', () => {
    render(<MainView />);
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
  });

  it('shows welcome message when no server is active', () => {
    useServerStore.setState({ servers: [], activeServerId: null });
    useChannelStore.setState({ channels: [], activeChannelId: null });
    render(<MainView />);
    expect(screen.getByText('Welcome to Concord Voice')).toBeInTheDocument();
  });

  it('shows channel selection prompt when server active but no channel', () => {
    useChannelStore.setState({ channels: [mockChannel], activeChannelId: null });
    render(<MainView />);
    expect(screen.getByText('Select a channel to start chatting.')).toBeInTheDocument();
  });

  it('shows empty server message when server has no channels', () => {
    useChannelStore.setState({ channels: [], activeChannelId: null });
    render(<MainView />);
    expect(screen.getByText('This server appears empty.')).toBeInTheDocument();
    expect(screen.getByText('Add some channels to start chatting!')).toBeInTheDocument();
  });

  it('renders member space section', () => {
    render(<MainView />);
    expect(screen.getByTestId('member-space')).toBeInTheDocument();
    expect(screen.getByText('MemberFlexSpace')).toBeInTheDocument();
  });

  it('renders the view container with correct class', () => {
    const { container } = render(<MainView />);
    expect(container.querySelector('.main-view')).toBeInTheDocument();
  });

  // ── Voice persistence ──────────────────────────────────────────────────────

  it('renders AudioOutputs persistently when user is connected to voice', () => {
    useVoiceStore.setState({
      activeChannelId: 'voice-ch-1',
      connectionState: 'connected',
    });
    // Active channel is a text channel (user browsed away from voice)
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
    });
    render(<MainView />);
    expect(screen.getByTestId('audio-outputs')).toBeInTheDocument();
  });

  it('does not render AudioOutputs when not connected to voice', () => {
    useVoiceStore.setState({
      activeChannelId: null,
      connectionState: 'disconnected',
    });
    render(<MainView />);
    expect(screen.queryByTestId('audio-outputs')).not.toBeInTheDocument();
  });

  it('renders AudioOutputs even while viewing the active voice channel', () => {
    const voiceChannel = { ...mockChannel, id: 'voice-ch-1', type: 'voice' as const };
    useVoiceStore.setState({
      activeChannelId: 'voice-ch-1',
      connectionState: 'connected',
    });
    useChannelStore.setState({
      channels: [voiceChannel],
      activeChannelId: 'voice-ch-1',
    });
    render(<MainView />);
    expect(screen.getByTestId('audio-outputs')).toBeInTheDocument();
  });

  it('renders VoiceView when active channel type is voice', () => {
    const voiceChannel = { ...mockChannel, id: 'voice-ch-1', type: 'voice' as const };
    useChannelStore.setState({
      channels: [voiceChannel],
      activeChannelId: 'voice-ch-1',
    });
    render(<MainView />);
    expect(screen.getByTestId('voice-view')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('renders PersistentVoiceBar when in voice but viewing a different channel', () => {
    useVoiceStore.setState({
      activeChannelId: 'voice-ch-1',
      connectionState: 'connected',
    });
    // User is viewing a text channel (not the voice channel)
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
    });
    render(<MainView />);
    expect(screen.getByTestId('persistent-voice-bar')).toBeInTheDocument();
  });

  it('does not render PersistentVoiceBar when viewing own voice channel', () => {
    const voiceChannel = { ...mockChannel, id: 'voice-ch-1', type: 'voice' as const };
    useVoiceStore.setState({
      activeChannelId: 'voice-ch-1',
      connectionState: 'connected',
    });
    useChannelStore.setState({
      channels: [voiceChannel],
      activeChannelId: 'voice-ch-1',
    });
    render(<MainView />);
    expect(screen.queryByTestId('persistent-voice-bar')).not.toBeInTheDocument();
  });
});
