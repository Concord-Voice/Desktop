import { render, screen } from '../../../test-utils';
import ServerBar from '@/renderer/components/Layout/ServerBar';
import { useServerStore } from '@/renderer/stores/serverStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../../helpers/store-helpers';
import { mockServer, mockServer2 } from '../../../mocks/fixtures';
import { vi } from 'vitest';

// Mock apiClient to prevent real API calls from fetchServers useEffect
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([]),
  }),
  API_BASE: 'http://localhost:3001',
}));

describe('ServerBar', () => {
  const onOpenActionModal = vi.fn();
  const onContextMenu = vi.fn();

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    // Override fetchServers to prevent store from clearing manually-set servers
    useServerStore.setState({ fetchServers: vi.fn() as unknown as () => Promise<void> });
  });

  it('renders PM button', () => {
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    expect(screen.getByLabelText('Direct Messages')).toBeInTheDocument();
  });

  it('renders add server button', () => {
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    expect(screen.getByLabelText('Add Server')).toBeInTheDocument();
  });

  it('calls onOpenActionModal when add button clicked', async () => {
    const { userEvent } = await import('../../../test-utils');
    const user = userEvent.setup();
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    await user.click(screen.getByLabelText('Add Server'));
    expect(onOpenActionModal).toHaveBeenCalled();
  });

  it('renders server icons when servers exist', () => {
    useServerStore.setState({
      servers: [mockServer, mockServer2],
      activeServerId: mockServer.id,
      isLoading: false,
    });
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    // mockServer2 should be in the bar (non-active)
    expect(screen.getByLabelText('Second Server server')).toBeInTheDocument();
  });

  it('shows active server icon', () => {
    useServerStore.setState({
      servers: [mockServer],
      activeServerId: mockServer.id,
      isLoading: false,
    });
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    expect(screen.getByLabelText('Toggle channel panel')).toBeInTheDocument();
  });

  it('shows placeholder when no active server', () => {
    useServerStore.setState({ servers: [], isLoading: false, activeServerId: null });
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    expect(screen.getByLabelText('No active server')).toBeInTheDocument();
  });

  it('shows unread badge for servers with unreads', () => {
    useServerStore.setState({
      servers: [mockServer, mockServer2],
      activeServerId: mockServer.id,
      isLoading: false,
    });
    useUnreadStore.getState().markServerUnread(mockServer2.id);
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    const badge = document.querySelector('.server-bar-badge');
    expect(badge).toBeInTheDocument();
  });

  it('shows loading skeletons when loading', () => {
    useServerStore.setState({ servers: [], isLoading: true });
    render(<ServerBar onOpenActionModal={onOpenActionModal} onContextMenu={onContextMenu} />);
    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });
});
