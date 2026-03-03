import { render, screen } from '../../../test-utils';
import ChannelList from '@/renderer/components/Channels/ChannelList';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import { mockChannel, mockEncryptedChannel } from '../../../mocks/fixtures';
import { vi } from 'vitest';

// Mock apiFetch to prevent real API calls
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
  API_BASE: 'http://localhost:3001',
}));

describe('ChannelList', () => {
  const onContextMenu = vi.fn();

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    // Override fetchChannels and clearChannels to prevent useEffect from modifying state
    useChannelStore.setState({
      fetchChannels: vi.fn() as unknown as (serverId: string) => Promise<void>,
      clearChannels: vi.fn() as unknown as () => void,
    });
  });

  it('shows empty state when no server selected', () => {
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('Select a server to view channels')).toBeInTheDocument();
  });

  it('shows empty state when server has no channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({ channels: [], isLoading: false, error: null });
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('No channels yet')).toBeInTheDocument();
  });

  it('renders text channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: 'group-1' }],
      channelGroups: [{ id: 'group-1', server_id: 'server-1', name: 'Text Channels', position: 0 }],
      isLoading: false,
      error: null,
    });
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('TEXT CHANNELS')).toBeInTheDocument();
  });

  it('renders encrypted indicator for encrypted channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockEncryptedChannel],
      isLoading: false,
      error: null,
    });
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('encrypted-chat')).toBeInTheDocument();
    const encryptedIcon = document.querySelector('.channel-encrypted-icon');
    expect(encryptedIcon).toBeInTheDocument();
  });

  it('highlights active channel', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
      isLoading: false,
      error: null,
    });
    render(<ChannelList onContextMenu={onContextMenu} />);
    const activeItem = document.querySelector('.channel-item.active');
    expect(activeItem).toBeInTheDocument();
  });

  it('shows unread badge', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: null,
      isLoading: false,
      error: null,
    });
    useUnreadStore.getState().setInitialUnreads(new Map([['channel-1', 5]]));
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows 99+ for large unread counts', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: null,
      isLoading: false,
      error: null,
    });
    useUnreadStore.getState().setInitialUnreads(new Map([['channel-1', 150]]));
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('shows error state with retry button', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [],
      isLoading: false,
      error: 'Failed to load channels',
    });
    render(<ChannelList onContextMenu={onContextMenu} />);
    expect(screen.getByText('Failed to load channels')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});
