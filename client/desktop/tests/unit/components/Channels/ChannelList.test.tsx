import { render, screen, fireEvent } from '../../../test-utils';
import ChannelList from '@/renderer/components/Channels/ChannelList';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { usePermissionStore } from '@/renderer/stores/permissionStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import { mockChannel, mockEncryptedChannel } from '../../../mocks/fixtures';
import { ADMIN_PERMISSIONS, MANAGE_CHANNELS } from '@/renderer/utils/permissions';
import { vi } from 'vitest';
import type { Channel, ChannelGroup } from '@/renderer/types/chat';

// Mock apiFetch to prevent real API calls
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
  API_BASE: 'http://localhost:3001',
}));

const mockVoiceChannel: Channel = {
  id: 'voice-1',
  server_id: 'server-1',
  name: 'General Voice',
  type: 'voice',
  is_encrypted: false,
  position: 2,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const mockBulletinChannel: Channel = {
  id: 'bulletin-1',
  server_id: 'server-1',
  name: 'Announcements',
  type: 'bulletin',
  is_encrypted: false,
  position: 3,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const mockChannelGroup: ChannelGroup = {
  id: 'group-1',
  server_id: 'server-1',
  name: 'Text Channels',
  position: 0,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

const mockChannelGroup2: ChannelGroup = {
  id: 'group-2',
  server_id: 'server-1',
  name: 'Voice Channels',
  position: 1,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

describe('ChannelList', () => {
  const onContextMenu = vi.fn();
  const onEmptyContextMenu = vi.fn();
  const onCategoryContextMenu = vi.fn();

  const renderChannelList = () =>
    render(
      <ChannelList
        onContextMenu={onContextMenu}
        onEmptyContextMenu={onEmptyContextMenu}
        onCategoryContextMenu={onCategoryContextMenu}
      />
    );

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    // Override fetchChannels and clearChannels to prevent useEffect from modifying state
    useChannelStore.setState({
      fetchChannels: vi.fn() as unknown as (serverId: string) => Promise<void>,
      clearChannels: vi.fn() as unknown as () => void,
    });
  });

  // ── Empty / Loading / Error States ──

  it('shows empty state when no server selected', () => {
    renderChannelList();
    expect(screen.getByText('Select a server to view channels')).toBeInTheDocument();
  });

  it('shows empty state when server has no channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({ channels: [], channelGroups: [], isLoading: false, error: null });
    renderChannelList();
    expect(screen.getByText('No channels yet')).toBeInTheDocument();
  });

  it('shows loading skeletons when loading', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({ channels: [], isLoading: true, error: null });
    const { container } = renderChannelList();
    const skeletons = container.querySelectorAll('.channel-skeleton');
    expect(skeletons.length).toBe(3);
  });

  it('shows error state with retry button', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [],
      isLoading: false,
      error: 'Failed to load channels',
    });
    renderChannelList();
    expect(screen.getByText('Failed to load channels')).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('calls fetchChannels on retry click', () => {
    const mockFetch = vi.fn() as unknown as (serverId: string) => Promise<void>;
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [],
      isLoading: false,
      error: 'Network error',
      fetchChannels: mockFetch,
    });
    renderChannelList();
    fireEvent.click(screen.getByText('Retry'));
    expect(mockFetch).toHaveBeenCalledWith('server-1');
  });

  // ── Rendering Channels ──

  it('renders text channels with hash icon', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: 'group-1' }],
      channelGroups: [mockChannelGroup],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('general')).toBeInTheDocument();
    expect(screen.getByText('TEXT CHANNELS')).toBeInTheDocument();
  });

  it('renders voice channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockVoiceChannel, group_id: 'group-2' }],
      channelGroups: [mockChannelGroup2],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('General Voice')).toBeInTheDocument();
    expect(screen.getByText('VOICE CHANNELS')).toBeInTheDocument();
  });

  it('renders bulletin channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockBulletinChannel],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('Announcements')).toBeInTheDocument();
  });

  it('renders encrypted indicator for encrypted channels', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockEncryptedChannel],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('encrypted-chat')).toBeInTheDocument();
    const encryptedIcon = document.querySelector('.channel-encrypted-icon');
    expect(encryptedIcon).toBeInTheDocument();
  });

  it('renders multiple channel groups with correct headers', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [
        { ...mockChannel, group_id: 'group-1' },
        { ...mockVoiceChannel, group_id: 'group-2' },
      ],
      channelGroups: [mockChannelGroup, mockChannelGroup2],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('TEXT CHANNELS')).toBeInTheDocument();
    expect(screen.getByText('VOICE CHANNELS')).toBeInTheDocument();
  });

  it('renders uncategorized channels without a group header', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: null, position: 1000 }],
      channelGroups: [],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('general')).toBeInTheDocument();
    // No group header should exist
    const headers = document.querySelectorAll('.channel-group-header--collapsible');
    expect(headers.length).toBe(0);
  });

  // ── Active State ──

  it('highlights active channel', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
      isLoading: false,
      error: null,
    });
    renderChannelList();
    const activeItem = document.querySelector('.channel-item.active');
    expect(activeItem).toBeInTheDocument();
  });

  it('sets active channel on click', () => {
    const mockSetActive = vi.fn();
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: null,
      isLoading: false,
      error: null,
      setActiveChannel: mockSetActive,
    });
    renderChannelList();
    fireEvent.click(screen.getByText('general'));
    expect(mockSetActive).toHaveBeenCalledWith('channel-1');
  });

  // ── Unread Badges ──

  it('shows unread badge', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: null,
      isLoading: false,
      error: null,
    });
    useUnreadStore.getState().setInitialUnreads(new Map([['channel-1', 5]]));
    renderChannelList();
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
    renderChannelList();
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('does not show unread badge when channel is active', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      activeChannelId: 'channel-1',
      isLoading: false,
      error: null,
    });
    useUnreadStore.getState().setInitialUnreads(new Map([['channel-1', 5]]));
    renderChannelList();
    expect(screen.queryByText('5')).not.toBeInTheDocument();
  });

  // ── Category Collapsing ──

  it('toggles category collapsed state on click', () => {
    const mockToggle = vi.fn();
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: 'group-1' }],
      channelGroups: [mockChannelGroup],
      collapsedGroups: [],
      toggleGroupCollapsed: mockToggle,
      isLoading: false,
      error: null,
    });
    renderChannelList();
    fireEvent.click(screen.getByText('TEXT CHANNELS'));
    expect(mockToggle).toHaveBeenCalledWith('group-1');
  });

  it('hides channels when category is collapsed', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: 'group-1' }],
      channelGroups: [mockChannelGroup],
      collapsedGroups: ['group-1'],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('TEXT CHANNELS')).toBeInTheDocument();
    // Channel should be hidden
    expect(screen.queryByText('general')).not.toBeInTheDocument();
  });

  // ── Context Menus ──

  it('fires context menu on channel right-click', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    fireEvent.contextMenu(screen.getByText('general'));
    expect(onContextMenu).toHaveBeenCalled();
  });

  it('fires category context menu on header right-click', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, group_id: 'group-1' }],
      channelGroups: [mockChannelGroup],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    fireEvent.contextMenu(screen.getByText('TEXT CHANNELS'));
    expect(onCategoryContextMenu).toHaveBeenCalled();
  });

  // ── Drag and Drop ──

  it('makes channels draggable when user has MANAGE_CHANNELS permission', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      isLoading: false,
      error: null,
    });
    usePermissionStore.setState({
      serverPermissions: { 'server-1': ADMIN_PERMISSIONS | MANAGE_CHANNELS },
    });
    renderChannelList();
    const channelItem = document.querySelector('.channel-item');
    expect(channelItem?.getAttribute('draggable')).toBe('true');
  });

  it('makes channels not draggable without permission', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockChannel],
      isLoading: false,
      error: null,
    });
    usePermissionStore.setState({
      serverPermissions: { 'server-1': 0n },
    });
    renderChannelList();
    const channelItem = document.querySelector('.channel-item');
    expect(channelItem?.getAttribute('draggable')).toBe('false');
  });

  // ── Voice Channel Members ──

  it('shows voice participants when connected to a voice channel', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockVoiceChannel],
      isLoading: false,
      error: null,
    });
    useVoiceStore.setState({
      activeChannelId: 'voice-1',
      connectionState: 'connected',
      participants: {
        'user-1': {
          peerId: 'peer-1',
          userId: 'user-1',
          username: 'testuser',
          displayName: 'Test User',
          isMuted: false,
          isDeafened: false,
          isSpeaking: false,
        },
      },
    });
    renderChannelList();
    expect(screen.getByText('Test User')).toBeInTheDocument();
  });

  it('shows channel voice members from REST data when not connected', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [mockVoiceChannel],
      isLoading: false,
      error: null,
    });
    useVoiceStore.setState({
      activeChannelId: null,
      connectionState: 'idle',
      channelVoiceMembers: {
        'voice-1': [
          {
            userId: 'user-2',
            username: 'otheruser',
            displayName: 'Other User',
            isMuted: false,
          },
        ],
      },
    });
    renderChannelList();
    expect(screen.getByText('Other User')).toBeInTheDocument();
  });

  // ── Channel with Emoji ──

  it('renders channel custom emoji when set', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({
      channels: [{ ...mockChannel, emoji: '🎮' }],
      isLoading: false,
      error: null,
    });
    renderChannelList();
    expect(screen.getByText('🎮')).toBeInTheDocument();
  });

  // ── Empty hint ──

  it('shows "Use + Add above to create one" hint in empty state', () => {
    useServerStore.setState({ activeServerId: 'server-1' });
    useChannelStore.setState({ channels: [], channelGroups: [], isLoading: false, error: null });
    renderChannelList();
    expect(screen.getByText('Use "+ Add" above to create one')).toBeInTheDocument();
  });
});
