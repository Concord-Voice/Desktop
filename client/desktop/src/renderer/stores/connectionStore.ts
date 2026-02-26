import { create } from 'zustand';

interface ConnectionLossState {
  /** Whether the connection-lost overlay is visible */
  showOverlay: boolean;

  /** Whether we are in the 15-second grace period before showing overlay */
  inGracePeriod: boolean;

  /** Timestamp when connection was lost */
  lostAt: number | null;

  /** Voice channel the user was in when connection dropped (for grace-period rejoin) */
  lastVoiceChannelId: string | null;

  /** Start the grace period (called when WS transitions to RECONNECTING) */
  startGracePeriod: () => void;

  /** Store the voice channel ID before emergency cleanup */
  setLastVoiceChannelId: (id: string | null) => void;

  /** Show the overlay (called when grace period expires without reconnection) */
  showConnectionLost: () => void;

  /** Reset everything (called when connection is restored or session resets) */
  reset: () => void;
}

export const useConnectionStore = create<ConnectionLossState>()((set) => ({
  showOverlay: false,
  inGracePeriod: false,
  lostAt: null,
  lastVoiceChannelId: null,

  startGracePeriod: () => set({
    inGracePeriod: true,
    lostAt: Date.now(),
  }),

  setLastVoiceChannelId: (id) => set({ lastVoiceChannelId: id }),

  showConnectionLost: () => set({
    showOverlay: true,
    inGracePeriod: false,
    lastVoiceChannelId: null,
  }),

  reset: () => set({
    showOverlay: false,
    inGracePeriod: false,
    lostAt: null,
    lastVoiceChannelId: null,
  }),
}));
