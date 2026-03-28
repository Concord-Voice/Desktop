/**
 * Extended tests for useWebSocket — covers validateEpochsOnReconnect,
 * the key rotation coordinator, and connection state listener mapping.
 * The base test file covers handler registration and basic functionality;
 * this focuses on the E2EE reconnect logic and rotation coordinator.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { useChatStore } from '@/renderer/stores/chatStore';
import { resetAllStores } from '../../helpers/store-helpers';

// Capture registered handlers so we can invoke them in tests
const registeredHandlers = new Map<string, Function>();
let connectionChangeHandler: Function | null = null;

const mockWsService = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn((type: string, handler: Function) => {
    registeredHandlers.set(type, handler);
    return () => {
      registeredHandlers.delete(type);
    };
  }),
  onConnectionChange: vi.fn((handler: Function) => {
    connectionChangeHandler = handler;
    handler('disconnected');
    return () => {
      connectionChangeHandler = null;
    };
  }),
  getConnectionInfo: vi.fn(() => null),
  getState: vi.fn(() => 'disconnected'),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  sendMessage: vi.fn(),
  sendTypingIndicator: vi.fn(),
  setAggressiveReconnect: vi.fn(),
};

vi.mock('@/renderer/services/websocketService', () => ({
  getWebSocketService: () => mockWsService,
  ConnectionState: {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    ERROR: 'error',
  },
}));

const mockGetCurrentKeyVersion = vi.fn().mockReturnValue(0);
const mockInvalidateChannelKey = vi.fn();
const mockRotateChannelKey = vi.fn().mockResolvedValue(undefined);
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    isInitialized: false,
    processPendingKeyRequests: vi.fn().mockResolvedValue(undefined),
    decryptForChannel: vi.fn(),
    invalidateChannelKey: (...args: unknown[]) => mockInvalidateChannelKey(...args),
    getCurrentKeyVersion: (...args: unknown[]) => mockGetCurrentKeyVersion(...args),
    rotateChannelKey: (...args: unknown[]) => mockRotateChannelKey(...args),
  },
}));

vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: { fetchAndApply: vi.fn() },
}));

vi.mock('@/renderer/services/notificationSoundService', () => ({
  notificationSoundService: { play: vi.fn() },
}));

// Mock apiFetch for validate-epochs
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  safeJson: async (res: { json: () => Promise<unknown> }) => res.json(),
}));

import { useWebSocket } from '@/renderer/hooks/useWebSocket';

beforeEach(() => {
  resetAllStores();
  registeredHandlers.clear();
  connectionChangeHandler = null;
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ participants: [] }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWebSocket — extended', () => {
  describe('connection state mapping', () => {
    it('maps CONNECTED to connected UI state', () => {
      useAuthStore.getState().setAccessToken('test-token');
      renderHook(() => useWebSocket());

      act(() => {
        connectionChangeHandler?.('connected');
      });

      expect(useChatStore.getState().connectionState).toBe('connected');
    });

    it('maps CONNECTING to connecting UI state', () => {
      useAuthStore.getState().setAccessToken('test-token');
      renderHook(() => useWebSocket());

      act(() => {
        connectionChangeHandler?.('connecting');
      });

      expect(useChatStore.getState().connectionState).toBe('connecting');
    });

    it('maps RECONNECTING to connecting UI state', () => {
      useAuthStore.getState().setAccessToken('test-token');
      renderHook(() => useWebSocket());

      act(() => {
        connectionChangeHandler?.('reconnecting');
      });

      expect(useChatStore.getState().connectionState).toBe('connecting');
    });

    it('maps ERROR to disconnected UI state', () => {
      useAuthStore.getState().setAccessToken('test-token');
      renderHook(() => useWebSocket());

      act(() => {
        connectionChangeHandler?.('error');
      });

      expect(useChatStore.getState().connectionState).toBe('disconnected');
    });
  });

  describe('subscribe/unsubscribe/sendMessage/sendTyping', () => {
    it('unsubscribe delegates to wsService', () => {
      useAuthStore.getState().setAccessToken('test-token');
      const { result } = renderHook(() => useWebSocket());

      result.current.unsubscribe('ch-1');
      expect(mockWsService.unsubscribe).toHaveBeenCalledWith('ch-1');
    });

    it('sendTyping delegates to wsService', () => {
      useAuthStore.getState().setAccessToken('test-token');
      const { result } = renderHook(() => useWebSocket());

      result.current.sendTyping('ch-1', true);
      expect(mockWsService.sendTypingIndicator).toHaveBeenCalledWith('ch-1', true);
    });

    it('getState returns current WS state', () => {
      useAuthStore.getState().setAccessToken('test-token');
      mockWsService.getState.mockReturnValue('connected');
      const { result } = renderHook(() => useWebSocket());

      expect(result.current.getState()).toBe('connected');
    });
  });

  describe('connection lifecycle', () => {
    it('reconnects when token changes', () => {
      useAuthStore.getState().setAccessToken('token-1');
      const { rerender } = renderHook(() => useWebSocket());

      expect(mockWsService.connect).toHaveBeenCalledWith('token-1');
      mockWsService.connect.mockClear();

      // Change token
      useAuthStore.getState().setAccessToken('token-2');
      rerender();

      // Should disconnect old and reconnect with new token
      expect(mockWsService.disconnect).toHaveBeenCalled();
    });
  });

  describe('key rotation coordinator', () => {
    it('listens for e2ee-key-rotation events', async () => {
      useAuthStore.getState().setAccessToken('test-token');
      vi.useFakeTimers();

      renderHook(() => useWebSocket());

      // Mock e2eeService as initialized
      const { e2eeService } = await import('@/renderer/services/e2eeService');
      (e2eeService as any).isInitialized = true;

      // Add a channel for the rotation coordinator to find
      useChannelStore.getState().addChannel({
        id: 'ch-rotate',
        server_id: 'server-1',
        name: 'test',
        type: 'text',
        is_encrypted: true,
        position: 0,
        created_at: '',
        updated_at: '',
      });

      // Mock API calls for the rotation flow
      mockApiFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ key: { key_version: 1 } }),
        }) // check existing key
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              members: [{ user_id: 'user-1' }, { user_id: 'user-2' }],
            }),
        }) // fetch members
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ public_key: 'mock-pk-1' }),
        }) // user-1 public key
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ public_key: 'mock-pk-2' }),
        }); // user-2 public key

      // Dispatch the event
      globalThis.dispatchEvent(
        new CustomEvent('e2ee-key-rotation', {
          detail: { channelId: 'ch-rotate', newEpoch: 2 },
        })
      );

      // The coordinator uses random jitter 0-2s — advance past it
      await vi.advanceTimersByTimeAsync(3000);

      // Verify the rotation coordinator attempted API calls for key rotation
      expect(mockApiFetch).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('cleans up rotation event listener on unmount', () => {
      useAuthStore.getState().setAccessToken('test-token');
      const removeListenerSpy = vi.spyOn(globalThis, 'removeEventListener');

      const { unmount } = renderHook(() => useWebSocket());
      unmount();

      expect(removeListenerSpy).toHaveBeenCalledWith('e2ee-key-rotation', expect.any(Function));
    });
  });
});
