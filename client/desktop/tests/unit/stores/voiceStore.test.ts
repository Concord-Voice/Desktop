import { useVoiceStore, type VoiceParticipant } from '@/renderer/stores/voiceStore';
import { resetAllStores } from '../../helpers/store-helpers';

beforeEach(() => {
  resetAllStores();
  localStorage.clear();
});

const mockParticipant: VoiceParticipant = {
  userId: 'user-1',
  username: 'alice',
  isMuted: false,
  isDeafened: false,
  isVideoOn: false,
  isScreenSharing: false,
  isSpeaking: false,
};

describe('voiceStore', () => {
  describe('channel management', () => {
    it('sets active channel', () => {
      useVoiceStore.getState().setActiveChannel('voice-1', 'General', 'server-1');
      expect(useVoiceStore.getState().activeChannelId).toBe('voice-1');
    });

    it('reset clears voice state', () => {
      useVoiceStore.getState().setActiveChannel('voice-1', 'General', 'server-1');
      useVoiceStore.getState().addParticipant(mockParticipant);

      useVoiceStore.getState().reset();

      const state = useVoiceStore.getState();
      expect(state.activeChannelId).toBeNull();
      expect(Object.keys(state.participants)).toHaveLength(0);
      expect(state.connectionState).toBe('disconnected');
    });
  });

  describe('self state toggles', () => {
    it('toggles muted', () => {
      useVoiceStore.getState().setMuted(true);
      expect(useVoiceStore.getState().isMuted).toBe(true);

      useVoiceStore.getState().setMuted(false);
      expect(useVoiceStore.getState().isMuted).toBe(false);
    });

    it('toggles deafened', () => {
      useVoiceStore.getState().setDeafened(true);
      expect(useVoiceStore.getState().isDeafened).toBe(true);
    });

    it('toggles video', () => {
      useVoiceStore.getState().setVideoOn(true);
      expect(useVoiceStore.getState().isVideoOn).toBe(true);
    });

    it('toggles screen sharing', () => {
      useVoiceStore.getState().setScreenSharing(true);
      expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    });
  });

  describe('participant management', () => {
    it('adds participant', () => {
      useVoiceStore.getState().addParticipant(mockParticipant);
      expect(Object.keys(useVoiceStore.getState().participants)).toHaveLength(1);
      expect(useVoiceStore.getState().participants['user-1']?.username).toBe('alice');
    });

    it('updates participant', () => {
      useVoiceStore.getState().addParticipant(mockParticipant);
      useVoiceStore.getState().updateParticipant('user-1', { isMuted: true, isSpeaking: true });

      const p = useVoiceStore.getState().participants['user-1'];
      expect(p?.isMuted).toBe(true);
      expect(p?.isSpeaking).toBe(true);
    });

    it('removes participant', () => {
      useVoiceStore.getState().addParticipant(mockParticipant);
      useVoiceStore.getState().removeParticipant('user-1');
      expect(Object.keys(useVoiceStore.getState().participants)).toHaveLength(0);
    });
  });

  describe('connection state', () => {
    it('transitions connection state', () => {
      useVoiceStore.getState().setConnectionState('connecting');
      expect(useVoiceStore.getState().connectionState).toBe('connecting');

      useVoiceStore.getState().setConnectionState('connected');
      expect(useVoiceStore.getState().connectionState).toBe('connected');

      useVoiceStore.getState().setConnectionState('failed');
      expect(useVoiceStore.getState().connectionState).toBe('failed');
    });
  });

  describe('audio quality tiers', () => {
    it('sets quality tier', () => {
      useVoiceStore.getState().setQualityTier('hifi');
      expect(useVoiceStore.getState().qualityTier).toBe('hifi');
    });
  });

  describe('device selection', () => {
    it('sets audio input device', () => {
      useVoiceStore.getState().setAudioInputDevice('mic-1');
      expect(useVoiceStore.getState().audioInputDeviceId).toBe('mic-1');
    });

    it('sets audio output device', () => {
      useVoiceStore.getState().setAudioOutputDevice('speaker-1');
      expect(useVoiceStore.getState().audioOutputDeviceId).toBe('speaker-1');
    });

    it('sets video device', () => {
      useVoiceStore.getState().setVideoDevice('cam-1');
      expect(useVoiceStore.getState().videoDeviceId).toBe('cam-1');
    });
  });
});
