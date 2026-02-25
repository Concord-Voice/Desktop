import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Persisted device settings (per-machine via localStorage)
// ---------------------------------------------------------------------------
const VOICE_SETTINGS_KEY = 'concord:voice-settings';

interface PersistedVoiceSettings {
  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;
  videoDeviceId: string | null;
  qualityTier: AudioQualityTier;
}

function loadPersistedSettings(): Partial<PersistedVoiceSettings> {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PersistedVoiceSettings>;
  } catch {
    return {};
  }
}

function savePersistedSettings(settings: PersistedVoiceSettings): void {
  try {
    localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

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

export interface AudioQualityTierConfig {
  label: string;
  description: string;
  maxBitrate: number;
  opusDtx: boolean;
  opusFec: boolean;
  opusStereo: boolean;
  opusApplication: 'voip' | 'audio' | 'lowdelay';
  frameSize: number; // ms: 10, 20, 40, 60
  premium: boolean;
}

export const AUDIO_QUALITY_TIERS: Record<AudioQualityTier, AudioQualityTierConfig> = {
  voice: {
    label: 'Voice',
    description: 'Optimized for speech, minimal bandwidth',
    maxBitrate: 24_000,
    opusDtx: true,
    opusFec: true,
    opusStereo: false,
    opusApplication: 'voip',
    frameSize: 20,
    premium: false,
  },
  standard: {
    label: 'Standard',
    description: 'Clear stereo voice for general use',
    maxBitrate: 64_000,
    opusDtx: false,
    opusFec: true,
    opusStereo: true,
    opusApplication: 'audio',
    frameSize: 20,
    premium: false,
  },
  high: {
    label: 'High Quality',
    description: 'Streaming quality, music-friendly',
    maxBitrate: 128_000,
    opusDtx: false,
    opusFec: false,
    opusStereo: true,
    opusApplication: 'audio',
    frameSize: 20,
    premium: true,
  },
  hifi: {
    label: 'Hi-Fi',
    description: 'Near-lossless, perceptually transparent',
    maxBitrate: 320_000,
    opusDtx: false,
    opusFec: false,
    opusStereo: true,
    opusApplication: 'audio',
    frameSize: 10,
    premium: true,
  },
  studio: {
    label: 'Studio',
    description: 'Maximum Opus quality, 48 kHz full-bandwidth stereo',
    maxBitrate: 510_000,
    opusDtx: false,
    opusFec: false,
    opusStereo: true,
    opusApplication: 'audio',
    frameSize: 10,
    premium: true,
  },
};

// ---------------------------------------------------------------------------
// Channel voice members (sidebar display — who's in each voice channel)
// ---------------------------------------------------------------------------
export interface ChannelVoiceMember {
  userId: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  isMuted: boolean;
}

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
  effectiveQualityTier: AudioQualityTier; // Resolved: channel override or personal tier

  // Network quality (updated by packet loss monitor)
  packetLossPercent: number;
  packetLossWarning: boolean;

  // Channel voice members (sidebar — all voice channels, not just the one we're in)
  channelVoiceMembers: Record<string, ChannelVoiceMember[]>;

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
  setEffectiveQualityTier: (tier: AudioQualityTier) => void;
  setPacketLoss: (percent: number, warningThreshold?: number) => void;

  // Participant management
  addParticipant: (participant: VoiceParticipant) => void;
  removeParticipant: (userId: string) => void;
  updateParticipant: (userId: string, update: Partial<VoiceParticipant>) => void;
  setParticipants: (participants: VoiceParticipant[]) => void;
  clearParticipants: () => void;

  // Channel voice members management (sidebar)
  setChannelVoiceMembers: (channelId: string, members: ChannelVoiceMember[]) => void;
  addChannelVoiceMember: (channelId: string, member: ChannelVoiceMember) => void;
  removeChannelVoiceMember: (channelId: string, userId: string) => void;
  clearAllChannelVoiceMembers: () => void;

  // Full reset (on disconnect)
  reset: () => void;
}

// Load persisted device settings from localStorage
const persisted = loadPersistedSettings();

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
  audioInputDeviceId: (persisted.audioInputDeviceId ?? null) as string | null,
  audioOutputDeviceId: (persisted.audioOutputDeviceId ?? null) as string | null,
  videoDeviceId: (persisted.videoDeviceId ?? null) as string | null,
  qualityTier: (persisted.qualityTier ?? 'standard') as AudioQualityTier,
  effectiveQualityTier: (persisted.qualityTier ?? 'standard') as AudioQualityTier,
  packetLossPercent: 0,
  packetLossWarning: false,
  channelVoiceMembers: {} as Record<string, ChannelVoiceMember[]>,
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
  setAudioInputDevice: (audioInputDeviceId) => {
    set({ audioInputDeviceId });
    const s = useVoiceStore.getState();
    savePersistedSettings({ audioInputDeviceId, audioOutputDeviceId: s.audioOutputDeviceId, videoDeviceId: s.videoDeviceId, qualityTier: s.qualityTier });
  },
  setAudioOutputDevice: (audioOutputDeviceId) => {
    set({ audioOutputDeviceId });
    const s = useVoiceStore.getState();
    savePersistedSettings({ audioInputDeviceId: s.audioInputDeviceId, audioOutputDeviceId, videoDeviceId: s.videoDeviceId, qualityTier: s.qualityTier });
  },
  setVideoDevice: (videoDeviceId) => {
    set({ videoDeviceId });
    const s = useVoiceStore.getState();
    savePersistedSettings({ audioInputDeviceId: s.audioInputDeviceId, audioOutputDeviceId: s.audioOutputDeviceId, videoDeviceId, qualityTier: s.qualityTier });
  },
  setQualityTier: (qualityTier) => {
    set({ qualityTier });
    const s = useVoiceStore.getState();
    savePersistedSettings({ audioInputDeviceId: s.audioInputDeviceId, audioOutputDeviceId: s.audioOutputDeviceId, videoDeviceId: s.videoDeviceId, qualityTier });
  },
  setEffectiveQualityTier: (effectiveQualityTier) => set({ effectiveQualityTier }),
  setPacketLoss: (percent, warningThreshold = 3) => {
    set({ packetLossPercent: percent, packetLossWarning: percent >= warningThreshold });
  },

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

  // Channel voice members (sidebar)
  setChannelVoiceMembers: (channelId, members) =>
    set((state) => ({
      channelVoiceMembers: { ...state.channelVoiceMembers, [channelId]: members },
    })),
  addChannelVoiceMember: (channelId, member) =>
    set((state) => {
      const existing = state.channelVoiceMembers[channelId] || [];
      // Avoid duplicates
      if (existing.some((m) => m.userId === member.userId)) return state;
      return {
        channelVoiceMembers: {
          ...state.channelVoiceMembers,
          [channelId]: [...existing, member],
        },
      };
    }),
  removeChannelVoiceMember: (channelId, userId) =>
    set((state) => {
      const existing = state.channelVoiceMembers[channelId];
      if (!existing) return state;
      const filtered = existing.filter((m) => m.userId !== userId);
      if (filtered.length === 0) {
        const { [channelId]: _, ...rest } = state.channelVoiceMembers;
        return { channelVoiceMembers: rest };
      }
      return {
        channelVoiceMembers: { ...state.channelVoiceMembers, [channelId]: filtered },
      };
    }),
  clearAllChannelVoiceMembers: () => set({ channelVoiceMembers: {} }),

  reset: () =>
    set((state) => ({
      ...initialState,
      // Preserve server-wide voice member data (sidebar display) across join/leave
      channelVoiceMembers: state.channelVoiceMembers,
      // Preserve device settings across join/leave (they're persisted to localStorage)
      audioInputDeviceId: state.audioInputDeviceId,
      audioOutputDeviceId: state.audioOutputDeviceId,
      videoDeviceId: state.videoDeviceId,
      qualityTier: state.qualityTier,
    })),
}));
