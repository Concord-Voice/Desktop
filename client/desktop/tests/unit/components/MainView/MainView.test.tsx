import { render, screen } from '../../../test-utils';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
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
    <div>{header}{children}</div>
  ),
}));
vi.mock('@/renderer/components/Layout/MemberFlexSpace', () => ({
  default: () => <div>MemberFlexSpace</div>,
}));
vi.mock('@/renderer/components/Chat', () => ({
  ChatView: () => <div data-testid="chat-view">ChatView</div>,
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
    expect(screen.getByText('Welcome to Concord')).toBeInTheDocument();
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
});
