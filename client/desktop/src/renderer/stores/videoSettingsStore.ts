import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { CodecCapability } from '../services/mediaCapabilities';

// ---------------------------------------------------------------------------
// Video quality presets
// ---------------------------------------------------------------------------

export interface VideoQualityPreset {
  label: string;
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

export const VIDEO_QUALITY_PRESETS: Record<string, VideoQualityPreset> = {
  '360p30': { label: '360p 30fps', width: 640, height: 360, frameRate: 30, maxBitrate: 400_000 },
  '480p30': { label: '480p 30fps', width: 854, height: 480, frameRate: 30, maxBitrate: 700_000 },
  '720p30': { label: '720p 30fps', width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000 },
  '720p60': { label: '720p 60fps', width: 1280, height: 720, frameRate: 60, maxBitrate: 2_500_000 },
  '1080p30': { label: '1080p 30fps', width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_500_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, frameRate: 60, maxBitrate: 5_000_000 },
  '1440p30': { label: '1440p 30fps', width: 2560, height: 1440, frameRate: 30, maxBitrate: 6_000_000 },
  '1440p60': { label: '1440p 60fps', width: 2560, height: 1440, frameRate: 60, maxBitrate: 8_000_000 },
  '4K30': { label: '4K 30fps', width: 3840, height: 2160, frameRate: 30, maxBitrate: 10_000_000 },
  '4K60': { label: '4K 60fps', width: 3840, height: 2160, frameRate: 60, maxBitrate: 16_000_000 },
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ScreenResolution = 'source' | '720p' | '1080p' | '1440p' | '4K';
export type ScreenContentType = 'auto' | 'motion' | 'detail';

interface VideoSettings {
  // Camera
  cameraPreset: string; // Key into VIDEO_QUALITY_PRESETS
  preferredVideoCodec: string | null; // mimeType e.g. "video/VP9"

  // Screen share
  screenResolution: ScreenResolution;
  screenFrameRate: 5 | 15 | 30 | 60;
  screenContentType: ScreenContentType;
  preferredScreenCodec: string | null;

  // Hardware
  hardwareAcceleration: boolean;

  // Cached capabilities (non-persisted in practice, but ok to persist for fast initial render)
  codecCapabilities: CodecCapability[];
  gpuInfo: { vendor: string; device: string } | null;
}

interface VideoSettingsState extends VideoSettings {
  setCameraPreset: (preset: string) => void;
  setPreferredVideoCodec: (codec: string | null) => void;
  setScreenResolution: (res: ScreenResolution) => void;
  setScreenFrameRate: (fps: 5 | 15 | 30 | 60) => void;
  setScreenContentType: (type: ScreenContentType) => void;
  setPreferredScreenCodec: (codec: string | null) => void;
  setHardwareAcceleration: (enabled: boolean) => void;
  setCodecCapabilities: (caps: CodecCapability[]) => void;
  setGpuInfo: (info: { vendor: string; device: string } | null) => void;
}

const defaults: VideoSettings = {
  cameraPreset: '720p30',
  preferredVideoCodec: null,
  screenResolution: 'source',
  screenFrameRate: 30,
  screenContentType: 'auto',
  preferredScreenCodec: null,
  hardwareAcceleration: true,
  codecCapabilities: [],
  gpuInfo: null,
};

export const useVideoSettingsStore = create<VideoSettingsState>()(
  persist(
    (set) => ({
      ...defaults,

      setCameraPreset: (cameraPreset) => set({ cameraPreset }),
      setPreferredVideoCodec: (preferredVideoCodec) => set({ preferredVideoCodec }),
      setScreenResolution: (screenResolution) => set({ screenResolution }),
      setScreenFrameRate: (screenFrameRate) => set({ screenFrameRate }),
      setScreenContentType: (screenContentType) => set({ screenContentType }),
      setPreferredScreenCodec: (preferredScreenCodec) => set({ preferredScreenCodec }),
      setHardwareAcceleration: (hardwareAcceleration) => set({ hardwareAcceleration }),
      setCodecCapabilities: (codecCapabilities) => set({ codecCapabilities }),
      setGpuInfo: (gpuInfo) => set({ gpuInfo }),
    }),
    {
      name: 'concord:video-settings',
    }
  )
);
