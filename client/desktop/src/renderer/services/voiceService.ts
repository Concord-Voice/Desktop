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
} from '../stores/videoSettingsStore';
import { apiFetch } from './apiClient';
import { MediaEncryption } from './mediaEncryption';
import { e2eeService } from './e2eeService';

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

  // Local producers: source → Producer
  private producers: Map<string, mediasoupTypes.Producer> = new Map();
  // Remote consumers: consumerId → Consumer
  private consumers: Map<string, mediasoupTypes.Consumer> = new Map();
  // Consumer metadata for ownership transfer (parallel to consumers Map)
  private consumerMeta: Map<
    string,
    { source: string; producerUserId: string; producerId: string }
  > = new Map();
  // Local media streams
  private localMicStream: MediaStream | null = null;
  private localCameraStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;

  // E2EE
  private mediaEncryption: MediaEncryption | null = null;
  private isEncrypted = false;

  // Consume queue — serializes consume operations to prevent concurrent SDP
  // negotiations that cause "Duplicate a=mid value" errors.
  private consumeQueue: Promise<void> = Promise.resolve();

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
    if (this.vadAudioContext && this.vadAudioContext.state !== 'closed') {
      this.vadAudioContext.close().catch(() => {});
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
      for (let i = 0; i < dataArray.length; i++) {
        const offset = Math.abs(dataArray[i] - 128);
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
    if (this.noiseGateCtx && this.noiseGateCtx.state !== 'closed') {
      this.noiseGateCtx.close().catch(() => {});
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
    if (this.inputVolumeCtx && this.inputVolumeCtx.state !== 'closed') {
      this.inputVolumeCtx.close().catch(() => {});
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
              const K =
                tierConfig.maxBitrate < 64_000 ? 4 : tierConfig.maxBitrate < 128_000 ? 2.5 : 1.5;
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
   * Calculate recommended bitrate based on resolution, FPS, and codec.
   */
  private calculateRecommendedBitrate(
    vs: ReturnType<typeof useVideoSettingsStore.getState>
  ): number {
    const resMap: Record<string, { w: number; h: number }> = {
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
      source: { w: 1920, h: 1080 },
    };
    const parsed = vs.screenResolution.match(/^(\d+)x(\d+)$/);
    const res = parsed
      ? { w: Number(parsed[1]), h: Number(parsed[2]) }
      : resMap[vs.screenResolution] || resMap['1080p'];
    const effectiveFps = vs.screenFrameRate === 0 ? 60 : vs.screenFrameRate;
    // Effective codec: active (in-use) > preferred > auto-pick (check if any efficient codec is available)
    const activeCodec = useVoiceStore.getState().activeScreenCodec;
    const effectiveCodec = activeCodec ?? vs.preferredVideoCodec;
    const isEfficient = effectiveCodec
      ? effectiveCodec.includes('AV1') ||
        effectiveCodec.includes('H265') ||
        effectiveCodec.includes('HEVC') ||
        effectiveCodec.includes('VP9')
      : vs.codecCapabilities.some(
          (c) =>
            c.mimeType.includes('AV1') ||
            c.mimeType.includes('H265') ||
            c.mimeType.includes('HEVC') ||
            c.mimeType.includes('VP9')
        );
    const bpp = isEfficient ? 0.04 : 0.07;
    const bps = res.w * res.h * effectiveFps * bpp;
    return Math.max(1_500_000, Math.min(30_000_000, Math.round(bps / 100_000) * 100_000));
  }

  /**
   * Pick the best codec for camera video.
   * User preference → AV1 (SVC) → HEVC (SVC) → VP9 (SVC) → H264 (simulcast) → VP8 (simulcast)
   */
  private pickCameraCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
  } {
    const vs = useVideoSettingsStore.getState();
    const preset = VIDEO_QUALITY_PRESETS[vs.cameraPreset] || VIDEO_QUALITY_PRESETS['720p30'];
    const prio = vs.cameraPriority;
    const svcMode = vs.scalabilityMode === 'auto' ? 'L3T3' : vs.scalabilityMode;

    // Base encoding params: priority for DSCP marking (skip when 'off')
    const base: Partial<mediasoupTypes.RtpEncodingParameters> =
      prio === 'off'
        ? {}
        : {
            priority: prio,
            networkPriority: prio,
          };

    const isSvcCodec = (mime: string) =>
      mime.includes('AV1') ||
      mime.includes('H265') ||
      mime.includes('HEVC') ||
      mime.includes('VP9');

    const makeSvc = (codec: mediasoupTypes.RtpCodecCapability) => ({
      codec,
      encodings: [{ ...base, scalabilityMode: svcMode, maxBitrate: preset.maxBitrate }],
    });
    const makeSimulcast = (codec?: mediasoupTypes.RtpCodecCapability) => ({
      codec,
      encodings: [
        { ...base, maxBitrate: Math.round(preset.maxBitrate * 0.1), scaleResolutionDownBy: 4 },
        { ...base, maxBitrate: Math.round(preset.maxBitrate * 0.33), scaleResolutionDownBy: 2 },
        { ...base, maxBitrate: preset.maxBitrate },
      ],
    });

    // Check user's preferred codec first — only if floor-compatible
    const preferred = vs.preferredVideoCodec;
    if (preferred && this.isInCodecFloor(preferred)) {
      const codec = this.findSendCodec(preferred);
      if (codec) {
        return isSvcCodec(preferred) ? makeSvc(codec) : makeSimulcast(codec);
      }
    }

    // Priority cascade: AV1 → HEVC → VP9 (HDR if enabled) → VP9 → H264 → VP8
    // When HW accel is on, first pass tries only HW-accelerated codecs.
    // If no HW codec is floor-compatible, second pass tries all codecs (SW fallback).
    const hwAccel = vs.hardwareAcceleration;
    const hdrEncoding = vs.hdrEncoding;
    const codecCascade: { mime: string; alt?: string; svc: boolean }[] = [
      { mime: 'video/AV1', svc: true },
      { mime: 'video/H265', alt: 'video/HEVC', svc: true },
      ...(hdrEncoding ? [{ mime: 'video/VP9:2', svc: true }] : []),
      { mime: 'video/VP9', svc: true },
      { mime: 'video/H264', svc: false },
    ];

    // Pass 1: HW-only (when HW accel enabled)
    if (hwAccel) {
      for (const { mime, alt, svc } of codecCascade) {
        if (
          (this.isHwAccelerated(mime) || (alt && this.isHwAccelerated(alt))) &&
          (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt)))
        ) {
          const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
          if (codec) return svc ? makeSvc(codec) : makeSimulcast(codec);
        }
      }
    }

    // Pass 2: All codecs (SW fallback, or when HW accel disabled)
    for (const { mime, alt, svc } of codecCascade) {
      if (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt))) {
        const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
        if (codec) return svc ? makeSvc(codec) : makeSimulcast(codec);
      }
    }

    // VP8 last resort — universal support, bypasses floor
    return makeSimulcast(this.findSendCodec('video/VP8'));
  }

  /**
   * Pick the best codec for screen sharing.
   * User preference → AV1 (SVC) → HEVC (SVC) → VP9 (SVC) → H264 → VP8
   */
  private pickScreenCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
  } {
    const vs = useVideoSettingsStore.getState();
    const preferred = vs.preferredVideoCodec;
    const prio = vs.screenSharePriority;
    const svcMode = vs.scalabilityMode === 'auto' ? 'L3T3' : vs.scalabilityMode;
    const userBitrate = vs.screenShareBitrate; // 0 = auto

    // Base encoding params: priority for DSCP marking (skip when 'off')
    const base: Partial<mediasoupTypes.RtpEncodingParameters> =
      prio === 'off'
        ? {}
        : {
            priority: prio,
            networkPriority: prio,
          };

    const isSvcCodec = (mime: string) =>
      mime.includes('AV1') ||
      mime.includes('H265') ||
      mime.includes('HEVC') ||
      mime.includes('VP9');

    // Dynamic auto-bitrate: calculate based on resolution, FPS, and codec
    const autoBitrate = this.calculateRecommendedBitrate(vs);
    const bitrate = userBitrate || autoBitrate;

    // User preference — only if floor-compatible
    if (preferred && this.isInCodecFloor(preferred)) {
      const codec = this.findSendCodec(preferred);
      if (codec) {
        return isSvcCodec(preferred)
          ? { codec, encodings: [{ ...base, scalabilityMode: svcMode, maxBitrate: bitrate }] }
          : { codec, encodings: [{ ...base, maxBitrate: bitrate }] };
      }
    }

    // Priority cascade: AV1 → HEVC → VP9 (HDR if enabled) → VP9 → H264 → VP8
    // When HW accel is on, first pass tries only HW-accelerated codecs.
    // If no HW codec is floor-compatible, second pass tries all codecs (SW fallback).
    const hwAccel = vs.hardwareAcceleration;
    const hdrEncoding = vs.hdrEncoding;
    const codecCascade: { mime: string; alt?: string; svc: boolean }[] = [
      { mime: 'video/AV1', svc: true },
      { mime: 'video/H265', alt: 'video/HEVC', svc: true },
      ...(hdrEncoding ? [{ mime: 'video/VP9:2', svc: true }] : []),
      { mime: 'video/VP9', svc: true },
      { mime: 'video/H264', svc: false },
    ];

    const makeEncodings = (svc: boolean) =>
      svc
        ? [{ ...base, scalabilityMode: svcMode, maxBitrate: bitrate }]
        : [{ ...base, maxBitrate: bitrate }];

    // Pass 1: HW-only (when HW accel enabled)
    if (hwAccel) {
      for (const { mime, alt, svc } of codecCascade) {
        if (
          (this.isHwAccelerated(mime) || (alt && this.isHwAccelerated(alt))) &&
          (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt)))
        ) {
          const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
          if (codec) return { codec, encodings: makeEncodings(svc) };
        }
      }
    }

    // Pass 2: All codecs (SW fallback, or when HW accel disabled)
    for (const { mime, alt, svc } of codecCascade) {
      if (this.isInCodecFloor(mime) || (alt && this.isInCodecFloor(alt))) {
        const codec = this.findSendCodec(mime) || (alt ? this.findSendCodec(alt) : undefined);
        if (codec) return { codec, encodings: makeEncodings(svc) };
      }
    }

    // VP8 last resort — universal support, bypasses floor
    return {
      codec: this.findSendCodec('video/VP8'),
      encodings: [{ ...base, maxBitrate: bitrate }],
    };
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
          (params.encodings[0] as any).networkPriority = 'low';
        } else {
          params.encodings[0].priority = priority;
          (params.encodings[0] as any).networkPriority = priority;
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
        (enc as any).networkPriority = effectivePriority;
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
      if (bitrate > 0 && params.encodings?.[0]) {
        params.encodings[0].maxBitrate = bitrate;
        producer.rtpSender.setParameters(params).catch(() => {});
      }
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
        this.localMicStream.getTracks().forEach((t) => t.stop());
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
        this.localCameraStream.getTracks().forEach((t) => t.stop());
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
      this.localCameraStream.getTracks().forEach((t) => t.stop());
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
        const m = codec.sdpFmtpLine.match(/profile-level-id=([0-9a-fA-F]{6})/i);
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
    if (!track || track.readyState !== 'live') {
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

    const newProducer = await this.sendTransport.produce({
      track,
      encodings,
      codec,
      codecOptions: { videoGoogleStartBitrate: 300 },
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
        this.localCameraStream.getTracks().forEach((t) => t.stop());
        this.localCameraStream = null;
      }
      const s = useVoiceStore.getState();
      s.setVideoOn(false);
      const uid = useUserStore.getState().user?.id;
      if (uid) s.updateParticipant(uid, { videoStream: undefined, isVideoOn: false });
    });

    useVoiceStore.getState().setActiveCameraCodec(codec?.mimeType?.toLowerCase() ?? null);
    const hwTag = codec && this.isHwAccelerated(codec.mimeType) ? 'HW' : 'SW';
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
    if (!track || track.readyState !== 'live') {
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
    const { codec, encodings } = this.pickScreenCodec();

    const newProducer = await this.sendTransport.produce({
      track,
      encodings,
      codec,
      codecOptions: { videoGoogleStartBitrate: 1000 },
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
        this.localScreenStream.getTracks().forEach((t) => t.stop());
        this.localScreenStream = null;
      }
      const s = useVoiceStore.getState();
      s.setScreenSharing(false);
      const uid = useUserStore.getState().user?.id;
      if (uid) s.updateParticipant(uid, { screenStream: undefined, isScreenSharing: false });
    });

    useVoiceStore.getState().setActiveScreenCodec(codec?.mimeType?.toLowerCase() ?? null);
    const hwTag = codec && this.isHwAccelerated(codec.mimeType) ? 'HW' : 'SW';
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
        console.info(
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
      this.socket!.emit('update-rtp-capabilities', {
        rtpCapabilities: this.device.rtpCapabilities,
      });

      // Step 5: Create transports in parallel (no dependency between send/recv)
      this.isEncrypted = channel.is_encrypted;
      await Promise.all([this.createSendTransport(), this.createRecvTransport()]);

      // Step 6: Initialize E2EE if channel is encrypted
      if (this.isEncrypted) {
        await this.initEncryption(channel.id);
        // Add decrypt keys for existing participants
        for (const p of roomJoined.participants) {
          await this.addDecryptKeyForUser(channel.id, p.userId);
        }
        // Catch up to server epoch immediately (existing participants may be
        // encrypting at a higher keyId due to prior join/leave rotations).
        // The self-healing ratchet handles frame-level catch-up, but catching
        // up now means the first frame won't need an expensive ratchet chain.
        if (roomJoined.e2eeEpoch && this.mediaEncryption) {
          await this.mediaEncryption.catchUpToEpoch(roomJoined.e2eeEpoch);
        }
      }

      // Step 7: Set participants BEFORE consuming producers so that
      // updateParticipant calls inside consumeProducerImpl can find them.
      // Derive initial video/screen state from existingProducers so joiners
      // immediately see who has camera or screen share active.
      const producersByUser = new Map<string, { isVideoOn: boolean; isScreenSharing: boolean }>();
      for (const ep of roomJoined.existingProducers) {
        const entry = producersByUser.get(ep.userId) || {
          isVideoOn: false,
          isScreenSharing: false,
        };
        if (ep.source === 'camera') entry.isVideoOn = true;
        if (ep.source === 'screen') entry.isScreenSharing = true;
        producersByUser.set(ep.userId, entry);
      }

      const participants: VoiceParticipant[] = roomJoined.participants.map((p) => {
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
      store.setParticipants(participants);

      // Step 8: Produce audio (using pre-acquired mic stream from step 1b)
      const preAcquiredStream = await micPromise;
      await this.produceAudio(undefined, preAcquiredStream);

      // Step 8b: Set up live settings subscriptions for mid-call changes
      this.setupLiveSubscriptions();

      // Step 9: Consume existing producers (participants already in store,
      // so updateParticipant will attach streams correctly).
      // Screen shares use opt-in ("Tune In") model — add to available list instead.
      for (const producer of roomJoined.existingProducers) {
        if (producer.source === 'screen') {
          const participant = store.participants[producer.userId];
          store.addAvailableScreenShare({
            producerId: producer.producerId,
            userId: producer.userId,
            username: participant?.username || 'Unknown',
            displayName: participant?.displayName,
          });
        } else {
          await this.consumeProducer(producer.producerId, producer.userId);
        }
      }

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
    // 1. Stop all local media tracks immediately
    for (const stream of [this.localMicStream, this.localCameraStream, this.localScreenStream]) {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    }
    this.localMicStream = null;
    this.localCameraStream = null;
    this.localScreenStream = null;

    // 2. Close all producers (sync)
    for (const [, producer] of this.producers) {
      try {
        producer.close();
      } catch {
        /* ignore */
      }
    }
    this.producers.clear();

    // 3. Close all consumers
    for (const [, consumer] of this.consumers) {
      try {
        consumer.close();
      } catch {
        /* ignore */
      }
    }
    this.consumers.clear();
    this.consumerMeta.clear();

    // 4. Close transports (sync)
    try {
      this.sendTransport?.close();
    } catch {
      /* ignore */
    }
    try {
      this.recvTransport?.close();
    } catch {
      /* ignore */
    }
    this.sendTransport = null;
    this.recvTransport = null;

    // 5. Stop timers and subscriptions
    this.stopLocalVAD();
    this.stopPacketLossMonitor();
    this.teardownLiveSubscriptions();
    if (this.decoderProfilingTimer) {
      clearInterval(this.decoderProfilingTimer);
      this.decoderProfilingTimer = null;
    }

    // 6. Destroy E2EE
    this.mediaEncryption?.destroy();
    this.mediaEncryption = null;
    this.isEncrypted = false;

    // 7. Disconnect socket (fire-and-forget)
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;

    // 8. Reset device and consume queue
    this.device = null;
    this.consumeQueue = Promise.resolve();

    // 9. Reset store
    useVoiceStore.getState().clearAvailableScreenShares();
    useVoiceStore.getState().reset();
  }

  // ─── Audio Producer ────────────────────────────────────────────────

  /**
   * Pre-acquire the mic stream so getUserMedia latency overlaps with
   * socket connection, room join, and transport creation.
   */
  private async acquireMicStream(): Promise<MediaStream | null> {
    try {
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
        preAcquiredStream.getTracks().forEach((t) => t.stop());
      }

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

    // Resolve effective Opus settings based on basic/advanced mode
    const effectiveFec = adv.advancedMode ? adv.inlineFec : tierConfig.opusFec;

    // DTX: in basic mode, tier controls; in advanced mode, user overrides
    const effectiveDtx = adv.advancedMode
      ? adv.silenceDetection || tierConfig.opusDtx
      : tierConfig.opusDtx;

    // Stereo: in basic mode, tier controls; in advanced mode, user can override
    const effectiveStereo =
      adv.advancedMode && adv.stereoOverride !== null ? adv.stereoOverride : tierConfig.opusStereo;

    // Frame size resolution:
    //   0 (Default) → use tier's preferredFrameSize
    //   Explicit value → respect user's choice (advanced mode only)
    //   adaptivePtime → use tier default as starting target
    let effectiveFrameSize: number;
    if (adv.adaptivePtime) {
      effectiveFrameSize = tierConfig.preferredFrameSize;
    } else if (!adv.advancedMode || adv.frameSize === 0) {
      effectiveFrameSize = tierConfig.preferredFrameSize;
    } else {
      effectiveFrameSize = adv.frameSize;
    }

    const audioPrioParams =
      adv.audioPriority === 'off'
        ? {}
        : {
            priority: adv.audioPriority,
            networkPriority: adv.audioPriority,
          };
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
        this.localMicStream.getTracks().forEach((t) => t.stop());
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
        ...(!isSystemDefault
          ? [
              {
                video: {
                  width: { ideal: preset.width },
                  height: { ideal: preset.height },
                  frameRate: { ideal: preset.frameRate },
                },
              },
            ]
          : []),
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
            constraints !== fallbackChain[fallbackChain.length - 1]
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

      const producer = await this.sendTransport.produce({
        track,
        encodings,
        codec,
        codecOptions: {
          videoGoogleStartBitrate: 300,
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
      if (localUserId) {
        store.updateParticipant(localUserId, {
          videoStream: this.localCameraStream!,
          isVideoOn: true,
        });
      }

      if (this.isEncrypted && this.mediaEncryption) {
        this.applyEncryptTransform(producer);
      }

      producer.on('transportclose', () => {
        this.producers.delete('camera');
        if (this.localCameraStream) {
          this.localCameraStream.getTracks().forEach((t) => t.stop());
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
        this.localCameraStream.getTracks().forEach((t) => t.stop());
        this.localCameraStream = null;
      }
      const errMsg =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera access denied. Check your browser or system permissions.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No camera found. Check that your camera is connected.'
            : 'Could not start camera. Try a different camera or video preset in Settings.';
      voiceState.setVideoSlotError(errMsg);
    }
  }

  /** Produce screen share — AV1 SVC preferred (best compression for static content), VP9 fallback */
  async produceScreen(sourceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) {
      console.warn('produceScreen: no sendTransport or device — cannot share screen');
      return;
    }

    // Read screen share quality settings
    const screenSettings = useVideoSettingsStore.getState();
    const screenFps = screenSettings.screenFrameRate === 0 ? 60 : screenSettings.screenFrameRate; // 0 = Native, use 60 as capture max
    const resMap: Record<string, { w: number; h: number }> = {
      source: { w: 3840, h: 2160 },
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
    };
    // Parse custom WxH display resolutions
    const customParsed = screenSettings.screenResolution.match(/^(\d+)x(\d+)$/);
    const screenRes = customParsed
      ? { w: Number(customParsed[1]), h: Number(customParsed[2]) }
      : resMap[screenSettings.screenResolution] || resMap['source'];

    // Use Electron desktopCapturer if available
    let stream: MediaStream;
    if (window.electron?.getDesktopSources) {
      // sourceId should come from ScreenSharePicker; fallback to first screen
      let chosenId = sourceId;
      if (!chosenId) {
        const sources = await window.electron.getDesktopSources();
        if (sources.length === 0) throw new Error('No screen sources available');
        chosenId = sources.find((s) => s.id.startsWith('screen:'))?.id || sources[0].id;
      }
      console.debug('produceScreen: capturing desktop source', chosenId);
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
    } else {
      console.debug('produceScreen: using getDisplayMedia fallback');
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: screenRes.w },
          height: { ideal: screenRes.h },
          frameRate: { ideal: screenFps },
        },
        audio: false,
      });
    }

    const videoTracks = stream.getVideoTracks();
    if (videoTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Screen capture returned no video tracks');
    }

    const track = videoTracks[0];

    // Apply content hint for screen share optimization
    if (screenSettings.screenContentType === 'motion') {
      track.contentHint = 'motion';
    } else if (screenSettings.screenContentType === 'detail') {
      track.contentHint = 'detail';
    }
    // 'auto' → don't set contentHint, let the browser decide

    // Wrap produce in try/catch so we can clean up the stream on failure
    try {
      const { codec, encodings } = this.pickScreenCodec();

      const producer = await this.sendTransport.produce({
        track,
        encodings,
        codec,
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
        appData: { source: 'screen' },
      });

      // Apply degradation preference on the RTP sender
      this.applyDegradationPreference(producer);

      this.localScreenStream = stream;
      this.producers.set('screen', producer);

      // Track active codec for settings UI
      useVoiceStore.getState().setActiveScreenCodec(codec?.mimeType?.toLowerCase() ?? null);

      // Update store: both global flag and local participant's screen stream
      const store = useVoiceStore.getState();
      store.setScreenSharing(true);
      const localUserId = useUserStore.getState().user?.id;
      if (localUserId) {
        store.updateParticipant(localUserId, {
          screenStream: this.localScreenStream!,
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

      // Handle user stopping screen share via browser UI
      track.onended = () => {
        this.closeProducer('screen');
      };

      producer.on('transportclose', () => {
        this.producers.delete('screen');
        if (this.localScreenStream) {
          this.localScreenStream.getTracks().forEach((t) => t.stop());
          this.localScreenStream = null;
        }
        const s = useVoiceStore.getState();
        s.setScreenSharing(false);
        const uid = useUserStore.getState().user?.id;
        if (uid) s.updateParticipant(uid, { screenStream: undefined, isScreenSharing: false });
      });
    } catch (err) {
      // Clean up stream tracks if produce failed
      stream.getTracks().forEach((t) => t.stop());
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

  /** Toggle screen share. Pass sourceId from ScreenSharePicker for Electron. */
  async toggleScreenShare(sourceId?: string): Promise<void> {
    const store = useVoiceStore.getState();
    console.debug('toggleScreenShare:', { isScreenSharing: store.isScreenSharing, sourceId });
    if (store.isScreenSharing) {
      await this.closeProducer('screen');
    } else {
      await this.produceScreen(sourceId);
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
    if (!producer || !producer.paused) return;
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
    await this.consumeProducer(producerId, userId);

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
  }

  /** Opt-out of a tuned-in screen share */
  async tuneOutOfScreenShare(producerId: string): Promise<void> {
    const store = useVoiceStore.getState();
    const consumerId = store.tunedInScreenShares[producerId];

    // Close the consumer
    if (consumerId) {
      const consumer = this.consumers.get(consumerId);
      if (consumer) {
        consumer.close();
        this.consumers.delete(consumerId);
        this.consumerMeta.delete(consumerId);
      }
    }

    // Find the producing user to update their participant state
    const participants = store.participants;
    let producerUserId: string | undefined;
    for (const [uid, p] of Object.entries(participants)) {
      if (p.screenStream) {
        // Check if this participant's screen stream matches
        producerUserId = uid;
        break;
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
    if (consumer && consumer.paused) {
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
    if (!this.sendTransport || this.sendTransport.closed) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.sendTransport as any)._awaitQueue.push(async () => {
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
        this.localMicStream.getTracks().forEach((t) => t.stop());
        this.localMicStream = null;
      }
    } else if (source === 'camera') {
      if (this.localCameraStream) {
        this.localCameraStream.getTracks().forEach((t) => t.stop());
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
      if (this.localScreenStream) {
        this.localScreenStream.getTracks().forEach((t) => t.stop());
        this.localScreenStream = null;
      }
      useVoiceStore.getState().setScreenSharing(false);
      useVoiceStore.getState().setActiveScreenCodec(null);
      if (localUserId) {
        useVoiceStore
          .getState()
          .updateParticipant(localUserId, { screenStream: undefined, isScreenSharing: false });
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
    const options = await this.emitAsync<TransportOptions>('create-transport', {
      direction: 'send',
    });

    this.sendTransport = this.device!.createSendTransport({
      id: options.id,
      iceParameters: options.iceParameters,
      iceCandidates: options.iceCandidates,
      dtlsParameters: options.dtlsParameters,
      ...(this.isEncrypted && {
        additionalSettings: {
          encodedInsertableStreams: true,
        } as unknown as Partial<RTCConfiguration>,
      }),
    });

    this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.emitAsync('connect-transport', {
        transportId: this.sendTransport!.id,
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
            transportId: this.sendTransport!.id,
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
  }

  private async createRecvTransport(): Promise<void> {
    const options = await this.emitAsync<TransportOptions>('create-transport', {
      direction: 'recv',
    });

    this.recvTransport = this.device!.createRecvTransport({
      id: options.id,
      iceParameters: options.iceParameters,
      iceCandidates: options.iceCandidates,
      dtlsParameters: options.dtlsParameters,
      ...(this.isEncrypted && {
        additionalSettings: {
          encodedInsertableStreams: true,
        } as unknown as Partial<RTCConfiguration>,
      }),
    });

    this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.emitAsync('connect-transport', {
        transportId: this.recvTransport!.id,
        dtlsParameters,
      })
        .then(() => callback())
        .catch(errback);
    });
  }

  // ─── Consumer Management ───────────────────────────────────────────

  /**
   * Queue a consume operation. This serializes all consume calls to prevent
   * concurrent SDP negotiations that cause "Duplicate a=mid value" errors.
   */
  private async consumeProducer(producerId: string, senderUserId?: string): Promise<void> {
    this.consumeQueue = this.consumeQueue
      .then(() => this.consumeProducerImpl(producerId, senderUserId))
      .catch((err) => {
        console.error('Consume queue error:', err);
      });
    await this.consumeQueue;
  }

  private async consumeProducerImpl(producerId: string, senderUserId?: string): Promise<void> {
    if (!this.recvTransport || !this.device) {
      console.warn('[consume] skipped — no recvTransport or device', { producerId });
      return;
    }

    try {
      console.debug('[consume] requesting', { producerId, senderUserId });
      const result = await this.emitAsync<ConsumeResponse>('consume', { producerId });
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

      const consumer = await this.recvTransport.consume({
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

      if (result.kind === 'audio') {
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

    this.socket.on(
      'new-producer',
      async ({ producerId, userId, kind: _kind, source, requiresOptIn }) => {
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

        await this.consumeProducer(producerId, userId);
        if (source === 'camera') store.updateParticipant(userId, { isVideoOn: true });
        if (source === 'screen') store.updateParticipant(userId, { isScreenSharing: true });
      }
    );

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
          this.mediaEncryption.debouncedRotateKeys();
        }
      }

      // Solo bandwidth saving: exit solo mode when someone joins
      this.checkSoloBandwidthSaving();
    });

    this.socket.on('user-left', async ({ userId }) => {
      useVoiceStore.getState().removeParticipant(userId);

      // E2EE: rotate keys when a member leaves (forward secrecy)
      if (this.isEncrypted && this.mediaEncryption) {
        this.mediaEncryption.debouncedRotateKeys();
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
        console.info(
          `E2EE epoch sync: local=${localEpoch}, server=${epoch}, catching up ${gap} steps`
        );
        try {
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

          // Average decode time per frame (ms)
          const avgDecodeMs = (totalDecodeTime / framesDecoded) * 1000;
          // p95 estimate ≈ 1.5× average
          const p95DecodeMs = avgDecodeMs * 1.5;
          // Load ratio (rho)
          const rho = (p95DecodeMs * currentFps) / 1000;

          // currentLayers / setPreferredLayers are SFU-side extensions not
          // present in the mediasoup-client type definitions, so cast to any.
          const consumerAny = consumer as any;
          const currentLayers: { spatialLayer: number; temporalLayer: number } | undefined =
            consumerAny.currentLayers;

          if (rho >= 0.925) {
            // RED zone — critical decoder load
            worstZone = 'red';
            if (currentLayers && currentLayers.spatialLayer > 0) {
              consumerAny.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer - 1,
                temporalLayer: currentLayers.temporalLayer,
              });
              console.warn(
                `IGNIS RED: lowering spatial layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`
              );
            } else if (currentLayers && currentLayers.temporalLayer > 0) {
              consumerAny.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.warn(
                `IGNIS RED: lowering temporal layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)})`
              );
            } else {
              // Already at lowest layers — pause lowest-priority consumer.
              // Prefer pausing camera consumers over screen share consumers.
              const tunedIn = useVoiceStore.getState().tunedInScreenShares;
              const isScreenShare = Object.values(tunedIn).includes(consumer.id);
              if (isScreenShare) {
                // Try to find a camera consumer to pause instead
                let pausedCamera = false;
                for (const [, c] of this.consumers) {
                  if (c.kind === 'video' && !c.paused && !Object.values(tunedIn).includes(c.id)) {
                    c.pause();
                    console.warn(
                      `IGNIS RED: pausing camera consumer ${c.id} instead of screen share ${consumer.id}`
                    );
                    pausedCamera = true;
                    break;
                  }
                }
                if (!pausedCamera) {
                  consumer.pause();
                  console.warn(
                    `IGNIS RED: pausing screen share consumer ${consumer.id} — no camera to demote`
                  );
                }
              } else {
                consumer.pause();
                console.warn(
                  `IGNIS RED: pausing camera consumer ${consumer.id} — no layers to reduce`
                );
              }
            }
          } else if (rho >= 0.8) {
            // YELLOW zone — approaching limit
            if (worstZone !== 'red') worstZone = 'yellow';
            if (currentLayers && currentLayers.temporalLayer > 0) {
              consumerAny.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.info(
                `IGNIS YELLOW: lowering temporal layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`
              );
            }
          }
          // GREEN zone (rho < 0.67) — no intervention needed
        }
      } catch {
        // Stats not available — skip
      }
    }

    useVoiceStore.getState().setDecoderHealth(worstZone);
  }

  // ─── E2EE ─────────────────────────────────────────────────────

  /** Initialize media encryption for an encrypted channel (fail-closed with retry) */
  private async initEncryption(channelId: string): Promise<void> {
    const retryDelays = [500, 1000, 2000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const channelCSK = await e2eeService.getChannelKey(channelId);
        const userId = useUserStore.getState().user?.id;
        if (!userId) throw new Error('No local userId for E2EE init');

        this.mediaEncryption = new MediaEncryption();
        await this.mediaEncryption.init(channelCSK, userId);
        console.info('E2EE: encryption initialized', {
          channelId,
          userId,
          attempt: attempt + 1,
        });
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
          // Wait longer for pending keys (distribution in progress)
          const delay = isPending ? retryDelays[attempt] * 2 : retryDelays[attempt];
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries exhausted — fail-closed: re-throw so join flow aborts
    this.mediaEncryption = null;
    throw lastError instanceof Error
      ? lastError
      : new Error(
          'E2EE: failed to initialize encryption after retries' +
            (lastError != null ? ` (${String(lastError)})` : '')
        );
  }

  /** Add a decryption key for a remote user, pre-ratcheted to current epoch (with retry) */
  private async addDecryptKeyForUser(channelId: string, userId: string): Promise<boolean> {
    if (!this.mediaEncryption) return false;

    const retryDelays = [500, 1000, 2000];
    let lastError: unknown;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      // Re-check: encryption may have been torn down during sleep/await
      if (!this.mediaEncryption) return false;
      try {
        const channelCSK = await e2eeService.getChannelKey(channelId);
        if (!this.mediaEncryption) return false; // Torn down during await
        const currentEpoch = this.mediaEncryption.getCurrentKeyId();
        if (currentEpoch > 0) {
          await this.mediaEncryption.addDecryptKeyAtEpoch(channelCSK, userId, currentEpoch);
        } else {
          await this.mediaEncryption.addDecryptKey(channelCSK, userId);
        }
        console.info('E2EE: decrypt key added', {
          channelId,
          targetUserId: userId,
          currentEpoch,
          attempt: attempt + 1,
        });
        return true;
      } catch (err) {
        lastError = err;
        const isPending = err instanceof Error && err.message === 'PENDING_KEY';
        if (attempt < retryDelays.length) {
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
   * Apply Insertable Streams encrypt transform to a producer.
   * Tries RTCRtpScriptTransform (modern, Chrome 118+) first,
   * falls back to createEncodedStreams (legacy, Chrome 86-130).
   */
  private applyEncryptTransform(producer: mediasoupTypes.Producer): void {
    if (!this.mediaEncryption) return;

    const sender = producer.rtpSender;
    if (!sender) {
      console.warn('E2EE: no rtpSender on producer — frames will not be encrypted');
      return;
    }

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
                console.info('E2EE: first frame encrypted successfully', {
                  kind: 'type' in frame ? 'video' : 'audio',
                  dataSize: frame.data.byteLength,
                });
              }
              if (encryptDropCount > 0) {
                console.info(`E2EE: encrypt recovered after ${encryptDropCount} dropped frames`);
                encryptDropCount = 0;
              }
            } catch (err) {
              // Encrypt failed — DROP the frame to avoid sending unencrypted
              // plaintext on an encrypted channel. Silence/blank is correct.
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
        console.info('E2EE: encrypt transform applied');
      } catch (err) {
        console.error('E2EE: createEncodedStreams failed on sender:', err);
      }
    } else {
      console.warn('E2EE: Insertable Streams API not available — frames will not be encrypted');
    }
  }

  /**
   * Apply Insertable Streams decrypt transform to a consumer.
   * With magic-byte detection, unencrypted frames pass through safely.
   */
  private applyDecryptTransform(consumer: mediasoupTypes.Consumer, senderUserId: string): void {
    if (!this.mediaEncryption) return;

    const receiver = consumer.rtpReceiver;
    if (!receiver) {
      console.warn('E2EE: no rtpReceiver on consumer — frames will not be decrypted');
      return;
    }

    const encryption = this.mediaEncryption;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiverAny = receiver as any;

    // Self-healing recovery state (captured by transform closure)
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const voiceSvc = this;
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
          async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
            try {
              await encryption.decryptFrame(frame, senderUserId);
              controller.enqueue(frame);
              // Log first successful decrypt per sender
              if (!firstDecryptLogged) {
                firstDecryptLogged = true;
                console.info(`E2EE: first frame decrypted for ${senderUserId}`);
              }
              // Reset drop counter on success
              if (dropCount > 0) {
                console.info(
                  `E2EE: decrypt recovered after ${dropCount} dropped frames for ${senderUserId}`
                );
                dropCount = 0;
              }
            } catch (decryptErr) {
              dropCount++;
              if (dropCount === 1 || dropCount % 100 === 0) {
                console.warn(
                  `E2EE: dropping undecryptable frame for ${senderUserId} (total dropped: ${dropCount})`,
                  {
                    error: decryptErr instanceof Error ? decryptErr.message : String(decryptErr),
                    frameSize: frame.data.byteLength,
                    localEpoch: encryption.getCurrentKeyId(),
                  }
                );
              }

              // Self-healing: after threshold, attempt to re-derive decrypt key
              if (
                dropCount === RECOVERY_THRESHOLD &&
                !recoveryInProgress &&
                Date.now() - lastRecoveryAttempt > RECOVERY_COOLDOWN_MS
              ) {
                recoveryInProgress = true;
                lastRecoveryAttempt = Date.now();
                const channelId = useVoiceStore.getState().activeChannelId;
                if (channelId && voiceSvc.mediaEncryption) {
                  console.info(`E2EE: attempting self-healing key recovery for ${senderUserId}`);
                  e2eeService.invalidateChannelKey(channelId);
                  voiceSvc
                    .addDecryptKeyForUser(channelId, senderUserId)
                    .then((ok) => {
                      if (ok) {
                        console.info(`E2EE: recovery key re-derived for ${senderUserId}`);
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
        console.info(`E2EE: decrypt transform applied for ${senderUserId}`);
      } catch (err) {
        console.error('E2EE: createEncodedStreams failed on receiver:', err);
      }
    } else {
      console.warn('E2EE: Insertable Streams API not available — frames will not be decrypted');
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
      if (stream) stream.getTracks().forEach((t) => t.stop());
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

    // Close transports
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;

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
    this.mediaEncryption?.destroy();
    this.mediaEncryption = null;
    this.isEncrypted = false;

    // Clear screen share opt-in list
    useVoiceStore.getState().clearAvailableScreenShares();

    // Reset consume queue so pending consumes from the old session don't
    // interfere with the next join.
    this.consumeQueue = Promise.resolve();

    // Disconnect socket
    this.socket?.disconnect();
    this.socket = null;

    // Reset device
    this.device = null;
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
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    voiceService.emergencyCleanup();
  });
}
