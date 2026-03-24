import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from '../../../src/renderer/stores/notificationStore';

describe('notificationStore', () => {
  beforeEach(() => {
    // Reset store to defaults
    useNotificationStore.setState({
      enabled: true,
      volume: 80,
      messageSound: true,
      mentionSound: true,
      dmSound: true,
      friendRequestSound: true,
      suppressWhenFocused: true,
    });
  });

  it('has correct defaults', () => {
    const state = useNotificationStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.volume).toBe(80);
    expect(state.messageSound).toBe(true);
    expect(state.mentionSound).toBe(true);
    expect(state.dmSound).toBe(true);
    expect(state.friendRequestSound).toBe(true);
    expect(state.suppressWhenFocused).toBe(true);
  });

  it('toggles master enabled', () => {
    useNotificationStore.getState().setEnabled(false);
    expect(useNotificationStore.getState().enabled).toBe(false);
    useNotificationStore.getState().setEnabled(true);
    expect(useNotificationStore.getState().enabled).toBe(true);
  });

  it('sets volume with clamping', () => {
    useNotificationStore.getState().setVolume(50);
    expect(useNotificationStore.getState().volume).toBe(50);

    useNotificationStore.getState().setVolume(-10);
    expect(useNotificationStore.getState().volume).toBe(0);

    useNotificationStore.getState().setVolume(200);
    expect(useNotificationStore.getState().volume).toBe(100);
  });

  it('toggles per-category sounds', () => {
    const { setMessageSound, setMentionSound, setDmSound, setFriendRequestSound } =
      useNotificationStore.getState();

    setMessageSound(false);
    expect(useNotificationStore.getState().messageSound).toBe(false);

    setMentionSound(false);
    expect(useNotificationStore.getState().mentionSound).toBe(false);

    setDmSound(false);
    expect(useNotificationStore.getState().dmSound).toBe(false);

    setFriendRequestSound(false);
    expect(useNotificationStore.getState().friendRequestSound).toBe(false);
  });

  it('toggles suppressWhenFocused', () => {
    useNotificationStore.getState().setSuppressWhenFocused(false);
    expect(useNotificationStore.getState().suppressWhenFocused).toBe(false);
  });
});
