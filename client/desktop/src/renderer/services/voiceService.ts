/**
 * VoiceService — mediasoup-client wrapper for voice, video, and screen sharing.
 *
 * Manages the Socket.IO signaling connection to the media plane and the
 * mediasoup Device (send/recv transports, producers, consumers).
 *
 * Join flow:
 *   1. POST /channels/{id}/voice/join → media_server_url, ICE servers, is_encrypted
 *   2. Connect Socket.IO to media plane with JWT auth
 *   3. Emit join-room → receive router RTP caps + existing producers
 *   4. device.load(routerRtpCapabilities)
 *   5. Create send + recv transports
 *   6. Produce audio (mic)
 *   7. Consume all existing producers
 *   8. Listen for new-producer events to auto-consume joiners
 */

import { Device, types as mediasoupTypes } from 'mediasoup-client';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../stores/authStore';
import { useUserStore } from '../stores/userStore';
import {
  useVoiceStore,
  AUDIO_QUALITY_TIERS,
  type AudioQualityTier,
  type VoiceParticipant,
} from '../stores/voiceStore';
import { useAudioSettingsStore, type AudioPriority } from '../stores/audioSettingsStore';
import {
  useVideoSettingsStore,
  VIDEO_QUALITY_PRESETS,
  type VideoPriority,
  type ScreenShareOptions,
} from '../stores/videoSettingsStore';
import { apiFetch } from './apiClient';
import { MediaEncryption, deriveFrameKey, ratchetKey } from './mediaEncryption';
import { e2eeService } from './e2eeService';
import {
  useOsPermissionStore,
  ensureOsPermission as ensureOsPermissionShared,
} from '../stores/osPermissionStore';
import type {
  E2EEWorkerMessage,
  E2EEMainMessage,
  E2EETransformOptions,
} from '../workers/e2eeProtocol';

// Toggle for verbose E2EE/SDP diagnostics — set to true when debugging
// frame drops, BUNDLE collisions, or key rotation issues. When false,
// only errors, warnings, and key lifecycle events are logged.
const E2EE_VERBOSE = false;

// Detect which Insertable Streams API is available at module load.
//
// Priority: createEncodedStreams (legacy) > RTCRtpScriptTransform (modern).
//
// Reason: encodedInsertableStreams + RTCRtpScriptTransform CONFLICT in Chromium 135 —
// the internal pipeline created by encodedInsertableStreams blocks the decoder output
// even when RTCRtpScriptTransform processes frames in the Worker, producing silence.
// RTCRtpScriptTransform WITHOUT encodedInsertableStreams receives no frames at all.
// createEncodedStreams + encodedInsertableStreams is the proven path (#295).
//
interface RtpSenderWithEncodedStreams {
  createEncodedStreams?: () => { readable: ReadableStream; writable: WritableStream };
}

/** SFU-layer-aware consumer — mediasoup-client exposes currentLayers/setPreferredLayers
 *  on the server but not in the public client type definitions. */
interface ConsumerWithLayers {
  currentLayers?: { spatialLayer: number; temporalLayer: number };
  setPreferredLayers(layers: { spatialLayer: number; temporalLayer: number }): void;
}
const HAS_ENCODED_STREAMS =
  typeof RTCRtpSender !== 'undefined' &&
  typeof (RTCRtpSender.prototype as RtpSenderWithEncodedStreams).createEncodedStreams ===
    'function';
const USE_SCRIPT_TRANSFORM = !HAS_ENCODED_STREAMS && typeof RTCRtpScriptTransform !== 'undefined';

if (E2EE_VERBOSE) {
  console.debug('E2EE API detection:', {
    hasEncodedStreams: HAS_ENCODED_STREAMS,
    hasScriptTransform: typeof RTCRtpScriptTransform !== 'undefined',
    selectedPath: (() => {
      if (HAS_ENCODED_STREAMS) return 'createEncodedStreams (legacy)';
      if (USE_SCRIPT_TRANSFORM) return 'RTCRtpScriptTransform (Worker)';
      return 'NONE — E2EE unavailable';
    })(),
  });
}

// ---------------------------------------------------------------------------
// Helpers to reduce cognitive complexity (extracted from class methods)
// ---------------------------------------------------------------------------

/** Resolve effective Opus codec settings from advanced settings + tier config. */
function resolveOpusSettings(
  adv: ReturnType<typeof useAudioSettingsStore.getState>,
  tierConfig: (typeof AUDIO_QUALITY_TIERS)[AudioQualityTier]
) {
  const effectiveFec = adv.advancedMode ? adv.inlineFec : tierConfig.opusFec;

  const effectiveDtx = adv.advancedMode
    ? adv.silenceDetection || tierConfig.opusDtx
    : tierConfig.opusDtx;

  const effectiveStereo =
    adv.advancedMode && adv.stereoOverride !== null ? adv.stereoOverride : tierConfig.opusStereo;

  let effectiveFrameSize: number;
  if (adv.adaptivePtime || !adv.advancedMode || adv.frameSize === 0) {
    effectiveFrameSize = tierConfig.preferredFrameSize;
  } else {
    effectiveFrameSize = adv.frameSize;
  }

  return { effectiveFec, effectiveDtx, effectiveStereo, effectiveFrameSize };
}

type RtpPriority = 'low' | 'medium' | 'high' | 'very-low';

/** Build DSCP priority params for RTP encoding (empty object when 'off'). */
function buildPriorityParams(
  priority: 'off' | RtpPriority
): Partial<{ priority: RtpPriority; networkPriority: RtpPriority }> {
  if (priority === 'off') return {};
  return { priority, networkPriority: priority };
}

// ---------------------------------------------------------------------------
// Types matching server signaling protocol
// ---------------------------------------------------------------------------

interface JoinResponse {
  allowed: boolean;
  media_server_url: string;
  ice_servers: Array<{ urls: string; username?: string; credential?: string }>;
  channel: {
    id: string;
    name: string;
    server_id: string;
    is_encrypted: boolean;
    audio_quality_tier?: string | null;
  };
}

interface RoomJoinedResponse {
  rtpCapabilities: mediasoupTypes.RtpCapabilities;
  existingProducers: Array<{
    producerId: string;
    userId: string;
    kind: string;
    source: string;
  }>;
  participants: Array<{
    userId: string;
    username: string;
    displayName?: string;
    avatarUrl?: string;
  }>;
  isEncrypted: boolean;
  channelName: string;
  e2eeEpoch?: number;
}

interface TransportOptions {
  id: string;
  iceParameters: mediasoupTypes.IceParameters;
  iceCandidates: mediasoupTypes.IceCandidate[];
  dtlsParameters: mediasoupTypes.DtlsParameters;
}

interface ConsumeResponse {
  id: string;
  producerId: string;
  kind: mediasoupTypes.MediaKind;
  rtpParameters: mediasoupTypes.RtpParameters;
  producerUserId: string;
  source: string;
}

// ---------------------------------------------------------------------------
// VoiceService singleton
// ---------------------------------------------------------------------------

class VoiceService {
  private socket: Socket | null = null;
  private device: Device | null = null;
  private sendTransport: mediasoupTypes.Transport | null = null;
  private recvTransport: mediasoupTypes.Transport | null = null;
  // Split recv transports for E2EE channels — avoids BUNDLE codec collision (#291).
  // Audio and video get separate recv PeerConnections so payload types can't collide.
  // Send transport stays single (server allows only 1, and send path has no demux).
  private recvTransportAudio: mediasoupTypes.Transport | null = null;
  private recvTransportVideo: mediasoupTypes.Transport | null = null;

  // Local producers: source → Producer
  private readonly producers: Map<string, mediasoupTypes.Producer> = new Map();
  // Remote consumers: consumerId → Consumer
  private readonly consumers: Map<string, mediasoupTypes.Consumer> = new Map();
  // Consumer metadata for ownership transfer (parallel to consumers Map)
  private readonly consumerMeta: Map<
    string,
    { source: string; producerUserId: string; producerId: string }
  > = new Map();
  // Local media streams
  private localMicStream: MediaStream | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;

  // Pending screen-audio producers from remote users (userId → producerId)
  // Consumed when the local user tunes into the corresponding screen share
  private readonly pendingScreenAudioProducers: Map<string, string> = new Map();

  // E2EE
  private mediaEncryption: MediaEncryption | null = null;
  private isEncrypted = false;
  // RTCRtpScriptTransform Worker (Chromium 129+) — owns frame crypto in a dedicated thread
  private e2eeWorker: Worker | null = null;
  // Debounced rotation state (extracted from MediaEncryption for Worker path)
  private rotationTimer: ReturnType<typeof setTimeout> | null = null;
  private rotationPending = false;
  private rotationDeadline = 0;
  private static readonly ROTATION_DEBOUNCE_MS = 2000;
  private static readonly ROTATION_MAX_CAP_MS = 5000;

  // Consume queues — serialized per-transport to prevent concurrent SDP
  // negotiations that cause "Duplicate a=mid value" errors.
  // E2EE uses per-transport queues; non-E2EE uses consumeQueue only.
  private consumeQueue: Promise<void> = Promise.resolve();
  private consumeQueueAudio: Promise<void> = Promise.resolve();
  private consumeQueueVideo: Promise<void> = Promise.resolve();

  // Client-side voice activity detection (Web Audio API)
  private vadAudioContext: AudioContext | null = null;
  private vadAnalyser: AnalyserNode | null = null;
  private vadSource: MediaStreamAudioSourceNode | null = null;
  private vadTimer: ReturnType<typeof setInterval> | null = null;
  private vadSpeaking = false;

  // Noise gate (Web Audio API)
  private noiseGateCtx: AudioContext | null = null;
  private noiseGateTimer: ReturnType<typeof setInterval> | null = null;

  // Input volume (Web Audio API GainNode)
  private inputVolumeCtx: AudioContext | null = null;
  private inputVolumeGain: GainNode | null = null;
  private inputVolumeUnsub: (() => void) | null = null;

  // Live settings subscriptions (apply changes during active calls)
  private liveAudioUnsub: (() => void) | null = null;
  private liveVideoUnsub: (() => void) | null = null;

  // Packet loss monitor
  private packetLossTimer: ReturnType<typeof setInterval> | null = null;
  private lastPacketsLost = 0;
  private lastPacketsSent = 0;

  // Solo bandwidth saving
  private soloNotificationTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Client-side Voice Activity Detection (VAD) ──────────────────

  /**
   * Start local VAD using Web Audio AnalyserNode on the mic stream.
   * Updates the local user's isSpeaking state in the store at ~20 Hz.
   * This provides instant visual feedback without server roundtrip latency.
   */
  private startLocalVAD(micStream: MediaStream): void {
    this.stopLocalVAD();

    try {
      this.vadAudioContext = new AudioContext();
      this.vadSource = this.vadAudioContext.createMediaStreamSource(micStream);
      this.vadAnalyser = this.vadAudioContext.createAnalyser();
      this.vadAnalyser.fftSize = 256;
      this.vadAnalyser.smoothingTimeConstant = 0.3;
      this.vadSource.connect(this.vadAnalyser);

      const bufferLength = this.vadAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const SPEAKING_THRESHOLD = 8; // byte average (0-255 range) — lower = more sensitive
      const SILENCE_DELAY = 200; // ms to hold speaking state after drop
      let silenceStart = 0;

      this.vadTimer = setInterval(() => {
        if (!this.vadAnalyser) return;

        this.vadAnalyser.getByteFrequencyData(dataArray);
        // Average volume across frequency bins
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const average = sum / bufferLength;

        const now = Date.now();
        const isSpeakingNow = average > SPEAKING_THRESHOLD;

        if (isSpeakingNow) {
          silenceStart = 0;
          if (!this.vadSpeaking) {
            this.vadSpeaking = true;
            this.updateLocalSpeaking(true);
          }
        } else if (this.vadSpeaking) {
          // Debounce: hold speaking state briefly to avoid flickering
          if (silenceStart === 0) {
            silenceStart = now;
          } else if (now - silenceStart > SILENCE_DELAY) {
            this.vadSpeaking = false;
            this.updateLocalSpeaking(false);
          }
        }
      }, 50); // 20 Hz poll
    } catch (err) {
      console.warn('Failed to start local VAD:', err);
    }
  }

  /** Stop local VAD and clean up audio nodes */
  private stopLocalVAD(): void {
    if (this.vadTimer) {
      clearInterval(this.vadTimer);
      this.vadTimer = null;
    }
    if (this.vadSpeaking) {
      this.vadSpeaking = false;
      this.updateLocalSpeaking(false);
    }
    this.vadSource?.disconnect();
    this.vadSource = null;
    this.vadAnalyser = null;
    if (this.vadAudioContext?.state !== 'closed') {
      this.vadAudioContext?.close().catch(() => {});
    }
    this.vadAudioContext = null;
  }

  /** Update the local user's isSpeaking state in the store */
  private updateLocalSpeaking(speaking: boolean): void {
    const store = useVoiceStore.getState();
    const localUserId = useUserStore.getState().user?.id;
    if (!localUserId) return;

    store.updateParticipant(localUserId, { isSpeaking: speaking });
    if (speaking) {
      store.setActiveSpeaker(localUserId);
    } else if (store.activeSpeakerId === localUserId) {
      store.setActiveSpeaker(null);
    }
  }

  // ─── Noise Gate ──────────────────────────────────────────────────

  /**
   * Apply a noise gate to the mic stream using Web Audio API.
   * Returns a new MediaStreamTrack from a MediaStreamDestination node.
   * Audio below the threshold (dBFS) is silenced via a GainNode.
   */
  private applyNoiseGate(micStream: MediaStream, thresholdDbfs: number): MediaStreamTrack {
    this.stopNoiseGate();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.noiseGateCtx = ctx;

    const source = ctx.createMediaStreamSource(micStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();

    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(destination);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    // Convert dBFS threshold to a 0–255 byte level (AnalyserNode getByteTimeDomainData range)
    // dBFS -80 → ~0, -20 → ~200. Formula: 128 * 10^(dBFS/20) maps to amplitude offset from 128.
    const thresholdAmplitude = 128 * Math.pow(10, thresholdDbfs / 20);

    this.noiseGateTimer = setInterval(() => {
      analyser.getByteTimeDomainData(dataArray);
      // Peak amplitude offset from silence (128)
      let peak = 0;
      for (const sample of dataArray) {
        const offset = Math.abs(sample - 128);
        if (offset > peak) peak = offset;
      }

      const isOpen = peak >= thresholdAmplitude;
      const target = isOpen ? 1 : 0;
      gain.gain.setTargetAtTime(target, ctx.currentTime, 0.015);
    }, 20); // 50 Hz poll for responsive gating

    return destination.stream.getAudioTracks()[0];
  }

  /** Stop noise gate and clean up audio nodes */
  private stopNoiseGate(): void {
    if (this.noiseGateTimer) {
      clearInterval(this.noiseGateTimer);
      this.noiseGateTimer = null;
    }
    if (this.noiseGateCtx?.state !== 'closed') {
      this.noiseGateCtx?.close().catch(() => {});
    }
    this.noiseGateCtx = null;
  }

  // ─── Input Volume ───────────────────────────────────────────────

  /**
   * Apply input volume via a GainNode. Returns a processed MediaStreamTrack.
   * Stores references so the gain can be updated in real-time from the settings store.
   */
  private applyInputVolume(track: MediaStreamTrack, volumePercent: number): MediaStreamTrack {
    this.stopInputVolume();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.inputVolumeCtx = ctx;

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const gain = ctx.createGain();
    const destination = ctx.createMediaStreamDestination();

    gain.gain.value = volumePercent / 100;
    source.connect(gain);
    gain.connect(destination);

    this.inputVolumeGain = gain;

    // Subscribe to real-time volume changes from the settings store
    this.inputVolumeUnsub = useAudioSettingsStore.subscribe((state, prevState) => {
      if (
        state.inputVolume !== prevState.inputVolume &&
        this.inputVolumeGain &&
        this.inputVolumeCtx &&
        this.inputVolumeCtx.state !== 'closed'
      ) {
        this.inputVolumeGain.gain.setTargetAtTime(
          state.inputVolume / 100,
          this.inputVolumeCtx.currentTime,
          0.01
        );
      }
    });

    return destination.stream.getAudioTracks()[0];
  }

  /** Stop input volume processing and clean up */
  private stopInputVolume(): void {
    if (this.inputVolumeUnsub) {
      this.inputVolumeUnsub();
      this.inputVolumeUnsub = null;
    }
    if (this.inputVolumeCtx?.state !== 'closed') {
      this.inputVolumeCtx?.close().catch(() => {});
    }
    this.inputVolumeCtx = null;
    this.inputVolumeGain = null;
  }

  // ─── Packet loss monitor ─────────────────────────────────────────

  /**
   * Poll outbound-rtp + remote-inbound-rtp stats every 5s to measure packet loss.
   * When FEC headroom is enabled, reactively inflates maxBitrate so Opus has room
   * for in-band FEC without sacrificing primary audio quality.
   * Loss > threshold → packetLossWarning in store.
   */
  private startPacketLossMonitor(): void {
    this.stopPacketLossMonitor();
    this.lastPacketsLost = 0;
    this.lastPacketsSent = 0;

    this.packetLossTimer = setInterval(async () => {
      const micProducer = this.producers.get('mic');
      if (!micProducer) return;

      try {
        const stats = await micProducer.getStats();

        let totalPacketsSent = 0;
        let totalPacketsLost = 0;

        for (const report of stats.values()) {
          if (report.type === 'outbound-rtp') {
            totalPacketsSent = (report as { packetsSent?: number }).packetsSent ?? 0;
          }
          if (report.type === 'remote-inbound-rtp') {
            totalPacketsLost = (report as { packetsLost?: number }).packetsLost ?? 0;
          }
        }

        // Calculate delta loss since last poll
        const deltaSent = totalPacketsSent - this.lastPacketsSent;
        const deltaLost = totalPacketsLost - this.lastPacketsLost;
        this.lastPacketsSent = totalPacketsSent;
        this.lastPacketsLost = totalPacketsLost;

        if (deltaSent <= 0) return;

        const lossPercent = Math.max(0, (deltaLost / deltaSent) * 100);
        const adv = useAudioSettingsStore.getState();
        useVoiceStore.getState().setPacketLoss(lossPercent, adv.packetLossWarningThreshold);

        // FEC headroom — reactively inflate bitrate when loss detected
        if (micProducer.rtpSender) {
          const tier = useVoiceStore.getState().effectiveQualityTier;
          const tierConfig = AUDIO_QUALITY_TIERS[tier];
          const effectiveHeadroom = adv.advancedMode
            ? adv.inlineFec && adv.fecHeadroom
            : tierConfig.opusFec; // basic mode: headroom on when FEC is on

          const params = micProducer.rtpSender.getParameters();
          if (params.encodings?.[0]) {
            if (effectiveHeadroom && lossPercent > 0) {
              // Tier-derived multiplier: low bitrate tiers need proportionally more
              // headroom since FEC eats a larger share of a small budget
              let K: number;
              if (tierConfig.maxBitrate < 64_000) K = 4;
              else if (tierConfig.maxBitrate < 128_000) K = 2.5;
              else K = 1.5;
              const headroomPercent = Math.min(50, lossPercent * K);
              params.encodings[0].maxBitrate = Math.round(
                tierConfig.maxBitrate * (1 + headroomPercent / 100)
              );
            } else {
              params.encodings[0].maxBitrate = tierConfig.maxBitrate;
            }
            micProducer.rtpSender.setParameters(params).catch(() => {});
          }
        }
      } catch {
        // Stats unavailable — ignore
      }
    }, 5000);
  }

  private stopPacketLossMonitor(): void {
    if (this.packetLossTimer) {
      clearInterval(this.packetLossTimer);
      this.packetLossTimer = null;
    }
    useVoiceStore.getState().setPacketLoss(0);
  }

  // ─── Codec preference helpers ──────────────────────────────────────

  /**
   * Find a video codec from the loaded device's send capabilities.
   * Accepts a codec key like "video/H264:640034" or plain mimeType "video/VP9".
   * When a profile is specified, matches exactly. When mimeType-only, returns
   * the last match (highest quality — router lists profiles in ascending order).
   */
  private findSendCodec(key: string): mediasoupTypes.RtpCodecCapability | undefined {
    if (!this.device?.rtpCapabilities?.codecs) return undefined;
    const [mime, profileId] = key.split(':');
    const mimeLower = mime.toLowerCase();

    const matches = this.device.rtpCapabilities.codecs.filter(
      (c) => c.mimeType.toLowerCase() === mimeLower && c.kind === 'video'
    );
    if (matches.length === 0) return undefined;

    if (profileId) {
      return matches.find((c) => {
        const params = c.parameters ?? {};
        if (mimeLower === 'video/h264') {
          return String(params['profile-level-id'] ?? '')
            .toLowerCase()
            .startsWith(profileId.toLowerCase().substring(0, 4));
        }
        if (mimeLower === 'video/vp9') {
          return String(params['profile-id'] ?? '0') === profileId;
        }
        return true;
      });
    }

    // No profile specified — return best (last = highest quality in router order)
    return matches[matches.length - 1];
  }

  /**
   * Check if a codec is compatible with the current room codec floor.
   * Extracts mimeType from codec key — floor operates at mimeType level.
   */
  private isInCodecFloor(key: string): boolean {
    const floor = useVoiceStore.getState().codecFloor;
    if (!floor) return true;
    const mime = key.split(':')[0].toLowerCase();
    return floor.includes(mime);
  }

  /**
   * Check if a codec has hardware-accelerated encoding available.
   * Extracts mimeType from codec key — HW detection is mimeType-level.
   */
  private isHwAccelerated(key: string): boolean {
    const caps = useVideoSettingsStore.getState().codecCapabilities;
    const mime = key.split(':')[0].toLowerCase();
    return caps.some((c) => c.mimeType.toLowerCase() === mime && c.powerEfficient);
  }

  /**
   * Calculate recommended bitrate from resolution × FPS × codec-aware bits-per-pixel.
   * Efficient codecs (AV1, HEVC, VP9) use 0.04 bpp; H.264/VP8 use 0.07 bpp.
   * Clamped to [1.5 Mbps, 30 Mbps] and rounded to nearest 100 kbps.
   */
  private calculateRecommendedBitrate(
    width: number,
    height: number,
    fps: number,
    codecMime?: string | null
  ): number {
    const isEfficient = codecMime ? /AV1|H265|HEVC|VP9/i.test(codecMime) : false;
    const bpp = isEfficient ? 0.04 : 0.07;
    const bps = width * height * fps * bpp;
    return Math.max(1_500_000, Math.min(30_000_000, Math.round(bps / 100_000) * 100_000));
  }

  /**
   * Calculate recommended screen share bitrate using current screen settings.
   * Resolves 'source' resolution to actual capture dimensions when available.
   * If codecMime is not provided, infers from active screen codec or preferred codec.
   */
  private calculateScreenBitrate(codecMime?: string | null): number {
    if (!codecMime) {
      const activeCodec = useVoiceStore.getState().activeScreenCodec;
      const preferredCodec = useVideoSettingsStore.getState().preferredVideoCodec;
      codecMime = activeCodec ?? preferredCodec ?? null;
    }
    const vs = useVideoSettingsStore.getState();
    const resMap: Record<string, { w: number; h: number }> = {
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
      source: { w: 3840, h: 2160 },
    };
    const parsed = vs.screenResolution.match(/^(\d+)x(\d+)$/);
    let res = parsed
      ? { w: Number(parsed[1]), h: Number(parsed[2]) }
      : resMap[vs.screenResolution] || resMap['1080p'];

    // For 'source' resolution, use actual capture dimensions if available
    if (vs.screenResolution === 'source') {
      const screenTrack = this.localScreenStream?.getVideoTracks()[0];
      if (screenTrack?.readyState === 'live') {
        const settings = screenTrack.getSettings();
        if (settings.width && settings.height) {
          res = { w: settings.width, h: settings.height };
        }
      }
    }

    const effectiveFps = vs.screenFrameRate === 0 ? 60 : vs.screenFrameRate;
    return this.calculateRecommendedBitrate(res.w, res.h, effectiveFps, codecMime);
  }

  /**
   * Compute videoGoogleStartBitrate (kbps) from target bitrate (bps).
   * Starting at ~50% of target reduces encoder ramp-up delay vs. the low defaults.
   * Clamped to [100, 10000] kbps.
   */
  private computeStartBitrate(targetBps: number): number {
    return Math.max(100, Math.min(10_000, Math.round((targetBps * 0.5) / 1000)));
  }

  /**
   * Pick the best codec for camera video. Single-layer encoding only (E2EE
   * requires byte-for-byte SFU forwarding — SVC/simulcast break AES-GCM #291).
   *
   * Cascade: user pref → AV1 → HEVC → H264 High → VP9:2 (HDR) → H264 → VP9 → VP8
   * Two-pass: HW-accelerated first, then SW fallback.
   */
  private pickCameraCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
  } {
    const vs = useVideoSettingsStore.getState();
    const preset = VIDEO_QUALITY_PRESETS[vs.cameraPreset] || VIDEO_QUALITY_PRESETS['720p30'];
    const prio = vs.cameraPriority;

    // Base encoding params: priority for DSCP marking (skip when 'off')
    const base: Partial<mediasoupTypes.RtpEncodingParameters> =
      prio === 'off'
        ? {}
        : {
            priority: prio,
            networkPriority: prio,
          };

    const makeResult = (codec?: mediasoupTypes.RtpCodecCapability) => ({
      codec,
      encodings: [{ ...base, maxBitrate: preset.maxBitrate }],
    });

    // Check user's preferred codec first — only if floor-compatible
    const preferred = vs.preferredVideoCodec;
    if (preferred && this.isInCodecFloor(preferred)) {
      const codec = this.findSendCodec(preferred);
      if (codec) return makeResult(codec);
    }

    // Priority cascade: AV1 → HEVC → H264 High → VP9:2 (HDR) → H264 → VP9 → VP8
    // When HW accel is on, first pass tries only HW-accelerated codecs.
    // If no HW codec is floor-compatible, second pass tries all codecs (SW fallback).
    const hwAccel = vs.hardwareAcceleration;
    const hdrEncoding = vs.hdrEncoding;
    const codecCascade: { mime: string; alt?: string }[] = [
      { mime: 'video/AV1' },
      { mime: 'video/H265', alt: 'video/HEVC' },
      { mime: 'video/H264:6400' },
      ...(hdrEncoding ? [{ mime: 'video/VP9:2' }] : []),
      { mime: 'video/H264' },
      { mime: 'video/VP9' },
    ];

    // Pass 1: HW-only (when HW accel enabled)
    if (hwAccel) {
      for (const { mime, alt } of codecCascade) {
        if (
          (this.isHwAccelerated(mime) || (alt && this.isHwAccelerated(alt))) &&
          (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt)))
        ) {
          const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
          if (codec) return makeResult(codec);
        }
      }
    }

    // Pass 2: All codecs (SW fallback, or when HW accel disabled)
    for (const { mime, alt } of codecCascade) {
      if (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt))) {
        const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
        if (codec) return makeResult(codec);
      }
    }

    // VP8 last resort — universal support, bypasses floor
    return makeResult(this.findSendCodec('video/VP8'));
  }

  /**
   * Pick the best codec for screen sharing. Single-layer encoding only (E2EE
   * requires byte-for-byte SFU forwarding — SVC/simulcast break AES-GCM #291).
   *
   * Cascade: user pref → AV1 → HEVC → H264 High → VP9:2 (HDR) → H264 → VP9 → VP8
   * Two-pass: HW-accelerated first, then SW fallback.
   */
  private pickScreenCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
    effectiveBitrate: number;
  } {
    const vs = useVideoSettingsStore.getState();
    const preferred = vs.preferredVideoCodec;
    const prio = vs.screenSharePriority;
    const userBitrate = vs.screenShareBitrate; // 0 = auto

    // Base encoding params: priority for DSCP marking (skip when 'off')
    const base: Partial<mediasoupTypes.RtpEncodingParameters> =
      prio === 'off'
        ? {}
        : {
            priority: prio,
            networkPriority: prio,
          };

    // Dynamic auto-bitrate: calculate based on resolution, FPS, and codec
    const autoBitrate = this.calculateScreenBitrate();
    const bitrate = userBitrate || autoBitrate;

    const makeResult = (codec?: mediasoupTypes.RtpCodecCapability) => ({
      codec,
      encodings: [{ ...base, maxBitrate: bitrate }],
      effectiveBitrate: bitrate,
    });

    // User preference — only if floor-compatible
    if (preferred && this.isInCodecFloor(preferred)) {
      const codec = this.findSendCodec(preferred);
      if (codec) return makeResult(codec);
    }

    // Priority cascade: AV1 → HEVC → H264 High → VP9:2 (HDR) → H264 → VP9 → VP8
    // When HW accel is on, first pass tries only HW-accelerated codecs.
    // If no HW codec is floor-compatible, second pass tries all codecs (SW fallback).
    const hwAccel = vs.hardwareAcceleration;
    const hdrEncoding = vs.hdrEncoding;
    const codecCascade: { mime: string; alt?: string }[] = [
      { mime: 'video/AV1' },
      { mime: 'video/H265', alt: 'video/HEVC' },
      { mime: 'video/H264:6400' },
      ...(hdrEncoding ? [{ mime: 'video/VP9:2' }] : []),
      { mime: 'video/H264' },
      { mime: 'video/VP9' },
    ];

    // Pass 1: HW-only (when HW accel enabled)
    if (hwAccel) {
      for (const { mime, alt } of codecCascade) {
        if (
          (this.isHwAccelerated(mime) || (alt && this.isHwAccelerated(alt))) &&
          (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt)))
        ) {
          const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
          if (codec) return makeResult(codec);
        }
      }
    }

    // Pass 2: All codecs (SW fallback, or when HW accel disabled)
    for (const { mime, alt } of codecCascade) {
      if (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt))) {
        const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
        if (codec) return makeResult(codec);
      }
    }

    // VP8 last resort — universal support, bypasses floor
    return makeResult(this.findSendCodec('video/VP8'));
  }

  /**
   * Apply degradation preference to a video producer's RTP sender.
   * Controls whether the encoder drops framerate or resolution under congestion.
   */
  private applyDegradationPreference(producer: mediasoupTypes.Producer): void {
    const pref = useVideoSettingsStore.getState().degradationPreference;
    if (pref === 'balanced') return; // Browser default — no override needed

    try {
      const sender = producer.rtpSender;
      if (!sender) return;
      const params = sender.getParameters();
      params.degradationPreference = pref;
      sender.setParameters(params).catch((err: unknown) => {
        console.warn('Failed to set degradationPreference:', err);
      });
    } catch {
      // Ignore — rtpSender may not be available in all environments
    }
  }

  // ─── Live Settings Application ─────────────────────────────────────
  // Subscribe to audio/video settings stores and apply changes mid-call.

  private setupLiveSubscriptions(): void {
    this.teardownLiveSubscriptions();

    // Audio settings subscription
    this.liveAudioUnsub = useAudioSettingsStore.subscribe((state, prev) => {
      if (!this.producers.get('mic') || !this.sendTransport) return;

      // --- Instant: setParameters (DSCP priority) ---
      if (state.audioPriority !== prev.audioPriority) {
        this.liveUpdateAudioPriority(state.audioPriority);
      }

      // --- replaceTrack: re-acquire mic with new constraints ---
      const constraintChanged =
        state.noiseCancellation !== prev.noiseCancellation ||
        state.echoCancellation !== prev.echoCancellation ||
        state.autoGainControl !== prev.autoGainControl ||
        state.noiseGateMode !== prev.noiseGateMode ||
        state.noiseGateLevel !== prev.noiseGateLevel;

      if (constraintChanged) {
        this.liveReplaceAudioTrack();
        return; // replaceTrack handles everything
      }

      // --- Re-produce: codec options changed ---
      const codecOptionChanged =
        state.musicMode !== prev.musicMode ||
        state.frameSize !== prev.frameSize ||
        state.silenceDetection !== prev.silenceDetection ||
        state.inlineFec !== prev.inlineFec ||
        state.fecHeadroom !== prev.fecHeadroom ||
        state.opusNack !== prev.opusNack ||
        state.adaptivePtime !== prev.adaptivePtime;

      if (codecOptionChanged) {
        this.liveReproduceAudio();
      }
    });

    // Video settings subscription
    this.liveVideoUnsub = useVideoSettingsStore.subscribe((state, prev) => {
      // --- Camera: instant parameter updates ---
      const cameraProducer = this.producers.get('camera');
      if (cameraProducer) {
        if (state.degradationPreference !== prev.degradationPreference) {
          this.applyDegradationPreference(cameraProducer);
        }
        if (state.cameraPriority !== prev.cameraPriority) {
          this.liveUpdateVideoPriority(cameraProducer, state.cameraPriority);
        }
        // Camera preset change → replaceTrack with new constraints
        if (state.cameraPreset !== prev.cameraPreset) {
          this.liveReplaceCameraTrack();
        }
        // Codec change → re-produce camera (and screen if active)
        if (state.preferredVideoCodec !== prev.preferredVideoCodec) {
          this.liveReproduceCamera();
          if (this.producers.get('screen')) {
            this.fastReproduceScreen();
          }
        }
      }

      // --- Screen share: instant parameter updates ---
      const screenProducer = this.producers.get('screen');
      if (screenProducer) {
        if (state.screenSharePriority !== prev.screenSharePriority) {
          this.liveUpdateVideoPriority(screenProducer, state.screenSharePriority);
        }
        if (state.screenShareBitrate !== prev.screenShareBitrate) {
          this.liveUpdateScreenBitrate(screenProducer, state.screenShareBitrate);
        }
        // Note: screen resolution/FPS/contentType changes cannot use replaceTrack
        // because getDisplayMedia requires a user gesture. Apply on next session.
      }
    });
  }

  private teardownLiveSubscriptions(): void {
    this.liveAudioUnsub?.();
    this.liveAudioUnsub = null;
    this.liveVideoUnsub?.();
    this.liveVideoUnsub = null;
  }

  // --- Instant update helpers (setParameters, no track change) ---

  private liveUpdateAudioPriority(priority: AudioPriority): void {
    const producer = this.producers.get('mic');
    if (!producer?.rtpSender) return;
    try {
      const params = producer.rtpSender.getParameters();
      if (params.encodings?.[0]) {
        if (priority === 'off') {
          // Reset to default (low = DF / best effort)
          params.encodings[0].priority = 'low';
          (params.encodings[0] as Record<string, unknown>).networkPriority = 'low';
        } else {
          params.encodings[0].priority = priority;
          (params.encodings[0] as Record<string, unknown>).networkPriority = priority;
        }
        producer.rtpSender.setParameters(params).catch(() => {});
      }
    } catch {
      /* rtpSender may not be available */
    }
  }

  private liveUpdateVideoPriority(
    producer: mediasoupTypes.Producer,
    priority: VideoPriority
  ): void {
    if (!producer?.rtpSender) return;
    try {
      const params = producer.rtpSender.getParameters();
      const effectivePriority = priority === 'off' ? 'low' : priority;
      for (const enc of params.encodings) {
        enc.priority = effectivePriority;
        (enc as Record<string, unknown>).networkPriority = effectivePriority;
      }
      producer.rtpSender.setParameters(params).catch(() => {});
    } catch {
      /* rtpSender may not be available */
    }
  }

  private liveUpdateScreenBitrate(producer: mediasoupTypes.Producer, bitrate: number): void {
    if (!producer?.rtpSender) return;
    try {
      const params = producer.rtpSender.getParameters();
      if (!params.encodings?.[0]) return;
      // When bitrate is 0 (auto), recalculate from current screen settings
      const effectiveBitrate = bitrate > 0 ? bitrate : this.calculateScreenBitrate();
      params.encodings[0].maxBitrate = effectiveBitrate;
      producer.rtpSender.setParameters(params).catch(() => {});
    } catch {
      /* rtpSender may not be available */
    }
  }

  // --- replaceTrack: re-acquire media with new constraints, swap on existing producer ---

  private async liveReplaceAudioTrack(): Promise<void> {
    const producer = this.producers.get('mic');
    if (!producer) return;

    const adv = useAudioSettingsStore.getState();
    const useProcessing = !adv.musicMode;

    // Briefly mute to hide transition
    producer.pause();

    try {
      // Stop old processing chain
      this.stopNoiseGate();
      this.stopInputVolume();
      if (this.localMicStream) {
        for (const t of this.localMicStream.getTracks()) t.stop();
      }

      // Re-acquire mic with new constraints
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: useProcessing && adv.echoCancellation,
          noiseSuppression: useProcessing && adv.noiseCancellation,
          autoGainControl: useProcessing && adv.autoGainControl,
          sampleRate: 48000,
          channelCount: 2,
        },
      });
      this.localMicStream = stream;
      let track = stream.getAudioTracks()[0];

      // Re-apply processing chain
      if (adv.noiseGateMode === 'manual') {
        track = this.applyNoiseGate(stream, adv.noiseGateLevel);
      }
      track = this.applyInputVolume(track, adv.inputVolume);

      // Swap track on existing producer (no SDP renegotiation)
      await producer.replaceTrack({ track });
    } catch (err) {
      console.warn('liveReplaceAudioTrack failed:', err);
    }

    producer.resume();
  }

  private async liveReplaceCameraTrack(): Promise<void> {
    const producer = this.producers.get('camera');
    if (!producer) return;

    const vs = useVideoSettingsStore.getState();
    const preset = VIDEO_QUALITY_PRESETS[vs.cameraPreset] || VIDEO_QUALITY_PRESETS['system'];
    const isSystemDefault = vs.cameraPreset === 'system' || preset.width === 0;

    producer.pause();

    try {
      if (this.localCameraStream) {
        for (const t of this.localCameraStream.getTracks()) t.stop();
      }

      // Try preferred constraints, fall back to bare minimum on OverconstrainedError
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(isSystemDefault
              ? {}
              : {
                  width: { ideal: preset.width },
                  height: { ideal: preset.height },
                  frameRate: { ideal: preset.frameRate },
                }),
          },
        });
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === 'OverconstrainedError' &&
          !isSystemDefault
        ) {
          console.warn('Camera overconstrained during track replace, falling back:', err);
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        } else {
          throw err;
        }
      }
      this.localCameraStream = stream;
      const track = stream.getVideoTracks()[0];

      await producer.replaceTrack({ track });

      // Update participant store with new stream
      const localUserId = useUserStore.getState().user?.id;
      if (localUserId) {
        useVoiceStore.getState().updateParticipant(localUserId, { videoStream: stream });
      }
    } catch (err) {
      console.warn('liveReplaceCameraTrack failed:', err);
    }

    producer.resume();
  }

  // --- Re-produce: close + re-create producer with new codec options ---

  private async liveReproduceAudio(): Promise<void> {
    if (!this.producers.get('mic') || !this.sendTransport) return;
    await this.closeProducer('mic');
    await this.produceAudio();
  }

  private async liveReproduceCamera(): Promise<void> {
    if (!this.producers.get('camera') || !this.sendTransport) return;
    if (this.localCameraStream) {
      for (const t of this.localCameraStream.getTracks()) t.stop();
      this.localCameraStream = null;
    }
    await this.closeProducer('camera');
    await this.produceVideo();
  }

  // --- Codec floor: fast re-produce (reuses existing track, no media re-acquisition) ---

  /**
   * Get the codec key of the codec currently used by a producer.
   * Returns profile-aware keys like "video/h264:640034" or "video/vp9:2".
   */
  private getProducerCodecMimeType(source: string): string | null {
    const producer = this.producers.get(source);
    if (!producer?.rtpSender) return null;
    const params = producer.rtpSender.getParameters();
    const codec = params.codecs?.[0];
    if (!codec) return null;
    const mime = codec.mimeType.toLowerCase();
    if (codec.sdpFmtpLine) {
      if (mime === 'video/h264') {
        const m = /profile-level-id=([0-9a-f]{6})/i.exec(codec.sdpFmtpLine);
        if (m) return `${mime}:${m[1].toLowerCase()}`;
      }
      if (mime === 'video/vp9') {
        const m = codec.sdpFmtpLine.match(/profile-id=(\d+)/);
        if (m && m[1] !== '0') return `${mime}:${m[1]}`;
      }
    }
    return mime;
  }

  /**
   * Fast re-produce camera: close producer and re-produce with best floor-compatible
   * codec, reusing the existing video track for a subsecond switch.
   */
  private async fastReproduceCamera(): Promise<void> {
    const producer = this.producers.get('camera');
    if (!producer || !this.sendTransport || !this.localCameraStream) return;

    const track = this.localCameraStream.getVideoTracks()[0];
    if (track?.readyState !== 'live') {
      await this.liveReproduceCamera();
      return;
    }

    // Close old producer (does NOT stop the track)
    producer.close();
    // Drain transport queue so stopSending SDP renegotiation finishes before produce()
    await this.drainSendTransportQueue();
    this.producers.delete('camera');
    this.socket?.emit('close-producer', { producerId: producer.id });

    // Pick new codec respecting the floor
    const { codec, encodings } = this.pickCameraCodec();
    const cameraBitrate = encodings[0]?.maxBitrate ?? 2_500_000;

    const newProducer = await this.sendTransport.produce({
      track,
      encodings,
      codec,
      codecOptions: { videoGoogleStartBitrate: this.computeStartBitrate(cameraBitrate) },
      appData: { source: 'camera' },
    });

    this.applyDegradationPreference(newProducer);
    this.producers.set('camera', newProducer);

    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(newProducer);
    }

    newProducer.on('transportclose', () => {
      this.producers.delete('camera');
      if (this.localCameraStream) {
        for (const t of this.localCameraStream.getTracks()) t.stop();
        this.localCameraStream = null;
      }
      const s = useVoiceStore.getState();
      s.setVideoOn(false);
      const uid = useUserStore.getState().user?.id;
      if (uid) s.updateParticipant(uid, { videoStream: undefined, isVideoOn: false });
    });

    useVoiceStore.getState().setActiveCameraCodec(codec?.mimeType?.toLowerCase() ?? null);
    const hwTag = codec?.mimeType && this.isHwAccelerated(codec.mimeType) ? 'HW' : 'SW';
    console.debug(
      `[codec-floor] Fast re-produced camera with ${codec?.mimeType ?? 'default'} (${hwTag})`
    );
  }

  /**
   * Fast re-produce screen: close producer and re-produce with best floor-compatible
   * codec, reusing the existing screen track.
   */
  private async fastReproduceScreen(): Promise<void> {
    const oldProducer = this.producers.get('screen');
    if (!oldProducer || !this.sendTransport || !this.localScreenStream) return;

    const track = this.localScreenStream.getVideoTracks()[0];
    if (track?.readyState !== 'live') {
      console.warn('[codec-floor] Screen track is dead, cannot re-acquire without user gesture');
      return;
    }

    const oldProducerId = oldProducer.id;

    // Close old producer (does NOT stop the track)
    oldProducer.close();
    // Drain transport queue so stopSending SDP renegotiation finishes before produce()
    await this.drainSendTransportQueue();
    this.producers.delete('screen');
    this.socket?.emit('close-producer', { producerId: oldProducerId });

    // Pick new codec respecting the floor
    const { codec, encodings, effectiveBitrate: screenBitrate } = this.pickScreenCodec();

    const newProducer = await this.sendTransport.produce({
      track,
      encodings,
      codec,
      codecOptions: { videoGoogleStartBitrate: this.computeStartBitrate(screenBitrate) },
      appData: { source: 'screen' },
    });

    this.applyDegradationPreference(newProducer);
    this.producers.set('screen', newProducer);

    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(newProducer);
    }

    // Re-wire track ended handler
    track.onended = () => {
      this.closeProducer('screen');
    };

    // Update tuned-in mapping since producer ID changed
    const store = useVoiceStore.getState();
    if (store.tunedInScreenShares[oldProducerId]) {
      store.tuneOut(oldProducerId);
      store.tuneIn(newProducer.id, 'local-screen');
    }
    if (store.dominantScreenShareId === oldProducerId) {
      store.setDominantScreenShare(newProducer.id);
    }

    newProducer.on('transportclose', () => {
      this.producers.delete('screen');
      if (this.localScreenStream) {
        for (const t of this.localScreenStream.getTracks()) t.stop();
        this.localScreenStream = null;
      }
      const s = useVoiceStore.getState();
      s.setScreenSharing(false);
      const uid = useUserStore.getState().user?.id;
      if (uid) s.updateParticipant(uid, { screenStream: undefined, isScreenSharing: false });
    });

    // Re-produce screen audio if it was active
    const oldAudioProducer = this.producers.get('screen-audio');
    if (oldAudioProducer && this.localScreenStream) {
      const audioTrack = this.localScreenStream.getAudioTracks()[0];
      if (audioTrack?.readyState === 'live') {
        const oldAudioId = oldAudioProducer.id;
        oldAudioProducer.close();
        await this.drainSendTransportQueue();
        this.producers.delete('screen-audio');
        this.socket?.emit('close-producer', { producerId: oldAudioId });

        try {
          const newAudioProducer = await this.sendTransport.produce({
            track: audioTrack,
            codecOptions: { opusStereo: true, opusDtx: false },
            appData: { source: 'screen-audio' },
          });
          this.producers.set('screen-audio', newAudioProducer);
          if (this.isEncrypted && this.mediaEncryption) {
            this.applyEncryptTransform(newAudioProducer);
          }
          newAudioProducer.on('transportclose', () => {
            this.producers.delete('screen-audio');
          });
        } catch (err) {
          console.warn('Failed to re-produce screen audio:', err);
        }
      }
    }

    useVoiceStore.getState().setActiveScreenCodec(codec?.mimeType?.toLowerCase() ?? null);
    const hwTag = codec?.mimeType && this.isHwAccelerated(codec.mimeType) ? 'HW' : 'SW';
    console.debug(
      `[codec-floor] Fast re-produced screen with ${codec?.mimeType ?? 'default'} (${hwTag})`
    );
  }

  /**
   * Handle a codec floor update. Check each active video producer and
   * re-produce if a better floor-compatible codec is available or the
   * current codec is no longer in the floor.
   */
  private async handleCodecFloorChange(
    _previousFloor: string[] | null,
    _newFloor: string[] | null
  ): Promise<void> {
    for (const source of ['camera', 'screen'] as const) {
      const producer = this.producers.get(source);
      if (!producer) continue;

      const currentMime = this.getProducerCodecMimeType(source);
      if (!currentMime) continue;

      // Determine what codec the selection logic would pick now
      const bestPick = source === 'camera' ? this.pickCameraCodec() : this.pickScreenCodec();
      const bestMime = bestPick.codec?.mimeType?.toLowerCase() ?? null;

      if (bestMime && bestMime !== currentMime) {
        // Never switch to a HW codec if hardware acceleration is disabled
        const hwAccel = useVideoSettingsStore.getState().hardwareAcceleration;
        if (!hwAccel && this.isHwAccelerated(bestMime) && !this.isHwAccelerated(currentMime)) {
          console.debug(
            `[codec-floor] Skipping ${source} switch to ${bestMime} (HW) — hardware accel is off`
          );
          continue;
        }
        const hwLabel = this.isHwAccelerated(bestMime) ? 'HW' : 'SW';
        console.debug(
          `[codec-floor] Re-producing ${source}: ${currentMime} → ${bestMime} (${hwLabel})`
        );
        if (source === 'camera') {
          await this.fastReproduceCamera();
        } else {
          await this.fastReproduceScreen();
        }
      }
    }
  }

  // Decoder budget profiling
  private decoderProfilingTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Join / Leave ──────────────────────────────────────────────────

  /** Set up E2EE encryption, decrypt keys, and epoch catch-up for an encrypted channel */
  private async setupE2EEForChannel(
    channelId: string,
    roomJoined: RoomJoinedResponse
  ): Promise<void> {
    await this.initEncryption(channelId);
    for (const p of roomJoined.participants) {
      await this.addDecryptKeyForUser(channelId, p.userId);
    }
    if (roomJoined.e2eeEpoch && this.mediaEncryption) {
      if (this.e2eeWorker) {
        this.e2eeWorker.postMessage({
          type: 'catchUpToEpoch',
          targetEpoch: roomJoined.e2eeEpoch,
        } satisfies E2EEWorkerMessage);
      }
      await this.mediaEncryption.catchUpToEpoch(roomJoined.e2eeEpoch);
    }
  }

  /** Build VoiceParticipant list from room-join response, including video/screen state */
  private buildParticipantList(roomJoined: RoomJoinedResponse): VoiceParticipant[] {
    const producersByUser = new Map<string, { isVideoOn: boolean; isScreenSharing: boolean }>();
    for (const ep of roomJoined.existingProducers) {
      const entry = producersByUser.get(ep.userId) || { isVideoOn: false, isScreenSharing: false };
      if (ep.source === 'camera') entry.isVideoOn = true;
      if (ep.source === 'screen') entry.isScreenSharing = true;
      producersByUser.set(ep.userId, entry);
    }
    return roomJoined.participants.map((p) => {
      const producerState = producersByUser.get(p.userId);
      return {
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        isMuted: false,
        isDeafened: false,
        isVideoOn: producerState?.isVideoOn ?? false,
        isScreenSharing: producerState?.isScreenSharing ?? false,
        isSpeaking: false,
      };
    });
  }

  /** Consume or register existing producers from the room-join response */
  private async consumeExistingProducers(
    existingProducers: RoomJoinedResponse['existingProducers']
  ): Promise<void> {
    const store = useVoiceStore.getState();
    for (const producer of existingProducers) {
      if (producer.source === 'screen') {
        const participant = store.participants[producer.userId];
        store.addAvailableScreenShare({
          producerId: producer.producerId,
          userId: producer.userId,
          username: participant?.username || 'Unknown',
          displayName: participant?.displayName,
        });
      } else if (producer.source === 'screen-audio') {
        this.pendingScreenAudioProducers.set(producer.userId, producer.producerId);
      } else {
        await this.consumeProducer(
          producer.producerId,
          producer.userId,
          producer.kind as mediasoupTypes.MediaKind
        );
      }
    }
  }

  /** Authorize and join a voice channel */
  async joinChannel(channelId: string, joinType: 'channel' | 'dm' = 'channel'): Promise<void> {
    const store = useVoiceStore.getState();
    if (store.activeChannelId) {
      await this.leaveChannel();
    }

    store.setConnectionState('connecting');

    try {
      // Step 1: Authorize via control plane (uses apiFetch for automatic token refresh)
      const endpoint =
        joinType === 'dm'
          ? `/api/v1/dm/conversations/${channelId}/voice/join`
          : `/api/v1/channels/${channelId}/voice/join`;
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Voice join failed: ${res.status}`);
      }

      const joinData: JoinResponse = await res.json();
      if (!joinData.allowed) throw new Error('Not allowed to join this channel');

      const { media_server_url, channel } = joinData;

      store.setActiveChannel(channel.id, channel.name, channel.server_id);
      store.setEncrypted(channel.is_encrypted);

      // Track DM call state
      if (joinType === 'dm') {
        store.setDMCall(true, channelId);
      }

      // Resolve effective quality tier: channel override takes priority over personal setting
      const channelTier = channel.audio_quality_tier;
      const validTiers = ['minimum', 'low', 'moderate', 'standard', 'high', 'hifi', 'studio'];
      if (channelTier && validTiers.includes(channelTier)) {
        store.setEffectiveQualityTier(channelTier as AudioQualityTier);
      } else {
        store.setEffectiveQualityTier(store.qualityTier);
      }

      // Pre-acquire mic stream in parallel with socket connection + room join.
      // getUserMedia can take 500ms+ (device enumeration, permission prompt).
      // Starting it now overlaps that latency with the network handshake below.
      const micPromise = this.acquireMicStream();

      // Step 2: Connect Socket.IO to media plane
      // Get the (possibly refreshed) access token for Socket.IO auth
      const token = useAuthStore.getState().accessToken;
      if (!token) throw new Error('Not authenticated');

      const user = useUserStore.getState().user;
      this.socket = io(media_server_url, {
        auth: {
          token,
          username: user?.username || 'unknown',
          displayName: user?.display_name || undefined,
          avatarUrl: user?.avatar_url || undefined,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
      });

      await this.waitForConnect();
      this.setupSocketListeners();

      // Step 3: Join room on media plane
      const roomJoined = await this.emitAsync<RoomJoinedResponse>('join-room', {
        roomId: channel.id,
        rtpCapabilities: undefined, // Will be set after device.load
      });

      // Step 4: Load device with router capabilities
      this.device = new Device();
      await this.device.load({ routerRtpCapabilities: roomJoined.rtpCapabilities });

      // Send actual RTP capabilities to server (join-room sent undefined)
      if (!this.socket) throw new Error('Socket disconnected before RTP capabilities update');
      this.socket.emit('update-rtp-capabilities', {
        rtpCapabilities: this.device.rtpCapabilities,
      });

      // Step 5: Create transports in parallel (no dependency between send/recv)
      this.isEncrypted = channel.is_encrypted;
      await Promise.all([this.createSendTransport(), this.createRecvTransports()]);

      // Step 6: Initialize E2EE if channel is encrypted
      if (this.isEncrypted) {
        await this.setupE2EEForChannel(channel.id, roomJoined);
      }

      // Step 7: Set participants before consuming producers
      store.setParticipants(this.buildParticipantList(roomJoined));

      // Step 8: Produce audio (using pre-acquired mic stream)
      const preAcquiredStream = await micPromise;
      await this.produceAudio(undefined, preAcquiredStream);
      this.setupLiveSubscriptions();

      // Step 9: Consume existing producers
      await this.consumeExistingProducers(roomJoined.existingProducers);

      store.setConnectionState('connected');

      // Step 10: Start decoder budget profiling (IGNIS insight)
      // Profiles decode performance and adjusts SVC layers to avoid queue buildup
      this.startDecoderBudgetProfiling();
    } catch (err) {
      console.error('Failed to join voice channel:', err);
      store.setConnectionState('error');
      await this.cleanup();
      throw err;
    }
  }

  /** Leave the current voice channel */
  async leaveChannel(): Promise<void> {
    const store = useVoiceStore.getState();
    const channelId = store.activeChannelId;
    const localUserId = useUserStore.getState().user?.id;

    if (this.socket?.connected) {
      this.socket.emit('leave-room');
    }
    await this.cleanup();

    // Remove local user from channel voice members immediately so the
    // channel sidebar updates without waiting for the server roundtrip.
    if (channelId && localUserId) {
      store.removeChannelVoiceMember(channelId, localUserId);
    }

    store.reset();
  }

  /**
   * Emergency cleanup: synchronously stop all local media tracks and tear
   * down transports without awaiting any server-side acknowledgment.
   * Used for forced logout, token revocation, connection loss, and app close
   * where we can't wait for network round-trips.
   * All operations are idempotent — safe to call multiple times.
   */
  emergencyCleanup(): void {
    this.cleanupMediaAndTransports();
    this.cleanupTimersAndE2EE();

    // Disconnect socket (fire-and-forget)
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;

    // Reset device and consume queues
    this.device = null;
    this.consumeQueue = Promise.resolve();
    this.consumeQueueAudio = Promise.resolve();
    this.consumeQueueVideo = Promise.resolve();

    // Reset store
    useVoiceStore.getState().clearAvailableScreenShares();
    useVoiceStore.getState().reset();
  }

  /** Stop local streams, close producers/consumers/transports. */
  private cleanupMediaAndTransports(): void {
    for (const stream of [this.localMicStream, this.localCameraStream, this.localScreenStream]) {
      if (stream) for (const t of stream.getTracks()) t.stop();
    }
    this.localMicStream = null;
    this.localCameraStream = null;
    this.localScreenStream = null;

    for (const [, producer] of this.producers) {
      try {
        producer.close();
      } catch {
        /* ignore */
      }
    }
    this.producers.clear();

    for (const [, consumer] of this.consumers) {
      try {
        consumer.close();
      } catch {
        /* ignore */
      }
    }
    this.consumers.clear();
    this.consumerMeta.clear();
    this.pendingScreenAudioProducers.clear();

    for (const t of [
      this.sendTransport,
      this.recvTransport,
      this.recvTransportAudio,
      this.recvTransportVideo,
    ]) {
      try {
        t?.close();
      } catch {
        /* ignore */
      }
    }
    this.sendTransport = null;
    this.recvTransport = null;
    this.recvTransportAudio = null;
    this.recvTransportVideo = null;
  }

  /** Stop timers, subscriptions, and E2EE state. */
  private cleanupTimersAndE2EE(): void {
    this.stopLocalVAD();
    this.stopPacketLossMonitor();
    this.teardownLiveSubscriptions();
    if (this.decoderProfilingTimer) {
      clearInterval(this.decoderProfilingTimer);
      this.decoderProfilingTimer = null;
    }
    this.terminateE2EEWorker();
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.rotationPending = false;
    this.rotationDeadline = 0;
    this.mediaEncryption?.destroy();
    this.mediaEncryption = null;
    this.isEncrypted = false;
  }

  // ─── Audio Producer ────────────────────────────────────────────────

  /**
   * Pre-acquire the mic stream so getUserMedia latency overlaps with
   * socket connection, room join, and transport creation.
   */
  private async acquireMicStream(): Promise<MediaStream | null> {
    try {
      // JIT permission check (#197): request mic access on macOS before getUserMedia
      await this.ensureOsPermission('microphone');

      const adv = useAudioSettingsStore.getState();
      const useProcessing = !adv.musicMode;
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: useProcessing && adv.echoCancellation,
          noiseSuppression: useProcessing && adv.noiseCancellation,
          autoGainControl: useProcessing && adv.autoGainControl,
          sampleRate: 48000,
          channelCount: 2,
        },
      });
    } catch (err) {
      console.warn('[VoiceService] Pre-acquire mic failed, will retry in produceAudio:', err);
      return null;
    }
  }

  async produceAudio(deviceId?: string, preAcquiredStream?: MediaStream | null): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    // Read advanced audio settings
    const adv = useAudioSettingsStore.getState();

    // Music mode disables all audio processing to preserve tonal fidelity
    const useProcessing = !adv.musicMode;

    // Use pre-acquired stream if provided (from parallel mic acquisition during join),
    // otherwise acquire fresh (device switch, live reproduce, etc.)
    if (preAcquiredStream && !deviceId) {
      this.localMicStream = preAcquiredStream;
    } else {
      // Stop any pre-acquired stream we're not using (device changed)
      if (preAcquiredStream) {
        for (const t of preAcquiredStream.getTracks()) t.stop();
      }

      // JIT permission check (#197): request mic access on macOS before getUserMedia
      await this.ensureOsPermission('microphone');

      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: useProcessing && adv.echoCancellation,
          noiseSuppression: useProcessing && adv.noiseCancellation,
          autoGainControl: useProcessing && adv.autoGainControl,
          sampleRate: 48000,
          channelCount: 2,
        },
      };

      this.localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    let track = this.localMicStream.getAudioTracks()[0];

    // Apply noise gate in manual mode
    if (adv.noiseGateMode === 'manual') {
      track = this.applyNoiseGate(this.localMicStream, adv.noiseGateLevel);
    }

    // Apply input volume control (GainNode)
    track = this.applyInputVolume(track, adv.inputVolume);

    const tier = useVoiceStore.getState().effectiveQualityTier;
    const tierConfig = AUDIO_QUALITY_TIERS[tier];
    const { effectiveFec, effectiveDtx, effectiveStereo, effectiveFrameSize } = resolveOpusSettings(
      adv,
      tierConfig
    );
    const audioPrioParams = buildPriorityParams(adv.audioPriority);

    const producer = await this.sendTransport.produce({
      track,
      encodings: [
        {
          maxBitrate: tierConfig.maxBitrate,
          adaptivePtime: adv.adaptivePtime || undefined,
          ...audioPrioParams,
        },
      ],
      codecOptions: {
        opusStereo: effectiveStereo,
        opusDtx: effectiveDtx,
        opusFec: effectiveFec,
        opusNack: adv.opusNack,
        opusMaxAverageBitrate: tierConfig.maxBitrate,
        opusMaxPlaybackRate: 48000,
        opusPtime: effectiveFrameSize,
      },
      appData: { source: 'mic' },
    });

    this.producers.set('mic', producer);

    // Start client-side VAD for instant speaking indicator
    this.startLocalVAD(this.localMicStream);

    // Start packet loss monitor for dynamic FEC
    this.startPacketLossMonitor();

    // Apply E2EE encrypt transform if encrypted
    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(producer);
    }

    producer.on('transportclose', () => {
      this.producers.delete('mic');
      this.stopLocalVAD();
      this.stopNoiseGate();
      this.stopInputVolume();
      if (this.localMicStream) {
        for (const t of this.localMicStream.getTracks()) t.stop();
        this.localMicStream = null;
      }
    });
  }

  /** Produce camera video — VP9 SVC (L3T3) preferred, H264 simulcast fallback */
  async produceVideo(deviceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    // Video slot enforcement
    const voiceState = useVoiceStore.getState();
    const videoOnCount = Object.values(voiceState.participants).filter((p) => p.isVideoOn).length;
    if (videoOnCount >= voiceState.maxVideoSlots) {
      voiceState.setVideoSlotError(
        `Maximum video streams reached (${voiceState.maxVideoSlots}). ` +
          'Wait for someone to turn off video or a screen share to end.'
      );
      return;
    }

    try {
      // JIT permission check (#197): request camera access on macOS before getUserMedia
      await this.ensureOsPermission('camera');

      // Read video settings for camera preset
      const videoSettings = useVideoSettingsStore.getState();
      const preset =
        VIDEO_QUALITY_PRESETS[videoSettings.cameraPreset] || VIDEO_QUALITY_PRESETS['system'];
      const isSystemDefault = videoSettings.cameraPreset === 'system' || preset.width === 0;

      // Try getUserMedia with progressive constraint relaxation on OverconstrainedError:
      // 1. Full constraints (deviceId exact + resolution/frameRate ideal)
      // 2. Drop resolution/frameRate, keep deviceId
      // 3. Drop deviceId, keep resolution/frameRate
      // 4. Bare minimum (no constraints at all)
      const fallbackChain: MediaStreamConstraints[] = [
        {
          video: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            ...(isSystemDefault
              ? {}
              : {
                  width: { ideal: preset.width },
                  height: { ideal: preset.height },
                  frameRate: { ideal: preset.frameRate },
                }),
          },
        },
        ...(deviceId && !isSystemDefault
          ? [
              {
                video: { deviceId: { exact: deviceId } },
              },
            ]
          : []),
        ...(isSystemDefault
          ? []
          : [
              {
                video: {
                  width: { ideal: preset.width },
                  height: { ideal: preset.height },
                  frameRate: { ideal: preset.frameRate },
                },
              },
            ]),
        { video: true },
      ];

      for (const constraints of fallbackChain) {
        try {
          this.localCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'OverconstrainedError' &&
            constraints !== fallbackChain.at(-1)
          ) {
            console.warn('Camera overconstrained, relaxing constraints:', err);
            continue;
          }
          throw err;
        }
      }

      if (!this.localCameraStream) {
        voiceState.setVideoSlotError(
          'Could not access camera. Check that your camera is connected and not in use by another application.'
        );
        return;
      }
      const track = this.localCameraStream.getVideoTracks()[0];

      const { codec, encodings } = this.pickCameraCodec();
      const cameraBitrate = encodings[0]?.maxBitrate ?? 2_500_000;

      const producer = await this.sendTransport.produce({
        track,
        encodings,
        codec,
        codecOptions: {
          videoGoogleStartBitrate: this.computeStartBitrate(cameraBitrate),
        },
        appData: { source: 'camera' },
      });

      // Apply degradation preference on the RTP sender
      this.applyDegradationPreference(producer);

      this.producers.set('camera', producer);

      // Track active codec for settings UI
      useVoiceStore.getState().setActiveCameraCodec(codec?.mimeType?.toLowerCase() ?? null);

      // Update store: both global flag and local participant's video stream
      const store = useVoiceStore.getState();
      store.setVideoOn(true);
      const localUserId = useUserStore.getState().user?.id;
      if (localUserId && this.localCameraStream) {
        store.updateParticipant(localUserId, {
          videoStream: this.localCameraStream,
          isVideoOn: true,
        });
      }

      if (this.isEncrypted && this.mediaEncryption) {
        this.applyEncryptTransform(producer);
      }

      producer.on('transportclose', () => {
        this.producers.delete('camera');
        if (this.localCameraStream) {
          for (const t of this.localCameraStream.getTracks()) t.stop();
          this.localCameraStream = null;
        }
        const s = useVoiceStore.getState();
        s.setVideoOn(false);
        const uid = useUserStore.getState().user?.id;
        if (uid) s.updateParticipant(uid, { videoStream: undefined, isVideoOn: false });
      });
    } catch (err) {
      console.error('Failed to start camera:', err);
      // Clean up any partial stream
      if (this.localCameraStream) {
        for (const t of this.localCameraStream.getTracks()) t.stop();
        this.localCameraStream = null;
      }
      let errMsg: string;
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        errMsg = 'Camera access denied. Check your browser or system permissions.';
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        errMsg = 'No camera found. Check that your camera is connected.';
      } else {
        errMsg = 'Could not start camera. Try a different camera or video preset in Settings.';
      }
      voiceState.setVideoSlotError(errMsg);
    }
  }

  /** Produce screen share — AV1 SVC preferred (best compression for static content), VP9 fallback */
  async produceScreen(sourceId?: string, options?: ScreenShareOptions): Promise<void> {
    if (!this.sendTransport || !this.device) {
      console.warn('produceScreen: no sendTransport or device — cannot share screen');
      return;
    }

    // JIT permission check (#197): on macOS, screen recording requires manual grant in System Settings
    const screenStatus = await useOsPermissionStore.getState().checkOne('screen');
    if (screenStatus === 'denied' || screenStatus === 'restricted') {
      const voiceState = useVoiceStore.getState();
      voiceState.setVideoSlotError(
        'Screen recording access denied. On macOS, enable Screen Recording in ' +
          'System Settings > Privacy & Security, then restart Concord.'
      );
      useOsPermissionStore.getState().openSettings('screen');
      return;
    }

    // Read screen share quality settings — prefer per-share options from picker, fall back to persisted store
    const screenSettings = useVideoSettingsStore.getState();
    const resolution = options?.resolution ?? screenSettings.screenResolution;
    const frameRate = options?.frameRate ?? screenSettings.screenFrameRate;
    const contentType = options?.contentType ?? screenSettings.screenContentType;

    const screenFps = frameRate === 0 ? 60 : frameRate; // 0 = Native, use 60 as capture max
    const resMap: Record<string, { w: number; h: number }> = {
      source: { w: 3840, h: 2160 },
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
    };
    // Parse custom WxH display resolutions
    const customParsed = resolution.match(/^(\d+)x(\d+)$/);
    const screenRes = customParsed
      ? { w: Number(customParsed[1]), h: Number(customParsed[2]) }
      : resMap[resolution] || resMap['source'];

    // Use Electron desktopCapturer if available
    let stream: MediaStream;
    if (globalThis.electron?.getDesktopSources) {
      // sourceId should come from ScreenSharePicker; fallback to first screen
      let chosenId = sourceId;
      if (!chosenId) {
        const sources = await globalThis.electron.getDesktopSources();
        if (sources.length === 0) throw new Error('No screen sources available');
        chosenId = sources.find((s) => s.id.startsWith('screen:'))?.id || sources[0].id;
      }
      console.debug('produceScreen: capturing desktop source', chosenId);

      // Try video+audio first (audio not available on macOS), fall back to video-only
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: chosenId,
            },
          } as unknown as MediaTrackConstraints,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: chosenId,
              maxWidth: screenRes.w,
              maxHeight: screenRes.h,
              maxFrameRate: screenFps,
            },
          } as unknown as MediaTrackConstraints,
        });
      } catch (audioErr) {
        // Audio capture failed (expected on macOS, may also be permission/device errors)
        console.debug(
          'produceScreen: audio capture unavailable, falling back to video-only',
          audioErr
        );
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: chosenId,
              maxWidth: screenRes.w,
              maxHeight: screenRes.h,
              maxFrameRate: screenFps,
            },
          } as unknown as MediaTrackConstraints,
        });
      }
    } else {
      console.debug('produceScreen: using getDisplayMedia fallback');
      // audio: true shows "Share audio" checkbox in browser picker.
      // If declined or unsupported, stream simply has no audio tracks.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: screenRes.w },
          height: { ideal: screenRes.h },
          frameRate: { ideal: screenFps },
        },
        audio: true,
      });
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      for (const t of stream.getTracks()) t.stop();
      throw new Error('Screen capture returned no video tracks');
    }

    const track = videoTracks[0];

    // Apply content hint for screen share optimization
    if (contentType === 'motion') {
      track.contentHint = 'motion';
    } else if (contentType === 'detail') {
      track.contentHint = 'detail';
    }
    // 'auto' → don't set contentHint, let the browser decide

    // Set localScreenStream early so calculateScreenBitrate() can read
    // actual capture dimensions via track.getSettings() for 'source' resolution
    this.localScreenStream = stream;

    // Wrap produce in try/catch so we can clean up the stream on failure
    try {
      const { codec, encodings, effectiveBitrate: screenBitrate } = this.pickScreenCodec();

      const producer = await this.sendTransport.produce({
        track,
        encodings,
        codec,
        codecOptions: {
          videoGoogleStartBitrate: this.computeStartBitrate(screenBitrate),
        },
        appData: { source: 'screen' },
      });

      // Apply degradation preference on the RTP sender
      this.applyDegradationPreference(producer);

      this.producers.set('screen', producer);

      // Track active codec for settings UI
      useVoiceStore.getState().setActiveScreenCodec(codec?.mimeType?.toLowerCase() ?? null);

      // Update store: both global flag and local participant's screen stream
      const store = useVoiceStore.getState();
      store.setScreenSharing(true);
      const localUserId = useUserStore.getState().user?.id;
      if (localUserId && this.localScreenStream) {
        store.updateParticipant(localUserId, {
          screenStream: this.localScreenStream,
          isScreenSharing: true,
        });
      }

      // Auto-stage: tune in to own screen share and set as dominant
      store.tuneIn(producer.id, 'local-screen');
      if (!store.dominantScreenShareId) {
        store.setDominantScreenShare(producer.id);
      }

      if (this.isEncrypted && this.mediaEncryption) {
        this.applyEncryptTransform(producer);
      }

      // Produce screen audio if available (piggybacked on same capture stream)
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0 && this.sendTransport) {
        try {
          const audioTrack = audioTracks[0];
          const audioProducer = await this.sendTransport.produce({
            track: audioTrack,
            codecOptions: {
              opusStereo: true,
              opusDtx: false,
            },
            appData: { source: 'screen-audio' },
          });

          this.producers.set('screen-audio', audioProducer);

          if (this.isEncrypted && this.mediaEncryption) {
            this.applyEncryptTransform(audioProducer);
          }

          audioProducer.on('transportclose', () => {
            this.producers.delete('screen-audio');
          });

          console.debug('produceScreen: screen audio producer created', audioProducer.id);
        } catch (err) {
          console.warn('Failed to produce screen audio:', err);
          // Non-fatal — screen share works without audio
        }
      }

      // Handle user stopping screen share via browser UI
      track.onended = () => {
        this.closeProducer('screen');
      };

      producer.on('transportclose', () => {
        this.producers.delete('screen');
        if (this.localScreenStream) {
          for (const t of this.localScreenStream.getTracks()) t.stop();
          this.localScreenStream = null;
        }
        const s = useVoiceStore.getState();
        s.setScreenSharing(false);
        const uid = useUserStore.getState().user?.id;
        if (uid) s.updateParticipant(uid, { screenStream: undefined, isScreenSharing: false });
      });
    } catch (err) {
      // Clean up stream and reference if produce failed
      for (const t of stream.getTracks()) t.stop();
      this.localScreenStream = null;
      throw err;
    }
  }

  // ─── Producer Controls ─────────────────────────────────────────────

  /** Toggle mute (pause/resume mic producer) */
  async toggleMute(): Promise<void> {
    const store = useVoiceStore.getState();
    const producer = this.producers.get('mic');
    if (!producer) return;

    if (store.isMuted) {
      await producer.resume();
      this.socket?.emit('resume-producer', { producerId: producer.id });
      store.setMuted(false);
      // Restart VAD when unmuting
      if (this.localMicStream) this.startLocalVAD(this.localMicStream);
    } else {
      await producer.pause();
      this.socket?.emit('pause-producer', { producerId: producer.id });
      store.setMuted(true);
      // Stop VAD when muted — user shouldn't show as speaking
      this.stopLocalVAD();
    }
  }

  /** Toggle deafen (mute all incoming audio) */
  toggleDeafen(): void {
    const store = useVoiceStore.getState();
    const newDeafened = !store.isDeafened;
    store.setDeafened(newDeafened);

    // Mute/unmute all audio consumers
    for (const [, consumer] of this.consumers) {
      if (consumer.kind === 'audio') {
        if (newDeafened) {
          consumer.pause();
        } else {
          consumer.resume();
        }
      }
    }

    // Also mute self when deafened
    if (newDeafened && !store.isMuted) {
      this.toggleMute();
    }
  }

  /** Toggle video (start/stop camera) */
  async toggleVideo(): Promise<void> {
    const store = useVoiceStore.getState();
    if (store.isVideoOn) {
      await this.closeProducer('camera');
    } else {
      await this.produceVideo(store.videoDeviceId || undefined);
    }
  }

  /** Toggle screen share. Pass sourceId and options from ScreenSharePicker for Electron. */
  async toggleScreenShare(sourceId?: string, options?: ScreenShareOptions): Promise<void> {
    const store = useVoiceStore.getState();
    console.debug('toggleScreenShare:', { isScreenSharing: store.isScreenSharing, sourceId });
    if (store.isScreenSharing) {
      await this.closeProducer('screen');
    } else {
      await this.produceScreen(sourceId, options);
    }
  }

  /** Pause a local producer by source name (e.g. 'screen', 'camera', 'mic') */
  pauseLocalProducer(source: string): void {
    const producer = this.producers.get(source);
    if (!producer || producer.paused) return;
    producer.pause();
    this.socket?.emit('pause-producer', { producerId: producer.id });
  }

  /** Resume a local producer by source name */
  resumeLocalProducer(source: string): void {
    const producer = this.producers.get(source);
    if (!producer?.paused) return;
    producer.resume();
    this.socket?.emit('resume-producer', { producerId: producer.id });
  }

  // ─── Solo Bandwidth Saving ──────────────────────────────────────────

  /**
   * Check participant count and enter/exit solo bandwidth saving mode.
   * When alone in a call, pauses all producers to save bandwidth.
   * Resumes automatically when someone joins.
   */
  private checkSoloBandwidthSaving(): void {
    const store = useVoiceStore.getState();
    const participantCount = Object.keys(store.participants).length;
    const wasSolo = store.isSoloBandwidthSaving;

    if (participantCount <= 1 && !wasSolo) {
      this.enterSoloBandwidthSaving();
    } else if (participantCount > 1 && wasSolo) {
      this.exitSoloBandwidthSaving();
    }
  }

  private enterSoloBandwidthSaving(): void {
    const store = useVoiceStore.getState();
    store.setSoloBandwidthSaving(true);

    // Pause all producers (stops sending data to server)
    // But do NOT stop local MediaStream tracks (keeps local preview/VAD)
    for (const [, producer] of this.producers) {
      if (!producer.paused) {
        producer.pause();
        this.socket?.emit('pause-producer', { producerId: producer.id });
      }
    }

    // Start 60-second timer for user notification
    this.soloNotificationTimer = setTimeout(() => {
      useVoiceStore.getState().setSoloBandwidthNotification(true);
    }, 60_000);
  }

  private exitSoloBandwidthSaving(): void {
    const store = useVoiceStore.getState();
    store.setSoloBandwidthSaving(false);
    store.setSoloBandwidthNotification(false);

    // Clear notification timer
    if (this.soloNotificationTimer) {
      clearTimeout(this.soloNotificationTimer);
      this.soloNotificationTimer = null;
    }

    // Resume all producers (start sending again)
    // Respect current mute state — don't resume mic if user is muted
    for (const [source, producer] of this.producers) {
      if (source === 'mic' && store.isMuted) continue; // stay paused if intentionally muted
      if (producer.paused) {
        producer.resume();
        this.socket?.emit('resume-producer', { producerId: producer.id });
      }
    }
  }

  /** Opt-in to consume a remote screen share ("Tune In" model) — up to 5 concurrent */
  async tuneInToScreenShare(producerId: string, userId: string): Promise<void> {
    const store = useVoiceStore.getState();

    // Enforce 5-stream limit
    if (Object.keys(store.tunedInScreenShares).length >= 5) {
      store.setVideoSlotError('Maximum 5 screen shares reached. Tune out of one first.');
      return;
    }

    // Ensure decrypt key is ready for E2EE screen share
    if (this.isEncrypted && this.mediaEncryption) {
      const channelId = store.activeChannelId;
      if (channelId) await this.addDecryptKeyForUser(channelId, userId);
    }

    // Remove from available list and consume the producer
    store.removeAvailableScreenShare(producerId);
    await this.consumeProducer(producerId, userId, 'video');

    // Find the consumer that was just created for this producer
    let consumerId = '';
    for (const [cid, consumer] of this.consumers) {
      if (consumer.producerId === producerId) {
        consumerId = cid;
        break;
      }
    }

    // Track in store
    store.tuneIn(producerId, consumerId);

    // Set as dominant if first tuned-in share
    if (!store.dominantScreenShareId) {
      store.setDominantScreenShare(producerId);
    }

    store.updateParticipant(userId, { isScreenSharing: true });

    // Consume paired screen audio if available (keep mapping for re-tune)
    const audioProducerId = this.pendingScreenAudioProducers.get(userId);
    if (audioProducerId) {
      await this.consumeProducer(audioProducerId, userId, 'audio');
    }
  }

  /** Opt-out of a tuned-in screen share */
  async tuneOutOfScreenShare(producerId: string): Promise<void> {
    const store = useVoiceStore.getState();
    const consumerId = store.tunedInScreenShares[producerId];

    // Identify the producing user from the video consumer's metadata
    const videoMeta = consumerId ? this.consumerMeta.get(consumerId) : undefined;
    const screenOwnerUserId = videoMeta?.producerUserId;

    // Close the screen video consumer
    if (consumerId) {
      const consumer = this.consumers.get(consumerId);
      if (consumer) {
        consumer.close();
        this.consumers.delete(consumerId);
        this.consumerMeta.delete(consumerId);
      }
    }

    // Close the paired screen-audio consumer for this specific user
    if (screenOwnerUserId) {
      for (const [cid, meta] of this.consumerMeta) {
        if (meta.source === 'screen-audio' && meta.producerUserId === screenOwnerUserId) {
          const consumer = this.consumers.get(cid);
          if (consumer) {
            consumer.close();
            this.consumers.delete(cid);
            this.consumerMeta.delete(cid);
            this.socket?.emit('close-consumer', { consumerId: cid });
          }
          store.updateParticipant(screenOwnerUserId, { screenAudioStream: undefined });
          break;
        }
      }
    }

    // Find the producing user to update their participant state
    const participants = store.participants;
    let producerUserId: string | undefined = screenOwnerUserId;
    if (!producerUserId) {
      for (const [uid, p] of Object.entries(participants)) {
        if (p.screenStream) {
          producerUserId = uid;
          break;
        }
      }
    }

    // Add back to available shares
    if (producerUserId) {
      const participant = participants[producerUserId];
      store.addAvailableScreenShare({
        producerId,
        userId: producerUserId,
        username: participant?.username || 'Unknown',
        displayName: participant?.displayName,
      });
    }

    // Remove from tuned-in (this also handles dominant swap & slot recalculation)
    store.tuneOut(producerId);
  }

  /** Pause a consumer locally and signal the server to stop forwarding RTP */
  pauseConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer && !consumer.paused) {
      consumer.pause();
      this.socket?.emit('pause-consumer', { consumerId });
    }
  }

  /** Resume a consumer locally and signal the server to resume forwarding RTP */
  resumeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer?.paused) {
      consumer.resume();
      this.socket?.emit('resume-consumer', { consumerId });
    }
  }

  /** Get consumer IDs filtered by source (e.g. 'audio', 'camera', 'screen'). No filter returns all. */
  getConsumerIdsBySource(source?: string): string[] {
    if (!source) return Array.from(this.consumers.keys());
    const ids: string[] = [];
    for (const [id, meta] of this.consumerMeta) {
      if (meta.source === source) ids.push(id);
    }
    return ids;
  }

  /** Get the router's RTP capabilities (needed for PiP voice client Device.load()) */
  getRouterRtpCapabilities(): unknown {
    return this.device?.rtpCapabilities ?? null;
  }

  /** Get all consumer metadata entries (used by PiP signaling proxy for ownership transfer) */
  getConsumerMeta(): Map<string, { source: string; producerUserId: string; producerId: string }> {
    return new Map(this.consumerMeta);
  }

  /** Proxy a signaling event to the media plane (used by PiP signaling proxy) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  forwardToServer<T = any>(event: string, data?: unknown): Promise<T> {
    return this.emitAsync<T>(event, data);
  }

  /**
   * Wait for the send transport's internal AwaitQueue to drain.
   *
   * producer.close() enqueues a stopSending() SDP renegotiation as fire-and-forget
   * on the transport's _awaitQueue. If we call sendTransport.produce() before that
   * completes, the new m= section's codec PT can collide with the recycled section
   * from the closing producer (Chromium BUNDLE PT 45 collision).
   *
   * This pushes a no-op onto the same queue and awaits it, guaranteeing all prior
   * queued operations (including stopSending) have finished before we proceed.
   */
  private async drainSendTransportQueue(): Promise<void> {
    const transport = this.sendTransport;
    if (!transport || transport.closed) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (transport as any)._awaitQueue.push(async () => {
        /* no-op — just wait for our turn */
      }, 'drainSendTransportQueue');
    } catch {
      // Transport may have closed while waiting — safe to ignore
    }
  }

  /** Close a specific producer by source */
  async closeProducer(source: string): Promise<void> {
    const producer = this.producers.get(source);

    if (producer) {
      producer.close();
      // Drain the transport's internal queue so the stopSending SDP renegotiation
      // completes before any subsequent produce() call (prevents PT collision).
      await this.drainSendTransportQueue();
      this.producers.delete(source);
      this.socket?.emit('close-producer', { producerId: producer.id });
    }

    // Always clean up local tracks and reset state, even if no producer exists.
    // This prevents state from getting stuck (e.g. isScreenSharing=true with no producer).
    const localUserId = useUserStore.getState().user?.id;
    if (source === 'mic') {
      this.stopLocalVAD();
      this.stopNoiseGate();
      this.stopInputVolume();
      if (this.localMicStream) {
        for (const t of this.localMicStream.getTracks()) t.stop();
        this.localMicStream = null;
      }
    } else if (source === 'camera') {
      if (this.localCameraStream) {
        for (const t of this.localCameraStream.getTracks()) t.stop();
        this.localCameraStream = null;
      }
      useVoiceStore.getState().setVideoOn(false);
      useVoiceStore.getState().setActiveCameraCodec(null);
      if (localUserId) {
        useVoiceStore
          .getState()
          .updateParticipant(localUserId, { videoStream: undefined, isVideoOn: false });
      }
    } else if (source === 'screen') {
      // Also close the paired screen-audio producer
      const audioProducer = this.producers.get('screen-audio');
      if (audioProducer) {
        audioProducer.close();
        await this.drainSendTransportQueue();
        this.producers.delete('screen-audio');
        this.socket?.emit('close-producer', { producerId: audioProducer.id });
      }

      if (this.localScreenStream) {
        for (const t of this.localScreenStream.getTracks()) t.stop(); // Stops both video & audio tracks
        this.localScreenStream = null;
      }
      useVoiceStore.getState().setScreenSharing(false);
      useVoiceStore.getState().setActiveScreenCodec(null);
      if (localUserId) {
        useVoiceStore.getState().updateParticipant(localUserId, {
          screenStream: undefined,
          screenAudioStream: undefined,
          isScreenSharing: false,
        });
      }
    }
  }

  /** Update audio quality tier on existing mic producer */
  async setQualityTier(tier: AudioQualityTier): Promise<void> {
    useVoiceStore.getState().setQualityTier(tier);
    // Re-produce mic with new codec options if we have an active producer
    const producer = this.producers.get('mic');
    if (producer && this.sendTransport) {
      await this.closeProducer('mic');
      await this.produceAudio();
    }
  }

  // ─── Transport Setup ───────────────────────────────────────────────

  private async createSendTransport(): Promise<void> {
    if (!this.device) throw new Error('Device not initialized before creating send transport');

    const options = await this.emitAsync<TransportOptions>('create-transport', {
      direction: 'send',
    });

    this.sendTransport = this.device.createSendTransport({
      id: options.id,
      iceParameters: options.iceParameters,
      iceCandidates: options.iceCandidates,
      dtlsParameters: options.dtlsParameters,
      // E2EE (legacy path): encodedInsertableStreams enables createEncodedStreams().
      // NOT set for RTCRtpScriptTransform — the two mechanisms conflict (#295).
      ...(this.isEncrypted &&
        HAS_ENCODED_STREAMS && {
          additionalSettings: {
            encodedInsertableStreams: true,
          } as unknown as Partial<RTCConfiguration>,
        }),
    });

    const sendTransportId = this.sendTransport.id;
    this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.emitAsync('connect-transport', {
        transportId: sendTransportId,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    this.sendTransport.on(
      'produce',
      async ({ kind, rtpParameters, appData }, callback, errback) => {
        try {
          const result = await this.emitAsync<{ id: string }>('produce', {
            transportId: sendTransportId,
            kind,
            rtpParameters,
            appData,
          });
          callback({ id: result.id });
        } catch (err) {
          errback(err as Error);
        }
      }
    );

    // DEBUG: Capture SDP from the send transport's PeerConnection
    // to identify the source of the payload_type=45 BUNDLE collision
    if (this.isEncrypted) {
      this.logTransportSdp(this.sendTransport, 'send');
    }
  }

  /**
   * Create recv transport(s). For E2EE channels, creates separate audio and
   * video transports to avoid BUNDLE payload_type collision (#291). Each
   * transport gets its own RTCPeerConnection, so audio and video codecs
   * can never collide within a BUNDLE group.
   */
  private async createRecvTransports(): Promise<void> {
    if (this.isEncrypted) {
      await Promise.all([
        this.createRecvTransportForKind('audio'),
        this.createRecvTransportForKind('video'),
      ]);
    } else {
      await this.createRecvTransportSingle();
    }
  }

  /** Create a single recv transport (non-E2EE path — unchanged behavior) */
  private async createRecvTransportSingle(): Promise<void> {
    if (!this.device) throw new Error('Device not initialized before creating recv transport');

    const options = await this.emitAsync<TransportOptions>('create-transport', {
      direction: 'recv',
    });

    this.recvTransport = this.device.createRecvTransport({
      id: options.id,
      iceParameters: options.iceParameters,
      iceCandidates: options.iceCandidates,
      dtlsParameters: options.dtlsParameters,
    });

    const recvTransportId = this.recvTransport.id;
    this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.emitAsync('connect-transport', {
        transportId: recvTransportId,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });
  }

  /** Create a recv transport for a specific media kind (E2EE path) */
  private async createRecvTransportForKind(mediaKind: 'audio' | 'video'): Promise<void> {
    if (!this.device) throw new Error('Device not initialized before creating recv transport');

    const options = await this.emitAsync<TransportOptions>('create-transport', {
      direction: 'recv',
    });

    const transport = this.device.createRecvTransport({
      id: options.id,
      iceParameters: options.iceParameters,
      iceCandidates: options.iceCandidates,
      dtlsParameters: options.dtlsParameters,
      // E2EE (legacy path only) — see send transport comment (#295)
      ...(HAS_ENCODED_STREAMS && {
        additionalSettings: {
          encodedInsertableStreams: true,
        } as unknown as Partial<RTCConfiguration>,
      }),
    });

    if (mediaKind === 'audio') {
      this.recvTransportAudio = transport;
    } else {
      this.recvTransportVideo = transport;
    }

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.emitAsync('connect-transport', {
        transportId: transport.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });

    // DEBUG: Capture SDP from E2EE recv transport
    this.logTransportSdp(transport, `recv-${mediaKind}`);
  }

  /**
   * DEBUG: Log the SDP from a transport's underlying PeerConnection.
   * Helps identify the source of the payload_type=45 BUNDLE collision.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private logTransportSdp(transport: mediasoupTypes.Transport, label: string): void {
    if (!E2EE_VERBOSE) return; // Only log SDP when verbose debugging is enabled
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (transport as any)._handler;
      if (!handler?._pc) return;
      const pc = handler._pc as RTCPeerConnection;

      const logSdp = () => {
        if (pc.localDescription) {
          console.debug(`[SDP] ${label} local:`, pc.localDescription.sdp);
        }
        if (pc.remoteDescription) {
          console.debug(`[SDP] ${label} remote:`, pc.remoteDescription.sdp);
        }
      };

      pc.addEventListener('signalingstatechange', () => {
        console.debug(`[SDP] ${label} signalingState: ${pc.signalingState}`);
        if (pc.signalingState === 'stable') logSdp();
      });
    } catch {
      // Non-critical debug logging — don't break transport setup
    }
  }

  /** Get the recv transport for a given media kind */
  private getRecvTransport(kind: mediasoupTypes.MediaKind): mediasoupTypes.Transport | null {
    if (this.isEncrypted) {
      return kind === 'audio' ? this.recvTransportAudio : this.recvTransportVideo;
    }
    return this.recvTransport;
  }

  /** Get the transport ID to pass to the server for a consume request */
  private getRecvTransportId(kind: mediasoupTypes.MediaKind): string | undefined {
    return this.getRecvTransport(kind)?.id;
  }

  // ─── Consumer Management ───────────────────────────────────────────

  /**
   * Queue a consume operation. Serializes per-transport for E2EE (each
   * transport has independent SDP negotiation), single queue for non-E2EE.
   */
  private async consumeProducer(
    producerId: string,
    senderUserId?: string,
    kind?: mediasoupTypes.MediaKind
  ): Promise<void> {
    // Validate kind for E2EE transport routing
    if (this.isEncrypted && kind && kind !== 'audio' && kind !== 'video') {
      console.warn('[consume] skipped — invalid kind for E2EE routing', { producerId, kind });
      return;
    }
    // Warn if kind is missing in E2EE mode (fallback to single queue)
    if (this.isEncrypted && !kind) {
      console.warn('[consume] E2EE active but kind not provided — using single queue fallback', {
        producerId,
      });
    }
    if (this.isEncrypted && kind) {
      // E2EE: route to per-transport queues so audio/video negotiate in parallel
      if (kind === 'audio') {
        this.consumeQueueAudio = this.consumeQueueAudio
          .then(() => this.consumeProducerImpl(producerId, senderUserId, kind))
          .catch((err) => console.error('Audio consume queue error:', err));
        await this.consumeQueueAudio;
      } else {
        this.consumeQueueVideo = this.consumeQueueVideo
          .then(() => this.consumeProducerImpl(producerId, senderUserId, kind))
          .catch((err) => console.error('Video consume queue error:', err));
        await this.consumeQueueVideo;
      }
    } else {
      // Non-E2EE or kind unknown: single queue (existing behavior)
      this.consumeQueue = this.consumeQueue
        .then(() => this.consumeProducerImpl(producerId, senderUserId, kind))
        .catch((err) => console.error('Consume queue error:', err));
      await this.consumeQueue;
    }
  }

  private async consumeProducerImpl(
    producerId: string,
    senderUserId?: string,
    kind?: mediasoupTypes.MediaKind
  ): Promise<void> {
    if (!this.device) {
      console.warn('[consume] skipped — no device', { producerId });
      return;
    }

    try {
      // For E2EE, tell the server which recv transport to use for this consumer.
      // Guard: ensure recv transport exists before server call to prevent
      // to avoid leaking server-side consumers that the client can't attach.
      const transportId = kind ? this.getRecvTransportId(kind) : undefined;
      if (this.isEncrypted && kind && !transportId) {
        console.warn('[consume] skipped — E2EE recv transport not ready for kind', {
          producerId,
          kind,
        });
        return;
      }

      console.debug('[consume] requesting', { producerId, senderUserId, kind, transportId });
      const result = await this.emitAsync<ConsumeResponse>('consume', {
        producerId,
        ...(transportId && { transportId }),
      });
      if (!result || 'error' in result) {
        console.warn('[consume] server returned error or empty result', { producerId, result });
        return;
      }

      console.debug('[consume] server responded', {
        consumerId: result.id,
        kind: result.kind,
        source: result.source,
        producerUserId: result.producerUserId,
      });

      // Route to the correct recv transport (split for E2EE, single for non-E2EE)
      const recvTransport = this.getRecvTransport(result.kind) || this.recvTransport;
      if (!recvTransport) {
        console.warn('[consume] skipped — no recvTransport for kind', {
          producerId,
          kind: result.kind,
        });
        return;
      }

      const consumer = await recvTransport.consume({
        id: result.id,
        producerId: result.producerId,
        kind: result.kind,
        rtpParameters: result.rtpParameters,
      });

      this.consumers.set(consumer.id, consumer);
      this.consumerMeta.set(consumer.id, {
        source: result.source,
        producerUserId: result.producerUserId,
        producerId: result.producerId,
      });

      console.debug('[consume] consumer created', {
        consumerId: consumer.id,
        kind: consumer.kind,
        trackState: consumer.track.readyState,
        trackEnabled: consumer.track.enabled,
        paused: consumer.paused,
      });

      // Apply E2EE decrypt transform if encrypted
      const producerUserId = senderUserId || result.producerUserId;
      if (this.isEncrypted) {
        // Lazy re-init: if initEncryption failed at join time but CSK is now available
        if (!this.mediaEncryption) {
          const channelId = useVoiceStore.getState().activeChannelId;
          if (channelId) {
            try {
              await this.initEncryption(channelId);
            } catch {
              console.warn('E2EE: lazy re-init failed, consumer will receive encrypted frames');
            }
          }
        }
        if (this.mediaEncryption) {
          // Fire-and-forget: add decrypt key without blocking the consume queue.
          // Self-healing recovery in applyDecryptTransform handles missing keys.
          const channelId = useVoiceStore.getState().activeChannelId;
          if (channelId) {
            void this.addDecryptKeyForUser(channelId, producerUserId).catch((err) => {
              console.warn('E2EE: addDecryptKeyForUser failed, self-healing will retry', {
                producerUserId,
                error: err instanceof Error ? err.message : err,
              });
            });
          }
          this.applyDecryptTransform(consumer, producerUserId);
        }
      }

      // Attach stream to participant
      const stream = new MediaStream([consumer.track]);
      const store = useVoiceStore.getState();
      const source = result.source;
      const hasParticipant = !!store.participants[result.producerUserId];

      if (!hasParticipant) {
        console.warn('[consume] participant not in store!', {
          producerUserId: result.producerUserId,
          knownUserIds: Object.keys(store.participants),
        });
      }

      if (source === 'screen-audio') {
        store.updateParticipant(result.producerUserId, { screenAudioStream: stream });
      } else if (result.kind === 'audio') {
        store.updateParticipant(result.producerUserId, { audioStream: stream });
      } else if (source === 'camera') {
        store.updateParticipant(result.producerUserId, { videoStream: stream, isVideoOn: true });
      } else if (source === 'screen') {
        store.updateParticipant(result.producerUserId, {
          screenStream: stream,
          isScreenSharing: true,
        });
      }

      console.debug('[consume] stream attached', {
        kind: result.kind,
        source,
        producerUserId: result.producerUserId,
        hasParticipant,
      });

      // Clean up on close
      consumer.on('transportclose', () => {
        console.debug('[consume] transport closed for consumer', consumer.id);
        this.consumers.delete(consumer.id);
        this.consumerMeta.delete(consumer.id);
      });

      // Resume the consumer (was created paused on server)
      await this.emitAsync('resume-consumer', { consumerId: consumer.id });
      console.debug('[consume] consumer resumed', { consumerId: consumer.id });
    } catch (err) {
      console.error('[consume] Failed to consume producer:', producerId, err);
    }
  }

  // ─── Socket Listeners ──────────────────────────────────────────────

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('new-producer', async ({ producerId, userId, kind, source, requiresOptIn }) => {
      const store = useVoiceStore.getState();

      // Screen shares use opt-in ("Tune In") model — announce but don't auto-consume
      if (requiresOptIn && source === 'screen') {
        const participant = store.participants[userId];
        store.addAvailableScreenShare({
          producerId,
          userId,
          username: participant?.username || 'Unknown',
          displayName: participant?.displayName,
        });
        store.updateParticipant(userId, { isScreenSharing: true });
        return;
      }

      // Screen-audio is paired with screen video — store mapping and auto-consume
      // if the user is already tuned into this user's screen share
      if (requiresOptIn && source === 'screen-audio') {
        this.pendingScreenAudioProducers.set(userId, producerId);
        // Check if we're already tuned into a screen share from this user
        const alreadyTunedIn =
          Object.values(store.tunedInScreenShares).length > 0 &&
          [...this.consumerMeta.values()].some(
            (m) => m.source === 'screen' && m.producerUserId === userId
          );
        if (alreadyTunedIn) {
          // Late arrival — consume immediately
          await this.consumeProducer(producerId, userId, 'audio');
        }
        return;
      }

      // E2EE: ensure decrypt key is ready BEFORE consuming so the first
      // frames can be decrypted. Socket.IO doesn't await async handlers,
      // so user-joined's addDecryptKeyForUser may still be in-flight.
      if (this.isEncrypted && this.mediaEncryption) {
        const channelId = store.activeChannelId;
        if (channelId) {
          await this.addDecryptKeyForUser(channelId, userId);
        }
      }

      // Video slot enforcement for camera streams
      if (source === 'camera') {
        const videoOnCount = Object.values(store.participants).filter((p) => p.isVideoOn).length;
        if (videoOnCount >= store.maxVideoSlots) {
          console.warn(
            `[new-producer] Video slot limit reached (${store.maxVideoSlots}), skipping camera consume for ${userId}`
          );
          store.updateParticipant(userId, { isVideoOn: true }); // Mark them as video-on even if we can't consume
          return;
        }
      }

      await this.consumeProducer(producerId, userId, kind as mediasoupTypes.MediaKind);
      if (source === 'camera') store.updateParticipant(userId, { isVideoOn: true });
      if (source === 'screen') store.updateParticipant(userId, { isScreenSharing: true });
    });

    this.socket.on('producer-paused', ({ producerId: _producerId, userId }) => {
      useVoiceStore.getState().updateParticipant(userId, { isMuted: true });
    });

    this.socket.on('producer-resumed', ({ producerId: _producerId, userId }) => {
      useVoiceStore.getState().updateParticipant(userId, { isMuted: false });
    });

    this.socket.on('producer-closed', ({ producerId, userId, source }) => {
      // Find and close the corresponding consumer
      for (const [consumerId, consumer] of this.consumers) {
        if (consumer.producerId === producerId) {
          consumer.close();
          this.consumers.delete(consumerId);
          this.consumerMeta.delete(consumerId);
          break;
        }
      }

      const store = useVoiceStore.getState();
      if (source === 'camera')
        store.updateParticipant(userId, { isVideoOn: false, videoStream: undefined });
      else if (source === 'screen') {
        store.updateParticipant(userId, { isScreenSharing: false, screenStream: undefined });
        store.removeAvailableScreenShare(producerId);
        // Clean up tunedInScreenShares so UI collapses back to user frame grid
        if (producerId in store.tunedInScreenShares) {
          store.tuneOut(producerId);
        }
      } else if (source === 'screen-audio') {
        store.updateParticipant(userId, { screenAudioStream: undefined });
        this.pendingScreenAudioProducers.delete(userId);
      }
    });

    this.socket.on('user-joined', async ({ userId, username, displayName, avatarUrl }) => {
      useVoiceStore.getState().addParticipant({
        userId,
        username,
        displayName,
        avatarUrl,
        isMuted: false,
        isDeafened: false,
        isVideoOn: false,
        isScreenSharing: false,
        isSpeaking: false,
      });

      // E2EE: add decrypt key for new participant & rotate keys (new epoch)
      if (this.isEncrypted && this.mediaEncryption) {
        const channelId = useVoiceStore.getState().activeChannelId;
        if (channelId) {
          await this.addDecryptKeyForUser(channelId, userId);
          this.debouncedRotateE2EEKeys();
        }
      }

      // Solo bandwidth saving: exit solo mode when someone joins
      this.checkSoloBandwidthSaving();
    });

    this.socket.on('user-left', async ({ userId }) => {
      useVoiceStore.getState().removeParticipant(userId);

      // E2EE: rotate keys when a member leaves (forward secrecy)
      if (this.isEncrypted && this.mediaEncryption) {
        this.debouncedRotateE2EEKeys();
      }

      // Solo bandwidth saving: enter solo mode when everyone else leaves
      this.checkSoloBandwidthSaving();
    });

    // E2EE: periodic epoch sync — recover from missed join/leave events
    this.socket.on('epoch-sync', async ({ epoch }: { epoch: number }) => {
      if (!this.isEncrypted || !this.mediaEncryption) return;
      const localEpoch = this.mediaEncryption.getCurrentKeyId();
      if (epoch > localEpoch) {
        const gap = epoch - localEpoch;
        console.debug(
          `E2EE epoch sync: local=${localEpoch}, server=${epoch}, catching up ${gap} steps`
        );
        try {
          if (this.e2eeWorker) {
            this.e2eeWorker.postMessage({
              type: 'catchUpToEpoch',
              targetEpoch: epoch,
            } satisfies E2EEWorkerMessage);
          }
          await this.mediaEncryption.catchUpToEpoch(epoch);
        } catch (err) {
          console.error('E2EE: epoch catch-up failed — decrypt may fail until rejoin', {
            localEpoch,
            serverEpoch: epoch,
            error: err instanceof Error ? err.message : err,
          });
        }
      }
    });

    this.socket.on('active-speaker', ({ userId }) => {
      const store = useVoiceStore.getState();
      // Clear previous speaker
      if (store.activeSpeakerId && store.activeSpeakerId !== userId) {
        store.updateParticipant(store.activeSpeakerId, { isSpeaking: false });
      }
      if (userId) {
        store.setActiveSpeaker(userId);
        store.updateParticipant(userId, { isSpeaking: true });
      } else {
        // Silence — no one is speaking
        store.setActiveSpeaker(null);
      }
    });

    this.socket.on('room-codec-floor', ({ codecFloor }: { codecFloor: string[] | null }) => {
      const store = useVoiceStore.getState();
      const previousFloor = store.codecFloor;
      store.setCodecFloor(codecFloor);
      this.handleCodecFloorChange(previousFloor, codecFloor);
    });

    this.socket.on('consumer-closed', ({ consumerId }) => {
      const consumer = this.consumers.get(consumerId);
      if (consumer) {
        // If this was a screen share consumer, clean up tunedInScreenShares
        const store = useVoiceStore.getState();
        const producerId = consumer.producerId;
        if (producerId && producerId in store.tunedInScreenShares) {
          store.tuneOut(producerId);
        }

        consumer.close();
        this.consumers.delete(consumerId);
        this.consumerMeta.delete(consumerId);
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('Media plane disconnected:', reason);
      if (reason === 'io server disconnect') {
        // Server forcibly disconnected us — full cleanup
        this.emergencyCleanup();
      } else {
        useVoiceStore.getState().setConnectionState('reconnecting');
      }
    });

    this.socket.on('connect', () => {
      if (useVoiceStore.getState().connectionState === 'reconnecting') {
        useVoiceStore.getState().setConnectionState('connected');
      }
    });

    // Socket.IO exhausted all reconnection attempts
    this.socket.io.on('reconnect_failed', () => {
      this.emergencyCleanup();
    });

    this.socket.on('error', ({ message }) => {
      console.error('Media plane error:', message);
    });
  }

  // ─── Decoder Budget Profiling (IGNIS insight) ─────────────────

  /**
   * Profile decode performance of video consumers and adjust preferred SVC
   * layers to prevent decoder queue buildup.
   *
   * IGNIS formula: FPS_safe = 0.8 × (1000 / T_decode_p95)
   * Exceeding the decoder budget causes exponential queue buildup
   * ("counterintuitive latency" — pushing higher quality actually increases
   * total latency due to decoder overload).
   */
  private startDecoderBudgetProfiling(): void {
    // Profile every 5 seconds for the first 30 seconds, then every 30 seconds
    let probeCount = 0;
    const maxInitialProbes = 6; // 6 × 5s = 30s initial period

    this.decoderProfilingTimer = setInterval(async () => {
      probeCount++;

      // Switch to slower interval after initial profiling
      if (probeCount === maxInitialProbes + 1 && this.decoderProfilingTimer) {
        clearInterval(this.decoderProfilingTimer);
        this.decoderProfilingTimer = setInterval(() => this.profileDecoders(), 30_000);
      }

      await this.profileDecoders();
    }, 5_000);
  }

  /**
   * Full IGNIS decoder budget profiling.
   *
   * Zone thresholds:
   *   Green:  rho < 0.67  (decode time < 67% of frame interval)
   *   Yellow: rho < 0.80  (approaching limit)
   *   Red:    rho >= 0.925 (near-critical, 92.5% capacity)
   *
   * Formulas:
   *   Load Ratio:  rho = T_d_p95 / T_f = (T_d_p95 × FPS) / 1000
   *   Safe FPS:    FPS_safe = margin × (1000 / T_d_p95)
   *   Risk Score:  R = (FPS × T_d_p95) / 1000
   *
   * Actions:
   *   Green:  full quality, no intervention
   *   Yellow: lower temporal layer by 1
   *   Red:    lower spatial layer by 1, if already lowest → pause lowest-priority consumer
   */
  /** Handle RED zone decoder overload: reduce layers or pause lowest-priority consumer */
  private handleRedZone(
    consumer: mediasoupTypes.Consumer,
    consumerWithLayers: ConsumerWithLayers,
    currentLayers: { spatialLayer: number; temporalLayer: number } | undefined,
    rho: number,
    p95DecodeMs: number,
    currentFps: number
  ): void {
    if (currentLayers && currentLayers.spatialLayer > 0) {
      consumerWithLayers.setPreferredLayers({
        spatialLayer: currentLayers.spatialLayer - 1,
        temporalLayer: currentLayers.temporalLayer,
      });
      console.warn(
        `IGNIS RED: lowering spatial layer for consumer ${consumer.id}`,
        `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`
      );
      return;
    }

    if (currentLayers && currentLayers.temporalLayer > 0) {
      consumerWithLayers.setPreferredLayers({
        spatialLayer: currentLayers.spatialLayer,
        temporalLayer: currentLayers.temporalLayer - 1,
      });
      console.warn(
        `IGNIS RED: lowering temporal layer for consumer ${consumer.id}`,
        `(rho=${rho.toFixed(2)})`
      );
      return;
    }

    // Already at lowest layers — pause lowest-priority consumer
    this.pauseLowestPriorityConsumer(consumer);
  }

  /** Pause a consumer, preferring to pause camera over screen share */
  private pauseLowestPriorityConsumer(consumer: mediasoupTypes.Consumer): void {
    const tunedIn = useVoiceStore.getState().tunedInScreenShares;
    const isScreenShare = Object.values(tunedIn).includes(consumer.id);

    if (!isScreenShare) {
      consumer.pause();
      console.warn(`IGNIS RED: pausing camera consumer ${consumer.id} — no layers to reduce`);
      return;
    }

    // Try to find a camera consumer to pause instead
    for (const [, c] of this.consumers) {
      if (c.kind === 'video' && !c.paused && !Object.values(tunedIn).includes(c.id)) {
        c.pause();
        console.warn(
          `IGNIS RED: pausing camera consumer ${c.id} instead of screen share ${consumer.id}`
        );
        return;
      }
    }

    consumer.pause();
    console.warn(`IGNIS RED: pausing screen share consumer ${consumer.id} — no camera to demote`);
  }

  private async profileDecoders(): Promise<void> {
    let worstZone: 'green' | 'yellow' | 'red' = 'green';

    for (const [, consumer] of this.consumers) {
      if (consumer.kind !== 'video') continue;

      try {
        const stats = await consumer.getStats();

        for (const report of stats.values()) {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video') continue;

          const totalDecodeTime = (report as Record<string, unknown>).totalDecodeTime as
            | number
            | undefined;
          const framesDecoded = (report as Record<string, unknown>).framesDecoded as
            | number
            | undefined;
          const currentFps = (report as Record<string, unknown>).framesPerSecond as
            | number
            | undefined;

          if (!totalDecodeTime || !framesDecoded || framesDecoded === 0 || !currentFps) continue;

          const avgDecodeMs = (totalDecodeTime / framesDecoded) * 1000;
          const p95DecodeMs = avgDecodeMs * 1.5;
          const rho = (p95DecodeMs * currentFps) / 1000;

          const consumerWithLayers = consumer as unknown as ConsumerWithLayers;
          const currentLayers = consumerWithLayers.currentLayers;

          if (rho >= 0.925) {
            worstZone = 'red';
            this.handleRedZone(
              consumer,
              consumerWithLayers,
              currentLayers,
              rho,
              p95DecodeMs,
              currentFps
            );
          } else if (rho >= 0.8) {
            if (worstZone !== 'red') worstZone = 'yellow';
            if (currentLayers && currentLayers.temporalLayer > 0) {
              consumerWithLayers.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.warn(
                `IGNIS YELLOW: lowering temporal layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`
              );
            }
          }
        }
      } catch {
        // Stats not available — skip
      }
    }

    useVoiceStore.getState().setDecoderHealth(worstZone);
  }

  // ─── E2EE ─────────────────────────────────────────────────────

  /** Initialize media encryption for an encrypted channel (fail-closed with retry) */
  /** Core encryption setup: derive key, create Worker or legacy MediaEncryption */
  private async initEncryptionCore(channelId: string, attempt: number): Promise<void> {
    const channelCSK = await e2eeService.getChannelKey(channelId);
    const userId = useUserStore.getState().user?.id;
    if (!userId) throw new Error('No local userId for E2EE init');

    const encryptKey = await deriveFrameKey(channelCSK, userId);

    if (USE_SCRIPT_TRANSFORM) {
      this.initE2EEWorker();
      if (!this.e2eeWorker) throw new Error('E2EE Worker failed to initialize');
      this.e2eeWorker.postMessage({
        type: 'init',
        encryptKey,
        currentKeyId: 0,
      } satisfies E2EEWorkerMessage);
      this.mediaEncryption = new MediaEncryption();
      this.mediaEncryption.initFromKey(encryptKey, 0);
    } else {
      this.mediaEncryption = new MediaEncryption();
      await this.mediaEncryption.init(channelCSK, userId);
    }

    console.debug('E2EE: encryption initialized', {
      channelId,
      userId,
      attempt: attempt + 1,
      useScriptTransform: USE_SCRIPT_TRANSFORM,
    });
  }

  /** Initialize media encryption for an encrypted channel (fail-closed with retry) */
  private async initEncryption(channelId: string): Promise<void> {
    const retryDelays = [500, 1000, 2000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await this.initEncryptionCore(channelId, attempt);
        return;
      } catch (err) {
        lastError = err;
        const isPending = err instanceof Error && err.message === 'PENDING_KEY';
        console.warn('E2EE: initEncryption attempt failed', {
          channelId,
          attempt: attempt + 1,
          isPending,
          error: err instanceof Error ? err.message : err,
        });

        if (attempt < retryDelays.length) {
          const delay = isPending ? retryDelays[attempt] * 2 : retryDelays[attempt];
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted — fail-closed
    this.mediaEncryption = null;
    this.terminateE2EEWorker();
    if (lastError instanceof Error) throw lastError;
    const detail = lastError == null ? '' : ` (${String(lastError)})`;
    throw new Error(`E2EE: failed to initialize encryption after retries${detail}`);
  }

  /** Create the E2EE Worker for RTCRtpScriptTransform */
  private initE2EEWorker(): void {
    if (this.e2eeWorker) return;
    this.e2eeWorker = new Worker(new URL('../workers/e2eeWorker.ts', import.meta.url), {
      type: 'module',
    });
    this.e2eeWorker.onmessage = (event: MessageEvent<E2EEMainMessage>) => {
      this.handleWorkerMessage(event.data);
    };
    this.e2eeWorker.onerror = (err) => {
      console.error('E2EE Worker error:', err);
    };
  }

  /** Terminate and clean up the E2EE Worker */
  private terminateE2EEWorker(): void {
    if (this.e2eeWorker) {
      this.e2eeWorker.postMessage({ type: 'destroy' } satisfies E2EEWorkerMessage);
      this.e2eeWorker.terminate();
      this.e2eeWorker = null;
    }
  }

  /** Handle messages from the E2EE Worker */
  private handleWorkerMessage(msg: E2EEMainMessage): void {
    switch (msg.type) {
      case 'rotationComplete':
        // Sync the main-thread epoch tracker with the Worker's authoritative state.
        // The main-thread MediaEncryption is only used for getCurrentKeyId() calls
        // (key derivation uses the epoch to pre-ratchet new decrypt keys).
        this.mediaEncryption?.setCurrentKeyId(msg.newKeyId);
        break;

      case 'requestRecovery': {
        const channelId = useVoiceStore.getState().activeChannelId;
        if (channelId) {
          console.debug(`E2EE: Worker requested recovery for ${msg.senderUserId}`);
          e2eeService.invalidateChannelKey(channelId);
          this.addDecryptKeyForUser(channelId, msg.senderUserId).catch(() => {});
        }
        break;
      }

      case 'log':
        // Forward Worker logs to renderer console
        // eslint-disable-next-line no-console
        console[msg.level](msg.message, msg.data || '');
        break;
    }
  }

  /**
   * Debounced key rotation: collapses rapid join/leave bursts.
   * For Worker path: sends rotateKeys to the Worker.
   * For legacy path: delegates to MediaEncryption.debouncedRotateKeys().
   */
  private debouncedRotateE2EEKeys(): void {
    if (!USE_SCRIPT_TRANSFORM) {
      // Legacy path: MediaEncryption handles its own debounce
      this.mediaEncryption?.debouncedRotateKeys();
      return;
    }

    // Modern path: debounce on main thread, send to Worker
    if (!this.e2eeWorker) return;
    this.rotationPending = true;

    if (!this.rotationDeadline) {
      this.rotationDeadline = Date.now() + VoiceService.ROTATION_MAX_CAP_MS;
    }

    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    const remaining = this.rotationDeadline - Date.now();
    const delay = remaining <= 0 ? 0 : Math.min(VoiceService.ROTATION_DEBOUNCE_MS, remaining);

    this.rotationTimer = setTimeout(() => {
      this.rotationTimer = null;
      this.rotationDeadline = 0;
      if (!this.rotationPending || !this.e2eeWorker) return;
      this.rotationPending = false;
      this.e2eeWorker.postMessage({ type: 'rotateKeys' } satisfies E2EEWorkerMessage);
    }, delay);
  }

  /** Add a decryption key for a remote user, pre-ratcheted to current epoch (with retry) */
  /** Derive and install a decrypt key for a single user at the current epoch */
  private async deriveAndInstallDecryptKey(
    channelId: string,
    userId: string,
    attempt: number
  ): Promise<void> {
    if (!this.mediaEncryption) throw new Error('mediaEncryption destroyed');
    const channelCSK = await e2eeService.getChannelKey(channelId);
    if (!this.mediaEncryption) throw new Error('mediaEncryption destroyed');
    const currentEpoch = this.mediaEncryption.getCurrentKeyId();

    if (currentEpoch > 100) {
      throw new Error(`E2EE: epoch ${currentEpoch} exceeds ratchet limit (100), rejoin required`);
    }

    let key: CryptoKey = await deriveFrameKey(channelCSK, userId);
    for (let i = 0; i < currentEpoch; i++) {
      key = await ratchetKey(key);
    }

    this.mediaEncryption.addDecryptKeyDirect(userId, currentEpoch, key);

    if (this.e2eeWorker) {
      this.e2eeWorker.postMessage({
        type: 'addDecryptKey',
        senderUserId: userId,
        keyId: currentEpoch,
        key,
      } satisfies E2EEWorkerMessage);
    }

    console.debug('E2EE: decrypt key added', {
      channelId,
      targetUserId: userId,
      currentEpoch,
      keyId: currentEpoch,
      attempt: attempt + 1,
    });
  }

  /** Add a decryption key for a remote user, pre-ratcheted to current epoch (with retry) */
  private async addDecryptKeyForUser(channelId: string, userId: string): Promise<boolean> {
    if (!this.mediaEncryption) return false;

    const retryDelays = [500, 1000, 2000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        await this.deriveAndInstallDecryptKey(channelId, userId, attempt);
        return true;
      } catch (err) {
        lastError = err;
        if (attempt < retryDelays.length) {
          const isPending = err instanceof Error && err.message === 'PENDING_KEY';
          const delay = isPending ? retryDelays[attempt] * 2 : retryDelays[attempt];
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    console.error('E2EE: failed to add decrypt key after retries', {
      channelId,
      targetUserId: userId,
      error: lastError instanceof Error ? lastError.message : lastError,
    });
    return false;
  }

  /**
   * Apply E2EE encrypt transform to a producer.
   * Modern path: RTCRtpScriptTransform (Chromium 129+, Worker-based).
   * Legacy path: createEncodedStreams (Chromium 86-130, main-thread).
   */
  private applyEncryptTransform(producer: mediasoupTypes.Producer): void {
    const sender = producer.rtpSender;
    if (!sender) {
      console.warn('E2EE: no rtpSender on producer — frames will not be encrypted');
      return;
    }

    // Modern path: RTCRtpScriptTransform (Chromium 129+)
    if (USE_SCRIPT_TRANSFORM && this.e2eeWorker) {
      try {
        const options: E2EETransformOptions = { role: 'encrypt' };
        sender.transform = new RTCRtpScriptTransform(this.e2eeWorker, options);
        console.debug('E2EE: encrypt transform applied (RTCRtpScriptTransform)');
      } catch (err) {
        console.error('E2EE: RTCRtpScriptTransform failed on sender:', err);
      }
      return;
    }

    // Legacy path: createEncodedStreams (Chromium 86-130)
    if (!this.mediaEncryption) return;
    const encryption = this.mediaEncryption;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senderAny = sender as any;

    if (typeof senderAny.createEncodedStreams === 'function') {
      try {
        const { readable, writable } = senderAny.createEncodedStreams();
        let encryptDropCount = 0;
        let firstEncryptLogged = false;
        const transform = new TransformStream({
          async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
            try {
              await encryption.encryptFrame(frame);
              controller.enqueue(frame);
              if (!firstEncryptLogged) {
                firstEncryptLogged = true;
                console.debug('E2EE: first frame encrypted successfully', {
                  kind: 'type' in frame ? 'video' : 'audio',
                  dataSize: frame.data.byteLength,
                });
              }
              if (encryptDropCount > 0) {
                console.debug(`E2EE: encrypt recovered after ${encryptDropCount} dropped frames`);
                encryptDropCount = 0;
              }
            } catch (err) {
              encryptDropCount++;
              if (encryptDropCount === 1 || encryptDropCount % 100 === 0) {
                console.warn('E2EE: encrypt frame dropped', {
                  totalDropped: encryptDropCount,
                  error: err instanceof Error ? err.message : err,
                });
              }
            }
          },
        });
        readable
          .pipeThrough(transform)
          .pipeTo(writable)
          .catch((err: unknown) => {
            console.error('E2EE: encrypt pipe broken — frames stopped flowing:', err);
          });
        console.debug('E2EE: encrypt transform applied (createEncodedStreams)');
      } catch (err) {
        console.error('E2EE: createEncodedStreams failed on sender:', err);
      }
    } else {
      console.warn('E2EE: no Insertable Streams API available — frames will not be encrypted');
    }
  }

  /**
   * Apply E2EE decrypt transform to a consumer.
   * Modern path: RTCRtpScriptTransform (Chromium 129+, Worker-based).
   * Legacy path: createEncodedStreams (Chromium 86-130, main-thread).
   */
  private applyDecryptTransform(consumer: mediasoupTypes.Consumer, senderUserId: string): void {
    const receiver = consumer.rtpReceiver;
    if (!receiver) {
      console.warn('E2EE: no rtpReceiver on consumer — frames will not be decrypted');
      return;
    }

    // Modern path: RTCRtpScriptTransform (Chromium 129+)
    if (USE_SCRIPT_TRANSFORM && this.e2eeWorker) {
      try {
        const options: E2EETransformOptions = { role: 'decrypt', senderUserId };
        receiver.transform = new RTCRtpScriptTransform(this.e2eeWorker, options);
        console.debug(
          `E2EE: decrypt transform applied for ${senderUserId} (RTCRtpScriptTransform)`
        );
      } catch (err) {
        console.error('E2EE: RTCRtpScriptTransform failed on receiver:', err);
      }
      return;
    }

    // Legacy path: createEncodedStreams (Chromium 86-130)
    if (!this.mediaEncryption) return;
    const encryption = this.mediaEncryption;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiverAny = receiver as any;

    let recoveryInProgress = false;
    let lastRecoveryAttempt = 0;
    const RECOVERY_COOLDOWN_MS = 5000;
    const RECOVERY_THRESHOLD = 50;
    const PERSISTENT_FAILURE_THRESHOLD = 500;
    let firstDecryptLogged = false;

    if (typeof receiverAny.createEncodedStreams === 'function') {
      try {
        const { readable, writable } = receiverAny.createEncodedStreams();
        let dropCount = 0;
        const transform = new TransformStream({
          transform: async (frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) => {
            try {
              await encryption.decryptFrame(frame, senderUserId);
              controller.enqueue(frame);
              if (!firstDecryptLogged) {
                firstDecryptLogged = true;
                console.debug(`E2EE: first frame decrypted for ${senderUserId}`);
              }
              if (dropCount > 0) {
                console.debug(
                  `E2EE: decrypt recovered after ${dropCount} dropped frames for ${senderUserId}`
                );
                dropCount = 0;
              }
            } catch (decryptErr) {
              dropCount++;
              if (dropCount === 1 || dropCount % 100 === 0) {
                const errMsg =
                  decryptErr instanceof Error
                    ? `${decryptErr.name}: ${decryptErr.message}`
                    : String(decryptErr);
                if (E2EE_VERBOSE) {
                  const fd = new Uint8Array(frame.data);
                  const trailerHex =
                    fd.length >= 16
                      ? Array.from(fd.slice(-16))
                          .map((b) => b.toString(16).padStart(2, '0'))
                          .join(' ')
                      : 'too-small';
                  const hasMagic = fd.length >= 2 && fd.at(-2) === 0xde && fd.at(-1) === 0xad;
                  console.warn(`E2EE: dropping frame for ${senderUserId} (dropped: ${dropCount})`, {
                    error: errMsg,
                    frameSize: fd.length,
                    localEpoch: encryption.getCurrentKeyId(),
                    hasMagic,
                    keyId: hasMagic && fd.length >= 15 ? fd.at(-15) : -1,
                    trailerHex,
                  });
                } else {
                  console.warn(
                    `E2EE: dropping undecryptable frame for ${senderUserId} (dropped: ${dropCount})`,
                    { error: errMsg, frameSize: frame.data.byteLength }
                  );
                }
              }

              if (
                dropCount === RECOVERY_THRESHOLD &&
                !recoveryInProgress &&
                Date.now() - lastRecoveryAttempt > RECOVERY_COOLDOWN_MS
              ) {
                recoveryInProgress = true;
                lastRecoveryAttempt = Date.now();
                const channelId = useVoiceStore.getState().activeChannelId;
                if (channelId && this.mediaEncryption) {
                  console.debug(`E2EE: attempting self-healing key recovery for ${senderUserId}`);
                  e2eeService.invalidateChannelKey(channelId);
                  this.addDecryptKeyForUser(channelId, senderUserId)
                    .then((ok) => {
                      if (ok) {
                        console.debug(`E2EE: recovery key re-derived for ${senderUserId}`);
                      }
                    })
                    .catch(() => {})
                    .finally(() => {
                      recoveryInProgress = false;
                    });
                } else {
                  recoveryInProgress = false;
                }
              }

              if (dropCount === PERSISTENT_FAILURE_THRESHOLD) {
                console.error(
                  `E2EE: persistent decrypt failure for ${senderUserId} — ${PERSISTENT_FAILURE_THRESHOLD} frames dropped. Rejoin may be required.`
                );
              }
            }
          },
        });
        readable
          .pipeThrough(transform)
          .pipeTo(writable)
          .catch((err: unknown) => {
            console.warn('E2EE decrypt pipe error:', err);
          });
        console.debug(`E2EE: decrypt transform applied for ${senderUserId} (createEncodedStreams)`);
      } catch (err) {
        console.error('E2EE: createEncodedStreams failed on receiver:', err);
      }
    } else {
      console.warn('E2EE: no Insertable Streams API available — frames will not be decrypted');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private waitForConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('No socket'));

      if (this.socket.connected) return resolve();

      const timeout = setTimeout(() => {
        reject(new Error('Socket connection timeout'));
      }, 10_000);

      this.socket.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.socket.once('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private emitAsync<T>(event: string, data?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('No socket connection'));

      const timeout = setTimeout(() => {
        reject(new Error(`Socket emit timeout: ${event}`));
      }, 10_000);

      this.socket.emit(event, data, (response: T & { error?: string }) => {
        clearTimeout(timeout);
        if (response && typeof response === 'object' && 'error' in response) {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });
    });
  }

  private async cleanup(): Promise<void> {
    // Clear solo bandwidth saving state
    if (this.soloNotificationTimer) {
      clearTimeout(this.soloNotificationTimer);
      this.soloNotificationTimer = null;
    }

    // Close all producers — snapshot keys first because closeProducer()
    // mutates the Map (deletes entries), which breaks for..of iteration
    // and causes producers to be skipped (camera stays alive).
    const producerSources = [...this.producers.keys()];
    for (const source of producerSources) {
      await this.closeProducer(source);
    }

    // Safety net: ensure ALL local media tracks are stopped even if
    // closeProducer missed them (e.g. due to a prior error or race).
    for (const stream of [this.localMicStream, this.localCameraStream, this.localScreenStream]) {
      if (stream) for (const t of stream.getTracks()) t.stop();
    }
    this.localMicStream = null;
    this.localCameraStream = null;
    this.localScreenStream = null;

    // Close all consumers
    for (const [, consumer] of this.consumers) {
      consumer.close();
    }
    this.consumers.clear();
    this.consumerMeta.clear();
    this.pendingScreenAudioProducers.clear();

    // Close transports
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.recvTransportAudio?.close();
    this.recvTransportVideo?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.recvTransportAudio = null;
    this.recvTransportVideo = null;

    // Stop local VAD, noise gate, input volume, and live subscriptions
    this.stopLocalVAD();
    this.stopNoiseGate();
    this.stopInputVolume();
    this.teardownLiveSubscriptions();

    // Stop packet loss monitor
    this.stopPacketLossMonitor();

    // Stop decoder profiling
    if (this.decoderProfilingTimer) {
      clearInterval(this.decoderProfilingTimer);
      this.decoderProfilingTimer = null;
    }

    // Destroy E2EE
    this.terminateE2EEWorker();
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }
    this.mediaEncryption?.destroy();
    this.mediaEncryption = null;
    this.isEncrypted = false;

    // Clear screen share opt-in list
    useVoiceStore.getState().clearAvailableScreenShares();

    // Reset consume queues so pending consumes from the old session don't
    // interfere with the next join.
    this.consumeQueue = Promise.resolve();
    this.consumeQueueAudio = Promise.resolve();
    this.consumeQueueVideo = Promise.resolve();

    // Disconnect socket
    this.socket?.disconnect();
    this.socket = null;

    // Reset device
    this.device = null;
  }

  // ─── OS Permission Helper (#197) ────────────────────────────────────

  /**
   * Ensure an OS-level permission is granted before proceeding.
   * On macOS, triggers the system permission prompt if status is 'not-determined'.
   * Throws a descriptive error if denied/restricted so the caller's catch block
   * can display a meaningful message.
   */
  private async ensureOsPermission(type: 'microphone' | 'camera'): Promise<void> {
    const status = await ensureOsPermissionShared(type);
    if (status === 'granted') return;

    const label = type === 'microphone' ? 'Microphone' : 'Camera';
    if (status === 'denied' || status === 'restricted') {
      throw new DOMException(
        `${label} access denied. Grant permission in System Settings > Privacy & Security.`,
        'NotAllowedError'
      );
    }
    if (status === 'unavailable') {
      throw new DOMException(
        `${label} is unavailable on this device or OS configuration.`,
        'NotAllowedError'
      );
    }
    // Catch-all for unexpected statuses
    throw new DOMException(
      `${label} access is not available (status: ${status}).`,
      'NotAllowedError'
    );
  }
}

// Export singleton
export const voiceService = new VoiceService();

// Auto-cleanup voice when auth tokens are cleared (logout, token revocation,
// refresh failure). This fires BEFORE the React tree re-renders, ensuring
// media stops immediately regardless of which code path called clearTokens().
useAuthStore.subscribe((state, prevState) => {
  if (prevState.accessToken && !state.accessToken) {
    voiceService.emergencyCleanup();
  }
});

// Stop all media when the window is closing (app quit, reload, crash).
// Ensures the OS releases mic/camera even on unclean shutdown.
if (globalThis.window) {
  globalThis.addEventListener('beforeunload', () => {
    voiceService.emergencyCleanup();
  });
}
