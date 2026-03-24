import { useNotificationStore } from '../stores/notificationStore';

export type NotificationSoundType = 'message' | 'mention' | 'dm' | 'friend-request';

const SOUND_PATHS: Record<NotificationSoundType, string> = {
  message: './sounds/message.wav',
  mention: './sounds/mention.wav',
  dm: './sounds/dm.wav',
  'friend-request': './sounds/friend-request.wav',
};

/** Minimum interval between notification sounds (ms) */
const DEBOUNCE_MS = 2000;

/** No-op handler for swallowing autoplay rejections */
// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/** Maps each sound type to the store key that controls it */
const CATEGORY_TOGGLE: Record<NotificationSoundType, keyof NotificationSoundSettings> = {
  message: 'messageSound',
  mention: 'mentionSound',
  dm: 'dmSound',
  'friend-request': 'friendRequestSound',
};

// Re-import the settings type for the toggle map
type NotificationSoundSettings = ReturnType<typeof useNotificationStore.getState>;

class NotificationSoundService {
  private readonly sounds = new Map<NotificationSoundType, HTMLAudioElement>();
  private lastPlayTime = 0;
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

  /** Check whether the sound should be suppressed based on current settings */
  private isSuppressed(
    type: NotificationSoundType,
    state: NotificationSoundSettings,
    focused: boolean
  ): boolean {
    if (!state.enabled) return true;
    if (focused && state.suppressWhenFocused && document.hasFocus()) return true;
    if (!state[CATEGORY_TOGGLE[type]]) return true;
    if (Date.now() - this.lastPlayTime < DEBOUNCE_MS) return true;
    return false;
  }

  /**
   * Play a notification sound if settings allow it.
   * @param type - Sound category to play
   * @param options.focused - If true, the user is viewing the source channel/conversation.
   *   Combined with suppressWhenFocused setting to skip sounds for the active view.
   */
  play(type: NotificationSoundType, options?: { focused?: boolean }): void {
    if (!this.initialized) this.init();

    const state = useNotificationStore.getState();
    if (this.isSuppressed(type, state, options?.focused ?? false)) return;

    const audio = this.sounds.get(type);
    if (!audio) return;

    audio.volume = state.volume / 100;
    audio.currentTime = 0;
    Promise.resolve(audio.play()).catch(noop);

    this.lastPlayTime = Date.now();
  }
}

export const notificationSoundService = new NotificationSoundService();
