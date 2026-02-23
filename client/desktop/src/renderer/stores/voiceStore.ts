import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Voice participant state
// ---------------------------------------------------------------------------
export interface VoiceParticipant {
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isMuted: boolean;
  isDeafened: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;
  isSpeaking: boolean;
  audioStream?: MediaStream;
  videoStream?: MediaStream;
  screenStream?: MediaStream;
}

// ---------------------------------------------------------------------------
// Audio quality tiers (must match server-side AUDIO_QUALITY_TIERS)
// ---------------------------------------------------------------------------
export type AudioQualityTier = 'voice' | 'standard' | 'high' | 'hifi' | 'studio';

export const AUDIO_QUALITY_TIERS: Record<
  AudioQualityTier,
  {
    label: string;
    maxBitrate: number;
    opusDtx: boolean;
    opusFec: boolean;
    opusStereo: boolean;
    premium: boolean;
  }
> = {
  voice: { label: 'Voice', maxBitrate: 24_000, opusDtx: true, opusFec: true, opusStereo: false, premium: false },
  standard: { label: 'Standard', maxBitrate: 64_000, opusDtx: false, opusFec: true, opusStereo: true, premium: false },
  high: { label: 'High Quality', maxBitrate: 128_000, opusDtx: false, opusFec: false, opusStereo: true, premium: true },
  hifi: { label: 'Hi-Fi', maxBitrate: 320_000, opusDtx: false, opusFec: false, opusStereo: true, premium: true },
  studio: { label: 'Studio', maxBitrate: 510_000, opusDtx: false, opusFec: false, opusStereo: true, premium: true },
};

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------
export type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

// ---------------------------------------------------------------------------
// Voice store
// ---------------------------------------------------------------------------
interface VoiceState {
  // Connection
  activeChannelId: string | null;
  activeChannelName: string | null;
  activeServerId: string | null;
  connectionState: VoiceConnectionState;
  isEncrypted: boolean;

  // Local user state
  isMuted: boolean;
  isDeafened: boolean;
  isVideoOn: boolean;
  isScreenSharing: boolean;

  // Participants (keyed by userId)
  participants: Record<string, VoiceParticipant>;
  activeSpeakerId: string | null;

  // Device selection
  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;
  videoDeviceId: string | null;

  // Quality
  qualityTier: AudioQualityTier;

  // Actions
  setConnectionState: (state: VoiceConnectionState) => void;
  setActiveChannel: (channelId: string | null, channelName?: string, serverId?: string) => void;
  setEncrypted: (encrypted: boolean) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setVideoOn: (on: boolean) => void;
  setScreenSharing: (sharing: boolean) => void;
  setActiveSpeaker: (userId: string | null) => void;
  setAudioInputDevice: (deviceId: string) => void;
  setAudioOutputDevice: (deviceId: string) => void;
  setVideoDevice: (deviceId: string) => void;
  setQualityTier: (tier: AudioQualityTier) => void;

  // Participant management
  addParticipant: (participant: VoiceParticipant) => void;
  removeParticipant: (userId: string) => void;
  updateParticipant: (userId: string, update: Partial<VoiceParticipant>) => void;
  setParticipants: (participants: VoiceParticipant[]) => void;
  clearParticipants: () => void;

  // Full reset (on disconnect)
  reset: () => void;
}

const initialState = {
  activeChannelId: null as string | null,
  activeChannelName: null as string | null,
  activeServerId: null as string | null,
  connectionState: 'disconnected' as VoiceConnectionState,
  isEncrypted: false,
  isMuted: false,
  isDeafened: false,
  isVideoOn: false,
  isScreenSharing: false,
  participants: {} as Record<string, VoiceParticipant>,
  activeSpeakerId: null as string | null,
  audioInputDeviceId: null as string | null,
  audioOutputDeviceId: null as string | null,
  videoDeviceId: null as string | null,
  qualityTier: 'standard' as AudioQualityTier,
};

export const useVoiceStore = create<VoiceState>()((set) => ({
  ...initialState,

  setConnectionState: (connectionState) => set({ connectionState }),
  setActiveChannel: (channelId, channelName, serverId) =>
    set({
      activeChannelId: channelId,
      activeChannelName: channelName ?? null,
      activeServerId: serverId ?? null,
    }),
  setEncrypted: (isEncrypted) => set({ isEncrypted }),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setVideoOn: (isVideoOn) => set({ isVideoOn }),
  setScreenSharing: (isScreenSharing) => set({ isScreenSharing }),
  setActiveSpeaker: (activeSpeakerId) => set({ activeSpeakerId }),
  setAudioInputDevice: (audioInputDeviceId) => set({ audioInputDeviceId }),
  setAudioOutputDevice: (audioOutputDeviceId) => set({ audioOutputDeviceId }),
  setVideoDevice: (videoDeviceId) => set({ videoDeviceId }),
  setQualityTier: (qualityTier) => set({ qualityTier }),

  addParticipant: (participant) =>
    set((state) => ({
      participants: { ...state.participants, [participant.userId]: participant },
    })),
  removeParticipant: (userId) =>
    set((state) => {
      const { [userId]: _, ...rest } = state.participants;
      return { participants: rest };
    }),
  updateParticipant: (userId, update) =>
    set((state) => {
      const existing = state.participants[userId];
      if (!existing) return state;
      return {
        participants: {
          ...state.participants,
          [userId]: { ...existing, ...update },
        },
      };
    }),
  setParticipants: (participants) =>
    set({
      participants: Object.fromEntries(participants.map((p) => [p.userId, p])),
    }),
  clearParticipants: () => set({ participants: {} }),

  reset: () => set(initialState),
}));
