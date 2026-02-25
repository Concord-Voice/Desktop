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
import { useVoiceStore, AUDIO_QUALITY_TIERS } from '../stores/voiceStore';
import type { AudioQualityTier, VoiceParticipant } from '../stores/voiceStore';
import { useAudioSettingsStore } from '../stores/audioSettingsStore';
import { useVideoSettingsStore, VIDEO_QUALITY_PRESETS } from '../stores/videoSettingsStore';
import { API_BASE, apiFetch } from './apiClient';
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

  // Packet loss monitor
  private packetLossTimer: ReturnType<typeof setInterval> | null = null;
  private lastPacketsLost = 0;
  private lastPacketsSent = 0;

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

  // ─── Packet loss monitor ─────────────────────────────────────────

  /**
   * Poll outbound-rtp + remote-inbound-rtp stats every 5s to measure packet loss.
   * When fecMode='auto', dynamically adjusts FEC parameters on the mic producer.
   * Baseline FEC: WiFi=20%, Wired=5%. Loss > threshold → packetLossWarning in store.
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

        // Dynamic FEC adjustment (auto mode only)
        if (adv.fecMode === 'auto' && micProducer.rtpSender) {
          const params = micProducer.rtpSender.getParameters();
          if (params.encodings?.[0]) {
            // Detect network type for baseline
            const conn = (navigator as { connection?: { type?: string } }).connection;
            const networkType = adv.networkType === 'auto'
              ? (conn?.type === 'ethernet' ? 'wired' : 'wifi')
              : adv.networkType;
            const baselineFec = networkType === 'wired' ? 5 : 20;

            // Scale FEC proportionally to loss, capped at 100%
            const targetFecPercent = Math.min(100, baselineFec + lossPercent * 3);

            // Apply via maxBitrate adjustment (increase bitrate budget for FEC overhead)
            const tier = useVoiceStore.getState().effectiveQualityTier;
            const tierConfig = AUDIO_QUALITY_TIERS[tier];
            const fecOverhead = 1 + targetFecPercent / 100;
            params.encodings[0].maxBitrate = Math.round(tierConfig.maxBitrate * fecOverhead);
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
   * Returns the RtpCodecCapability matching the given mimeType, or undefined.
   */
  private findSendCodec(mimeType: string): mediasoupTypes.RtpCodecCapability | undefined {
    if (!this.device?.rtpCapabilities?.codecs) return undefined;
    return this.device.rtpCapabilities.codecs.find(
      (c) => c.mimeType.toLowerCase() === mimeType.toLowerCase() && c.kind === 'video'
    );
  }

  /**
   * Pick the best codec for camera video.
   * User preference → VP9 (SVC L3T3) → H264 (simulcast) → VP8 (simulcast)
   */
  private pickCameraCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
  } {
    const preset = VIDEO_QUALITY_PRESETS[useVideoSettingsStore.getState().cameraPreset]
      || VIDEO_QUALITY_PRESETS['720p30'];

    // Check user's preferred codec first
    const preferred = useVideoSettingsStore.getState().preferredVideoCodec;
    if (preferred) {
      const codec = this.findSendCodec(preferred);
      if (codec) {
        // SVC-capable codecs get L3T3, others get simulcast
        const isSvc = preferred.includes('VP9') || preferred.includes('AV1');
        return isSvc
          ? { codec, encodings: [{ scalabilityMode: 'L3T3', maxBitrate: preset.maxBitrate }] }
          : { codec, encodings: [
              { maxBitrate: Math.round(preset.maxBitrate * 0.1), scaleResolutionDownBy: 4 },
              { maxBitrate: Math.round(preset.maxBitrate * 0.33), scaleResolutionDownBy: 2 },
              { maxBitrate: preset.maxBitrate },
            ] };
      }
    }

    // Auto selection: VP9 with SVC — single stream, 3 spatial + 3 temporal layers
    const vp9 = this.findSendCodec('video/VP9');
    if (vp9) {
      return {
        codec: vp9,
        encodings: [{ scalabilityMode: 'L3T3', maxBitrate: preset.maxBitrate }],
      };
    }

    // H264 with simulcast — 3 layers at different resolutions
    const h264 = this.findSendCodec('video/H264');
    if (h264) {
      return {
        codec: h264,
        encodings: [
          { maxBitrate: Math.round(preset.maxBitrate * 0.1), scaleResolutionDownBy: 4 },
          { maxBitrate: Math.round(preset.maxBitrate * 0.33), scaleResolutionDownBy: 2 },
          { maxBitrate: preset.maxBitrate },
        ],
      };
    }

    // VP8 fallback with simulcast
    return {
      codec: this.findSendCodec('video/VP8'),
      encodings: [
        { maxBitrate: Math.round(preset.maxBitrate * 0.1), scaleResolutionDownBy: 4 },
        { maxBitrate: Math.round(preset.maxBitrate * 0.33), scaleResolutionDownBy: 2 },
        { maxBitrate: preset.maxBitrate },
      ],
    };
  }

  /**
   * Pick the best codec for screen sharing.
   * User preference → AV1 (SVC, best compression) → VP9 (SVC) → H264
   */
  private pickScreenCodec(): {
    codec?: mediasoupTypes.RtpCodecCapability;
    encodings: mediasoupTypes.RtpEncodingParameters[];
  } {
    // Check user's preferred screen share codec
    const preferred = useVideoSettingsStore.getState().preferredScreenCodec;
    if (preferred) {
      const codec = this.findSendCodec(preferred);
      if (codec) {
        const isSvc = preferred.includes('VP9') || preferred.includes('AV1');
        return isSvc
          ? { codec, encodings: [{ scalabilityMode: 'L3T3', maxBitrate: 8_000_000 }] }
          : { codec, encodings: [{ maxBitrate: 5_000_000 }] };
      }
    }

    // AV1 with SVC — ideal for screen share (huge compression gains on static content)
    const av1 = this.findSendCodec('video/AV1');
    if (av1) {
      return {
        codec: av1,
        encodings: [{ scalabilityMode: 'L3T3', maxBitrate: 8_000_000 }],
      };
    }

    // VP9 with SVC fallback
    const vp9 = this.findSendCodec('video/VP9');
    if (vp9) {
      return {
        codec: vp9,
        encodings: [{ scalabilityMode: 'L3T3', maxBitrate: 5_000_000 }],
      };
    }

    // H264 fallback — no SVC, generous bitrate
    return {
      codec: this.findSendCodec('video/H264'),
      encodings: [{ maxBitrate: 5_000_000 }],
    };
  }

  // Decoder budget profiling
  private decoderProfilingTimer: ReturnType<typeof setInterval> | null = null;

  // ─── Join / Leave ──────────────────────────────────────────────────

  /** Authorize and join a voice channel */
  async joinChannel(channelId: string): Promise<void> {
    const store = useVoiceStore.getState();
    if (store.activeChannelId) {
      await this.leaveChannel();
    }

    store.setConnectionState('connecting');

    try {
      // Step 1: Authorize via control plane (uses apiFetch for automatic token refresh)
      const res = await apiFetch(`/api/v1/channels/${channelId}/voice/join`, {
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

      // Resolve effective quality tier: channel override takes priority over personal setting
      const channelTier = channel.audio_quality_tier;
      const validTiers = ['voice', 'standard', 'high', 'hifi', 'studio'];
      if (channelTier && validTiers.includes(channelTier)) {
        store.setEffectiveQualityTier(channelTier as AudioQualityTier);
      } else {
        store.setEffectiveQualityTier(store.qualityTier);
      }

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

      // Step 5: Create transports (with encodedInsertableStreams for E2EE)
      this.isEncrypted = channel.is_encrypted;
      await this.createSendTransport();
      await this.createRecvTransport();

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
        const entry = producersByUser.get(ep.userId) || { isVideoOn: false, isScreenSharing: false };
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

      // Step 8: Produce audio
      await this.produceAudio();

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

  // ─── Audio Producer ────────────────────────────────────────────────

  async produceAudio(deviceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    // Read advanced audio settings
    const adv = useAudioSettingsStore.getState();

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: adv.echoCancellation,
        noiseSuppression: adv.noiseCancellation,
        autoGainControl: adv.autoGainControl,
        sampleRate: 48000,
        channelCount: 2,
      },
    };

    this.localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.localMicStream.getAudioTracks()[0];

    const tier = useVoiceStore.getState().effectiveQualityTier;
    const tierConfig = AUDIO_QUALITY_TIERS[tier];

    // Resolve effective Opus settings: advanced overrides tier defaults
    const effectiveDtx = adv.silenceDetection || tierConfig.opusDtx;
    const effectiveFec = adv.fecMode === 'manual' ? adv.fecManualPercent > 0 : tierConfig.opusFec;
    const effectiveFrameSize = adv.frameSize !== 20 ? adv.frameSize : tierConfig.frameSize;

    const producer = await this.sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: tierConfig.opusStereo,
        opusDtx: effectiveDtx,
        opusFec: effectiveFec,
        opusMaxAverageBitrate: tierConfig.maxBitrate,
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

    // Read video settings for camera preset
    const videoSettings = useVideoSettingsStore.getState();
    const preset = VIDEO_QUALITY_PRESETS[videoSettings.cameraPreset] || VIDEO_QUALITY_PRESETS['720p30'];

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
    };

    this.localCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
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

    this.producers.set('camera', producer);

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
  }

  /** Produce screen share — AV1 SVC preferred (best compression for static content), VP9 fallback */
  async produceScreen(sourceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) {
      console.warn('produceScreen: no sendTransport or device — cannot share screen');
      return;
    }

    // Read screen share quality settings
    const screenSettings = useVideoSettingsStore.getState();
    const screenFps = screenSettings.screenFrameRate;
    const resMap: Record<string, { w: number; h: number }> = {
      'source': { w: 3840, h: 2160 },
      '720p': { w: 1280, h: 720 },
      '1080p': { w: 1920, h: 1080 },
      '1440p': { w: 2560, h: 1440 },
      '4K': { w: 3840, h: 2160 },
    };
    const screenRes = resMap[screenSettings.screenResolution] || resMap['source'];

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
        video: { width: { ideal: screenRes.w }, height: { ideal: screenRes.h }, frameRate: { ideal: screenFps } },
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

      this.localScreenStream = stream;
      this.producers.set('screen', producer);

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

  /** Pause a consumer (for soft-pause when section is hidden) */
  pauseConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer && !consumer.paused) {
      consumer.pause();
    }
  }

  /** Resume a consumer (for soft-resume when section is shown) */
  resumeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer && consumer.paused) {
      consumer.resume();
    }
  }

  /** Close a specific producer by source */
  async closeProducer(source: string): Promise<void> {
    const producer = this.producers.get(source);

    if (producer) {
      producer.close();
      this.producers.delete(source);
      this.socket?.emit('close-producer', { producerId: producer.id });
    }

    // Always clean up local tracks and reset state, even if no producer exists.
    // This prevents state from getting stuck (e.g. isScreenSharing=true with no producer).
    const localUserId = useUserStore.getState().user?.id;
    if (source === 'mic') {
      this.stopLocalVAD();
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
      if (localUserId) {
        useVoiceStore.getState().updateParticipant(localUserId, { videoStream: undefined, isVideoOn: false });
      }
    } else if (source === 'screen') {
      if (this.localScreenStream) {
        this.localScreenStream.getTracks().forEach((t) => t.stop());
        this.localScreenStream = null;
      }
      useVoiceStore.getState().setScreenSharing(false);
      if (localUserId) {
        useVoiceStore.getState().updateParticipant(localUserId, { screenStream: undefined, isScreenSharing: false });
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
        additionalSettings: { encodedInsertableStreams: true },
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

    this.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
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
    });
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
        additionalSettings: { encodedInsertableStreams: true },
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
    this.consumeQueue = this.consumeQueue.then(() =>
      this.consumeProducerImpl(producerId, senderUserId)
    ).catch((err) => {
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

      console.debug('[consume] consumer created', {
        consumerId: consumer.id,
        kind: consumer.kind,
        trackState: consumer.track.readyState,
        trackEnabled: consumer.track.enabled,
        paused: consumer.paused,
      });

      // Apply E2EE decrypt transform if encrypted
      const producerUserId = senderUserId || result.producerUserId;
      if (this.isEncrypted && this.mediaEncryption) {
        this.applyDecryptTransform(consumer, producerUserId);
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
        store.updateParticipant(result.producerUserId, { screenStream: stream, isScreenSharing: true });
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
          console.warn(`[new-producer] Video slot limit reached (${store.maxVideoSlots}), skipping camera consume for ${userId}`);
          store.updateParticipant(userId, { isVideoOn: true }); // Mark them as video-on even if we can't consume
          return;
        }
      }

      await this.consumeProducer(producerId, userId);
      if (source === 'camera') store.updateParticipant(userId, { isVideoOn: true });
      if (source === 'screen') store.updateParticipant(userId, { isScreenSharing: true });
    });

    this.socket.on('producer-paused', ({ producerId, userId }) => {
      useVoiceStore.getState().updateParticipant(userId, { isMuted: true });
    });

    this.socket.on('producer-resumed', ({ producerId, userId }) => {
      useVoiceStore.getState().updateParticipant(userId, { isMuted: false });
    });

    this.socket.on('producer-closed', ({ producerId, userId, source }) => {
      // Find and close the corresponding consumer
      for (const [consumerId, consumer] of this.consumers) {
        if (consumer.producerId === producerId) {
          consumer.close();
          this.consumers.delete(consumerId);
          break;
        }
      }

      const store = useVoiceStore.getState();
      if (source === 'camera') store.updateParticipant(userId, { isVideoOn: false, videoStream: undefined });
      else if (source === 'screen') {
        store.updateParticipant(userId, { isScreenSharing: false, screenStream: undefined });
        // Also remove from available screen shares (opt-in list)
        store.removeAvailableScreenShare(producerId);
      }
    });

    this.socket.on('user-joined', async ({ userId, username, displayName, avatarUrl }) => {
      useVoiceStore.getState().addParticipant({
        userId, username, displayName, avatarUrl,
        isMuted: false, isDeafened: false, isVideoOn: false, isScreenSharing: false,
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
    });

    this.socket.on('user-left', async ({ userId }) => {
      useVoiceStore.getState().removeParticipant(userId);

      // E2EE: rotate keys when a member leaves (forward secrecy)
      if (this.isEncrypted && this.mediaEncryption) {
        this.mediaEncryption.debouncedRotateKeys();
      }
    });

    // E2EE: periodic epoch sync — recover from missed join/leave events
    this.socket.on('epoch-sync', ({ epoch }: { epoch: number }) => {
      if (!this.isEncrypted || !this.mediaEncryption) return;
      const localEpoch = this.mediaEncryption.getCurrentKeyId();
      if (epoch > localEpoch) {
        console.info(`E2EE epoch sync: local=${localEpoch}, server=${epoch}, catching up ${epoch - localEpoch} steps`);
        this.mediaEncryption.catchUpToEpoch(epoch);
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

    this.socket.on('consumer-closed', ({ consumerId }) => {
      const consumer = this.consumers.get(consumerId);
      if (consumer) {
        consumer.close();
        this.consumers.delete(consumerId);
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('Media plane disconnected:', reason);
      if (reason === 'io server disconnect') {
        useVoiceStore.getState().setConnectionState('disconnected');
      } else {
        useVoiceStore.getState().setConnectionState('reconnecting');
      }
    });

    this.socket.on('connect', () => {
      if (useVoiceStore.getState().connectionState === 'reconnecting') {
        useVoiceStore.getState().setConnectionState('connected');
      }
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
      const interval = probeCount > maxInitialProbes ? 30_000 : 5_000;

      // Switch to slower interval after initial profiling
      if (probeCount === maxInitialProbes + 1 && this.decoderProfilingTimer) {
        clearInterval(this.decoderProfilingTimer);
        this.decoderProfilingTimer = setInterval(
          () => this.profileDecoders(),
          30_000,
        );
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

          const totalDecodeTime = (report as Record<string, unknown>).totalDecodeTime as number | undefined;
          const framesDecoded = (report as Record<string, unknown>).framesDecoded as number | undefined;
          const currentFps = (report as Record<string, unknown>).framesPerSecond as number | undefined;

          if (!totalDecodeTime || !framesDecoded || framesDecoded === 0 || !currentFps) continue;

          // Average decode time per frame (ms)
          const avgDecodeMs = (totalDecodeTime / framesDecoded) * 1000;
          // p95 estimate ≈ 1.5× average
          const p95DecodeMs = avgDecodeMs * 1.5;
          // Load ratio (rho)
          const rho = (p95DecodeMs * currentFps) / 1000;

          const currentLayers = consumer.currentLayers;

          if (rho >= 0.925) {
            // RED zone — critical decoder load
            worstZone = 'red';
            if (currentLayers && currentLayers.spatialLayer > 0) {
              consumer.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer - 1,
                temporalLayer: currentLayers.temporalLayer,
              });
              console.warn(
                `IGNIS RED: lowering spatial layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`,
              );
            } else if (currentLayers && currentLayers.temporalLayer > 0) {
              consumer.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.warn(
                `IGNIS RED: lowering temporal layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)})`,
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
                    console.warn(`IGNIS RED: pausing camera consumer ${c.id} instead of screen share ${consumer.id}`);
                    pausedCamera = true;
                    break;
                  }
                }
                if (!pausedCamera) {
                  consumer.pause();
                  console.warn(`IGNIS RED: pausing screen share consumer ${consumer.id} — no camera to demote`);
                }
              } else {
                consumer.pause();
                console.warn(`IGNIS RED: pausing camera consumer ${consumer.id} — no layers to reduce`);
              }
            }
          } else if (rho >= 0.80) {
            // YELLOW zone — approaching limit
            if (worstZone !== 'red') worstZone = 'yellow';
            if (currentLayers && currentLayers.temporalLayer > 0) {
              consumer.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.info(
                `IGNIS YELLOW: lowering temporal layer for consumer ${consumer.id}`,
                `(rho=${rho.toFixed(2)}, decode p95=${p95DecodeMs.toFixed(1)}ms, fps=${currentFps})`,
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

  /** Initialize media encryption for an encrypted channel */
  private async initEncryption(channelId: string): Promise<void> {
    try {
      const channelCSK = await e2eeService.getChannelKey(channelId);
      const userId = useUserStore.getState().user?.id;
      if (!userId) throw new Error('No local userId for E2EE init');

      this.mediaEncryption = new MediaEncryption();
      await this.mediaEncryption.init(channelCSK, userId);
    } catch (err) {
      console.error('Failed to initialize media encryption:', err);
      this.mediaEncryption = null;
    }
  }

  /** Add a decryption key for a remote user */
  private async addDecryptKeyForUser(channelId: string, userId: string): Promise<void> {
    if (!this.mediaEncryption) return;
    try {
      const channelCSK = await e2eeService.getChannelKey(channelId);
      await this.mediaEncryption.addDecryptKey(channelCSK, userId);
    } catch (err) {
      console.error('Failed to add decrypt key for user:', userId, err);
    }
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
        const transform = new TransformStream({
          async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
            try {
              await encryption.encryptFrame(frame);
              controller.enqueue(frame);
            } catch {
              // Encrypt failed — DROP the frame to avoid sending unencrypted
              // plaintext on an encrypted channel. Silence/blank is correct.
            }
          },
        });
        readable.pipeThrough(transform).pipeTo(writable).catch((err: unknown) => {
          console.warn('E2EE encrypt pipe error:', err);
        });
        console.debug('E2EE: encrypt transform applied via createEncodedStreams');
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

    if (typeof receiverAny.createEncodedStreams === 'function') {
      try {
        const { readable, writable } = receiverAny.createEncodedStreams();
        let dropCount = 0;
        const transform = new TransformStream({
          async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
            try {
              await encryption.decryptFrame(frame, senderUserId);
              controller.enqueue(frame);
              // Reset drop counter on success
              if (dropCount > 0) {
                console.debug(`E2EE: decrypt recovered after ${dropCount} dropped frames for ${senderUserId}`);
                dropCount = 0;
              }
            } catch {
              // Decrypt failed — DROP the frame. Silence (audio) or freeze/black
              // (video) is far better than feeding ciphertext to the decoder,
              // which produces garbled noise or corrupted video.
              dropCount++;
              if (dropCount === 1 || dropCount % 100 === 0) {
                console.warn(`E2EE: dropping undecryptable frame for ${senderUserId} (total dropped: ${dropCount})`);
              }
            }
          },
        });
        readable.pipeThrough(transform).pipeTo(writable).catch((err: unknown) => {
          console.warn('E2EE decrypt pipe error:', err);
        });
        console.debug('E2EE: decrypt transform applied via createEncodedStreams');
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

    // Close transports
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;

    // Stop local VAD
    this.stopLocalVAD();

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
