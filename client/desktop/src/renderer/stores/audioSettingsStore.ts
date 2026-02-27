import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ---------------------------------------------------------------------------
// Advanced audio settings — persisted to localStorage
// These override the quality tier's defaults when set.
// ---------------------------------------------------------------------------

export type AudioPriority = 'off' | 'low' | 'medium' | 'high';

export interface AudioSettings {
  // Audio processing (getUserMedia constraints)
  noiseCancellation: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noiseGateMode: 'auto' | 'manual'; // Auto = no gate (AGC handles it), Manual = expose slider
  noiseGateLevel: number; // dBFS, range -80 to -20 (only used in manual mode)

  // Opus advanced
  musicMode: boolean; // Disables audio processing (echo cancel, noise suppression, AGC) for music fidelity
  frameSize: 0 | 10 | 20 | 40 | 60; // ms (ptime) — 0 = "Default" (use tier's optimal: 10ms for hifi/studio, 20ms otherwise)
  silenceDetection: boolean; // DTX override

  // FEC & reliability
  fecMode: 'auto' | 'manual';
  fecManualPercent: number; // 0–100
  opusNack: boolean; // Request retransmission of lost audio packets

  // Transport
  adaptivePtime: boolean; // Let WebRTC dynamically adjust frame size based on network
  audioPriority: AudioPriority; // Encoding + network priority hint (DSCP via RFC 4594)

  // Volume
  inputVolume: number; // 0–200 (percent), default 100. Applied via GainNode in mic pipeline.
  outputVolume: number; // 0–200 (percent), default 100. Applied via GainNode per remote participant.

  // Quiet boost (receiver-side upward compressor)
  quietBoost: boolean; // Dynamically amplify quiet participants
  quietBoostThreshold: number; // dBFS, range -50 to -20. Below this → boost applied.

  // Network
  networkType: 'auto' | 'wifi' | 'wired';
  packetLossWarningThreshold: number; // percent, triggers UI warning
}

interface AudioSettingsState extends AudioSettings {
  setNoiseCancellation: (enabled: boolean) => void;
  setEchoCancellation: (enabled: boolean) => void;
  setAutoGainControl: (enabled: boolean) => void;
  setNoiseGateMode: (mode: 'auto' | 'manual') => void;
  setNoiseGateLevel: (level: number) => void;
  setMusicMode: (enabled: boolean) => void;
  setFrameSize: (size: 0 | 10 | 20 | 40 | 60) => void;
  setSilenceDetection: (enabled: boolean) => void;
  setFecMode: (mode: 'auto' | 'manual') => void;
  setFecManualPercent: (percent: number) => void;
  setOpusNack: (enabled: boolean) => void;
  setAdaptivePtime: (enabled: boolean) => void;
  setAudioPriority: (priority: AudioPriority) => void;
  setInputVolume: (volume: number) => void;
  setOutputVolume: (volume: number) => void;
  setQuietBoost: (enabled: boolean) => void;
  setQuietBoostThreshold: (threshold: number) => void;
  setNetworkType: (type: 'auto' | 'wifi' | 'wired') => void;
  setPacketLossWarningThreshold: (percent: number) => void;
}

const defaults: AudioSettings = {
  noiseCancellation: true,
  echoCancellation: true,
  autoGainControl: true,
  noiseGateMode: 'auto',
  noiseGateLevel: -50,
  musicMode: false,
  frameSize: 0, // Default — resolved at runtime to tier's optimal (10ms or 20ms)
  silenceDetection: false,
  fecMode: 'auto',
  fecManualPercent: 20,
  opusNack: false,
  adaptivePtime: false,
  audioPriority: 'medium',
  inputVolume: 100,
  outputVolume: 100,
  quietBoost: false,
  quietBoostThreshold: -35,
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
      setNoiseGateMode: (noiseGateMode) => set({ noiseGateMode }),
      setNoiseGateLevel: (noiseGateLevel) => set({ noiseGateLevel: Math.max(-80, Math.min(-20, noiseGateLevel)) }),
      setMusicMode: (musicMode) => set({ musicMode }),
      setFrameSize: (frameSize) => set({ frameSize }),
      setSilenceDetection: (silenceDetection) => set({ silenceDetection }),
      setFecMode: (fecMode) => set({ fecMode }),
      setFecManualPercent: (fecManualPercent) => set({ fecManualPercent: Math.max(0, Math.min(100, fecManualPercent)) }),
      setOpusNack: (opusNack) => set({ opusNack }),
      setAdaptivePtime: (adaptivePtime) => set({ adaptivePtime }),
      setAudioPriority: (audioPriority) => set({ audioPriority }),
      setInputVolume: (inputVolume) => set({ inputVolume: Math.max(0, Math.min(200, inputVolume)) }),
      setOutputVolume: (outputVolume) => set({ outputVolume: Math.max(0, Math.min(200, outputVolume)) }),
      setQuietBoost: (quietBoost) => set({ quietBoost }),
      setQuietBoostThreshold: (quietBoostThreshold) => set({ quietBoostThreshold: Math.max(-50, Math.min(-20, quietBoostThreshold)) }),
      setNetworkType: (networkType) => set({ networkType }),
      setPacketLossWarningThreshold: (packetLossWarningThreshold) => set({ packetLossWarningThreshold }),
    }),
    {
      name: 'concord:audio-advanced',
    }
  )
);
