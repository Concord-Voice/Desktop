import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEditLastMessage } from '@/renderer/hooks/messaging/useEditLastMessage';
import { useChatStore } from '@/renderer/stores/chat/chatStore';
import type { MessageWithStatus } from '@/renderer/types/chat';
import { mockMessage } from '../../mocks/fixtures';
import { resetAllStores } from '../../helpers/store-helpers';

const ME = mockMessage.user_id;

const msg = (overrides: Partial<MessageWithStatus>): MessageWithStatus => ({
  ...mockMessage,
  ...overrides,
});

describe('useEditLastMessage', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('opens the newest own delivered message for editing', () => {
    const messages = [msg({ id: 'older' }), msg({ id: 'newest' })];
    const { result } = renderHook(() => useEditLastMessage(messages, ME));
    expect(useChatStore.getState().editingMessageId).toBeNull();

    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBe('newest');
  });

  it('opens nothing when the newest own message is still pending, even with an older delivered one', () => {
    const messages = [msg({ id: 'older' }), msg({ id: 'newest', status: 'pending' })];
    const { result } = renderHook(() => useEditLastMessage(messages, ME));

    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBeNull();
  });

  it('opens nothing when the list holds no message by the current user', () => {
    const messages = [msg({ id: 'theirs', user_id: 'user-2' })];
    const { result } = renderHook(() => useEditLastMessage(messages, ME));

    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBeNull();
  });

  it('opens nothing when the current user id is empty', () => {
    const messages = [msg({ id: 'own' })];
    const { result } = renderHook(() => useEditLastMessage(messages, ''));

    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBeNull();
  });

  it.each(['call_event', 'expiration_event'] as const)(
    'skips a newer %s system row and opens the user message beneath it',
    (type) => {
      const messages = [msg({ id: 'user-row' }), msg({ id: 'system-row', type })];
      const { result } = renderHook(() => useEditLastMessage(messages, ME));

      act(() => result.current());

      expect(useChatStore.getState().editingMessageId).toBe('user-row');
    }
  );

  it('reflects re-rendered inputs: a newer own message becomes the target', () => {
    const initial = [msg({ id: 'first' })];
    const { result, rerender } = renderHook(
      ({ messages }: { messages: MessageWithStatus[] }) => useEditLastMessage(messages, ME),
      { initialProps: { messages: initial } }
    );
    act(() => result.current());
    expect(useChatStore.getState().editingMessageId).toBe('first');

    rerender({ messages: [...initial, msg({ id: 'second' })] });
    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBe('second');
  });

  it('never clears: a null selector result leaves an already-open edit untouched', () => {
    useChatStore.getState().setEditingMessageId('already-open');
    const messages = [msg({ id: 'newest', status: 'pending' })];
    const { result } = renderHook(() => useEditLastMessage(messages, ME));

    act(() => result.current());

    expect(useChatStore.getState().editingMessageId).toBe('already-open');
  });
});
