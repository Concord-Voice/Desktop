import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useNotificationStore } from '../../../src/renderer/stores/notificationStore';

// Must mock Audio before importing the service
const mockPlay = vi.fn().mockResolvedValue(undefined);

class MockAudio {
  preload = '';
  volume = 1;
  currentTime = 0;
  play = mockPlay;
  constructor(_src?: string) {
    // Track creation
  }
}

vi.stubGlobal('Audio', MockAudio);

// Import after mocking
const { notificationSoundService } =
  await import('../../../src/renderer/services/notificationSoundService');

describe('NotificationSoundService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlay.mockResolvedValue(undefined);

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
    });

    // Reset service internal state
    (notificationSoundService as Record<string, unknown>)['initialized'] = false;
    (notificationSoundService as Record<string, unknown>)['lastChatSoundTime'] = 0;
    (notificationSoundService as Record<string, unknown>)['sounds'] = new Map();
  });

  it('initializes and preloads all sounds', () => {
    notificationSoundService.init();
    const sounds = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      unknown
    >;
    expect(sounds.size).toBe(17);
  });

  it('auto-initializes on first play', () => {
    notificationSoundService.play('message');
    const sounds = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      unknown
    >;
    expect(sounds.size).toBe(17);
  });

  it('does not play when master toggle is off', () => {
    useNotificationStore.getState().setEnabled(false);
    notificationSoundService.play('message');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('does not play when message toggle is off', () => {
    useNotificationStore.getState().setMessageSound(false);
    notificationSoundService.play('message');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('does not play when mention toggle is off', () => {
    useNotificationStore.getState().setMentionSound(false);
    notificationSoundService.play('mention');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('does not play when dm toggle is off', () => {
    useNotificationStore.getState().setDmSound(false);
    notificationSoundService.play('dm');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('does not play when friend-request toggle is off', () => {
    useNotificationStore.getState().setFriendRequestSound(false);
    notificationSoundService.play('friend-request');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('plays sound when enabled', () => {
    notificationSoundService.play('message');
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('rate-limits sounds to 2 second intervals', () => {
    notificationSoundService.play('message');
    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Second play within 2s should be suppressed
    notificationSoundService.play('mention');
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('allows sound after rate limit expires', () => {
    notificationSoundService.play('message');
    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Simulate time passing beyond debounce
    (notificationSoundService as Record<string, unknown>)['lastChatSoundTime'] = Date.now() - 3000;

    notificationSoundService.play('dm');
    expect(mockPlay).toHaveBeenCalledTimes(2);
  });

  it('sets volume from store', () => {
    useNotificationStore.getState().setVolume(50);
    notificationSoundService.play('message');
    const sounds = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      MockAudio
    >;
    const audio = sounds.get('message');
    expect(audio?.volume).toBe(0.5);
  });

  it('handles play() returning undefined', () => {
    mockPlay.mockReturnValue(undefined);
    expect(() => notificationSoundService.play('message')).not.toThrow();
  });

  it('suppresses focused sound when suppressWhenFocused is on and window is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useNotificationStore.getState().setSuppressWhenFocused(true);
    notificationSoundService.play('message', { focused: true });
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('plays focused sound when suppressWhenFocused is off', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useNotificationStore.getState().setSuppressWhenFocused(false);
    notificationSoundService.play('message', { focused: true });
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('plays focused sound when window is not focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    useNotificationStore.getState().setSuppressWhenFocused(true);
    notificationSoundService.play('message', { focused: true });
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  // Voice event sound tests
  it('plays voice sounds when voiceEventSounds is enabled', () => {
    notificationSoundService.play('mute');
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('does not play voice sounds when voiceEventSounds is off', () => {
    useNotificationStore.getState().setVoiceEventSounds(false);
    notificationSoundService.play('mute');
    expect(mockPlay).not.toHaveBeenCalled();
  });

  it('voice sounds bypass chat debounce', () => {
    notificationSoundService.play('message');
    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Chat sound would be debounced, but voice sound should still play
    notificationSoundService.play('mute');
    expect(mockPlay).toHaveBeenCalledTimes(2);
  });

  it('voice sounds ignore focused option', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    useNotificationStore.getState().setSuppressWhenFocused(true);
    notificationSoundService.play('voice-join', { focused: true });
    expect(mockPlay).toHaveBeenCalledTimes(1);
  });

  it('voice sounds do not affect chat debounce timer', () => {
    // Play a voice sound first
    notificationSoundService.play('mute');
    expect(mockPlay).toHaveBeenCalledTimes(1);

    // Chat sound should still play (voice didn't start the debounce)
    notificationSoundService.play('message');
    expect(mockPlay).toHaveBeenCalledTimes(2);
  });

  it('double init is a no-op', () => {
    notificationSoundService.init();
    const sounds1 = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      unknown
    >;
    const size1 = sounds1.size;

    notificationSoundService.init();
    const sounds2 = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      unknown
    >;
    expect(sounds2.size).toBe(size1);
  });

  it('all voice sound types play correctly', () => {
    const voiceTypes = [
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
    ] as const;

    for (const type of voiceTypes) {
      mockPlay.mockClear();
      notificationSoundService.play(type);
      expect(mockPlay).toHaveBeenCalledTimes(1);
    }
  });

  it('all chat sound types play correctly', () => {
    const chatTypes = ['message', 'mention', 'dm', 'friend-request'] as const;

    for (const type of chatTypes) {
      mockPlay.mockClear();
      // Reset debounce timer between each
      (notificationSoundService as Record<string, unknown>)['lastChatSoundTime'] = 0;
      notificationSoundService.play(type);
      expect(mockPlay).toHaveBeenCalledTimes(1);
    }
  });

  it('handles play rejection gracefully', () => {
    mockPlay.mockRejectedValueOnce(new DOMException('Autoplay blocked'));
    expect(() => notificationSoundService.play('message')).not.toThrow();
  });

  it('resets currentTime before playing', () => {
    notificationSoundService.play('message');
    const sounds = (notificationSoundService as Record<string, unknown>)['sounds'] as Map<
      string,
      MockAudio
    >;
    const audio = sounds.get('message');
    expect(audio?.currentTime).toBe(0);
  });
});
