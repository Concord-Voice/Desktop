import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ---------------------------------------------------------------------------
// Advanced audio settings — persisted to localStorage
// These override the quality tier's defaults when set.
// ---------------------------------------------------------------------------

export interface AudioSettings {
  // Audio processing (getUserMedia constraints)
  noiseCancellation: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseGateLevel: number; // dBFS, range -80 to -20

  // Opus advanced
  musicMode: boolean; // Forces CELT sub-codec (opusApplication='audio' with no SILK)
  frameSize: 10 | 20 | 40 | 60; // ms (ptime)
  silenceDetection: boolean; // DTX override

  // FEC
  fecMode: 'auto' | 'manual';
  fecManualPercent: number; // 0–100

  // Network
  networkType: 'auto' | 'wifi' | 'wired';
  packetLossWarningThreshold: number; // percent, triggers UI warning
}

interface AudioSettingsState extends AudioSettings {
  setNoiseCancellation: (enabled: boolean) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setNoiseGateLevel: (level: number) => void;
  setMusicMode: (enabled: boolean) => void;
  setFrameSize: (size: 10 | 20 | 40 | 60) => void;
  setSilenceDetection: (enabled: boolean) => void;
  setFecMode: (mode: 'auto' | 'manual') => void;
  setFecManualPercent: (percent: number) => void;
  setNetworkType: (type: 'auto' | 'wifi' | 'wired') => void;
  setPacketLossWarningThreshold: (percent: number) => void;
}

const defaults: AudioSettings = {
  noiseCancellation: true,
  echoCancellation: true,
  autoGainControl: true,
  noiseGateLevel: -50,
  musicMode: false,
  frameSize: 20,
  silenceDetection: false,
  fecMode: 'auto',
  fecManualPercent: 20,
  networkType: 'auto',
  packetLossWarningThreshold: 3,
};

export const useAudioSettingsStore = create<AudioSettingsState>()(
  persist(
    (set) => ({
      ...defaults,

      setNoiseCancellation: (noiseCancellation) => set({ noiseCancellation }),
      setEchoCancellation: (echoCancellation) => set({ echoCancellation }),
      setAutoGainControl: (autoGainControl) => set({ autoGainControl }),
      setNoiseGateLevel: (noiseGateLevel) => set({ noiseGateLevel: Math.max(-80, Math.min(-20, noiseGateLevel)) }),
      setMusicMode: (musicMode) => set({ musicMode }),
      setFrameSize: (frameSize) => set({ frameSize }),
      setSilenceDetection: (silenceDetection) => set({ silenceDetection }),
      setFecMode: (fecMode) => set({ fecMode }),
      setFecManualPercent: (fecManualPercent) => set({ fecManualPercent: Math.max(0, Math.min(100, fecManualPercent)) }),
      setNetworkType: (networkType) => set({ networkType }),
      setPacketLossWarningThreshold: (packetLossWarningThreshold) => set({ packetLossWarningThreshold }),
    }),
    {
      name: 'concord:audio-advanced',
    }
  )
);
