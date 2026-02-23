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
import { API_BASE } from './apiClient';
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
  };
  quality_tier: string;
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
      // Step 1: Authorize via control plane
      const token = useAuthStore.getState().accessToken;
      if (!token) throw new Error('Not authenticated');

      const res = await fetch(`${API_BASE}/api/v1/channels/${channelId}/voice/join`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
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

      // Step 2: Connect Socket.IO to media plane
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

      // Re-join with actual RTP capabilities now that device is loaded
      // (the server stored null caps from step 3, update them)

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
      }

      // Step 7: Produce audio
      await this.produceAudio();

      // Step 8: Consume existing producers
      for (const producer of roomJoined.existingProducers) {
        await this.consumeProducer(producer.producerId, producer.userId);
      }

      // Set participants
      const participants: VoiceParticipant[] = roomJoined.participants.map((p) => ({
        userId: p.userId,
        username: p.username,
        displayName: p.displayName,
        avatarUrl: p.avatarUrl,
        isMuted: false,
        isDeafened: false,
        isVideoOn: false,
        isScreenSharing: false,
        isSpeaking: false,
      }));
      store.setParticipants(participants);
      store.setConnectionState('connected');

      // Step 9: Start decoder budget profiling (IGNIS insight)
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
    if (this.socket?.connected) {
      this.socket.emit('leave-room');
    }
    await this.cleanup();
    useVoiceStore.getState().reset();
  }

  // ─── Audio Producer ────────────────────────────────────────────────

  async produceAudio(deviceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    const constraints: MediaStreamConstraints = {
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 2,
      },
    };

    this.localMicStream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.localMicStream.getAudioTracks()[0];

    const tier = useVoiceStore.getState().qualityTier;
    const tierConfig = AUDIO_QUALITY_TIERS[tier];

    const producer = await this.sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: tierConfig.opusStereo,
        opusDtx: tierConfig.opusDtx,
        opusFec: tierConfig.opusFec,
        opusMaxAverageBitrate: tierConfig.maxBitrate,
      },
      appData: { source: 'mic' },
    });

    this.producers.set('mic', producer);

    // Apply E2EE encrypt transform if encrypted
    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(producer);
    }

    producer.on('transportclose', () => {
      this.producers.delete('mic');
    });
  }

  /** Produce camera video */
  async produceVideo(deviceId?: string): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    };

    this.localCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = this.localCameraStream.getVideoTracks()[0];

    const producer = await this.sendTransport.produce({
      track,
      encodings: [
        { maxBitrate: 100_000, scaleResolutionDownBy: 4 },   // 180p
        { maxBitrate: 300_000, scaleResolutionDownBy: 2 },   // 360p
        { maxBitrate: 900_000 },                              // 720p
      ],
      codecOptions: {
        videoGoogleStartBitrate: 300,
      },
      appData: { source: 'camera' },
    });

    this.producers.set('camera', producer);
    useVoiceStore.getState().setVideoOn(true);

    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(producer);
    }

    producer.on('transportclose', () => {
      this.producers.delete('camera');
      useVoiceStore.getState().setVideoOn(false);
    });
  }

  /** Produce screen share */
  async produceScreen(): Promise<void> {
    if (!this.sendTransport || !this.device) return;

    // Use Electron desktopCapturer if available
    let stream: MediaStream;
    if (window.electron?.getDesktopSources) {
      const sources = await window.electron.getDesktopSources();
      if (sources.length === 0) throw new Error('No screen sources available');
      // For now, pick the first screen. The UI picker (D4) will replace this.
      const sourceId = sources.find((s) => s.id.startsWith('screen:'))?.id || sources[0].id;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 3840,
            maxHeight: 2160,
            maxFrameRate: 30,
          },
        } as unknown as MediaTrackConstraints,
      });
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    }

    this.localScreenStream = stream;
    const track = stream.getVideoTracks()[0];

    const producer = await this.sendTransport.produce({
      track,
      encodings: [
        { maxBitrate: 5_000_000 }, // Generous — let congestion control adapt
      ],
      codecOptions: {
        videoGoogleStartBitrate: 1000,
      },
      appData: { source: 'screen' },
    });

    this.producers.set('screen', producer);
    useVoiceStore.getState().setScreenSharing(true);

    if (this.isEncrypted && this.mediaEncryption) {
      this.applyEncryptTransform(producer);
    }

    // Handle user stopping screen share via browser UI
    track.onended = () => {
      this.closeProducer('screen');
    };

    producer.on('transportclose', () => {
      this.producers.delete('screen');
      useVoiceStore.getState().setScreenSharing(false);
    });
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
    } else {
      await producer.pause();
      this.socket?.emit('pause-producer', { producerId: producer.id });
      store.setMuted(true);
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

  /** Toggle screen share */
  async toggleScreenShare(): Promise<void> {
    const store = useVoiceStore.getState();
    if (store.isScreenSharing) {
      await this.closeProducer('screen');
    } else {
      await this.produceScreen();
    }
  }

  /** Close a specific producer by source */
  async closeProducer(source: string): Promise<void> {
    const producer = this.producers.get(source);
    if (!producer) return;

    producer.close();
    this.producers.delete(source);
    this.socket?.emit('close-producer', { producerId: producer.id });

    // Stop local tracks
    if (source === 'mic' && this.localMicStream) {
      this.localMicStream.getTracks().forEach((t) => t.stop());
      this.localMicStream = null;
    } else if (source === 'camera' && this.localCameraStream) {
      this.localCameraStream.getTracks().forEach((t) => t.stop());
      this.localCameraStream = null;
      useVoiceStore.getState().setVideoOn(false);
    } else if (source === 'screen' && this.localScreenStream) {
      this.localScreenStream.getTracks().forEach((t) => t.stop());
      this.localScreenStream = null;
      useVoiceStore.getState().setScreenSharing(false);
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

  private async consumeProducer(producerId: string, senderUserId?: string): Promise<void> {
    if (!this.recvTransport || !this.device) return;

    try {
      const result = await this.emitAsync<ConsumeResponse>('consume', { producerId });
      if (!result || 'error' in result) return;

      const consumer = await this.recvTransport.consume({
        id: result.id,
        producerId: result.producerId,
        kind: result.kind,
        rtpParameters: result.rtpParameters,
      });

      this.consumers.set(consumer.id, consumer);

      // Apply E2EE decrypt transform if encrypted
      const producerUserId = senderUserId || result.producerUserId;
      if (this.isEncrypted && this.mediaEncryption) {
        this.applyDecryptTransform(consumer, producerUserId);
      }

      // Attach stream to participant
      const stream = new MediaStream([consumer.track]);
      const store = useVoiceStore.getState();
      const source = result.source;

      if (result.kind === 'audio') {
        store.updateParticipant(result.producerUserId, { audioStream: stream });
      } else if (source === 'camera') {
        store.updateParticipant(result.producerUserId, { videoStream: stream, isVideoOn: true });
      } else if (source === 'screen') {
        store.updateParticipant(result.producerUserId, { screenStream: stream, isScreenSharing: true });
      }

      // Clean up on close
      consumer.on('transportclose', () => {
        this.consumers.delete(consumer.id);
      });

      // Resume the consumer (was created paused)
      this.socket?.emit('resume-consumer', { consumerId: consumer.id });
    } catch (err) {
      console.error('Failed to consume producer:', producerId, err);
    }
  }

  // ─── Socket Listeners ──────────────────────────────────────────────

  private setupSocketListeners(): void {
    if (!this.socket) return;

    this.socket.on('new-producer', async ({ producerId, userId, kind, source }) => {
      await this.consumeProducer(producerId, userId);
      const store = useVoiceStore.getState();
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
      else if (source === 'screen') store.updateParticipant(userId, { isScreenSharing: false, screenStream: undefined });
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
          await this.mediaEncryption.rotateKeys();
        }
      }
    });

    this.socket.on('user-left', async ({ userId }) => {
      useVoiceStore.getState().removeParticipant(userId);

      // E2EE: rotate keys when a member leaves (forward secrecy)
      if (this.isEncrypted && this.mediaEncryption) {
        await this.mediaEncryption.rotateKeys();
      }
    });

    this.socket.on('active-speaker', ({ userId }) => {
      const store = useVoiceStore.getState();
      // Clear previous speaker
      if (store.activeSpeakerId && store.activeSpeakerId !== userId) {
        store.updateParticipant(store.activeSpeakerId, { isSpeaking: false });
      }
      store.setActiveSpeaker(userId);
      store.updateParticipant(userId, { isSpeaking: true });
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

  private async profileDecoders(): Promise<void> {
    for (const [, consumer] of this.consumers) {
      if (consumer.kind !== 'video') continue;

      try {
        const stats = await consumer.getStats();

        for (const report of stats.values()) {
          if (report.type !== 'inbound-rtp' || report.kind !== 'video') continue;

          // Extract decode time metrics (Chrome/Electron expose these)
          const totalDecodeTime = (report as Record<string, unknown>).totalDecodeTime as number | undefined;
          const framesDecoded = (report as Record<string, unknown>).framesDecoded as number | undefined;

          if (!totalDecodeTime || !framesDecoded || framesDecoded === 0) continue;

          // Average decode time per frame (ms)
          const avgDecodeMs = (totalDecodeTime / framesDecoded) * 1000;
          // Use p95 estimate ≈ 1.5× average (conservative)
          const p95DecodeMs = avgDecodeMs * 1.5;
          // IGNIS safe FPS formula
          const fpsSafe = 0.8 * (1000 / p95DecodeMs);

          const currentFps = (report as Record<string, unknown>).framesPerSecond as number | undefined;
          if (currentFps && currentFps > fpsSafe) {
            // Decoder is overloaded — request lower temporal layer
            const currentLayers = consumer.currentLayers;
            if (currentLayers && currentLayers.temporalLayer > 0) {
              consumer.setPreferredLayers({
                spatialLayer: currentLayers.spatialLayer,
                temporalLayer: currentLayers.temporalLayer - 1,
              });
              console.info(
                `Decoder budget: lowering temporal layer for consumer ${consumer.id}`,
                `(decode p95: ${p95DecodeMs.toFixed(1)}ms, fps: ${currentFps}, safe: ${fpsSafe.toFixed(0)})`,
              );
            }
          }
        }
      } catch {
        // Stats not available — skip
      }
    }
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

  /** Apply Insertable Streams encrypt transform to a producer */
  private applyEncryptTransform(producer: mediasoupTypes.Producer): void {
    if (!this.mediaEncryption) return;

    // Access the underlying RTCRtpSender
    const sender = producer.rtpSender;
    if (!sender) return;

    // Use createEncodedStreams (Insertable Streams API)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senderAny = sender as any;
    if (typeof senderAny.createEncodedStreams === 'function') {
      const { readable, writable } = senderAny.createEncodedStreams();
      const encryption = this.mediaEncryption;

      const transform = new TransformStream({
        async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
          await encryption.encryptFrame(frame);
          controller.enqueue(frame);
        },
      });

      readable.pipeThrough(transform).pipeTo(writable);
    } else {
      console.warn('Insertable Streams API not available — frames will not be encrypted');
    }
  }

  /** Apply Insertable Streams decrypt transform to a consumer */
  private applyDecryptTransform(consumer: mediasoupTypes.Consumer, senderUserId: string): void {
    if (!this.mediaEncryption) return;

    // Access the underlying RTCRtpReceiver
    const receiver = consumer.rtpReceiver;
    if (!receiver) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const receiverAny = receiver as any;
    if (typeof receiverAny.createEncodedStreams === 'function') {
      const { readable, writable } = receiverAny.createEncodedStreams();
      const encryption = this.mediaEncryption;

      const transform = new TransformStream({
        async transform(frame: RTCEncodedAudioFrame | RTCEncodedVideoFrame, controller) {
          await encryption.decryptFrame(frame, senderUserId);
          controller.enqueue(frame);
        },
      });

      readable.pipeThrough(transform).pipeTo(writable);
    } else {
      console.warn('Insertable Streams API not available — frames will not be decrypted');
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
    // Close all producers
    for (const [source] of this.producers) {
      await this.closeProducer(source);
    }

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

    // Stop decoder profiling
    if (this.decoderProfilingTimer) {
      clearInterval(this.decoderProfilingTimer);
      this.decoderProfilingTimer = null;
    }

    // Destroy E2EE
    this.mediaEncryption?.destroy();
    this.mediaEncryption = null;
    this.isEncrypted = false;

    // Disconnect socket
    this.socket?.disconnect();
    this.socket = null;

    // Reset device
    this.device = null;
  }
}

// Export singleton
export const voiceService = new VoiceService();
