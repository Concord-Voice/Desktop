import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatStore } from '@/renderer/stores/chatStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useDMStore } from '@/renderer/stores/dmStore';
import { useFriendStore } from '@/renderer/stores/friendStore';
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
const mockPlayLoop = vi.fn();
const mockStopLoop = vi.fn();
const mockStopAllLoops = vi.fn();
const mockIsLooping = vi.fn().mockReturnValue(false);
vi.mock('@/renderer/services/notificationSoundService', () => ({
  notificationSoundService: {
    play: (...args: unknown[]) => mockPlay(...args),
    playLoop: (...args: unknown[]) => mockPlayLoop(...args),
    stopLoop: (...args: unknown[]) => mockStopLoop(...args),
    stopAllLoops: () => mockStopAllLoops(),
    isLooping: (...args: unknown[]) => mockIsLooping(...args),
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
  mockPlayLoop.mockClear();
  mockStopLoop.mockClear();
  mockStopAllLoops.mockClear();
  mockIsLooping.mockReset().mockReturnValue(false);
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

  describe('runtime payload guards', () => {
    // These cover the defensive guards added in #667 against malformed
    // server-sent payloads. Each guard rejects the event and returns early
    // rather than poisoning Zustand state with undefined/malformed fields.
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('message handler rejects payload missing user_id', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('message');
      expect(handler).toBeDefined();

      act(() => {
        handler?.({
          type: 'message',
          data: {
            id: 'msg-guard-1',
            channel_id: 'channel-1',
            // user_id intentionally omitted
            content: 'should be dropped',
            created_at: '2026-04-19T12:00:00Z',
          },
        });
      });

      // No message should have been added to the store for this channel
      const msgs = useChatStore.getState().messagesByChannel.get('channel-1');
      expect(msgs?.some((m) => m.id === 'msg-guard-1')).toBeFalsy();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Message missing user_id:', expect.any(Object));
    });

    it('dm_message handler rejects malformed conversation_id (non-string)', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('dm_message');
      expect(handler).toBeDefined();

      const before = useDMStore.getState().conversations.length;
      act(() => {
        handler?.({
          type: 'dm_message',
          data: {
            conversation_id: 12345, // number, not string — should be rejected
            user_id: 'user-x',
            content: 'malformed',
          },
        });
      });

      expect(useDMStore.getState().conversations.length).toBe(before);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('dm_message handler rejects missing user_id even with valid conversation_id', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('dm_message');
      const before = useDMStore.getState().conversations.length;
      act(() => {
        handler?.({
          type: 'dm_message',
          data: {
            conversation_id: 'dm-conv-1',
            // user_id omitted
            content: 'no sender',
          },
        });
      });

      expect(useDMStore.getState().conversations.length).toBe(before);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'DM message missing user_id:',
        expect.any(Object)
      );
    });

    it('dm_unread_notify handler silently drops malformed conversation_id', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('dm_unread_notify');
      expect(handler).toBeDefined();

      // Should not throw and should not play a DM sound
      act(() => {
        handler?.({
          type: 'dm_unread_notify',
          data: {
            conversation_id: '', // empty string — should be rejected
            mentioned: true,
          },
        });
      });

      expect(mockPlay).not.toHaveBeenCalledWith('dm');
    });

    it('dm_conversation_created skips participants missing required fields', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('dm_conversation_created');
      expect(handler).toBeDefined();

      act(() => {
        handler?.({
          type: 'dm_conversation_created',
          data: {
            conversation: {
              id: 'conv-guard-1',
              is_group: false,
              created_at: '2026-04-19T12:00:00Z',
              participants: [
                // Valid participant
                { user_id: 'alice', username: 'alice' },
                // Malformed — should be skipped with warning
                { user_id: 'bob' /* username missing */ },
                // Another valid one
                { user_id: 'carol', username: 'carol', role: 'admin' },
              ],
            },
          },
        });
      });

      const conv = useDMStore.getState().conversations.find((c) => c.id === 'conv-guard-1');
      expect(conv).toBeDefined();
      // Only 2 of the 3 input participants should have been admitted
      expect(conv?.participants.length).toBe(2);
      expect(conv?.participants.map((p) => p.userId).sort()).toEqual(['alice', 'carol']);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'dm_conversation_created: skipping malformed participant',
        expect.any(Object)
      );
    });

    it('dm_conversation_created rejects envelope missing required fields', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('dm_conversation_created');
      const before = useDMStore.getState().conversations.length;
      act(() => {
        handler?.({
          type: 'dm_conversation_created',
          data: {
            conversation: {
              id: 'conv-malformed',
              // is_group missing
              created_at: '2026-04-19T12:00:00Z',
              participants: [],
            },
          },
        });
      });

      // No conversation should have been added
      expect(useDMStore.getState().conversations.length).toBe(before);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'dm_conversation_created: malformed conversation envelope',
        expect.any(Object)
      );
    });

    it('friend_request_received rejects payload missing required fields', () => {
      const ws = createMockWsService();
      renderHook(() => useWebSocketMessages(ws as never));

      const handler = ws.handlers.get('friend_request_received');
      expect(handler).toBeDefined();

      const before = useFriendStore.getState().pendingRequests.length;
      act(() => {
        handler?.({
          type: 'friend_request_received',
          data: {
            id: 'fr-malformed',
            from_user_id: 'user-x',
            // to_user_id + created_at missing
          },
        });
      });

      expect(useFriendStore.getState().pendingRequests.length).toBe(before);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'friend_request_received: malformed payload',
        expect.any(Object)
      );
      // The notification sound is only played when the guard passes
      expect(mockPlay).not.toHaveBeenCalledWith('friend-request');
    });
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
              to_user_id: 'user-1',
              to_username: 'self',
              created_at: '2026-04-19T07:30:00Z',
            },
          });
        });
        expect(mockPlay).toHaveBeenCalledWith('friend-request');
      }
    });

    describe('DM call sounds', () => {
      it('plays incoming ring when someone starts a DM call we are not in', () => {
        const ws = createMockWsService();
        useUserStore.setState({ user: { id: 'user-1', username: 'me' } as never });
        renderHook(() => useWebSocketMessages(ws as never));

        const handler = ws.handlers.get('dm_voice_state_update');
        if (handler) {
          act(() => {
            handler({
              type: 'dm_voice_state_update',
              data: {
                conversation_id: 'dm-conv-1',
                action: 'joined',
                user_id: 'user-2',
              },
            });
          });
          expect(mockPlayLoop).toHaveBeenCalledWith('call-ringing');
        }
      });

      it('plays call-connected when someone joins our active DM call', () => {
        const ws = createMockWsService();
        useUserStore.setState({ user: { id: 'user-1', username: 'me' } as never });
        useVoiceStore.setState({
          isDMCall: true,
          dmConversationId: 'dm-conv-1',
        });
        renderHook(() => useWebSocketMessages(ws as never));

        const handler = ws.handlers.get('dm_voice_state_update');
        if (handler) {
          act(() => {
            handler({
              type: 'dm_voice_state_update',
              data: {
                conversation_id: 'dm-conv-1',
                action: 'joined',
                user_id: 'user-2',
              },
            });
          });
          expect(mockStopAllLoops).toHaveBeenCalled();
          expect(mockPlay).toHaveBeenCalledWith('call-connected');
        }
      });

      it('plays call-declined when caller leaves while ringing', () => {
        const ws = createMockWsService();
        useUserStore.setState({ user: { id: 'user-1', username: 'me' } as never });
        mockIsLooping.mockImplementation((type: string) => type === 'call-ringing');
        renderHook(() => useWebSocketMessages(ws as never));

        const handler = ws.handlers.get('dm_voice_state_update');
        if (handler) {
          act(() => {
            handler({
              type: 'dm_voice_state_update',
              data: {
                conversation_id: 'dm-conv-1',
                action: 'left',
                user_id: 'user-2',
              },
            });
          });
          expect(mockStopLoop).toHaveBeenCalledWith('call-ringing');
          expect(mockPlay).toHaveBeenCalledWith('call-declined');
        }
      });

      it('stops all loops on room_empty', () => {
        const ws = createMockWsService();
        useUserStore.setState({ user: { id: 'user-1', username: 'me' } as never });
        renderHook(() => useWebSocketMessages(ws as never));

        const handler = ws.handlers.get('dm_voice_state_update');
        if (handler) {
          act(() => {
            handler({
              type: 'dm_voice_state_update',
              data: {
                conversation_id: 'dm-conv-1',
                action: 'room_empty',
              },
            });
          });
          expect(mockStopAllLoops).toHaveBeenCalled();
        }
      });

      it('ignores own dm_voice_state_update events', () => {
        const ws = createMockWsService();
        useUserStore.setState({ user: { id: 'user-1', username: 'me' } as never });
        renderHook(() => useWebSocketMessages(ws as never));

        const handler = ws.handlers.get('dm_voice_state_update');
        if (handler) {
          act(() => {
            handler({
              type: 'dm_voice_state_update',
              data: {
                conversation_id: 'dm-conv-1',
                action: 'joined',
                user_id: 'user-1', // Self
              },
            });
          });
          expect(mockPlayLoop).not.toHaveBeenCalled();
          expect(mockPlay).not.toHaveBeenCalled();
        }
      });
    });
  });
});
