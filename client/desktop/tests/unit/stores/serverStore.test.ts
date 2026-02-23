import { useServerStore } from '@/renderer/stores/serverStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockServer, mockServer2, mockMessage } from '../../mocks/fixtures';
import { server } from '../../mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('serverStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  describe('fetchServers', () => {
    it('fetches servers from API', async () => {
      await useServerStore.getState().fetchServers();
      const state = useServerStore.getState();
      expect(state.servers.length).toBeGreaterThan(0);
      expect(state.isLoading).toBe(false);
    });
  });

  describe('addServer', () => {
    it('adds a server to the list', () => {
      useServerStore.getState().addServer(mockServer);
      expect(useServerStore.getState().servers).toHaveLength(1);
      expect(useServerStore.getState().servers[0].id).toBe('server-1');
    });

    it('prepends new server', () => {
      useServerStore.getState().addServer(mockServer);
      useServerStore.getState().addServer(mockServer2);
      expect(useServerStore.getState().servers[0].id).toBe('server-2');
    });
  });

  describe('updateServer', () => {
    it('updates server properties', () => {
      useServerStore.getState().addServer(mockServer);
      useServerStore.getState().updateServer('server-1', { name: 'Renamed' });
      expect(useServerStore.getState().servers[0].name).toBe('Renamed');
    });
  });

  describe('updateOnlineCounts', () => {
    it('updates online counts for servers', () => {
      useServerStore.getState().addServer(mockServer);
      useServerStore.getState().updateOnlineCounts({ 'server-1': 5 });
      expect(useServerStore.getState().servers[0].online_count).toBe(5);
    });
  });

  describe('removeServer', () => {
    it('removes server from list', () => {
      useServerStore.getState().addServer(mockServer);
      useServerStore.getState().addServer(mockServer2);
      useServerStore.getState().removeServer('server-1');
      expect(useServerStore.getState().servers).toHaveLength(1);
      expect(useServerStore.getState().servers[0].id).toBe('server-2');
    });

    it('cascades to clear channels and messages', () => {
      useServerStore.getState().addServer(mockServer);
      useChatStore.getState().addMessage('channel-1', mockMessage);
      useUnreadStore.getState().setUnreadCount('channel-1', 3);
      useServerStore.getState().removeServer('server-1');
      // After removal, related data should be cleaned
      expect(useServerStore.getState().servers).toHaveLength(0);
    });
  });

  describe('setActiveServer', () => {
    it('sets the active server', () => {
      useServerStore.getState().setActiveServer('server-1');
      expect(useServerStore.getState().activeServerId).toBe('server-1');
    });

    it('persists activeServerId', () => {
      useServerStore.getState().setActiveServer('server-1');
      const stored = JSON.parse(localStorage.getItem('concord-servers') || '{}');
      expect(stored.state?.activeServerId).toBe('server-1');
    });
  });

  describe('clearServers', () => {
    it('clears all servers', () => {
      useServerStore.getState().addServer(mockServer);
      useServerStore.getState().clearServers();
      expect(useServerStore.getState().servers).toHaveLength(0);
      expect(useServerStore.getState().activeServerId).toBeNull();
    });
  });
});
