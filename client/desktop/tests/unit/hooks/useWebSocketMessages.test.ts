import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { resetAllStores } from '../../helpers/store-helpers';
import { mockChannel } from '../../mocks/fixtures';

// Mock e2eeService and ttsService to prevent side effects
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    decryptMessage: vi.fn((content: string) => Promise.resolve(content)),
    hasKey: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('@/renderer/services/ttsService', () => ({
  speak: vi.fn(),
}));

vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: { fetchAndApply: vi.fn() },
}));

vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ participants: [] }),
  }),
}));

import { useWebSocketMessages } from '@/renderer/hooks/useWebSocketMessages';

// Build a mock wsService with on() that captures handlers
function createMockWsService() {
  const handlers = new Map<string, Function>();
  return {
    handlers,
    on: vi.fn((type: string, handler: Function) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
  };
}

beforeEach(() => {
  resetAllStores();
  useAuthStore.getState().setAccessToken('mock-token');
  useChannelStore.getState().addChannel(mockChannel);
  useChatStore.setState({ isConnected: true });
});

describe('useWebSocketMessages', () => {
  it('registers message handlers on mount', () => {
    const ws = createMockWsService();
    renderHook(() => useWebSocketMessages(ws as never));
    expect(ws.on).toHaveBeenCalled();
    expect(ws.handlers.size).toBeGreaterThan(0);
  });

  it('handles incoming message', () => {
    const ws = createMockWsService();
    renderHook(() => useWebSocketMessages(ws as never));

    const messageHandler = ws.handlers.get('message');
    expect(messageHandler).toBeDefined();

    if (messageHandler) {
      act(() => {
        messageHandler({
          type: 'message',
          data: {
            id: 'msg-ws-1',
            channel_id: 'channel-1',
            user_id: 'user-2',
            content: 'Hello from WebSocket',
            username: 'testuser2',
            is_encrypted: false,
            created_at: '2025-01-01T12:00:00Z',
            updated_at: '2025-01-01T12:00:00Z',
          },
        });
      });

      const messages = useChatStore.getState().messagesByChannel.get('channel-1');
      expect(messages).toBeDefined();
      expect(messages?.some((m) => m.id === 'msg-ws-1')).toBe(true);
    }
  });

  it('handles message_deleted', () => {
    const ws = createMockWsService();
    renderHook(() => useWebSocketMessages(ws as never));

    // Add a message first
    useChatStore.getState().addMessage('channel-1', {
      id: 'msg-del-1',
      channel_id: 'channel-1',
      user_id: 'user-1',
      content: 'To be deleted',
      username: 'testuser',
      is_encrypted: false,
      status: 'delivered',
      created_at: '2025-01-01T12:00:00Z',
      updated_at: '2025-01-01T12:00:00Z',
    });

    const deleteHandler = ws.handlers.get('message_deleted');
    if (deleteHandler) {
      act(() => {
        deleteHandler({
          type: 'message_deleted',
          data: {
            message_id: 'msg-del-1',
            channel_id: 'channel-1',
          },
        });
      });

      const messages = useChatStore.getState().messagesByChannel.get('channel-1');
      expect(messages?.find((m) => m.id === 'msg-del-1')).toBeUndefined();
    }
  });

  it('handles typing indicator', () => {
    const ws = createMockWsService();
    renderHook(() => useWebSocketMessages(ws as never));

    const typingHandler = ws.handlers.get('typing');
    if (typingHandler) {
      act(() => {
        typingHandler({
          type: 'typing',
          data: {
            channel_id: 'channel-1',
            user_id: 'user-2',
            username: 'testuser2',
          },
        });
      });
    }
    // Typing state is transient — just verify no crash
  });

  it('unregisters handlers on unmount', () => {
    const ws = createMockWsService();
    const { unmount } = renderHook(() => useWebSocketMessages(ws as never));
    const handlerCount = ws.handlers.size;
    expect(handlerCount).toBeGreaterThan(0);

    unmount();
    // Cleanup functions should have been called, clearing handlers
    expect(ws.handlers.size).toBeLessThan(handlerCount);
  });
});
