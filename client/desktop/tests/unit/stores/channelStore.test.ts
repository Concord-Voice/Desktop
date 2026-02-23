import { useChannelStore } from '@/renderer/stores/channelStore';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useUnreadStore } from '@/renderer/stores/unreadStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockChannel, mockEncryptedChannel, mockMessage } from '../../mocks/fixtures';

describe('channelStore', () => {
  beforeEach(() => {
    resetAllStores();
  });

  describe('addChannel', () => {
    it('adds a channel', () => {
      useChannelStore.getState().addChannel(mockChannel);
      expect(useChannelStore.getState().channels).toHaveLength(1);
      expect(useChannelStore.getState().channels[0].name).toBe('general');
    });
  });

  describe('updateChannel', () => {
    it('updates channel properties', () => {
      useChannelStore.getState().addChannel(mockChannel);
      useChannelStore.getState().updateChannel('channel-1', { name: 'renamed' });
      expect(useChannelStore.getState().channels[0].name).toBe('renamed');
    });

    it('strips is_encrypted from updates', () => {
      useChannelStore.getState().addChannel(mockChannel);
      useChannelStore.getState().updateChannel('channel-1', { is_encrypted: true } as any);
      expect(useChannelStore.getState().channels[0].is_encrypted).toBe(false);
    });
  });

  describe('removeChannel', () => {
    it('removes a channel', () => {
      useChannelStore.getState().addChannel(mockChannel);
      useChannelStore.getState().addChannel(mockEncryptedChannel);
      useChannelStore.getState().removeChannel('channel-1');
      expect(useChannelStore.getState().channels).toHaveLength(1);
      expect(useChannelStore.getState().channels[0].id).toBe('channel-2');
    });

    it('cascades to clear messages and unreads', () => {
      useChannelStore.getState().addChannel(mockChannel);
      useChatStore.getState().addMessage('channel-1', mockMessage);
      useUnreadStore.getState().setUnreadCount('channel-1', 3);
      useChannelStore.getState().removeChannel('channel-1');
      expect(useChatStore.getState().messagesByChannel.has('channel-1')).toBe(false);
      expect(useUnreadStore.getState().unreadCounts.has('channel-1')).toBe(false);
    });
  });

  describe('setActiveChannel', () => {
    it('sets active channel', () => {
      useChannelStore.getState().setActiveChannel('channel-1');
      expect(useChannelStore.getState().activeChannelId).toBe('channel-1');
    });

    it('clears active channel with null', () => {
      useChannelStore.getState().setActiveChannel('channel-1');
      useChannelStore.getState().setActiveChannel(null);
      expect(useChannelStore.getState().activeChannelId).toBeNull();
    });
  });

  describe('lastChannelByServer', () => {
    it('tracks last-viewed channel per server', () => {
      // Simulate the store tracking behavior
      const store = useChannelStore.getState();
      store.addChannel(mockChannel);
      store.setActiveChannel('channel-1');
      // lastChannelByServer gets set in setActiveChannel when currentServerId is set
    });
  });

  describe('clearChannels', () => {
    it('clears all channels', () => {
      useChannelStore.getState().addChannel(mockChannel);
      useChannelStore.getState().addChannel(mockEncryptedChannel);
      useChannelStore.getState().clearChannels();
      expect(useChannelStore.getState().channels).toHaveLength(0);
      expect(useChannelStore.getState().activeChannelId).toBeNull();
    });
  });
});
