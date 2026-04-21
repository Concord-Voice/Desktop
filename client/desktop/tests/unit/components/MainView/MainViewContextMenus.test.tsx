import { render } from '../../../test-utils';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetAllStores } from '../../../helpers/store-helpers';
import MainViewContextMenus from '@/renderer/components/MainView/MainViewContextMenus';
import type { ServerWithRole } from '@/renderer/types/server';
import type { Channel, ChannelGroup } from '@/renderer/types/chat';

describe('MainViewContextMenus', () => {
  beforeEach(() => {
    resetAllStores();
  });

  const noopProps = {
    serverContextMenu: null,
    setServerContextMenu: vi.fn(),
    channelContextMenu: null,
    setChannelContextMenu: vi.fn(),
    categoryContextMenu: null,
    setCategoryContextMenu: vi.fn(),
    emptyContextMenu: null,
    setEmptyContextMenu: vi.fn(),
    activeServer: null,
    canManageChannels: false,
    onEditServer: vi.fn(),
    onDeleteServer: vi.fn(),
    onLeaveServer: vi.fn(),
    onInviteServer: vi.fn(),
    onEditChannel: vi.fn(),
    onDeleteChannel: vi.fn(),
    onChannelPermissions: vi.fn(),
    onEditCategory: vi.fn(),
    onDeleteCategory: vi.fn(),
    onCategoryPermissions: vi.fn(),
    onOpenCreateChannelModal: vi.fn(),
    onOpenCreateCategoryModal: vi.fn(),
  };

  it('renders without crashing when all menus are closed', () => {
    const { container } = render(<MainViewContextMenus {...noopProps} />);
    expect(container).toBeTruthy();
  });

  it('does not crash when all menu props are non-null (branch-coverage smoke)', () => {
    const mockServer: ServerWithRole = {
      id: 'server-1',
      name: 'Test Server',
      owner_id: 'user-1',
      e2ee_default: false,
      allow_embedded_content: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      role: 'owner',
      member_count: 1,
      online_count: 1,
    };

    const mockChannel: Channel = {
      id: 'chan-1',
      server_id: 'server-1',
      name: 'general',
      type: 'text',
      is_encrypted: false,
      position: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const mockCategory: ChannelGroup = {
      id: 'cat-1',
      server_id: 'server-1',
      name: 'General',
      position: 0,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    const allOpenProps = {
      ...noopProps,
      serverContextMenu: { server: mockServer, position: { x: 10, y: 10 } },
      channelContextMenu: { channel: mockChannel, position: { x: 10, y: 10 } },
      categoryContextMenu: { group: mockCategory, position: { x: 10, y: 10 } },
      emptyContextMenu: { position: { x: 10, y: 10 } },
      activeServer: mockServer,
      canManageChannels: true,
    };

    const { container } = render(<MainViewContextMenus {...allOpenProps} />);
    expect(container).toBeTruthy();
  });
});
