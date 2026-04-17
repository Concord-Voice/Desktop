import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMemberStore } from '@/renderer/stores/memberStore';
import { useDMStore } from '@/renderer/stores/dmStore';
import { useFriendStore } from '@/renderer/stores/friendStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { resetAllStores } from '../helpers/store-helpers';
import { mockUser } from '../mocks/fixtures';

vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: { isInitialized: false },
}));
vi.mock('@/renderer/services/ttsService', () => ({ speak: vi.fn() }));
vi.mock('@/renderer/services/preferencesSync', () => ({
  preferencesSyncService: { fetchAndApply: vi.fn() },
}));
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ participants: [] }),
  }),
}));
vi.mock('@/renderer/services/notificationSoundService', () => ({
  notificationSoundService: {
    play: vi.fn(),
    playLoop: vi.fn(),
    stopLoop: vi.fn(),
    stopAllLoops: vi.fn(),
    isLooping: vi.fn().mockReturnValue(false),
    init: vi.fn(),
  },
}));
vi.mock('@/renderer/services/savedGifsSync', () => ({
  savedGifsSyncService: { fetchAndApply: vi.fn() },
}));
vi.mock('@/renderer/services/searchService', () => ({
  indexMessage: vi.fn(),
}));
vi.mock('@/renderer/services/desktopNotificationService', () => ({
  desktopNotificationService: {
    shouldNotify: vi.fn().mockReturnValue(false),
    notify: vi.fn(),
    incrementBadge: vi.fn(),
  },
}));

import { useWebSocketMessages } from '@/renderer/hooks/useWebSocketMessages';

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
  useAuthStore.getState().setAccessToken('mock-token');
});

describe('Presence fan-out (integration)', () => {
  it('presence event updates memberStore, dmStore, and friendStore', () => {
    useUserStore.setState({ user: mockUser as never });

    // Seed DM participant
    useDMStore.setState({
      conversations: [
        {
          id: 'conv-1',
          isGroup: false,
          isPersonal: false,
          name: null,
          isEncrypted: false,
          participants: [{ userId: 'user-2', username: 'friend1', status: 'offline' }],
          lastMessage: null,
          unreadCount: 0,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
    } as never);

    // Seed friend
    useFriendStore.getState().addFriend({
      id: 'friend-1',
      userId: 'user-2',
      username: 'friend1',
      status: 'offline',
    });

    const wsService = createMockWsService();
    renderHook(() => useWebSocketMessages(wsService as never));

    const handler = wsService.handlers.get('presence');
    expect(handler).toBeDefined();

    act(() => {
      handler!({ type: 'presence', data: { user_id: 'user-2', status: 'online' } });
    });

    // memberStore: userStatuses Map updated
    expect(useMemberStore.getState().userStatuses.get('user-2')).toBe('online');

    // dmStore participant status updated
    const conv = useDMStore.getState().conversations[0];
    const participant = conv.participants.find((p) => p.userId === 'user-2');
    expect(participant?.status).toBe('online');

    // friendStore status updated
    const friend = useFriendStore.getState().friends.find((f) => f.userId === 'user-2');
    expect(friend?.status).toBe('online');
  });

  it('presence event to offline updates all three stores', () => {
    useUserStore.setState({ user: mockUser as never });

    useDMStore.setState({
      conversations: [
        {
          id: 'conv-1',
          isGroup: false,
          isPersonal: false,
          name: null,
          isEncrypted: false,
          participants: [{ userId: 'user-2', username: 'friend1', status: 'online' }],
          lastMessage: null,
          unreadCount: 0,
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
    } as never);

    useFriendStore.getState().addFriend({
      id: 'friend-1',
      userId: 'user-2',
      username: 'friend1',
      status: 'online',
    });

    const wsService = createMockWsService();
    renderHook(() => useWebSocketMessages(wsService as never));

    const handler = wsService.handlers.get('presence');
    act(() => {
      handler!({
        type: 'presence',
        data: { user_id: 'user-2', status: 'offline', timestamp: 1700000000 },
      });
    });

    expect(useMemberStore.getState().userStatuses.get('user-2')).toBe('offline');

    const conv = useDMStore.getState().conversations[0];
    const participant = conv.participants.find((p) => p.userId === 'user-2');
    expect(participant?.status).toBe('offline');

    const friend = useFriendStore.getState().friends.find((f) => f.userId === 'user-2');
    expect(friend?.status).toBe('offline');
  });

  it('presence event for self user is ignored', () => {
    useUserStore.setState({ user: mockUser as never });

    useFriendStore.getState().addFriend({
      id: 'friend-self',
      userId: 'user-1',
      username: 'testuser',
      status: 'online',
    });

    const wsService = createMockWsService();
    renderHook(() => useWebSocketMessages(wsService as never));

    const handler = wsService.handlers.get('presence');
    act(() => {
      // Server broadcasts "offline" for the self user (invisible case)
      handler!({ type: 'presence', data: { user_id: 'user-1', status: 'offline' } });
    });

    // Self status in memberStore should not be overridden
    // (setUserStatus is skipped for self)
    expect(useMemberStore.getState().userStatuses.get('user-1')).toBeUndefined();
  });
});
