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

const mockPlay = vi.fn();
vi.mock('@/renderer/services/notificationSoundService', () => ({
  notificationSoundService: {
    play: (...args: unknown[]) => mockPlay(...args),
    init: vi.fn(),
  },
}));

import { useWebSocketMessages } from '@/renderer/hooks/useWebSocketMessages';

// Build a mock wsService with on() that captures handlers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (...args: any[]) => void;

function createMockWsService() {
  const handlers = new Map<string, AnyHandler>();
  return {
    handlers,
    on: vi.fn((type: string, handler: AnyHandler) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    }),
  };
}

beforeEach(() => {
  resetAllStores();
  mockPlay.mockClear();
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

  describe('notification sounds', () => {
    beforeEach(() => {
      mockPlay.mockClear();
    });

    it('plays message sound on incoming channel message from another user', () => {
      const ws = createMockWsService();
      // Set current user to user-1 so messages from user-2 trigger sound
      useAuthStore.getState().setAccessToken('mock-token');
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('message');
      if (handler) {
        act(() => {
          handler({
            type: 'message',
            data: {
              id: 'msg-sound-1',
              channel_id: 'channel-1',
              user_id: 'user-2',
              content: 'Hello',
              username: 'other',
              is_encrypted: false,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('message', expect.any(Object));
      }
    });

    it('plays mention sound on unread_notify with mentioned flag', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('unread_notify');
      if (handler) {
        act(() => {
          handler({
            type: 'unread_notify',
            data: {
              channel_id: 'channel-1',
              mentioned: true,
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('mention');
      }
    });

    it('plays message sound on unread_notify without mention', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('unread_notify');
      if (handler) {
        act(() => {
          handler({
            type: 'unread_notify',
            data: {
              channel_id: 'channel-1',
              mentioned: false,
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('message');
      }
    });

    it('plays user-join sound on voice_participant_joined', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('voice_participant_joined');
      if (handler) {
        act(() => {
          handler({
            type: 'voice_participant_joined',
            data: {
              channel_id: 'channel-1',
              user_id: 'user-2',
              username: 'other',
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('user-join');
      }
    });

    it('plays user-leave sound on voice_participant_left', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('voice_participant_left');
      if (handler) {
        act(() => {
          handler({
            type: 'voice_participant_left',
            data: {
              channel_id: 'channel-1',
              user_id: 'user-2',
              username: 'other',
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('user-leave');
      }
    });

    it('plays friend-request sound on friend_request_received', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('friend_request_received');
      if (handler) {
        act(() => {
          handler({
            type: 'friend_request_received',
            data: {
              id: 'fr-1',
              from_user_id: 'user-2',
              from_username: 'other',
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('friend-request');
      }
    });
  });
});
