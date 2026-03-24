import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
  /** Suppress sound when the window is focused on the channel that received the message */
  suppressWhenFocused: boolean;
}

interface NotificationStore extends NotificationSoundSettings {
  setEnabled: (enabled: boolean) => void;
  setVolume: (volume: number) => void;
  setMessageSound: (enabled: boolean) => void;
  setMentionSound: (enabled: boolean) => void;
  setDmSound: (enabled: boolean) => void;
  setFriendRequestSound: (enabled: boolean) => void;
  setSuppressWhenFocused: (suppress: boolean) => void;
}

export const useNotificationStore = create<NotificationStore>()(
  persist(
    (set) => ({
      enabled: true,
      volume: 80,
      messageSound: true,
      mentionSound: true,
      dmSound: true,
      friendRequestSound: true,
      suppressWhenFocused: true,

      setEnabled: (enabled) => set({ enabled }),
      setVolume: (volume) => set({ volume: Math.max(0, Math.min(100, volume)) }),
      setMessageSound: (enabled) => set({ messageSound: enabled }),
      setMentionSound: (enabled) => set({ mentionSound: enabled }),
      setDmSound: (enabled) => set({ dmSound: enabled }),
      setFriendRequestSound: (enabled) => set({ friendRequestSound: enabled }),
      setSuppressWhenFocused: (suppress) => set({ suppressWhenFocused: suppress }),
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
        suppressWhenFocused: state.suppressWhenFocused,
      }),
    }
  )
);
