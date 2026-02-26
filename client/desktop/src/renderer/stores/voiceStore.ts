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
// Available screen shares (opt-in "Tune In" model)
// ---------------------------------------------------------------------------
export interface AvailableScreenShare {
  producerId: string;
  userId: string;
  username: string;
  displayName?: string;
}

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

  // Decoder health (IGNIS profiling)
  decoderHealth: 'green' | 'yellow' | 'red';

  // Available screen shares (opt-in "Tune In" model — not auto-consumed)
  availableScreenShares: AvailableScreenShare[];

  // Channel voice members (sidebar — all voice channels, not just the one we're in)
  channelVoiceMembers: Record<string, ChannelVoiceMember[]>;

  // Voice text chat
  showVoiceTextChat: boolean;
  voiceTextChatHeight: number;
  voiceTextChatLayout: 'horizontal' | 'vertical';
  voiceTextChatWidth: number;

  // Server-wide voice counts (for tooltip display)
  serverVoiceCounts: Record<string, number>;

  // Multi-stream screen share consumption (producerId → consumerId, up to 5)
  tunedInScreenShares: Record<string, string>;
  dominantScreenShareId: string | null;

  // Video slot enforcement: 50 - (5 * tuned-in screen share count)
  maxVideoSlots: number;
  videoSlotError: string | null;

  // Layout section visibility (Mode B — three-section layout)
  showUserFrameBar: boolean;
  showStreamBar: boolean;
  userFrameBarHeight: number;
  streamBarHeight: number;

  // Stage layout: 'equal' = all streams share center stage equally,
  //               'focus' = one dominant stream + others in bottom StreamBar
  stageLayout: 'equal' | 'focus';

  // PiP state
  pipWindows: string[];

  // Stream focus behavior
  keepActiveWhileUnfocused: boolean;

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
  setDecoderHealth: (health: 'green' | 'yellow' | 'red') => void;

  // Screen share opt-in management
  addAvailableScreenShare: (share: AvailableScreenShare) => void;
  removeAvailableScreenShare: (producerId: string) => void;
  clearAvailableScreenShares: () => void;

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

  // Voice text chat
  setShowVoiceTextChat: (show: boolean) => void;
  toggleVoiceTextChat: () => void;
  setVoiceTextChatHeight: (height: number) => void;
  setVoiceTextChatLayout: (layout: 'horizontal' | 'vertical') => void;
  toggleVoiceTextChatLayout: () => void;
  setVoiceTextChatWidth: (width: number) => void;

  // Server voice counts (tooltip)
  setServerVoiceCount: (serverId: string, count: number) => void;
  incrementServerVoiceCount: (serverId: string) => void;
  decrementServerVoiceCount: (serverId: string) => void;

  // Multi-stream screen share
  tuneIn: (producerId: string, consumerId: string) => void;
  tuneOut: (producerId: string) => void;
  setDominantScreenShare: (producerId: string | null) => void;
  recalculateMaxVideoSlots: () => void;
  setVideoSlotError: (msg: string | null) => void;

  // Layout sections (Mode B)
  toggleUserFrameBar: () => void;
  toggleStreamBar: () => void;
  setUserFrameBarHeight: (height: number) => void;
  setStreamBarHeight: (height: number) => void;
  setStageLayout: (layout: 'equal' | 'focus') => void;
  toggleStageLayout: () => void;

  // PiP
  addPipWindow: (id: string) => void;
  removePipWindow: (id: string) => void;

  // Stream focus behavior
  setKeepActiveWhileUnfocused: (keep: boolean) => void;

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
  decoderHealth: 'green' as 'green' | 'yellow' | 'red',
  availableScreenShares: [] as AvailableScreenShare[],
  channelVoiceMembers: {} as Record<string, ChannelVoiceMember[]>,
  showVoiceTextChat: false,
  voiceTextChatHeight: (() => {
    try {
      const s = localStorage.getItem('concord:voice-text-chat-height');
      if (s) { const n = parseInt(s, 10); if (!isNaN(n) && n >= 150) return n; }
    } catch { /* ignore */ }
    return 300;
  })(),
  voiceTextChatLayout: (() => {
    try {
      const s = localStorage.getItem('concord:voice-text-chat-layout');
      if (s === 'horizontal' || s === 'vertical') return s;
    } catch { /* ignore */ }
    return 'horizontal' as const;
  })(),
  voiceTextChatWidth: (() => {
    try {
      const s = localStorage.getItem('concord:voice-text-chat-width');
      if (s) { const n = parseInt(s, 10); if (!isNaN(n) && n >= 250) return n; }
    } catch { /* ignore */ }
    return 350;
  })(),
  serverVoiceCounts: {} as Record<string, number>,
  tunedInScreenShares: {} as Record<string, string>,
  dominantScreenShareId: null as string | null,
  maxVideoSlots: 50,
  videoSlotError: null as string | null,
  showUserFrameBar: true,
  showStreamBar: true,
  userFrameBarHeight: 120,
  streamBarHeight: 120,
  stageLayout: 'focus' as 'equal' | 'focus',
  pipWindows: [] as string[],
  keepActiveWhileUnfocused: (() => {
    try { return localStorage.getItem('concord:keep-active-unfocused') === 'true'; } catch { return false; }
  })(),
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
  setDecoderHealth: (decoderHealth) => set({ decoderHealth }),
  setPacketLoss: (percent, warningThreshold = 3) => {
    set({ packetLossPercent: percent, packetLossWarning: percent >= warningThreshold });
  },

  // Screen share opt-in
  addAvailableScreenShare: (share) =>
    set((state) => {
      // Avoid duplicates
      if (state.availableScreenShares.some((s) => s.producerId === share.producerId)) return state;
      return { availableScreenShares: [...state.availableScreenShares, share] };
    }),
  removeAvailableScreenShare: (producerId) =>
    set((state) => ({
      availableScreenShares: state.availableScreenShares.filter((s) => s.producerId !== producerId),
    })),
  clearAvailableScreenShares: () => set({ availableScreenShares: [] }),

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

  // Voice text chat
  setShowVoiceTextChat: (show) => set({ showVoiceTextChat: show }),
  toggleVoiceTextChat: () => set((state) => ({ showVoiceTextChat: !state.showVoiceTextChat })),
  setVoiceTextChatHeight: (height) => {
    set({ voiceTextChatHeight: height });
    try {
      localStorage.setItem('concord:voice-text-chat-height', String(height));
    } catch { /* ignore */ }
  },
  setVoiceTextChatLayout: (layout) => {
    set({ voiceTextChatLayout: layout });
    try { localStorage.setItem('concord:voice-text-chat-layout', layout); } catch { /* ignore */ }
  },
  toggleVoiceTextChatLayout: () =>
    set((state) => {
      const next = state.voiceTextChatLayout === 'horizontal' ? 'vertical' : 'horizontal';
      try { localStorage.setItem('concord:voice-text-chat-layout', next); } catch { /* ignore */ }
      return { voiceTextChatLayout: next };
    }),
  setVoiceTextChatWidth: (width) => {
    set({ voiceTextChatWidth: width });
    try { localStorage.setItem('concord:voice-text-chat-width', String(width)); } catch { /* ignore */ }
  },

  // Server voice counts
  setServerVoiceCount: (serverId, count) =>
    set((state) => ({
      serverVoiceCounts: { ...state.serverVoiceCounts, [serverId]: Math.max(0, count) },
    })),
  incrementServerVoiceCount: (serverId) =>
    set((state) => ({
      serverVoiceCounts: {
        ...state.serverVoiceCounts,
        [serverId]: (state.serverVoiceCounts[serverId] ?? 0) + 1,
      },
    })),
  decrementServerVoiceCount: (serverId) =>
    set((state) => ({
      serverVoiceCounts: {
        ...state.serverVoiceCounts,
        [serverId]: Math.max(0, (state.serverVoiceCounts[serverId] ?? 0) - 1),
      },
    })),

  // Multi-stream screen share
  tuneIn: (producerId, consumerId) =>
    set((state) => {
      const next = { ...state.tunedInScreenShares, [producerId]: consumerId };
      const count = Object.keys(next).length;
      return {
        tunedInScreenShares: next,
        maxVideoSlots: 50 - 5 * count,
      };
    }),
  tuneOut: (producerId) =>
    set((state) => {
      const { [producerId]: _, ...rest } = state.tunedInScreenShares;
      const count = Object.keys(rest).length;
      const dominant =
        state.dominantScreenShareId === producerId
          ? Object.keys(rest)[0] ?? null
          : state.dominantScreenShareId;
      return {
        tunedInScreenShares: rest,
        dominantScreenShareId: dominant,
        maxVideoSlots: 50 - 5 * count,
      };
    }),
  setDominantScreenShare: (dominantScreenShareId) => set({ dominantScreenShareId }),
  recalculateMaxVideoSlots: () =>
    set((state) => ({
      maxVideoSlots: 50 - 5 * Object.keys(state.tunedInScreenShares).length,
    })),
  setVideoSlotError: (videoSlotError) => set({ videoSlotError }),

  // Layout sections (Mode B)
  toggleUserFrameBar: () => set((state) => ({ showUserFrameBar: !state.showUserFrameBar })),
  toggleStreamBar: () => set((state) => ({ showStreamBar: !state.showStreamBar })),
  setUserFrameBarHeight: (userFrameBarHeight) => set({ userFrameBarHeight }),
  setStreamBarHeight: (streamBarHeight) => set({ streamBarHeight }),
  setStageLayout: (stageLayout) => set({ stageLayout }),
  toggleStageLayout: () =>
    set((state) => ({ stageLayout: state.stageLayout === 'equal' ? 'focus' : 'equal' })),

  // PiP
  addPipWindow: (id) =>
    set((state) => ({
      pipWindows: state.pipWindows.includes(id) ? state.pipWindows : [...state.pipWindows, id],
    })),
  removePipWindow: (id) =>
    set((state) => ({
      pipWindows: state.pipWindows.filter((w) => w !== id),
    })),

  // Stream focus behavior
  setKeepActiveWhileUnfocused: (keep) => {
    set({ keepActiveWhileUnfocused: keep });
    try { localStorage.setItem('concord:keep-active-unfocused', String(keep)); } catch { /* ignore */ }
  },

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
      // Preserve text chat preferences
      voiceTextChatHeight: state.voiceTextChatHeight,
      voiceTextChatLayout: state.voiceTextChatLayout,
      voiceTextChatWidth: state.voiceTextChatWidth,
      // Preserve server voice counts (cross-server state)
      serverVoiceCounts: state.serverVoiceCounts,
      // Preserve section height & layout preferences
      userFrameBarHeight: state.userFrameBarHeight,
      streamBarHeight: state.streamBarHeight,
      stageLayout: state.stageLayout,
      // Preserve stream focus preference
      keepActiveWhileUnfocused: state.keepActiveWhileUnfocused,
    })),
}));
