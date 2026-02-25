import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface TTSSettingsState {
  ttsEnabled: boolean;
  ttsSendEnabled: boolean;
  ttsVoice: string | null;
  ttsRate: number;
  ttsVolume: number;

  setTtsEnabled: (enabled: boolean) => void;
  setTtsSendEnabled: (enabled: boolean) => void;
  setTtsVoice: (voice: string | null) => void;
  setTtsRate: (rate: number) => void;
  setTtsVolume: (volume: number) => void;
}

export const useTTSSettingsStore = create<TTSSettingsState>()(
  persist(
    (set) => ({
      ttsEnabled: false,
      ttsSendEnabled: false,
      ttsVoice: null,
      ttsRate: 1.0,
      ttsVolume: 1.0,

      setTtsEnabled: (ttsEnabled) => set({ ttsEnabled }),
      setTtsSendEnabled: (ttsSendEnabled) => set({ ttsSendEnabled }),
      setTtsVoice: (ttsVoice) => set({ ttsVoice }),
      setTtsRate: (ttsRate) => set({ ttsRate: Math.max(0.5, Math.min(2.0, ttsRate)) }),
      setTtsVolume: (ttsVolume) => set({ ttsVolume: Math.max(0, Math.min(1, ttsVolume)) }),
    }),
    { name: 'concord:tts-settings' }
  )
);
