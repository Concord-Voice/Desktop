import { useChatStore } from '@/renderer/stores/chat/chatStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockMessage, mockMessage2 } from '../../mocks/fixtures';

describe('chatStore editingMessageId (#1959)', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('starts as null (#1959)', () => {
    expect(useChatStore.getState().editingMessageId).toBeNull();
  });

  it('setEditingMessageId opens a row and null closes it (#1959)', () => {
    useChatStore.getState().setEditingMessageId('msg-1');
    expect(useChatStore.getState().editingMessageId).toBe('msg-1');

    useChatStore.getState().setEditingMessageId(null);
    expect(useChatStore.getState().editingMessageId).toBeNull();
  });

  describe('same-value write', () => {
    it('notifies a subscriber on a real change (positive control, #1959)', () => {
      const listener = vi.fn();
      const unsubscribe = useChatStore.subscribe(listener);
      try {
        useChatStore.getState().setEditingMessageId('msg-1');
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        unsubscribe();
      }
    });

    it('keeps the same state object and does not notify when the id is unchanged (#1959)', () => {
      useChatStore.getState().setEditingMessageId('msg-1');
      const before = useChatStore.getState();
      const listener = vi.fn();
      const unsubscribe = useChatStore.subscribe(listener);
      try {
        useChatStore.getState().setEditingMessageId('msg-1');
        expect(useChatStore.getState()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('keeps the same state object and does not notify on null over null (#1959)', () => {
      const before = useChatStore.getState();
      const listener = vi.fn();
      const unsubscribe = useChatStore.subscribe(listener);
      try {
        useChatStore.getState().setEditingMessageId(null);
        expect(useChatStore.getState()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });
  });

  describe('deleteMessage', () => {
    it('clears editingMessageId when the editing row is deleted (#1959)', () => {
      useChatStore.getState().setMessages('channel-1', [mockMessage, mockMessage2]);
      useChatStore.getState().setEditingMessageId('msg-1');
      expect(useChatStore.getState().editingMessageId).toBe('msg-1');

      useChatStore.getState().deleteMessage('channel-1', 'msg-1');

      expect(useChatStore.getState().editingMessageId).toBeNull();
      expect(
        useChatStore
          .getState()
          .messagesByChannel.get('channel-1')
          ?.map((m) => m.id)
      ).toEqual(['msg-2']);
    });

    it('leaves editingMessageId alone when a different row is deleted (#1959)', () => {
      useChatStore.getState().setMessages('channel-1', [mockMessage, mockMessage2]);
      useChatStore.getState().setEditingMessageId('msg-1');
      expect(useChatStore.getState().editingMessageId).toBe('msg-1');

      useChatStore.getState().deleteMessage('channel-1', 'msg-2');

      expect(useChatStore.getState().editingMessageId).toBe('msg-1');
      expect(
        useChatStore
          .getState()
          .messagesByChannel.get('channel-1')
          ?.map((m) => m.id)
      ).toEqual(['msg-1']);
    });
  });

  describe('clearMessages', () => {
    it('clears editingMessageId when the cleared context held the editing row (#1959)', () => {
      useChatStore.getState().setMessages('channel-1', [mockMessage]);
      useChatStore
        .getState()
        .setMessages('channel-2', [{ ...mockMessage2, channel_id: 'channel-2' }]);
      useChatStore.getState().setEditingMessageId('msg-1');
      expect(useChatStore.getState().editingMessageId).toBe('msg-1');

      useChatStore.getState().clearMessages('channel-1');

      expect(useChatStore.getState().editingMessageId).toBeNull();
      expect(useChatStore.getState().messagesByChannel.has('channel-1')).toBe(false);
    });

    it('leaves editingMessageId alone when another context is cleared (#1959)', () => {
      useChatStore.getState().setMessages('channel-1', [mockMessage]);
      useChatStore
        .getState()
        .setMessages('channel-2', [{ ...mockMessage2, channel_id: 'channel-2' }]);
      useChatStore.getState().setEditingMessageId('msg-1');
      expect(useChatStore.getState().editingMessageId).toBe('msg-1');

      useChatStore.getState().clearMessages('channel-2');

      expect(useChatStore.getState().editingMessageId).toBe('msg-1');
      expect(useChatStore.getState().messagesByChannel.has('channel-2')).toBe(false);
      expect(useChatStore.getState().messagesByChannel.has('channel-1')).toBe(true);
    });

    it('leaves editingMessageId alone when clearing a context that has no messages (#1959)', () => {
      useChatStore.getState().setEditingMessageId('msg-1');
      expect(useChatStore.getState().editingMessageId).toBe('msg-1');

      useChatStore.getState().clearMessages('never-loaded');

      expect(useChatStore.getState().editingMessageId).toBe('msg-1');
    });
  });

  it('reset() clears editingMessageId (#1959)', () => {
    useChatStore.getState().setEditingMessageId('msg-1');
    expect(useChatStore.getState().editingMessageId).toBe('msg-1');

    useChatStore.getState().reset();

    expect(useChatStore.getState().editingMessageId).toBeNull();
  });
});
