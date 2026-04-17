import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { wrapStore } from '../utils/createStore';

export interface NotificationSoundSettings {
  /** Master toggle for all notification sounds */
  enabled: boolean;
  /** Volume level 0–100 */
  volume: number;
  /** Play sound for channel messages */
  messageSound: boolean;
  /** Play distinct sound for @mentions */
  mentionSound: boolean;
  /** Play sound for DM messages */
  dmSound: boolean;
  /** Play sound for friend requests */
  friendRequestSound: boolean;
  /** Play sounds for voice channel events (join, leave, mute, etc.) */
  voiceEventSounds: boolean;
  /** Suppress sound when the window is focused on the channel that received the message */
  suppressWhenFocused: boolean;
  /** Master toggle for desktop notifications */
  desktopNotificationsEnabled: boolean;
  /** Show desktop notification for DM messages */
  desktopNotifyDMs: boolean;
  /** Show desktop notification for @mentions */
  desktopNotifyMentions: boolean;
  /** Show desktop notification for all channel messages */
  desktopNotifyAllMessages: boolean;
  /** Suppress all notifications when DND status is active */
  doNotDisturb: boolean;
  /** Enable quiet hours (time-based suppression) */
  quietHoursEnabled: boolean;
  /** Quiet hours start time (HH:MM format) */
  quietHoursStart: string;
  /** Quiet hours end time (HH:MM format) */
  quietHoursEnd: string;
}

interface NotificationStore extends NotificationSoundSettings {
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setMessageSound: (enabled: boolean) => void;
  setMentionSound: (enabled: boolean) => void;
  setDmSound: (enabled: boolean) => void;
  setFriendRequestSound: (enabled: boolean) => void;
  setVoiceEventSounds: (enabled: boolean) => void;
  setSuppressWhenFocused: (suppress: boolean) => void;
  setDesktopNotificationsEnabled: (enabled: boolean) => void;
  setDesktopNotifyDMs: (enabled: boolean) => void;
  setDesktopNotifyMentions: (enabled: boolean) => void;
  setDesktopNotifyAllMessages: (enabled: boolean) => void;
  setDoNotDisturb: (enabled: boolean) => void;
  setQuietHoursEnabled: (enabled: boolean) => void;
  setQuietHoursStart: (start: string) => void;
  setQuietHoursEnd: (end: string) => void;
}

export const useNotificationStore = wrapStore(create<NotificationStore>()(
  persist(
    (set) => ({
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

      setEnabled: (enabled) => set({ enabled }),
      setVolume: (volume) => set({ volume: Math.max(0, Math.min(100, volume)) }),
      setMessageSound: (enabled) => set({ messageSound: enabled }),
      setMentionSound: (enabled) => set({ mentionSound: enabled }),
      setDmSound: (enabled) => set({ dmSound: enabled }),
      setFriendRequestSound: (enabled) => set({ friendRequestSound: enabled }),
      setVoiceEventSounds: (enabled) => set({ voiceEventSounds: enabled }),
      setSuppressWhenFocused: (suppress) => set({ suppressWhenFocused: suppress }),
      setDesktopNotificationsEnabled: (enabled) => set({ desktopNotificationsEnabled: enabled }),
      setDesktopNotifyDMs: (enabled) => set({ desktopNotifyDMs: enabled }),
      setDesktopNotifyMentions: (enabled) => set({ desktopNotifyMentions: enabled }),
      setDesktopNotifyAllMessages: (enabled) => set({ desktopNotifyAllMessages: enabled }),
      setDoNotDisturb: (enabled) => set({ doNotDisturb: enabled }),
      setQuietHoursEnabled: (enabled) => set({ quietHoursEnabled: enabled }),
      setQuietHoursStart: (start) => set({ quietHoursStart: start }),
      setQuietHoursEnd: (end) => set({ quietHoursEnd: end }),
    }),
    {
      name: 'concord:notification-sounds',
      partialize: (state) => ({
        enabled: state.enabled,
        volume: state.volume,
        messageSound: state.messageSound,
        mentionSound: state.mentionSound,
        dmSound: state.dmSound,
        friendRequestSound: state.friendRequestSound,
        voiceEventSounds: state.voiceEventSounds,
        suppressWhenFocused: state.suppressWhenFocused,
        desktopNotificationsEnabled: state.desktopNotificationsEnabled,
        desktopNotifyDMs: state.desktopNotifyDMs,
        desktopNotifyMentions: state.desktopNotifyMentions,
        desktopNotifyAllMessages: state.desktopNotifyAllMessages,
        doNotDisturb: state.doNotDisturb,
        quietHoursEnabled: state.quietHoursEnabled,
        quietHoursStart: state.quietHoursStart,
        quietHoursEnd: state.quietHoursEnd,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<NotificationSoundSettings>),
      }),
    }
  )
));
