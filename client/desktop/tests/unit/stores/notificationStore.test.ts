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
      voiceEventSounds: true,
      suppressWhenFocused: true,
      desktopNotificationsEnabled: true,
      desktopNotifyDMs: true,
      desktopNotifyMentions: true,
      desktopNotifyAllMessages: false,
      doNotDisturb: false,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
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
    expect(state.voiceEventSounds).toBe(true);
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

  it('toggles voiceEventSounds', () => {
    useNotificationStore.getState().setVoiceEventSounds(false);
    expect(useNotificationStore.getState().voiceEventSounds).toBe(false);
  });

  it('toggles suppressWhenFocused', () => {
    useNotificationStore.getState().setSuppressWhenFocused(false);
    expect(useNotificationStore.getState().suppressWhenFocused).toBe(false);
  });

  it('has correct defaults for desktop notification fields', () => {
    const state = useNotificationStore.getState();
    expect(state.desktopNotificationsEnabled).toBe(true);
    expect(state.desktopNotifyDMs).toBe(true);
    expect(state.desktopNotifyMentions).toBe(true);
    expect(state.desktopNotifyAllMessages).toBe(false);
    expect(state.doNotDisturb).toBe(false);
    expect(state.quietHoursEnabled).toBe(false);
    expect(state.quietHoursStart).toBe('22:00');
    expect(state.quietHoursEnd).toBe('08:00');
  });

  it('toggles desktopNotificationsEnabled', () => {
    useNotificationStore.getState().setDesktopNotificationsEnabled(false);
    expect(useNotificationStore.getState().desktopNotificationsEnabled).toBe(false);
    useNotificationStore.getState().setDesktopNotificationsEnabled(true);
    expect(useNotificationStore.getState().desktopNotificationsEnabled).toBe(true);
  });

  it('toggles desktopNotifyDMs', () => {
    useNotificationStore.getState().setDesktopNotifyDMs(false);
    expect(useNotificationStore.getState().desktopNotifyDMs).toBe(false);
    useNotificationStore.getState().setDesktopNotifyDMs(true);
    expect(useNotificationStore.getState().desktopNotifyDMs).toBe(true);
  });

  it('toggles desktopNotifyMentions', () => {
    useNotificationStore.getState().setDesktopNotifyMentions(false);
    expect(useNotificationStore.getState().desktopNotifyMentions).toBe(false);
    useNotificationStore.getState().setDesktopNotifyMentions(true);
    expect(useNotificationStore.getState().desktopNotifyMentions).toBe(true);
  });

  it('toggles desktopNotifyAllMessages', () => {
    useNotificationStore.getState().setDesktopNotifyAllMessages(true);
    expect(useNotificationStore.getState().desktopNotifyAllMessages).toBe(true);
    useNotificationStore.getState().setDesktopNotifyAllMessages(false);
    expect(useNotificationStore.getState().desktopNotifyAllMessages).toBe(false);
  });

  it('toggles doNotDisturb', () => {
    useNotificationStore.getState().setDoNotDisturb(true);
    expect(useNotificationStore.getState().doNotDisturb).toBe(true);
    useNotificationStore.getState().setDoNotDisturb(false);
    expect(useNotificationStore.getState().doNotDisturb).toBe(false);
  });

  it('toggles quietHoursEnabled', () => {
    useNotificationStore.getState().setQuietHoursEnabled(true);
    expect(useNotificationStore.getState().quietHoursEnabled).toBe(true);
    useNotificationStore.getState().setQuietHoursEnabled(false);
    expect(useNotificationStore.getState().quietHoursEnabled).toBe(false);
  });

  it('sets quietHoursStart', () => {
    useNotificationStore.getState().setQuietHoursStart('23:30');
    expect(useNotificationStore.getState().quietHoursStart).toBe('23:30');
  });

  it('sets quietHoursEnd', () => {
    useNotificationStore.getState().setQuietHoursEnd('07:00');
    expect(useNotificationStore.getState().quietHoursEnd).toBe('07:00');
  });
});
