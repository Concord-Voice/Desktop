import { useNotificationStore } from '../stores/notificationStore';

/** Chat notification sound types */
export type ChatSoundType = 'message' | 'mention' | 'dm' | 'friend-request';

/** Voice event sound types */
export type VoiceSoundType =
  | 'voice-join'
  | 'voice-leave'
  | 'user-join'
  | 'user-leave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'video-on'
  | 'video-off'
  | 'screen-on'
  | 'screen-off'
  | 'disconnect';

export type NotificationSoundType = ChatSoundType | VoiceSoundType;

const SOUND_PATHS: Record<NotificationSoundType, string> = {
  message: './sounds/message.wav',
  mention: './sounds/mention.wav',
  dm: './sounds/dm.wav',
  'friend-request': './sounds/friend-request.wav',
  'voice-join': './sounds/voice-join.wav',
  'voice-leave': './sounds/voice-leave.wav',
  'user-join': './sounds/user-join.wav',
  'user-leave': './sounds/user-leave.wav',
  mute: './sounds/mute.wav',
  unmute: './sounds/unmute.wav',
  deafen: './sounds/deafen.wav',
  undeafen: './sounds/undeafen.wav',
  'video-on': './sounds/video-on.wav',
  'video-off': './sounds/video-off.wav',
  'screen-on': './sounds/screen-on.wav',
  'screen-off': './sounds/screen-off.wav',
  disconnect: './sounds/disconnect.wav',
};

/** Minimum interval between chat notification sounds (ms) */
const CHAT_DEBOUNCE_MS = 2000;

/** No-op handler for swallowing autoplay rejections */
const noop = () => {
  /* intentionally empty */
};

type NotificationSoundSettings = ReturnType<typeof useNotificationStore.getState>;

/** Maps each chat sound type to the store key that controls it */
const CHAT_TOGGLE: Record<ChatSoundType, keyof NotificationSoundSettings> = {
  message: 'messageSound',
  mention: 'mentionSound',
  dm: 'dmSound',
  'friend-request': 'friendRequestSound',
};

/** Set of sound types that are voice-event feedback (no debounce, no focus suppression) */
const VOICE_SOUNDS = new Set<NotificationSoundType>([
  'voice-join',
  'voice-leave',
  'user-join',
  'user-leave',
  'mute',
  'unmute',
  'deafen',
  'undeafen',
  'video-on',
  'video-off',
  'screen-on',
  'screen-off',
  'disconnect',
]);

class NotificationSoundService {
  private readonly sounds = new Map<NotificationSoundType, HTMLAudioElement>();
  private lastChatSoundTime = 0;
  private initialized = false;

  /** Pre-load all notification audio elements */
  init(): void {
    if (this.initialized) return;

    for (const [type, path] of Object.entries(SOUND_PATHS)) {
      const audio = new Audio(path);
      audio.preload = 'auto';
      this.sounds.set(type as NotificationSoundType, audio);
    }

    this.initialized = true;
  }

  /** Check whether a chat sound should be suppressed */
  private isChatSuppressed(
    type: ChatSoundType,
    state: NotificationSoundSettings,
    focused: boolean
  ): boolean {
    if (focused && state.suppressWhenFocused && document.hasFocus()) return true;
    if (!state[CHAT_TOGGLE[type]]) return true;
    if (Date.now() - this.lastChatSoundTime < CHAT_DEBOUNCE_MS) return true;
    return false;
  }

  /**
   * Play a notification sound if settings allow it.
   * @param type - Sound category to play
   * @param options.focused - If true, the user is viewing the source channel/conversation.
   *   Only applies to chat sounds (voice sounds ignore this).
   */
  play(type: NotificationSoundType, options?: { focused?: boolean }): void {
    if (!this.initialized) this.init();

    const state = useNotificationStore.getState();
    if (!state.enabled) return;

    const isVoice = VOICE_SOUNDS.has(type);

    // Voice sounds: check the single voiceEventSounds toggle
    if (isVoice && !state.voiceEventSounds) return;

    // Chat sounds: per-category toggle, focus suppression, debounce
    if (
      !isVoice &&
      this.isChatSuppressed(type as ChatSoundType, state, options?.focused ?? false)
    ) {
      return;
    }

    const audio = this.sounds.get(type);
    if (!audio) return;

    audio.volume = state.volume / 100;
    audio.currentTime = 0;
    Promise.resolve(audio.play()).catch(noop);

    if (!isVoice) {
      this.lastChatSoundTime = Date.now();
    }
  }
}

export const notificationSoundService = new NotificationSoundService();
