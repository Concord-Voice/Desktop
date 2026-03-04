import { create } from 'zustand';
import { useSettingsStore, type AppearanceSettings, type CustomColors } from './settingsStore';
import { useAudioSettingsStore, type AudioSettings } from './audioSettingsStore';
import { useVideoSettingsStore, type VideoSettings } from './videoSettingsStore';
import { useTTSSettingsStore, type TTSSettings } from './ttsSettingsStore';
import { AUDIO_QUALITY_TIERS, type AudioQualityTier } from './voiceStore';

// ---------------------------------------------------------------------------
// Draftable types — exclude UI-only toggles and system-detected fields
// ---------------------------------------------------------------------------

export type DraftableAudioSettings = Omit<AudioSettings, 'advancedMode'>;
export type DraftableVideoSettings = Omit<
  VideoSettings,
  'videoAdvancedMode' | 'codecCapabilities' | 'gpuInfo' | 'systemHdr'
>;
export type DraftableTTSSettings = TTSSettings;
export type DraftableAppearanceSettings = AppearanceSettings;

// ---------------------------------------------------------------------------
// Draftable key lists (used for snapshotting)
// ---------------------------------------------------------------------------

const AUDIO_DRAFTABLE_KEYS: (keyof DraftableAudioSettings)[] = [
  'noiseCancellation',
  'echoCancellation',
  'autoGainControl',
  'noiseGateMode',
  'noiseGateLevel',
  'musicMode',
  'frameSize',
  'silenceDetection',
  'stereoOverride',
  'inlineFec',
  'fecHeadroom',
  'opusNack',
  'adaptivePtime',
  'audioPriority',
  'inputVolume',
  'outputVolume',
  'quietBoost',
  'quietBoostThreshold',
  'networkType',
  'packetLossWarningThreshold',
];

const VIDEO_DRAFTABLE_KEYS: (keyof DraftableVideoSettings)[] = [
  'cameraPreset',
  'preferredVideoCodec',
  'cameraPriority',
  'screenResolution',
  'screenFrameRate',
  'screenContentType',
  'screenSharePriority',
  'screenShareBitrate',
  'degradationPreference',
  'scalabilityMode',
  'hardwareAcceleration',
  'hdrEncoding',
];

const TTS_DRAFTABLE_KEYS: (keyof DraftableTTSSettings)[] = [
  'ttsEnabled',
  'ttsSendEnabled',
  'ttsVoice',
  'ttsRate',
  'ttsVolume',
];

// Audio fields that differ between Basic and Advanced modes (tier-controlled in Basic)
const AUDIO_MODE_KEYS: (keyof DraftableAudioSettings)[] = [
  'silenceDetection',
  'inlineFec',
  'fecHeadroom',
  'frameSize',
  'stereoOverride',
];

// ---------------------------------------------------------------------------
// Snapshot type
// ---------------------------------------------------------------------------

interface SettingsSnapshot {
  appearance: AppearanceSettings;
  audio: DraftableAudioSettings;
  video: DraftableVideoSettings;
  tts: DraftableTTSSettings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pickKeys<T extends object>(source: T, keys: (keyof T)[]): Partial<T> {
  const result: Partial<T> = {};
  for (const k of keys) {
    result[k] = source[k];
  }
  return result;
}

function takeSnapshot(): SettingsSnapshot {
  const appearance = structuredClone(useSettingsStore.getState().appearance);
  const audioState = useAudioSettingsStore.getState();
  const videoState = useVideoSettingsStore.getState();
  const ttsState = useTTSSettingsStore.getState();

  return {
    appearance,
    audio: pickKeys(audioState, AUDIO_DRAFTABLE_KEYS) as DraftableAudioSettings,
    video: pickKeys(videoState, VIDEO_DRAFTABLE_KEYS) as DraftableVideoSettings,
    tts: pickKeys(ttsState, TTS_DRAFTABLE_KEYS) as DraftableTTSSettings,
  };
}

/** Derive a setter name from a field name: 'inputVolume' → 'setInputVolume' */
function setterName(field: string): string {
  return `set${field.charAt(0).toUpperCase()}${field.slice(1)}`;
}

/** Call a store's setter by field name */
function callSetter(store: Record<string, unknown>, field: string, value: unknown) {
  const name = setterName(field);
  if (typeof store[name] === 'function') {
    (store[name] as (v: unknown) => void)(value);
  }
}

// ---------------------------------------------------------------------------
// Module-level flag for suppressing server sync during draft mode
// ---------------------------------------------------------------------------

export let draftModeActive = false;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface DraftOverlays {
  appearance: Partial<DraftableAppearanceSettings>;
  audio: Partial<DraftableAudioSettings>;
  video: Partial<DraftableVideoSettings>;
  tts: Partial<DraftableTTSSettings>;
}

const emptyDrafts = (): DraftOverlays => ({
  appearance: {},
  audio: {},
  video: {},
  tts: {},
});

interface DraftSettingsState {
  snapshot: SettingsSnapshot | null;
  drafts: DraftOverlays;

  // Mode stashes — saved draft values for the inactive audio mode
  audioBasicStash: Partial<DraftableAudioSettings> | null;
  audioAdvancedStash: Partial<DraftableAudioSettings> | null;

  // Lifecycle
  initialize: () => void;
  teardown: () => void;

  // Draft setters
  setAppearanceDraft: <K extends keyof DraftableAppearanceSettings>(
    key: K,
    value: DraftableAppearanceSettings[K]
  ) => void;
  setAudioDraft: <K extends keyof DraftableAudioSettings>(
    key: K,
    value: DraftableAudioSettings[K]
  ) => void;
  setVideoDraft: <K extends keyof DraftableVideoSettings>(
    key: K,
    value: DraftableVideoSettings[K]
  ) => void;
  setTtsDraft: <K extends keyof DraftableTTSSettings>(
    key: K,
    value: DraftableTTSSettings[K]
  ) => void;

  // Batch setter (for tier slider which sets 5 fields at once)
  batchSetAudioDrafts: (updates: Partial<DraftableAudioSettings>) => void;

  // Mode switch
  stashAndSwapAudioMode: (toAdvanced: boolean, qualityTier: AudioQualityTier) => void;

  // Actions
  apply: () => void;
  revert: () => void;
}

export const useDraftSettingsStore = create<DraftSettingsState>()((set, get) => ({
  snapshot: null,
  drafts: emptyDrafts(),
  audioBasicStash: null,
  audioAdvancedStash: null,

  // ── Lifecycle ────────────────────────────────────────────────────────────

  initialize: () => {
    draftModeActive = true;
    set({
      snapshot: takeSnapshot(),
      drafts: emptyDrafts(),
      audioBasicStash: null,
      audioAdvancedStash: null,
    });
  },

  teardown: () => {
    // Restore appearance from snapshot if there are pending appearance drafts
    const { snapshot, drafts } = get();
    if (snapshot && Object.keys(drafts.appearance).length > 0) {
      const store = useSettingsStore.getState();
      store.setTheme(snapshot.appearance.theme);
      store.setColorScheme(snapshot.appearance.colorScheme);
      store.setFontSize(snapshot.appearance.fontSize);
      store.setCompactMode(snapshot.appearance.compactMode);
      store.setReduceAnimations(snapshot.appearance.reduceAnimations);
      if (snapshot.appearance.customColors) {
        store.setCustomColors(snapshot.appearance.customColors);
      }
    }
    draftModeActive = false;
    set({
      snapshot: null,
      drafts: emptyDrafts(),
      audioBasicStash: null,
      audioAdvancedStash: null,
    });
  },

  // ── Draft setters ────────────────────────────────────────────────────────

  setAppearanceDraft: (key, value) => {
    // 1. Update draft store (smart change detection)
    set((state) => {
      if (!state.snapshot) return state;
      const snapshotValue = state.snapshot.appearance[key];
      const newDrafts = { ...state.drafts.appearance };

      if (deepEqual(value, snapshotValue)) {
        delete newDrafts[key];
      } else {
        (newDrafts as Record<string, unknown>)[key as string] = value;
      }

      return { drafts: { ...state.drafts, appearance: newDrafts } };
    });

    // 2. Write through to real store for live DOM preview
    // Special case: customColors setter also forces colorScheme:'custom'
    if (key === 'customColors') {
      useSettingsStore.getState().setCustomColors(value as CustomColors);
    } else {
      callSetter(
        useSettingsStore.getState() as unknown as Record<string, unknown>,
        key as string,
        value
      );
    }
  },

  setAudioDraft: (key, value) =>
    set((state) => {
      if (!state.snapshot) return state;
      const snapshotValue = state.snapshot.audio[key];
      const newDrafts = { ...state.drafts.audio };

      if (deepEqual(value, snapshotValue)) {
        delete newDrafts[key];
      } else {
        (newDrafts as Record<string, unknown>)[key as string] = value;
      }

      return { drafts: { ...state.drafts, audio: newDrafts } };
    }),

  setVideoDraft: (key, value) =>
    set((state) => {
      if (!state.snapshot) return state;
      const snapshotValue = state.snapshot.video[key];
      const newDrafts = { ...state.drafts.video };

      if (deepEqual(value, snapshotValue)) {
        delete newDrafts[key];
      } else {
        (newDrafts as Record<string, unknown>)[key as string] = value;
      }

      return { drafts: { ...state.drafts, video: newDrafts } };
    }),

  setTtsDraft: (key, value) =>
    set((state) => {
      if (!state.snapshot) return state;
      const snapshotValue = state.snapshot.tts[key];
      const newDrafts = { ...state.drafts.tts };

      if (deepEqual(value, snapshotValue)) {
        delete newDrafts[key];
      } else {
        (newDrafts as Record<string, unknown>)[key as string] = value;
      }

      return { drafts: { ...state.drafts, tts: newDrafts } };
    }),

  batchSetAudioDrafts: (updates) =>
    set((state) => {
      if (!state.snapshot) return state;
      const newDrafts = { ...state.drafts.audio };

      for (const [key, value] of Object.entries(updates)) {
        const k = key as keyof DraftableAudioSettings;
        if (deepEqual(value, state.snapshot.audio[k])) {
          delete newDrafts[k];
        } else {
          (newDrafts as Record<string, unknown>)[key] = value;
        }
      }

      return { drafts: { ...state.drafts, audio: newDrafts } };
    }),

  // ── Mode stashing ───────────────────────────────────────────────────────

  stashAndSwapAudioMode: (toAdvanced, qualityTier) =>
    set((state) => {
      if (!state.snapshot) return state;

      const currentDrafts = state.drafts.audio;
      const snapshot = state.snapshot.audio;

      // Pick current effective values for mode-dependent keys
      const currentModeValues: Partial<DraftableAudioSettings> = {};
      for (const k of AUDIO_MODE_KEYS) {
        currentModeValues[k] = (k in currentDrafts ? currentDrafts[k] : snapshot[k]) as never;
      }

      const newDrafts = { ...currentDrafts };

      if (toAdvanced) {
        // Basic → Advanced: stash basic, restore advanced
        const advancedStash = state.audioAdvancedStash;
        if (advancedStash) {
          // Restore advanced stash values
          for (const k of AUDIO_MODE_KEYS) {
            if (k in advancedStash) {
              if (deepEqual(advancedStash[k], snapshot[k])) {
                delete newDrafts[k];
              } else {
                (newDrafts as Record<string, unknown>)[k] = advancedStash[k];
              }
            }
          }
        }
        // else: keep current values (tier defaults flow through)

        return {
          audioBasicStash: currentModeValues,
          drafts: { ...state.drafts, audio: newDrafts },
        };
      } else {
        // Advanced → Basic: stash advanced, restore basic
        const basicStash = state.audioBasicStash;
        if (basicStash) {
          // Restore basic stash values
          for (const k of AUDIO_MODE_KEYS) {
            if (k in basicStash) {
              if (deepEqual(basicStash[k], snapshot[k])) {
                delete newDrafts[k];
              } else {
                (newDrafts as Record<string, unknown>)[k] = basicStash[k];
              }
            }
          }
        } else {
          // No basic stash — set to tier defaults
          const tc = AUDIO_QUALITY_TIERS[qualityTier];
          const tierDefaults: Partial<DraftableAudioSettings> = {
            silenceDetection: tc.opusDtx,
            inlineFec: tc.opusFec,
            fecHeadroom: tc.opusFec,
            frameSize: 0 as 0 | 10 | 20 | 40 | 60,
            stereoOverride: null,
          };
          for (const [k, v] of Object.entries(tierDefaults)) {
            const key = k as keyof DraftableAudioSettings;
            if (deepEqual(v, snapshot[key])) {
              delete newDrafts[key];
            } else {
              (newDrafts as Record<string, unknown>)[k] = v;
            }
          }
        }

        return {
          audioAdvancedStash: currentModeValues,
          drafts: { ...state.drafts, audio: newDrafts },
        };
      }
    }),

  // ── Apply ────────────────────────────────────────────────────────────────

  apply: () => {
    const { snapshot, drafts } = get();
    if (!snapshot) return;

    const willRestart = 'hardwareAcceleration' in drafts.video;

    // Appearance — already applied live, but we need to allow server sync
    // (appearance drafts were written through to real store already)

    // Audio — push to real store
    if (Object.keys(drafts.audio).length > 0) {
      const store = useAudioSettingsStore.getState();
      for (const [key, value] of Object.entries(drafts.audio)) {
        callSetter(store as unknown as Record<string, unknown>, key, value);
      }
    }

    // Video — push to real store (except hardwareAcceleration IPC handled below)
    if (Object.keys(drafts.video).length > 0) {
      const store = useVideoSettingsStore.getState();
      for (const [key, value] of Object.entries(drafts.video)) {
        if (key === 'hardwareAcceleration') continue; // handled separately
        callSetter(store as unknown as Record<string, unknown>, key, value);
      }
    }

    // TTS — push to real store
    if (Object.keys(drafts.tts).length > 0) {
      const store = useTTSSettingsStore.getState();
      for (const [key, value] of Object.entries(drafts.tts)) {
        callSetter(store as unknown as Record<string, unknown>, key, value);
      }
    }

    // Re-snapshot and clear drafts
    // Temporarily allow server sync to fire for appearance changes
    draftModeActive = false;

    set({
      snapshot: takeSnapshot(),
      drafts: emptyDrafts(),
      // Keep mode stashes for future toggles
    });

    // Re-enable draft mode (settings page is still open)
    draftModeActive = true;

    // Hardware acceleration restart — must happen AFTER all stores are saved
    if (willRestart) {
      setTimeout(() => {
        const hwValue = drafts.video.hardwareAcceleration;
        (window as any).electron?.setHardwareAcceleration?.(hwValue);
        (window as any).electron?.relaunchApp?.();
      }, 150);
    }
  },

  // ── Revert ──────────────────────────────────────────────────────────────

  revert: () => {
    const { snapshot } = get();

    // Restore appearance from snapshot (undo live preview)
    if (snapshot) {
      const store = useSettingsStore.getState();
      store.setTheme(snapshot.appearance.theme);
      store.setColorScheme(snapshot.appearance.colorScheme);
      store.setFontSize(snapshot.appearance.fontSize);
      store.setCompactMode(snapshot.appearance.compactMode);
      store.setReduceAnimations(snapshot.appearance.reduceAnimations);
      if (snapshot.appearance.customColors) {
        store.setCustomColors(snapshot.appearance.customColors);
      }
    }

    // Clear all drafts and stashes
    set({
      drafts: emptyDrafts(),
      audioBasicStash: null,
      audioAdvancedStash: null,
    });
  },
}));
