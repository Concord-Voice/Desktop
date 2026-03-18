import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useVoiceStore, AUDIO_QUALITY_TIERS, type AudioQualityTier } from '../../stores/voiceStore';
import { useAudioSettingsStore, type AudioPriority } from '../../stores/audioSettingsStore';
import {
  useVideoSettingsStore,
  VIDEO_QUALITY_PRESETS,
  type ScreenContentType,
  type DegradationPreference,
  type VideoPriority,
} from '../../stores/videoSettingsStore';
import {
  codecKey,
  codecKeyMime,
  getCodecInfo,
  type CodecCapability,
} from '../../services/mediaCapabilities';
import DeviceSelector from '../Voice/DeviceSelector';
import { useMicTest } from '../../hooks/useMicTest';
import {
  useDraftAudioSetting,
  useDraftVideoSetting,
  setDraftAudioSetting,
  setDraftVideoSetting,
  batchSetAudioDrafts,
  useStashAndSwapAudioMode,
} from '../../hooks/useDraftSettings';
import ToggleSwitch from './ToggleSwitch';
import CollapsibleSection from './CollapsibleSection';
import CustomSelect from '../ui/CustomSelect';

// ─── GPU Vendor Icon ────────────────────────────────────────────────────────

const GpuVendorIcon: React.FC<{ vendor: string }> = ({ vendor }) => {
  const v = vendor.toLowerCase();
  // Apple
  if (v.includes('apple'))
    return (
      <svg
        width="13"
        height="16"
        viewBox="0 0 256 315"
        fill="none"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <path
          d="M213.8 167.1c-.4-39.2 32-58.1 33.5-59.1-18.2-26.7-46.6-30.3-56.7-30.7-24.2-2.4-47.2 14.2-59.5 14.2-12.3 0-31.3-13.9-51.4-13.5-26.5.4-50.9 15.4-64.5 39.1-27.5 47.7-7 118.4 19.8 157.1 13.1 18.9 28.7 40.2 49.2 39.4 19.7-.8 27.2-12.8 51-12.8 23.9 0 30.6 12.8 51.5 12.4 21.2-.4 34.7-19.3 47.7-38.3 15.1-22 21.3-43.2 21.7-44.3-.5-.2-41.6-16-42.1-63.5zM175 64.2C185.8 51.1 193.1 33.4 191 15.8c-15.2.6-33.7 10.2-44.6 23-9.8 11.3-18.4 29.5-16.1 46.9 17 1.3 34.3-8.6 44.7-21.5z"
          fill="currentColor"
        />
      </svg>
    );
  // NVIDIA
  if (v.includes('nvidia'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#76B900" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="7"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          N
        </text>
      </svg>
    );
  // Intel
  if (v.includes('intel'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <circle cx="8" cy="8" r="7" fill="#0071C5" />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fill="white"
          fontSize="8"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          i
        </text>
      </svg>
    );
  // AMD
  if (v.includes('amd'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#ED1C24" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="6"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          AMD
        </text>
      </svg>
    );
  // Qualcomm
  if (v.includes('qualcomm'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <circle cx="8" cy="8" r="7" fill="#3253DC" />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fill="white"
          fontSize="8"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          Q
        </text>
      </svg>
    );
  // ARM
  if (v.includes('arm'))
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        style={{ verticalAlign: 'middle' }}
      >
        <rect x="1" y="3" width="14" height="10" rx="2" fill="#0091BD" />
        <text
          x="8"
          y="10.5"
          textAnchor="middle"
          fill="white"
          fontSize="6"
          fontWeight="bold"
          fontFamily="sans-serif"
        >
          ARM
        </text>
      </svg>
    );
  return null;
};

// ─── Voice & Audio Section ──────────────────────────────────────────────────

const TIER_ORDER: AudioQualityTier[] = [
  'minimum',
  'low',
  'moderate',
  'standard',
  'high',
  'hifi',
  'studio',
];

const TIER_DESCRIPTIONS_BASIC: Record<AudioQualityTier, string> = {
  minimum:
    '16 kbps · Mono | FEC On | DTX | AFS (60ms Preferred)\nOptimized for pure survival over quality. Uses silence detection and aggressive error correction to keep you connected when the digital world is ending. Use if:\n\u2022 Bandwidth is an absolute luxury.\n\u2022 Your system is basically a Commodore 64.\n\u2022 Your internet just filed for divorce and took the router.',
  low: "32 kbps · Mono | FEC On | DTX | AFS (40ms Preferred)\nPrioritizes keeping you in the conversation without chewing through your data cap. You won't sound like a podcast host, but we will understand you. Use if:\n\u2022 You are on a strict data diet.\n\u2022 Your microphone was found at the bottom of a cereal box.\n\u2022 Your Wi-Fi is acting suspiciously spotty.",
  moderate:
    "64 kbps · Mono | FEC On | DTX | AFS (20ms Preferred)\nThe ol' reliable. The industry standard sweet spot that perfectly balances crisp voice audio with reasonable bandwidth demands. Use if:\n\u2022 You just want it to work without overthinking it.\n\u2022 You are using standard consumer-grade headsets.\n\u2022 Your internet connection actually pays rent.",
  standard:
    '96 kbps · Mono | FEC On | DTX | AFS (20ms Preferred)\nThe Concord default. Optimized for maximum clarity in voice chats, making you sound exactly like your actual self (for better or worse). Use if:\n\u2022 You want the intended, nearly-transparent Concord Voice experience.\n\u2022 You refuse to mess with settings menus.',
  high: '192 kbps · Mono | FEC On | AFS (10ms Preferred)\nCranking the dial to "virtually transparent." Delivers exceptional clarity and frequency response without crossing into absolute overkill territory. Use if:\n\u2022 You are an enthusiast who appreciates the finer frequencies.\n\u2022 You invested in a seriously good microphone.\n\u2022 Your internet speeds are something you brag about at parties.',
  hifi: '256 kbps · Stereo | FEC Off | AFS (10ms Preferred)\nMaximum fidelity for power users. This is unfiltered, transparent audio that squeezes the full factor of quality with quantity out of the Opus codec. Use if:\n\u2022 You demand maximum bang-for-the-buck quality.\n\u2022 You have enthusiast-grade, borderline-unreasonable audio gear.\n\u2022 Your internet is hardwired and unflinching.',
  studio:
    "510 kbps · Stereo | FEC Off | AFS (10ms Preferred)\nThe absolute ceiling. Massive, glorious, overkill bandwidth for acoustically transparent 48kHz/16-bit audio. It's dangerous to go alone, so take these 510,000 bits per second... Every second. Use if:\n\u2022 You are running studio-level audio production over the web.\n\u2022 You own audiophile equipment that costs more than a used car.\n\u2022 You have a rock-solid, direct-to-the-vein fiber optic connection.",
};

const VoiceAudioSection: React.FC = () => {
  const qualityTier = useVoiceStore((s) => s.qualityTier);
  const setQualityTier = useVoiceStore((s) => s.setQualityTier);
  const activeCameraCodec = useVoiceStore((s) => s.activeCameraCodec);
  const activeScreenCodec = useVoiceStore((s) => s.activeScreenCodec);
  const isInVoiceCall = useVoiceStore(
    (s) =>
      s.connectionState === 'connected' ||
      s.connectionState === 'connecting' ||
      s.connectionState === 'reconnecting'
  );
  const { isTesting, dbfsLevel, error: micTestError, startTest, stopTest } = useMicTest();

  // Audio mode (excluded from drafts — immediate)
  const advancedMode = useAudioSettingsStore((s) => s.advancedMode);

  // Audio processing settings (drafted)
  const stereoOverride = useDraftAudioSetting('stereoOverride');
  const noiseCancellation = useDraftAudioSetting('noiseCancellation');
  const echoCancellation = useDraftAudioSetting('echoCancellation');
  const autoGainControl = useDraftAudioSetting('autoGainControl');
  const noiseGateMode = useDraftAudioSetting('noiseGateMode');
  const noiseGateLevel = useDraftAudioSetting('noiseGateLevel');
  const inputVolume = useDraftAudioSetting('inputVolume');
  const outputVolume = useDraftAudioSetting('outputVolume');
  const quietBoost = useDraftAudioSetting('quietBoost');
  const quietBoostThreshold = useDraftAudioSetting('quietBoostThreshold');

  // Video settings (drafted)
  const cameraPreset = useDraftVideoSetting('cameraPreset');
  const screenResolution = useDraftVideoSetting('screenResolution');
  const screenFrameRate = useDraftVideoSetting('screenFrameRate');
  const screenContentType = useDraftVideoSetting('screenContentType');
  const preferredVideoCodec = useDraftVideoSetting('preferredVideoCodec');
  const screenSharePriority = useDraftVideoSetting('screenSharePriority');
  const screenShareBitrate = useDraftVideoSetting('screenShareBitrate');
  const cameraPriority = useDraftVideoSetting('cameraPriority');
  const degradationPreference = useDraftVideoSetting('degradationPreference');
  const hardwareAcceleration = useDraftVideoSetting('hardwareAcceleration');
  const hdrEncoding = useDraftVideoSetting('hdrEncoding');

  // Video settings (excluded from drafts — system-detected / UI-only)
  const codecCapabilities = useVideoSettingsStore((s) => s.codecCapabilities);
  const gpuInfo = useVideoSettingsStore((s) => s.gpuInfo);
  const videoAdvancedMode = useVideoSettingsStore((s) => s.videoAdvancedMode);
  const systemHdr = useVideoSettingsStore((s) => s.systemHdr);

  const [displayInfo, setDisplayInfo] = useState<
    {
      width: number;
      height: number;
      refreshRate: number;
      scaleFactor: number;
      isPrimary: boolean;
    }[]
  >([]);

  useEffect(() => {
    window.electron?.getDisplayInfo?.().then((displays) => {
      if (displays) setDisplayInfo(displays);
    });
  }, []);

  // Mode stashing
  const stashAndSwapAudioMode = useStashAndSwapAudioMode();

  // Display-derived values for screen share options
  const bestDisplay = useMemo(() => {
    if (displayInfo.length === 0) return { width: 1920, height: 1080, refreshRate: 60 };
    return displayInfo.reduce((best, d) =>
      d.width * d.height > best.width * best.height ? d : best
    );
  }, [displayInfo]);

  const maxRefreshRate = useMemo(() => {
    if (displayInfo.length === 0) return 60;
    return Math.round(Math.max(...displayInfo.map((d) => d.refreshRate || 60)));
  }, [displayInfo]);

  // Unique display resolutions for the "Your Displays" optgroup
  const uniqueDisplayResolutions = useMemo(() => {
    const seen = new Set<string>();
    return displayInfo
      .map((d) => ({ width: d.width, height: d.height, isPrimary: d.isPrimary }))
      .filter((d) => {
        const key = `${d.width}x${d.height}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.width * b.height - a.width * a.height);
  }, [displayInfo]);

  // Dynamic bitrate recommendation based on resolution, FPS, and codec
  const recommendedBitrate = useMemo(() => {
    const resMap: Record<string, { w: number; h: number }> = {
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
      source: { w: bestDisplay.width, h: bestDisplay.height },
    };
    const parsed = screenResolution.match(/^(\d+)x(\d+)$/);
    const res = parsed
      ? { w: Number(parsed[1]), h: Number(parsed[2]) }
      : resMap[screenResolution] || resMap['1080p'];
    const effectiveFps = screenFrameRate === 0 ? maxRefreshRate : screenFrameRate;
    // Determine effective codec for efficiency: active (in-use) > preferred > auto-pick
    // Auto cascade picks AV1 → HEVC → VP9 first, so if any efficient codec is available, auto uses it
    const effectiveCodec = activeScreenCodec ?? preferredVideoCodec;
    const isEfficient = effectiveCodec
      ? effectiveCodec.includes('AV1') ||
        effectiveCodec.includes('H265') ||
        effectiveCodec.includes('HEVC') ||
        effectiveCodec.includes('VP9')
      : codecCapabilities.some(
          (c) =>
            c.mimeType.includes('AV1') ||
            c.mimeType.includes('H265') ||
            c.mimeType.includes('HEVC') ||
            c.mimeType.includes('VP9')
        );
    const bpp = isEfficient ? 0.04 : 0.07;
    const bps = res.w * res.h * effectiveFps * bpp;
    return Math.round(bps / 100_000) * 100_000;
  }, [
    screenResolution,
    screenFrameRate,
    preferredVideoCodec,
    activeScreenCodec,
    codecCapabilities,
    bestDisplay,
    maxRefreshRate,
  ]);

  const clampedRecommended = Math.max(1_500_000, Math.min(30_000_000, recommendedBitrate));

  // Advanced audio settings (drafted)
  const musicMode = useDraftAudioSetting('musicMode');
  const frameSize = useDraftAudioSetting('frameSize');
  const silenceDetection = useDraftAudioSetting('silenceDetection');
  const inlineFec = useDraftAudioSetting('inlineFec');
  const fecHeadroom = useDraftAudioSetting('fecHeadroom');
  const opusNack = useDraftAudioSetting('opusNack');
  const adaptivePtime = useDraftAudioSetting('adaptivePtime');
  const audioPriority = useDraftAudioSetting('audioPriority');

  // Derived tier capabilities
  const tierConfig = AUDIO_QUALITY_TIERS[qualityTier];
  // Tier slider index
  const tierIndex = TIER_ORDER.indexOf(qualityTier);
  const handleTierSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const idx = Number(e.target.value);
      if (idx >= 0 && idx < TIER_ORDER.length) {
        const tier = TIER_ORDER[idx];
        setQualityTier(tier); // voiceStore — immediate, not drafted
        if (!useAudioSettingsStore.getState().advancedMode) {
          // Basic mode: batch-draft tier defaults
          const tc = AUDIO_QUALITY_TIERS[tier];
          batchSetAudioDrafts({
            silenceDetection: tc.opusDtx,
            inlineFec: tc.opusFec,
            fecHeadroom: tc.opusFec,
            frameSize: 0 as 0 | 10 | 20 | 40 | 60,
            stereoOverride: null,
          });
        }
      }
    },
    [setQualityTier]
  );

  const handleAdvancedToggle = useCallback(
    (enabled: boolean) => {
      useAudioSettingsStore.getState().setAdvancedMode(enabled); // immediate — UI toggle
      stashAndSwapAudioMode(enabled, qualityTier);
    },
    [qualityTier, stashAndSwapAudioMode]
  );

  return (
    <>
      {/* ═══ Device Configuration ═══ */}
      <CollapsibleSection id="section-device-config" title="Device Configuration">
        <h3 className="settings-subsection-title">Input</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="audioinput" />
        </div>
        <div className="settings-volume-row">
          <div className="settings-row-info">
            <span className="settings-volume-label">Input Volume</span>
            <span className="settings-row-hint">
              Scales your microphone level from muted (left) to 2x boost (right). Values above 100%
              may introduce clipping.
            </span>
          </div>
          <div className="settings-slider-wrapper">
            <span className="settings-slider-value">{inputVolume}%</span>
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={inputVolume}
              onChange={(e) => setDraftAudioSetting('inputVolume', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="settings-mic-test-row">
          <button
            className={`settings-mic-test-btn${isTesting ? ' testing' : ''}`}
            onClick={isTesting ? stopTest : startTest}
            disabled={isInVoiceCall}
            title={isInVoiceCall ? 'Unavailable during a voice call' : undefined}
          >
            {isTesting ? 'Stop Testing' : 'Test'}
          </button>
          {micTestError && <span className="settings-mic-test-error">{micTestError}</span>}
        </div>

        {isTesting && (
          <div className="settings-mic-meter-container">
            <div className="settings-mic-meter-track">
              <div
                className="settings-mic-meter-fill"
                style={{ width: `${Math.max(0, ((dbfsLevel + 80) / 80) * 100)}%` }}
              />
            </div>
            <div className="settings-mic-meter-ticks">
              <span>-80</span>
              <span>-60</span>
              <span>-40</span>
              <span>-20</span>
              <span>0 dBFS</span>
            </div>
          </div>
        )}

        <h3 className="settings-subsection-title">Output</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="audiooutput" />
        </div>
        <div className="settings-volume-row">
          <div className="settings-row-info">
            <span className="settings-volume-label">Output Volume</span>
            <span className="settings-row-hint">
              Scales all incoming audio from muted (left) to 2x boost (right). Values above 100% may
              introduce clipping.
            </span>
          </div>
          <div className="settings-slider-wrapper">
            <span className="settings-slider-value">{outputVolume}%</span>
            <input
              type="range"
              className="settings-volume-slider"
              min={0}
              max={200}
              value={outputVolume}
              onChange={(e) => setDraftAudioSetting('outputVolume', Number(e.target.value))}
            />
          </div>
        </div>

        <h3 className="settings-subsection-title">Camera</h3>
        <div className="settings-device-row">
          <DeviceSelector kind="videoinput" />
        </div>
      </CollapsibleSection>

      {/* ═══ Audio Configuration ═══ */}
      <CollapsibleSection id="section-audio-config" title="Audio Configuration">
        {/* ── Mode Toggle ── */}
        <div className="settings-mode-toggle">
          <span
            className={`settings-mode-pill ${!advancedMode ? 'active' : ''}`}
            onClick={() => handleAdvancedToggle(false)}
          >
            Basic Settings
          </span>
          <span
            className={`settings-mode-pill ${advancedMode ? 'active' : ''}`}
            onClick={() => handleAdvancedToggle(true)}
          >
            Advanced Settings
          </span>
        </div>

        {advancedMode && (
          <p className="settings-mode-notice">
            These settings override the quality tier presets. Switching back to Basic will save your
            advanced configuration but apply your last Basic settings instead.
          </p>
        )}

        {/* ── Quality ── */}
        <h3 className="settings-subsection-title">Quality</h3>
        <p className="settings-section-description">
          Higher quality uses more bandwidth. Premium tiers require a subscription.
        </p>

        <div className="settings-tier-slider-container">
          <div className="settings-tier-labels">
            {TIER_ORDER.map((tier, i) => {
              const config = AUDIO_QUALITY_TIERS[tier];
              return (
                <span
                  key={tier}
                  className={`settings-tier-label ${tierIndex === i ? 'active' : ''}`}
                  onClick={() => {
                    setQualityTier(tier);
                    if (!useAudioSettingsStore.getState().advancedMode) {
                      const tc = AUDIO_QUALITY_TIERS[tier];
                      batchSetAudioDrafts({
                        silenceDetection: tc.opusDtx,
                        inlineFec: tc.opusFec,
                        fecHeadroom: tc.opusFec,
                        frameSize: 0 as 0 | 10 | 20 | 40 | 60,
                        stereoOverride: null,
                      });
                    }
                  }}
                >
                  {config.label}
                </span>
              );
            })}
          </div>
          <div className="settings-tier-track">
            <div className="settings-tier-ticks">
              {TIER_ORDER.map((_, i) => (
                <span key={i} className={`settings-tier-tick ${tierIndex === i ? 'active' : ''}`} />
              ))}
            </div>
            <input
              type="range"
              className="settings-tier-slider"
              min={0}
              max={TIER_ORDER.length - 1}
              step={1}
              value={tierIndex}
              onChange={handleTierSlider}
            />
          </div>
          <div className="settings-tier-kbps-container">
            <span
              className="settings-tier-kbps-label"
              style={{
                left: `calc(${100 / 14 + (tierIndex / (TIER_ORDER.length - 1)) * (100 - 200 / 14)}%)`,
              }}
            >
              {Math.round(AUDIO_QUALITY_TIERS[qualityTier].maxBitrate / 1000)} kbps
            </span>
          </div>
          {!advancedMode && (
            <div className="settings-tier-description">
              {TIER_DESCRIPTIONS_BASIC[qualityTier].split('\n').map((line, i) => (
                <span key={i}>{line}</span>
              ))}
              {AUDIO_QUALITY_TIERS[qualityTier].premium && (
                <span className="settings-quality-premium-badge">Premium</span>
              )}
            </div>
          )}
        </div>

        {/* ── Processing ── */}
        <h3 className="settings-subsection-title">Processing</h3>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Noise Cancellation</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Noise cancellation is forced off to preserve full-bandwidth audio fidelity.'
                : noiseCancellation
                  ? "Enabled. Background noise from your microphone is actively filtered out by the system's noise suppression. May slightly reduce audio fidelity in noisy environments."
                  : 'Disabled. No noise filtering is applied \u2014 all ambient sound passes through unprocessed.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && noiseCancellation}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('noiseCancellation', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Echo Cancellation</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Echo cancellation is forced off to preserve unprocessed audio fidelity.'
                : echoCancellation
                  ? 'Enabled. Acoustic echo cancellation prevents your speakers from feeding back into your microphone, allowing speaker use without headphones.'
                  : 'Disabled. No echo cancellation is applied. Use headphones to prevent feedback loops.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && echoCancellation}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('echoCancellation', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className={`settings-row ${musicMode ? 'settings-row-disabled' : ''}`}>
          <div className="settings-row-info">
            <span className="settings-row-label">Auto Gain Control</span>
            <span className="settings-row-hint">
              {musicMode
                ? 'Locked by Music Mode. Automatic gain control is forced off to prevent dynamic compression of your audio signal.'
                : autoGainControl
                  ? 'Enabled. Automatically normalizes your microphone volume \u2014 making quiet speech louder and loud speech softer.'
                  : 'Disabled. Your microphone level is not automatically adjusted. Manual volume control via the input slider is recommended.'}
            </span>
          </div>
          <ToggleSwitch
            checked={!musicMode && autoGainControl}
            onChange={(v) => {
              if (!musicMode) setDraftAudioSetting('autoGainControl', v);
            }}
            disabled={musicMode}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Input Noise Gate</span>
            <span className="settings-row-hint">
              {noiseGateMode === 'manual'
                ? `Enabled. Input below ${noiseGateLevel} dBFS is muted with a hard cutoff. Sounds above this threshold pass through unaffected.`
                : 'Disabled. No hard cutoff is applied to your input. Relies on noise cancellation and auto gain control if those are enabled.'}
            </span>
          </div>
          <ToggleSwitch
            checked={noiseGateMode === 'manual'}
            onChange={(v) => setDraftAudioSetting('noiseGateMode', v ? 'manual' : 'auto')}
          />
        </div>

        {noiseGateMode === 'manual' && (
          <div className="settings-row settings-row-child">
            <div className="settings-row-info">
              <span className="settings-row-label">Gate Threshold</span>
              <span className="settings-row-hint">
                {noiseGateLevel >= -25
                  ? `${noiseGateLevel} dBFS \u2014 Gates everything except loud, close-mic speech. Only passes through someone talking directly into a microphone.`
                  : noiseGateLevel >= -35
                    ? `${noiseGateLevel} dBFS \u2014 Gates background noise and quiet sounds. Passes through normal conversational speaking volume.`
                    : noiseGateLevel >= -50
                      ? `${noiseGateLevel} dBFS \u2014 Gates ambient room noise. Passes through most intentional speech, including softer voices.`
                      : noiseGateLevel >= -65
                        ? `${noiseGateLevel} dBFS \u2014 Gates only faint background hum. Most sounds above a quiet whisper will pass through.`
                        : `${noiseGateLevel} dBFS \u2014 Gates only near-total silence. Virtually everything audible passes through unaffected.`}
              </span>
            </div>
            <div className="settings-slider-wrapper">
              <span className="settings-slider-value">{noiseGateLevel} dBFS</span>
              <input
                type="range"
                className="settings-slider"
                min={-80}
                max={-20}
                value={noiseGateLevel}
                onChange={(e) => setDraftAudioSetting('noiseGateLevel', Number(e.target.value))}
              />
            </div>
          </div>
        )}

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Boost Quiet Users</span>
            <span className="settings-row-hint">
              {quietBoost
                ? 'Enabled. Participants whose audio falls below the threshold are dynamically amplified to a comfortable level. Normal-volume users are unaffected.'
                : 'Disabled. All participants play at their natural volume level with no receiver-side amplification.'}
            </span>
          </div>
          <ToggleSwitch
            checked={quietBoost}
            onChange={(v) => setDraftAudioSetting('quietBoost', v)}
          />
        </div>

        {quietBoost && (
          <div className="settings-row settings-row-child">
            <div className="settings-row-info">
              <span className="settings-row-label">Boost Threshold</span>
              <span className="settings-row-hint">
                {quietBoostThreshold >= -24
                  ? `${quietBoostThreshold} dBFS \u2014 Boosts anyone not talking directly at their mic. Like someone speaking to you from across the room.`
                  : quietBoostThreshold >= -30
                    ? `${quietBoostThreshold} dBFS \u2014 Boosts participants who sound turned away from their mic. Like someone talking but facing the other direction.`
                    : quietBoostThreshold >= -38
                      ? `${quietBoostThreshold} dBFS \u2014 Boosts noticeably quiet participants. Like someone whispering nearby or speaking softly from a distance.`
                      : quietBoostThreshold >= -45
                        ? `${quietBoostThreshold} dBFS \u2014 Boosts only very quiet participants. Like someone whispering close to their mic.`
                        : `${quietBoostThreshold} dBFS \u2014 Boosts only barely-audible participants. Like catching a faint whisper from across a quiet room.`}
              </span>
            </div>
            <div className="settings-slider-wrapper">
              <span className="settings-slider-value">{quietBoostThreshold} dBFS</span>
              <input
                type="range"
                className="settings-slider"
                min={-50}
                max={-20}
                value={quietBoostThreshold}
                onChange={(e) =>
                  setDraftAudioSetting('quietBoostThreshold', Number(e.target.value))
                }
              />
            </div>
          </div>
        )}

        {/* ── Advanced-only: Opus Codec ── */}
        {advancedMode && (
          <>
            <h3 className="settings-subsection-title">Opus Codec</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Music Mode</span>
                <span className="settings-row-hint">
                  {musicMode
                    ? 'Enabled. Noise suppression, echo cancellation, and auto gain control are bypassed. The Opus codec uses full 48 kHz bandwidth optimized for music fidelity.'
                    : 'Disabled. Standard voice processing is active with voice-optimized encoding.'}
                </span>
              </div>
              <ToggleSwitch
                checked={musicMode}
                onChange={(v) => setDraftAudioSetting('musicMode', v)}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Adaptive Frame Size (AFS)</span>
                <span className="settings-row-hint">
                  {adaptivePtime
                    ? 'Enabled. Concord Voice dynamically adjusts packet duration during congestion, trading latency for reliability. Manual Frame Size is overridden.'
                    : 'Disabled. Packet duration is fixed at the configured Frame Size value below.'}
                </span>
              </div>
              <ToggleSwitch
                checked={adaptivePtime}
                onChange={(v) => setDraftAudioSetting('adaptivePtime', v)}
              />
            </div>

            <div className={`settings-row ${adaptivePtime ? 'settings-row-disabled' : ''}`}>
              <div className="settings-row-info">
                <span className="settings-row-label">Frame Size (ptime)</span>
                <span className="settings-row-hint">
                  {adaptivePtime
                    ? 'Locked by Adaptive Frame Size. Manual frame size is overridden while adaptive sizing is active.'
                    : frameSize === 0
                      ? `Packet duration sent to other participants. Currently using the tier's preferred size (${tierConfig.preferredFrameSize}ms).`
                      : frameSize === 10
                        ? 'Packet duration sent to other participants. Currently 10ms \u2014 lowest latency, highest overhead.'
                        : frameSize === 20
                          ? 'Packet duration sent to other participants. Currently 20ms \u2014 standard balance of latency and efficiency.'
                          : frameSize === 40
                            ? 'Packet duration sent to other participants. Currently 40ms \u2014 reduced overhead, moderately increased latency.'
                            : 'Packet duration sent to other participants. Currently 60ms \u2014 maximum efficiency, highest latency.'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: '0', label: `Default (${tierConfig.preferredFrameSize} ms)` },
                  { value: '10', label: '10 ms (lowest latency)' },
                  { value: '20', label: '20 ms' },
                  { value: '40', label: '40 ms (efficient)' },
                  { value: '60', label: '60 ms (most efficient)' },
                ]}
                value={String(adaptivePtime ? 0 : frameSize)}
                onChange={(v) =>
                  setDraftAudioSetting('frameSize', Number(v) as 0 | 10 | 20 | 40 | 60)
                }
                disabled={adaptivePtime}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Silence Detection (DTX)</span>
                <span className="settings-row-hint">
                  {silenceDetection
                    ? 'Enabled. The Opus codec uses discontinuous transmission to send fewer packets during silence, reducing bandwidth usage.'
                    : 'Disabled. Packets are sent continuously regardless of input activity. Uses more bandwidth but avoids transition artifacts.'}
                </span>
              </div>
              <ToggleSwitch
                checked={silenceDetection}
                onChange={(v) => setDraftAudioSetting('silenceDetection', v)}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Mic Channel Mode</span>
                <span className="settings-row-hint">
                  {(stereoOverride ?? tierConfig.opusStereo)
                    ? 'Currently Stereo — Opus encodes two channels using mid-side (M/S) joint stereo, splitting audio into a summed Mid channel and a difference Side channel. When channels are similar, the Side channel compresses to near-nothing, so stereo does not double bandwidth. Recommended for multi-microphone setups, Hi-Fi, or studio-grade configurations.'
                    : 'Currently Mono — a single audio channel is encoded and delivered. Recommended for most users, especially with standard single-microphone headsets and desk mics.'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: 'stereo', label: 'Stereo' },
                  { value: 'mono', label: 'Mono' },
                ]}
                value={(stereoOverride ?? tierConfig.opusStereo) ? 'stereo' : 'mono'}
                onChange={(v) => setDraftAudioSetting('stereoOverride', v === 'stereo')}
              />
            </div>

            {/* ── Error Correction & Reliability ── */}
            <h3 className="settings-subsection-title">Error Correction & Reliability</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">In-Line Forward Error Correction (FEC)</span>
                <span className="settings-row-hint">
                  {inlineFec
                    ? 'Enabled. Every packet includes a low-quality copy of the previous frame as a safety net. The receiver uses it to fill gaps when a packet goes missing. VBR keeps the overhead minimal on easy frames.'
                    : 'Disabled. Packets carry only primary audio with no redundancy. Maximizes quality per-packet, but the receiver has nothing to fall back on during packet loss.'}
                </span>
              </div>
              <ToggleSwitch
                checked={inlineFec}
                onChange={(v) => setDraftAudioSetting('inlineFec', v)}
              />
            </div>

            {inlineFec && (
              <div className="settings-row">
                <div className="settings-row-info">
                  <span className="settings-row-label">Grant FEC Headroom</span>
                  <span className="settings-row-hint">
                    {fecHeadroom
                      ? 'Enabled. When packet loss is detected, the bitrate ceiling is raised so the always-present FEC payload does not eat into primary audio quality.'
                      : "Disabled. The bitrate ceiling stays fixed at the tier's base rate. Since FEC is always encoded, it competes with primary audio for the same budget on complex frames."}
                  </span>
                </div>
                <ToggleSwitch
                  checked={fecHeadroom}
                  onChange={(v) => setDraftAudioSetting('fecHeadroom', v)}
                />
              </div>
            )}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">NACK (Retransmission)</span>
                <span className="settings-row-hint">
                  {opusNack
                    ? 'Enabled. Concord requests retransmission of lost audio packets from the server. Improves reliability on lossy networks at the cost of added latency.'
                    : 'Disabled. Lost packets are not retransmitted. Relies on FEC or interpolation to handle gaps.'}
                </span>
              </div>
              <ToggleSwitch
                checked={opusNack}
                onChange={(v) => setDraftAudioSetting('opusNack', v)}
              />
            </div>

            {/* ── Transport ── */}
            <h3 className="settings-subsection-title">Transport</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Audio</span>
                <span className="settings-row-hint">
                  {
                    'Marks audio traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {audioPriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : audioPriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : audioPriority === 'medium'
                        ? 'Currently Default (AF41) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: 'off', label: 'Off (No Tagging)' },
                  { value: 'low', label: 'Low (DF)' },
                  { value: 'medium', label: 'Default (AF41)' },
                  { value: 'high', label: 'High (EF)' },
                ]}
                value={audioPriority}
                onChange={(v) => setDraftAudioSetting('audioPriority', v as AudioPriority)}
              />
            </div>
          </>
        )}
      </CollapsibleSection>

      {/* ═══ Video Configuration ═══ */}
      <CollapsibleSection id="section-video-screen" title="Video Configuration">
        <div className="settings-mode-toggle">
          <span
            className={`settings-mode-pill ${!videoAdvancedMode ? 'active' : ''}`}
            onClick={() => useVideoSettingsStore.getState().setVideoAdvancedMode(false)}
          >
            Basic Settings
          </span>
          <span
            className={`settings-mode-pill ${videoAdvancedMode ? 'active' : ''}`}
            onClick={() => useVideoSettingsStore.getState().setVideoAdvancedMode(true)}
          >
            Advanced Settings
          </span>
        </div>

        {/* ── Camera ── */}
        <h3 className="settings-subsection-title">Camera</h3>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Camera Preset</span>
            <span className="settings-row-hint">
              {cameraPreset === 'system'
                ? "Constrains the camera's capture resolution and frame rate. Currently System Default \u2014 the camera and driver decide automatically."
                : `Constrains the camera's capture resolution and frame rate. Currently requesting ${VIDEO_QUALITY_PRESETS[cameraPreset]?.label ?? cameraPreset}.`}
            </span>
          </div>
          <CustomSelect
            className="settings-select"
            options={Object.entries(VIDEO_QUALITY_PRESETS).map(([key, preset]) => ({
              value: key,
              label: preset.label,
            }))}
            value={cameraPreset}
            onChange={(v) => setDraftVideoSetting('cameraPreset', v)}
          />
        </div>

        {/* ── Screen Share ── */}
        <h3 className="settings-subsection-title">Screen Share</h3>
        <p className="settings-section-description">
          Default settings for screen sharing. These can be changed per-share in the picker.
        </p>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Resolution</span>
            <span className="settings-row-hint">
              {screenResolution === 'source'
                ? "Default capture resolution for screen sharing. Currently Native \u2014 captures at your display's full resolution."
                : `Default capture resolution for screen sharing. Currently ${screenResolution}.`}
            </span>
          </div>
          <CustomSelect
            className="settings-select"
            options={[
              { value: 'source', label: 'Native', group: 'Common Resolutions' },
              ...(bestDisplay.height >= 2160
                ? [{ value: '4K', label: '4K (3840×2160)', group: 'Common Resolutions' }]
                : []),
              ...(bestDisplay.height >= 1440
                ? [{ value: '1440p', label: '1440p (2560×1440)', group: 'Common Resolutions' }]
                : []),
              { value: '1080p', label: '1080p (1920×1080)', group: 'Common Resolutions' },
              { value: '720p', label: '720p (1280×720)', group: 'Common Resolutions' },
              ...uniqueDisplayResolutions.map((d) => ({
                value: `${d.width}x${d.height}`,
                label: `${d.width}×${d.height}${d.isPrimary ? ' (Primary)' : ''}`,
                group: 'Your Displays',
              })),
            ]}
            value={screenResolution}
            onChange={(v) => setDraftVideoSetting('screenResolution', v)}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Frame Rate</span>
            <span className="settings-row-hint">
              {screenFrameRate === 0
                ? `Default capture frame rate for screen sharing. Currently Native (${maxRefreshRate} Hz).`
                : `Default capture frame rate for screen sharing. Currently ${screenFrameRate} FPS.`}
            </span>
          </div>
          <CustomSelect
            className="settings-select"
            options={[
              { value: '0', label: `Native (${maxRefreshRate} Hz)`, group: 'Common' },
              { value: '60', label: '60 FPS', group: 'Common' },
              { value: '30', label: '30 FPS', group: 'Common' },
              ...(maxRefreshRate >= 120
                ? [{ value: '120', label: '120 FPS', group: 'Additional' }]
                : []),
              ...(maxRefreshRate >= 100
                ? [{ value: '100', label: '100 FPS', group: 'Additional' }]
                : []),
              ...(maxRefreshRate >= 90
                ? [{ value: '90', label: '90 FPS', group: 'Additional' }]
                : []),
              ...(maxRefreshRate >= 75
                ? [{ value: '75', label: '75 FPS', group: 'Additional' }]
                : []),
              { value: '24', label: '24 FPS (Cinematic)', group: 'Additional' },
              { value: '15', label: '15 FPS', group: 'Additional' },
              { value: '5', label: '5 FPS (Slideshow)', group: 'Additional' },
            ]}
            value={String(screenFrameRate)}
            onChange={(v) => setDraftVideoSetting('screenFrameRate', Number(v))}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Content Type</span>
            <span className="settings-row-hint">
              {screenContentType === 'auto'
                ? 'Optimizes encoding for the type of content being shared. Currently Auto \u2014 Concord Voice detects motion vs. static content and adjusts accordingly.'
                : screenContentType === 'motion'
                  ? 'Optimizes encoding for the type of content being shared. Currently Motion \u2014 prioritizes smooth frame rate for video and animations.'
                  : 'Optimizes encoding for the type of content being shared. Currently Detail \u2014 prioritizes sharp text and edges for code and documents.'}
            </span>
          </div>
          <CustomSelect
            className="settings-select"
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'motion', label: 'Motion (Video & Animation)' },
              { value: 'detail', label: 'Detail (Text & Code)' },
            ]}
            value={screenContentType}
            onChange={(v) => setDraftVideoSetting('screenContentType', v as ScreenContentType)}
          />
        </div>

        {/* ── Advanced Video Settings ── */}
        {videoAdvancedMode && (
          <>
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Congestion Priority</span>
                <span className="settings-row-hint">
                  {degradationPreference === 'balanced'
                    ? 'How Concord adapts your camera during network congestion. Currently Balanced \u2014 Concord decides whether to reduce resolution or framerate.'
                    : degradationPreference === 'maintain-framerate'
                      ? 'How Concord adapts your camera during network congestion. Currently Prefer Smooth Video \u2014 keeps framerate by reducing resolution.'
                      : 'How Concord adapts your camera during network congestion. Currently Prefer Sharp Details \u2014 keeps resolution by reducing framerate.'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: 'balanced', label: 'Balanced' },
                  { value: 'maintain-framerate', label: 'Prefer Smooth Video' },
                  { value: 'maintain-resolution', label: 'Prefer Sharp Details' },
                ]}
                value={degradationPreference}
                onChange={(v) =>
                  setDraftVideoSetting('degradationPreference', v as DegradationPreference)
                }
              />
            </div>

            <h3 className="settings-subsection-title">Codec & Hardware</h3>

            {gpuInfo && (
              <p className="settings-section-description" style={{ marginTop: 0, marginBottom: 6 }}>
                <span className="settings-gpu-badge">
                  <GpuVendorIcon vendor={gpuInfo.vendor} /> {gpuInfo.vendor}
                  {gpuInfo.device ? ` · ${gpuInfo.device}` : ''}
                </span>
              </p>
            )}

            {codecCapabilities.length > 0 &&
              (() => {
                const codecPriority: Record<string, number> = {
                  AV1: 0,
                  H265: 1,
                  HEVC: 1,
                  VP9: 2,
                  H264: 3,
                  VP8: 4,
                };
                const codecDisplayName: Record<string, string> = {
                  H264: 'AVC (H.264)',
                  H265: 'HEVC (H.265)',
                  HEVC: 'HEVC (H.265)',
                };
                // Codecs the mediasoup router supports (H265 not yet supported)
                const routerSupported = new Set([
                  'video/vp8',
                  'video/vp9',
                  'video/h264',
                  'video/av1',
                ]);
                const sortByPriority = (a: CodecCapability, b: CodecCapability) =>
                  (codecPriority[a.mimeType.replace('video/', '')] ?? 99) -
                  (codecPriority[b.mimeType.replace('video/', '')] ?? 99);
                const displayName = (c: CodecCapability) => {
                  const raw = c.mimeType.replace('video/', '');
                  const base = codecDisplayName[raw] ?? raw;
                  const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                  return `${base}${profile}`;
                };
                const isSupported = (c: CodecCapability) =>
                  routerSupported.has(c.mimeType.toLowerCase());

                // HW column: codecs with GPU acceleration
                // SW column: ALL codecs (every codec has a software encoder fallback)
                const hwCodecs = codecCapabilities
                  .filter((c) => c.powerEfficient)
                  .sort(sortByPriority);
                const swCodecs = [...codecCapabilities].sort(sortByPriority);

                // Which column is active
                const hwHasSupported = hwCodecs.some((c) => isSupported(c));
                const preferredMime = preferredVideoCodec
                  ? codecKeyMime(preferredVideoCodec)
                  : null;
                const hwActive = preferredMime
                  ? // User picked a specific codec → active column is whichever contains its mimeType
                    hardwareAcceleration &&
                    hwCodecs.some(
                      (c) =>
                        c.mimeType.toLowerCase() === preferredMime.toLowerCase() && isSupported(c)
                    )
                  : hardwareAcceleration && hwHasSupported;

                // Determine preferred codec key for green highlight
                const activeColumnCodecs = hwActive ? hwCodecs : swCodecs;
                const preferredKey =
                  preferredVideoCodec &&
                  routerSupported.has(codecKeyMime(preferredVideoCodec).toLowerCase())
                    ? preferredVideoCodec
                    : (() => {
                        const first = activeColumnCodecs.find((c) => isSupported(c));
                        return first ? codecKey(first) : null;
                      })();

                // Active codecs currently in use (from voice producers — now profile-aware keys)
                const inUseKeys = new Set<string>(
                  [activeCameraCodec, activeScreenCodec]
                    .filter(Boolean)
                    .map((k) => (k as string).toLowerCase())
                );

                const renderCodecItem = (
                  c: CodecCapability,
                  columnKey: string,
                  isActiveColumn: boolean
                ) => {
                  const supported = isSupported(c);
                  const cKey = codecKey(c);
                  const isPreferred = isActiveColumn && supported && cKey === preferredKey;
                  const isInUse =
                    supported &&
                    (inUseKeys.has(cKey.toLowerCase()) || inUseKeys.has(c.mimeType.toLowerCase()));
                  const tooltip = !supported
                    ? 'Not supported'
                    : isPreferred && isInUse
                      ? 'Preferred · In Use'
                      : isInUse
                        ? 'In Use'
                        : isPreferred
                          ? 'Preferred'
                          : 'Available';
                  return (
                    <div
                      key={`${columnKey}-${cKey}`}
                      className={`settings-codec-item${isPreferred ? ' preferred' : ''}${isInUse ? ' in-use' : ''}${!supported ? ' unsupported' : ''}`}
                      data-tooltip={tooltip}
                    >
                      <span className={`settings-codec-name${!supported ? ' strikethrough' : ''}`}>
                        {displayName(c)}
                      </span>
                    </div>
                  );
                };

                return (
                  <>
                    <div className="settings-codec-grid">
                      <div className={`settings-codec-column${hwActive ? ' active' : ''}`}>
                        <span
                          className={`settings-codec-column-header${hwActive ? ' active' : ''}`}
                          {...(hwActive ? { 'data-tooltip': 'Preferred' } : {})}
                        >
                          Hardware
                        </span>
                        <div className="settings-codec-column-items">
                          {hwCodecs.map((c) => renderCodecItem(c, 'hw', hwActive))}
                          {hwCodecs.length === 0 && (
                            <span className="settings-codec-empty">None detected</span>
                          )}
                        </div>
                      </div>
                      <div className={`settings-codec-column${!hwActive ? ' active' : ''}`}>
                        <span
                          className={`settings-codec-column-header${!hwActive ? ' active' : ''}`}
                          {...(!hwActive ? { 'data-tooltip': 'Preferred' } : {})}
                        >
                          Software
                        </span>
                        <div className="settings-codec-column-items">
                          {swCodecs.map((c) => renderCodecItem(c, 'sw', !hwActive))}
                          {swCodecs.length === 0 && (
                            <span className="settings-codec-empty">None detected</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {hardwareAcceleration && !hwHasSupported && (
                      <div className="settings-hw-fallback-notice">
                        Hardware acceleration is enabled, but none of your GPU's codecs are
                        currently supported. Concord Voice has automatically failed over to software
                        encoding.
                      </div>
                    )}
                  </>
                );
              })()}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Enable HDR Encoding</span>
                <span className="settings-row-hint">
                  {!systemHdr
                    ? 'No HDR display detected. Connect an HDR-capable display to enable.'
                    : hdrEncoding
                      ? 'Enabled. VP9 HDR (10-bit) will be prioritized when available.'
                      : 'Disabled. HDR codec profiles are available but not preferred.'}
                </span>
              </div>
              <ToggleSwitch
                checked={hdrEncoding}
                onChange={(v) => setDraftVideoSetting('hdrEncoding', v)}
                disabled={!systemHdr}
              />
            </div>

            {(() => {
              const routerSupported = new Set([
                'video/vp8',
                'video/vp9',
                'video/h264',
                'video/av1',
              ]);
              const codecPriority: Record<string, number> = {
                AV1: 0,
                H265: 1,
                HEVC: 1,
                VP9: 2,
                H264: 3,
                VP8: 4,
              };
              const sortByPriority = (a: CodecCapability, b: CodecCapability) =>
                (codecPriority[a.mimeType.replace('video/', '')] ?? 99) -
                (codecPriority[b.mimeType.replace('video/', '')] ?? 99);
              const supported = codecCapabilities.filter((c) =>
                routerSupported.has(c.mimeType.toLowerCase())
              );
              const sdrCodecs = supported.filter((c) => !c.isHdr).sort(sortByPriority);
              const hdrCodecs = supported.filter((c) => c.isHdr).sort(sortByPriority);

              // Resolve effective codec key for info badge
              const firstSupported = sdrCodecs[0] || supported[0];
              const effectiveKey =
                preferredVideoCodec || (firstSupported ? codecKey(firstSupported) : null);
              const info = effectiveKey ? getCodecInfo(effectiveKey) : null;

              return (
                <>
                  <div className="settings-row">
                    <div className="settings-row-info">
                      <span className="settings-row-label">Video Codec</span>
                      <span className="settings-row-hint">
                        {preferredVideoCodec
                          ? `Preferred codec for camera and screen share encoding. Currently ${getCodecInfo(preferredVideoCodec).name}. Concord falls back automatically if a peer cannot decode it.`
                          : 'Preferred codec for camera and screen share encoding. Currently Auto \u2014 Concord selects the best available based on hardware and peer support.'}
                      </span>
                    </div>
                    <CustomSelect
                      className="settings-select"
                      options={[
                        { value: '', label: 'Auto' },
                        ...sdrCodecs.map((c) => {
                          const key = codecKey(c);
                          const name = c.mimeType.replace('video/', '');
                          const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                          return { value: key, label: `${name}${profile}` };
                        }),
                        ...hdrCodecs.map((c) => {
                          const key = codecKey(c);
                          const name = c.mimeType.replace('video/', '');
                          const profile = c.profileLabel ? ` (${c.profileLabel})` : '';
                          return {
                            value: hdrEncoding ? key : `__disabled_${key}`,
                            label: `${name}${profile}`,
                            group: hdrEncoding ? 'HDR' : 'Requires HDR',
                          };
                        }),
                      ]}
                      value={preferredVideoCodec ?? ''}
                      onChange={(v) =>
                        setDraftVideoSetting(
                          'preferredVideoCodec',
                          v.startsWith('__disabled_') ? (preferredVideoCodec ?? '') : v || null
                        )
                      }
                    />
                  </div>

                  {info && (
                    <span className="settings-codec-info-badge">
                      {info.name} — {info.quality} quality · {info.efficiency} efficiency (
                      {info.compressionRatio}){info.hdr ? ' · HDR' : ''}
                      {info.notes ? ` · ${info.notes}` : ''}
                    </span>
                  )}

                  {preferredVideoCodec && (
                    <div className="settings-codec-preference-notice">
                      Your client will prefer this codec, but will fall back to the next best option
                      if another participant can't decode it. Active codecs are shown above with a{' '}
                      <span
                        className="settings-codec-item in-use"
                        style={{
                          display: 'inline-flex',
                          padding: '1px 6px',
                          margin: '0 3px',
                          fontSize: 'inherit',
                          verticalAlign: 'baseline',
                        }}
                      >
                        highlight
                      </span>
                      .
                    </div>
                  )}
                </>
              );
            })()}

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Hardware Acceleration</span>
                <span className="settings-row-hint">
                  {hardwareAcceleration
                    ? 'Enabled. Your GPU handles video encoding and decoding. Concord Voice falls back to software encoding for unsupported codecs.'
                    : 'Disabled. All video encoding and decoding runs on your CPU. Avoids GPU-specific limitations but increases CPU usage. Requires restart.'}
                </span>
              </div>
              <ToggleSwitch
                checked={hardwareAcceleration}
                onChange={(enabled) => setDraftVideoSetting('hardwareAcceleration', enabled)}
              />
            </div>

            <h3 className="settings-subsection-title">Bandwidth</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Automatic Bitrate</span>
                <span className="settings-row-hint">
                  {screenShareBitrate === 0
                    ? 'Enabled. Concord Voice adjusts bitrate based on your resolution, frame rate, and codec.'
                    : `Disabled. Using a fixed ${(screenShareBitrate / 1_000_000).toFixed(1)} Mbps cap. Recommended ~${(clampedRecommended / 1_000_000).toFixed(1)} Mbps for current settings.`}
                </span>
                {screenShareBitrate === 0 && (
                  <span className="settings-estimated-bitrate">
                    Estimated Bitrate: ~{(clampedRecommended / 1_000_000).toFixed(1)} Mbps
                  </span>
                )}
              </div>
              <ToggleSwitch
                checked={screenShareBitrate === 0}
                onChange={(v) =>
                  setDraftVideoSetting('screenShareBitrate', v ? 0 : clampedRecommended)
                }
              />
            </div>
            {screenShareBitrate !== 0 && (
              <div className="settings-volume-row">
                <div className="settings-row-info">
                  <span className="settings-volume-label">Cap</span>
                  <span className="settings-row-hint">
                    Sets the maximum bitrate cap for screen sharing. Left (1.5 Mbps) for simple
                    content. Right (30 Mbps) for high-motion content.
                  </span>
                </div>
                <div className="settings-slider-wrapper">
                  <span className="settings-slider-value">
                    {(screenShareBitrate / 1_000_000).toFixed(1)} Mbps
                  </span>
                  <input
                    type="range"
                    className="settings-volume-slider"
                    min={1.5}
                    max={30}
                    step={0.5}
                    value={screenShareBitrate / 1_000_000}
                    onChange={(e) =>
                      setDraftVideoSetting(
                        'screenShareBitrate',
                        Math.round(Number(e.target.value) * 1_000_000)
                      )
                    }
                  />
                </div>
              </div>
            )}

            <h3 className="settings-subsection-title">Transport</h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Camera</span>
                <span className="settings-row-hint">
                  {
                    'Marks camera traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {cameraPriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : cameraPriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : cameraPriority === 'medium'
                        ? 'Currently Default (AF43) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: 'off', label: 'Off (No Tagging)' },
                  { value: 'low', label: 'Low (DF)' },
                  { value: 'medium', label: 'Default (AF43)' },
                  { value: 'high', label: 'High (EF)' },
                ]}
                value={cameraPriority}
                onChange={(v) => setDraftVideoSetting('cameraPriority', v as VideoPriority)}
              />
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Quality of Service for Screen Share</span>
                <span className="settings-row-hint">
                  {
                    'Marks screen share traffic with DSCP tags so your network can prioritize it. Not all networks honor DSCP tags; some may ignore or strip them, so this setting may have no effect depending on you or your ISP\u2019s network configurations. '
                  }
                  {screenSharePriority === 'off'
                    ? 'Currently off \u2014 no tagging applied.'
                    : screenSharePriority === 'low'
                      ? 'Currently Low (DF) \u2014 minimal differentiation. (RFC 2474)'
                      : screenSharePriority === 'medium'
                        ? 'Currently Default (AF42) \u2014 recommended for most networks. (RFC 2597)'
                        : 'Currently High (EF) \u2014 highest priority. (RFC 5127)'}
                </span>
              </div>
              <CustomSelect
                className="settings-select"
                options={[
                  { value: 'off', label: 'Off (No Tagging)' },
                  { value: 'low', label: 'Low (DF)' },
                  { value: 'medium', label: 'Default (AF42)' },
                  { value: 'high', label: 'High (EF)' },
                ]}
                value={screenSharePriority}
                onChange={(v) => setDraftVideoSetting('screenSharePriority', v as VideoPriority)}
              />
            </div>

            {/* Video Quality Layers (SVC) removed from UI — E2EE forces
                single-layer encoding (#291). The scalabilityMode store value
                is preserved and still applied to non-E2EE channels using
                whatever value was last persisted (default 'auto' → L3T3). */}
          </>
        )}
      </CollapsibleSection>
    </>
  );
};

export default VoiceAudioSection;
