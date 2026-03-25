import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetAllStores } from '../../helpers/store-helpers';

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing voiceService
// ---------------------------------------------------------------------------

// --- mediasoup-client ---
const mockDeviceLoad = vi.fn().mockResolvedValue(undefined);
const mockDeviceRtpCapabilities = {
  codecs: [
    { mimeType: 'audio/opus', kind: 'audio', clockRate: 48000, channels: 2, parameters: {} },
    { mimeType: 'video/VP8', kind: 'video', clockRate: 90000, parameters: {} },
    { mimeType: 'video/VP9', kind: 'video', clockRate: 90000, parameters: { 'profile-id': '0' } },
    {
      mimeType: 'video/H264',
      kind: 'video',
      clockRate: 90000,
      parameters: { 'profile-level-id': '42e01f' },
    },
    {
      mimeType: 'video/H264',
      kind: 'video',
      clockRate: 90000,
      parameters: { 'profile-level-id': '640034' },
    },
    { mimeType: 'video/AV1', kind: 'video', clockRate: 90000, parameters: {} },
  ],
};

const mockCreateSendTransport = vi.fn();
const mockCreateRecvTransport = vi.fn();

vi.mock('mediasoup-client', () => ({
  Device: class MockDevice {
    load = mockDeviceLoad;
    rtpCapabilities = mockDeviceRtpCapabilities;
    createSendTransport = mockCreateSendTransport;
    createRecvTransport = mockCreateRecvTransport;
    loaded = true;
  },
  types: {},
}));

// --- socket.io-client ---
const socketListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
const socketOnceListeners: Record<string, Array<(...args: unknown[]) => void>> = {};

const mockSocket = {
  connected: false,
  emit: vi.fn(),
  on: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (!socketListeners[event]) socketListeners[event] = [];
    socketListeners[event].push(cb);
  }),
  once: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (!socketOnceListeners[event]) socketOnceListeners[event] = [];
    socketOnceListeners[event].push(cb);
  }),
  disconnect: vi.fn(),
  io: { on: vi.fn() },
};

vi.mock('socket.io-client', () => ({
  io: vi.fn().mockReturnValue(mockSocket),
}));

// --- apiClient ---
const mockApiFetch = vi.fn();
vi.mock('@/renderer/services/apiClient', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// --- e2eeService ---
vi.mock('@/renderer/services/e2eeService', () => ({
  e2eeService: {
    getChannelKey: vi.fn().mockResolvedValue(null),
    invalidateChannelKey: vi.fn(),
  },
}));

// --- mediaEncryption ---
vi.mock('@/renderer/services/mediaEncryption', () => ({
  MediaEncryption: class MockMediaEncryption {
    init = vi.fn().mockResolvedValue(undefined);
    initFromKey = vi.fn();
    destroy = vi.fn();
    getCurrentKeyId = vi.fn().mockReturnValue(0);
    setCurrentKeyId = vi.fn();
    encryptFrame = vi.fn().mockResolvedValue(undefined);
    decryptFrame = vi.fn().mockResolvedValue(undefined);
    addDecryptKey = vi.fn().mockResolvedValue(undefined);
    addDecryptKeyDirect = vi.fn();
    debouncedRotateKeys = vi.fn();
    catchUpToEpoch = vi.fn().mockResolvedValue(undefined);
  },
  deriveFrameKey: vi.fn().mockResolvedValue({} as CryptoKey),
  ratchetKey: vi.fn().mockResolvedValue({} as CryptoKey),
}));

// --- osPermissionStore ---
vi.mock('@/renderer/stores/osPermissionStore', () => ({
  useOsPermissionStore: {
    getState: vi.fn().mockReturnValue({
      checkOne: vi.fn().mockResolvedValue('granted'),
      openSettings: vi.fn(),
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
  ensureOsPermission: vi.fn().mockResolvedValue('granted'),
}));

// ---------------------------------------------------------------------------
// Mock browser APIs
// ---------------------------------------------------------------------------

const mockGainNode = {
  gain: { value: 1, setTargetAtTime: vi.fn() },
  connect: vi.fn(),
  disconnect: vi.fn(),
};
const mockAnalyser = {
  fftSize: 0,
  smoothingTimeConstant: 0,
  frequencyBinCount: 128,
  getByteFrequencyData: vi.fn(),
  getByteTimeDomainData: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const processedAudioTrack = {
  id: 'processed-track',
  kind: 'audio',
  readyState: 'live',
  enabled: true,
  stop: vi.fn(),
  getSettings: vi.fn().mockReturnValue({}),
};

class MockAudioContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  createAnalyser = vi.fn().mockReturnValue(mockAnalyser);
  createGain = vi.fn().mockReturnValue(mockGainNode);
  createMediaStreamDestination = vi.fn().mockReturnValue({
    stream: {
      getAudioTracks: vi.fn().mockReturnValue([processedAudioTrack]),
    },
  });
  close = vi.fn().mockResolvedValue(undefined);
}

Object.defineProperty(globalThis, 'AudioContext', {
  value: MockAudioContext,
  writable: true,
  configurable: true,
});

// Mock MediaStream (jsdom does not provide it)
class MockMediaStream {
  private _tracks: unknown[];
  constructor(tracks?: unknown[]) {
    this._tracks = tracks || [];
  }
  getTracks() {
    return this._tracks;
  }
  getAudioTracks() {
    return this._tracks.filter((t: any) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this._tracks.filter((t: any) => t.kind === 'video');
  }
  addTrack(t: unknown) {
    this._tracks.push(t);
  }
}
Object.defineProperty(globalThis, 'MediaStream', {
  value: MockMediaStream,
  writable: true,
  configurable: true,
});

// Mock RTCRtpSender (no createEncodedStreams for non-E2EE path)
function MockRTCRtpSender() {}
Object.defineProperty(globalThis, 'RTCRtpSender', {
  value: MockRTCRtpSender,
  writable: true,
  configurable: true,
});

// Ensure RTCRtpScriptTransform is NOT defined
if ('RTCRtpScriptTransform' in globalThis) {
  delete (globalThis as Record<string, unknown>)['RTCRtpScriptTransform'];
}

// Mock navigator.mediaDevices
const mockGetUserMedia = vi.fn();
const mockGetDisplayMedia = vi.fn();
Object.defineProperty(navigator, 'mediaDevices', {
  value: {
    getUserMedia: mockGetUserMedia,
    getDisplayMedia: mockGetDisplayMedia,
    enumerateDevices: vi.fn().mockResolvedValue([]),
  },
  writable: true,
  configurable: true,
});

function createMockMediaStream(tracks?: Array<{ kind: string; id?: string }>) {
  const allTracks = (tracks || [{ kind: 'audio', id: 'audio-1' }]).map((t) => ({
    id: t.id || `${t.kind}-${Math.random().toString(36).slice(2)}`,
    kind: t.kind,
    readyState: 'live',
    enabled: true,
    stop: vi.fn(),
    clone: vi.fn(),
    getSettings: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
    contentHint: '',
    onended: null as (() => void) | null,
  }));
  return {
    getAudioTracks: vi.fn().mockReturnValue(allTracks.filter((t) => t.kind === 'audio')),
    getVideoTracks: vi.fn().mockReturnValue(allTracks.filter((t) => t.kind === 'video')),
    getTracks: vi.fn().mockReturnValue(allTracks),
    addTrack: vi.fn(),
    removeTrack: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Import voiceService AFTER all mocks
// ---------------------------------------------------------------------------
const { voiceService } = await import('@/renderer/services/voiceService');

import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useAuthStore } from '@/renderer/stores/authStore';
import { useAudioSettingsStore } from '@/renderer/stores/audioSettingsStore';
import { useVideoSettingsStore } from '@/renderer/stores/videoSettingsStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupAuth() {
  useAuthStore.getState().setAccessToken('test-token');
  useUserStore.setState({
    user: {
      id: 'user-1',
      username: 'testuser',
      display_name: 'Test User',
      avatar_url: null,
      email: 'test@test.com',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}

function makeJoinResponse(co?: Record<string, unknown>) {
  return {
    allowed: true,
    media_server_url: 'http://localhost:3000',
    ice_servers: [{ urls: 'stun:stun.l.google.com:19302' }],
    channel: {
      id: 'channel-1',
      name: 'General',
      server_id: 'server-1',
      is_encrypted: false,
      audio_quality_tier: null,
      ...(co || {}),
    },
  };
}

function makeRoomJoined(ov?: Record<string, unknown>) {
  return {
    rtpCapabilities: mockDeviceRtpCapabilities,
    existingProducers: [],
    participants: [{ userId: 'user-1', username: 'testuser', displayName: 'Test User' }],
    isEncrypted: false,
    channelName: 'General',
    ...(ov || {}),
  };
}

function makeTransportOpts(id = 'transport-1') {
  return {
    id,
    iceParameters: { usernameFragment: 'f', password: 'p', iceLite: false },
    iceCandidates: [],
    dtlsParameters: { role: 'auto', fingerprints: [] },
  };
}

function createMockProducer(id = 'prod-1', source = 'mic') {
  return {
    id,
    kind: source === 'mic' || source === 'screen-audio' ? 'audio' : 'video',
    paused: false,
    closed: false,
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    replaceTrack: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    getStats: vi.fn().mockResolvedValue(new Map()),
    rtpSender: {
      getParameters: vi.fn().mockReturnValue({
        encodings: [{ maxBitrate: 32000, priority: 'low' }],
        codecs: [{ mimeType: 'audio/opus' }],
      }),
      setParameters: vi.fn().mockResolvedValue(undefined),
      transform: null,
    },
    appData: { source },
    producerId: id,
  };
}

function createMockConsumer(id = 'cons-1', kind: 'audio' | 'video' = 'audio', prodId = 'p-1') {
  return {
    id,
    kind,
    paused: false,
    closed: false,
    producerId: prodId,
    track: { id: `track-${id}`, kind, readyState: 'live', enabled: true, stop: vi.fn() },
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    on: vi.fn(),
    getStats: vi.fn().mockResolvedValue(new Map()),
    rtpReceiver: { transform: null },
  };
}

function setupEmitResponses(responses: Record<string, unknown>) {
  mockSocket.emit.mockImplementation(
    (event: string, _data: unknown, callback?: (r: unknown) => void) => {
      if (callback && event in responses) callback(responses[event]);
    }
  );
}

function makeSendTransport() {
  return {
    id: 'send-1',
    closed: false,
    close: vi.fn(),
    produce: vi.fn(),
    on: vi.fn(),
    _awaitQueue: {
      push: vi.fn().mockImplementation(async (fn: () => Promise<void>) => {
        await fn();
      }),
    },
  };
}

function makeRecvTransport() {
  return { id: 'recv-1', closed: false, close: vi.fn(), consume: vi.fn(), on: vi.fn() };
}

async function joinVoiceChannel(co?: Record<string, unknown>) {
  setupAuth();
  mockApiFetch.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue(makeJoinResponse(co)),
  });
  mockSocket.connected = true;

  const sendTransport = makeSendTransport();
  const recvTransport = makeRecvTransport();
  mockCreateSendTransport.mockReturnValue(sendTransport);
  mockCreateRecvTransport.mockReturnValue(recvTransport);

  setupEmitResponses({
    'join-room': makeRoomJoined({ isEncrypted: co?.is_encrypted ?? false }),
    'create-transport': makeTransportOpts(),
    produce: { id: 'prod-mic' },
    'resume-consumer': undefined,
    'close-producer': undefined,
    'pause-producer': undefined,
    'resume-producer': undefined,
  });

  mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'audio', id: 'mic-1' }]));
  const micProducer = createMockProducer('prod-mic', 'mic');
  sendTransport.produce.mockResolvedValue(micProducer);

  await voiceService.joinChannel('channel-1');
  return { sendTransport, recvTransport, micProducer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VoiceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetAllStores();
    mockSocket.connected = false;
    for (const k of Object.keys(socketListeners)) delete socketListeners[k];
    for (const k of Object.keys(socketOnceListeners)) delete socketOnceListeners[k];
  });

  afterEach(() => {
    vi.useRealTimers();
    try {
      voiceService.emergencyCleanup();
    } catch {
      /* ok */
    }
  });

  // ===== Singleton =====

  describe('singleton export', () => {
    it('exports a singleton with all public methods', () => {
      expect(voiceService).toBeDefined();
      for (const m of [
        'joinChannel',
        'leaveChannel',
        'toggleMute',
        'toggleDeafen',
        'toggleVideo',
        'toggleScreenShare',
        'emergencyCleanup',
        'pauseLocalProducer',
        'resumeLocalProducer',
        'pauseConsumer',
        'resumeConsumer',
        'getConsumerIdsBySource',
        'getRouterRtpCapabilities',
        'getConsumerMeta',
        'forwardToServer',
        'setQualityTier',
        'produceScreen',
        'tuneInToScreenShare',
        'tuneOutOfScreenShare',
      ]) {
        expect(typeof (voiceService as any)[m]).toBe('function');
      }
    });
  });

  // ===== joinChannel =====

  describe('joinChannel', () => {
    it('transitions connecting -> connected', async () => {
      await joinVoiceChannel();
      expect(useVoiceStore.getState().connectionState).toBe('connected');
      expect(useVoiceStore.getState().activeChannelId).toBe('channel-1');
    });

    it('sets error state on API non-OK', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: vi.fn().mockResolvedValue({ error: 'Forbidden' }),
      });
      await expect(voiceService.joinChannel('ch')).rejects.toThrow('Forbidden');
      expect(useVoiceStore.getState().connectionState).toBe('error');
    });

    it('throws when allowed=false', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...makeJoinResponse(), allowed: false }),
      });
      await expect(voiceService.joinChannel('ch')).rejects.toThrow('Not allowed');
    });

    it('throws when no auth token', async () => {
      useUserStore.setState({
        user: {
          id: 'u1',
          username: 'u',
          display_name: '',
          avatar_url: null,
          email: '',
          created_at: '',
          updated_at: '',
        },
      });
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = true;
      setupEmitResponses({ 'join-room': makeRoomJoined() });
      await expect(voiceService.joinChannel('ch')).rejects.toThrow('Not authenticated');
    });

    it('uses channel quality tier when valid', async () => {
      await joinVoiceChannel({ audio_quality_tier: 'high' });
      expect(useVoiceStore.getState().effectiveQualityTier).toBe('high');
    });

    it('falls back to personal tier when channel tier invalid', async () => {
      useVoiceStore.getState().setQualityTier('standard');
      await joinVoiceChannel({ audio_quality_tier: 'bogus' });
      expect(useVoiceStore.getState().effectiveQualityTier).toBe('standard');
    });

    it('uses DM endpoint', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = true;
      const st = makeSendTransport();
      const rt = makeRecvTransport();
      mockCreateSendTransport.mockReturnValue(st);
      mockCreateRecvTransport.mockReturnValue(rt);
      setupEmitResponses({
        'join-room': makeRoomJoined(),
        'create-transport': makeTransportOpts(),
        produce: { id: 'p1' },
      });
      mockGetUserMedia.mockResolvedValue(createMockMediaStream());
      st.produce.mockResolvedValue(createMockProducer());
      await voiceService.joinChannel('dm-ch', 'dm');
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/dm/conversations/dm-ch/voice/join',
        expect.any(Object)
      );
    });

    it('sets encrypted flag', async () => {
      await joinVoiceChannel({ is_encrypted: false });
      expect(useVoiceStore.getState().isEncrypted).toBe(false);
    });

    it('handles json parse failure on error response', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: vi.fn().mockRejectedValue(new Error('bad json')),
      });
      await expect(voiceService.joinChannel('ch')).rejects.toThrow('Voice join failed: 500');
    });

    it('sets participants with video state', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = true;
      const st = makeSendTransport();
      const rt = makeRecvTransport();
      mockCreateSendTransport.mockReturnValue(st);
      mockCreateRecvTransport.mockReturnValue(rt);
      const consumer = createMockConsumer('c2', 'video', 'p2cam');
      rt.consume.mockResolvedValue(consumer);
      setupEmitResponses({
        'join-room': makeRoomJoined({
          participants: [
            { userId: 'user-1', username: 'self' },
            { userId: 'user-2', username: 'other' },
          ],
          existingProducers: [
            { producerId: 'p2cam', userId: 'user-2', kind: 'video', source: 'camera' },
          ],
        }),
        'create-transport': makeTransportOpts(),
        produce: { id: 'pm' },
        consume: {
          id: 'c2',
          producerId: 'p2cam',
          kind: 'video',
          rtpParameters: {},
          producerUserId: 'user-2',
          source: 'camera',
        },
        'resume-consumer': undefined,
      });
      mockGetUserMedia.mockResolvedValue(createMockMediaStream());
      st.produce.mockResolvedValue(createMockProducer());
      await voiceService.joinChannel('ch');
      expect(useVoiceStore.getState().participants['user-2'].isVideoOn).toBe(true);
    });

    it('registers screen producers as available shares', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = true;
      const st = makeSendTransport();
      const rt = makeRecvTransport();
      mockCreateSendTransport.mockReturnValue(st);
      mockCreateRecvTransport.mockReturnValue(rt);
      setupEmitResponses({
        'join-room': makeRoomJoined({
          participants: [
            { userId: 'user-1', username: 'self' },
            { userId: 'user-2', username: 'sharer' },
          ],
          existingProducers: [
            { producerId: 'sp1', userId: 'user-2', kind: 'video', source: 'screen' },
          ],
        }),
        'create-transport': makeTransportOpts(),
        produce: { id: 'pm' },
      });
      mockGetUserMedia.mockResolvedValue(createMockMediaStream());
      st.produce.mockResolvedValue(createMockProducer());
      await voiceService.joinChannel('ch');
      const shares = useVoiceStore.getState().availableScreenShares;
      expect(shares).toHaveLength(1);
      expect(shares[0].producerId).toBe('sp1');
    });

    it('leaves existing channel before joining new one', async () => {
      await joinVoiceChannel();
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse({ id: 'ch2' })),
      });
      mockSocket.connected = true;
      const st2 = makeSendTransport();
      const rt2 = makeRecvTransport();
      mockCreateSendTransport.mockReturnValue(st2);
      mockCreateRecvTransport.mockReturnValue(rt2);
      setupEmitResponses({
        'join-room': makeRoomJoined(),
        'create-transport': makeTransportOpts(),
        produce: { id: 'p2' },
        'close-producer': undefined,
        'leave-room': undefined,
      });
      mockGetUserMedia.mockResolvedValue(createMockMediaStream());
      st2.produce.mockResolvedValue(createMockProducer('p2'));
      await voiceService.joinChannel('ch2');
      expect(useVoiceStore.getState().connectionState).toBe('connected');
    });
  });

  // ===== leaveChannel =====

  describe('leaveChannel', () => {
    it('resets to disconnected', async () => {
      await joinVoiceChannel();
      await voiceService.leaveChannel();
      expect(useVoiceStore.getState().connectionState).toBe('disconnected');
      expect(useVoiceStore.getState().activeChannelId).toBeNull();
    });

    it('emits leave-room', async () => {
      await joinVoiceChannel();
      await voiceService.leaveChannel();
      expect(mockSocket.emit).toHaveBeenCalledWith('leave-room');
    });

    it('safe when not connected', async () => {
      await voiceService.leaveChannel();
      expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    });
  });

  // ===== emergencyCleanup =====

  describe('emergencyCleanup', () => {
    it('resets all state', async () => {
      await joinVoiceChannel();
      voiceService.emergencyCleanup();
      expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    });

    it('is idempotent', () => {
      voiceService.emergencyCleanup();
      voiceService.emergencyCleanup();
      expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    });

    it('fires on auth token clear', () => {
      setupAuth();
      useVoiceStore.getState().setConnectionState('connected');
      useAuthStore.getState().clearAccessToken();
      expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    });
  });

  // ===== toggleMute =====

  describe('toggleMute', () => {
    it('noop without producer', async () => {
      await voiceService.toggleMute();
      expect(useVoiceStore.getState().isMuted).toBe(false);
    });

    it('pauses and mutes', async () => {
      const { micProducer } = await joinVoiceChannel();
      await voiceService.toggleMute();
      expect(micProducer.pause).toHaveBeenCalled();
      expect(useVoiceStore.getState().isMuted).toBe(true);
    });

    it('resumes and unmutes', async () => {
      const { micProducer } = await joinVoiceChannel();
      await voiceService.toggleMute();
      await voiceService.toggleMute();
      expect(micProducer.resume).toHaveBeenCalled();
      expect(useVoiceStore.getState().isMuted).toBe(false);
    });

    it('emits socket events', async () => {
      const { micProducer } = await joinVoiceChannel();
      await voiceService.toggleMute();
      expect(mockSocket.emit).toHaveBeenCalledWith('pause-producer', {
        producerId: micProducer.id,
      });
      await voiceService.toggleMute();
      expect(mockSocket.emit).toHaveBeenCalledWith('resume-producer', {
        producerId: micProducer.id,
      });
    });
  });

  // ===== toggleDeafen =====

  describe('toggleDeafen', () => {
    it('sets deafened', async () => {
      await joinVoiceChannel();
      voiceService.toggleDeafen();
      expect(useVoiceStore.getState().isDeafened).toBe(true);
    });

    it('also mutes', async () => {
      const { micProducer } = await joinVoiceChannel();
      voiceService.toggleDeafen();
      expect(micProducer.pause).toHaveBeenCalled();
    });

    it('un-deafens on second toggle', async () => {
      await joinVoiceChannel();
      voiceService.toggleDeafen();
      voiceService.toggleDeafen();
      expect(useVoiceStore.getState().isDeafened).toBe(false);
    });
  });

  // ===== toggleVideo =====

  describe('toggleVideo', () => {
    it('starts video', async () => {
      const { sendTransport } = await joinVoiceChannel();
      mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('cp', 'camera'));
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().isVideoOn).toBe(true);
    });

    it('stops video', async () => {
      const { sendTransport } = await joinVoiceChannel();
      mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('cp', 'camera'));
      await voiceService.toggleVideo();
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().isVideoOn).toBe(false);
    });

    it('enforces max video slots', async () => {
      const { sendTransport } = await joinVoiceChannel();
      // Set maxVideoSlots to 2 so we only need 2 video-on participants to hit the limit
      const parts: Record<string, any> = {
        u0: {
          userId: 'u0',
          username: 'u0',
          isMuted: false,
          isDeafened: false,
          isVideoOn: true,
          isScreenSharing: false,
          isSpeaking: false,
        },
        u1: {
          userId: 'u1',
          username: 'u1',
          isMuted: false,
          isDeafened: false,
          isVideoOn: true,
          isScreenSharing: false,
          isSpeaking: false,
        },
      };
      useVoiceStore.setState({ participants: parts, maxVideoSlots: 2 });
      mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('cp', 'camera'));
      await voiceService.produceVideo();
      expect(useVoiceStore.getState().videoSlotError).toBeTruthy();
    });
  });

  // ===== toggleScreenShare =====

  describe('toggleScreenShare', () => {
    it('starts and stops', async () => {
      const { sendTransport } = await joinVoiceChannel();
      mockGetDisplayMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.toggleScreenShare();
      expect(useVoiceStore.getState().isScreenSharing).toBe(true);
      await voiceService.toggleScreenShare();
      expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    });
  });

  // ===== pauseLocalProducer / resumeLocalProducer =====

  describe('pauseLocalProducer / resumeLocalProducer', () => {
    it('pauses active producer', async () => {
      const { micProducer } = await joinVoiceChannel();
      voiceService.pauseLocalProducer('mic');
      expect(micProducer.pause).toHaveBeenCalled();
    });

    it('noop for unknown source', () => {
      expect(() => voiceService.pauseLocalProducer('x')).not.toThrow();
    });

    it('resumes paused producer', async () => {
      const { micProducer } = await joinVoiceChannel();
      micProducer.paused = true;
      voiceService.resumeLocalProducer('mic');
      expect(micProducer.resume).toHaveBeenCalled();
    });

    it('skips non-paused producer', async () => {
      const { micProducer } = await joinVoiceChannel();
      micProducer.paused = false;
      voiceService.resumeLocalProducer('mic');
      expect(micProducer.resume).not.toHaveBeenCalled();
    });
  });

  // ===== pauseConsumer / resumeConsumer =====

  describe('pauseConsumer / resumeConsumer', () => {
    it('noop for unknown', () => {
      expect(() => voiceService.pauseConsumer('x')).not.toThrow();
      expect(() => voiceService.resumeConsumer('x')).not.toThrow();
    });
  });

  // ===== getConsumerIdsBySource =====

  describe('getConsumerIdsBySource', () => {
    it('empty without consumers', () => {
      expect(voiceService.getConsumerIdsBySource()).toEqual([]);
      expect(voiceService.getConsumerIdsBySource('audio')).toEqual([]);
    });
  });

  // ===== getRouterRtpCapabilities =====

  describe('getRouterRtpCapabilities', () => {
    it('null before device load', () => {
      voiceService.emergencyCleanup();
      expect(voiceService.getRouterRtpCapabilities()).toBeNull();
    });

    it('returns caps after join', async () => {
      await joinVoiceChannel();
      expect(voiceService.getRouterRtpCapabilities()).toBeDefined();
    });
  });

  // ===== getConsumerMeta =====

  describe('getConsumerMeta', () => {
    it('empty without consumers', () => {
      expect(voiceService.getConsumerMeta().size).toBe(0);
    });
  });

  // ===== forwardToServer =====

  describe('forwardToServer', () => {
    it('rejects without socket', async () => {
      voiceService.emergencyCleanup();
      await expect(voiceService.forwardToServer('ev')).rejects.toThrow('No socket');
    });

    it('rejects on server error', async () => {
      await joinVoiceChannel();
      mockSocket.emit.mockImplementation((_e: string, _d: unknown, cb?: (r: unknown) => void) => {
        if (cb) cb({ error: 'nope' });
      });
      await expect(voiceService.forwardToServer('ev', {})).rejects.toThrow('nope');
    });
  });

  // ===== setQualityTier =====

  describe('setQualityTier', () => {
    it('updates store', async () => {
      await voiceService.setQualityTier('high');
      expect(useVoiceStore.getState().qualityTier).toBe('high');
    });

    it('re-produces audio', async () => {
      const { sendTransport } = await joinVoiceChannel();
      sendTransport.produce.mockResolvedValue(createMockProducer('p2', 'mic'));
      mockGetUserMedia.mockResolvedValue(createMockMediaStream());
      await voiceService.setQualityTier('hifi');
      expect(sendTransport.produce).toHaveBeenCalledTimes(2);
    });
  });

  // ===== produceScreen =====

  describe('produceScreen', () => {
    it('noop without sendTransport', async () => {
      voiceService.emergencyCleanup();
      await voiceService.produceScreen();
      expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    });

    it('content hint motion', async () => {
      const { sendTransport } = await joinVoiceChannel();
      const vt = {
        id: 'st',
        kind: 'video',
        readyState: 'live',
        enabled: true,
        stop: vi.fn(),
        getSettings: vi.fn().mockReturnValue({}),
        contentHint: '',
        onended: null as any,
      };
      mockGetDisplayMedia.mockResolvedValue({
        getAudioTracks: vi.fn().mockReturnValue([]),
        getVideoTracks: vi.fn().mockReturnValue([vt]),
        getTracks: vi.fn().mockReturnValue([vt]),
      });
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.produceScreen(undefined, { contentType: 'motion' });
      expect(vt.contentHint).toBe('motion');
    });

    it('content hint detail', async () => {
      const { sendTransport } = await joinVoiceChannel();
      const vt = {
        id: 'st',
        kind: 'video',
        readyState: 'live',
        enabled: true,
        stop: vi.fn(),
        getSettings: vi.fn().mockReturnValue({}),
        contentHint: '',
        onended: null as any,
      };
      mockGetDisplayMedia.mockResolvedValue({
        getAudioTracks: vi.fn().mockReturnValue([]),
        getVideoTracks: vi.fn().mockReturnValue([vt]),
        getTracks: vi.fn().mockReturnValue([vt]),
      });
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.produceScreen(undefined, { contentType: 'detail' });
      expect(vt.contentHint).toBe('detail');
    });

    it('produces screen audio', async () => {
      const { sendTransport } = await joinVoiceChannel();
      mockGetDisplayMedia.mockResolvedValue(
        createMockMediaStream([
          { kind: 'video', id: 'sv' },
          { kind: 'audio', id: 'sa' },
        ])
      );
      let idx = 0;
      sendTransport.produce.mockImplementation(async (o: any) =>
        createMockProducer(`p-${++idx}`, o.appData?.source || 'mic')
      );
      await voiceService.produceScreen();
      const sources = sendTransport.produce.mock.calls.map((c: any) => c[0].appData?.source);
      expect(sources).toContain('screen');
      expect(sources).toContain('screen-audio');
    });

    it('custom WxH resolution', async () => {
      useVideoSettingsStore.setState({
        screenResolution: '2560x1440',
        screenFrameRate: 30,
        screenContentType: 'auto',
      });
      const { sendTransport } = await joinVoiceChannel();
      mockGetDisplayMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.produceScreen();
      expect(mockGetDisplayMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ width: { ideal: 2560 }, height: { ideal: 1440 } }),
        })
      );
    });

    it('uses 60fps when frameRate=0', async () => {
      useVideoSettingsStore.setState({
        screenResolution: '1080p',
        screenFrameRate: 0,
        screenContentType: 'auto',
      });
      const { sendTransport } = await joinVoiceChannel();
      mockGetDisplayMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.produceScreen();
      expect(mockGetDisplayMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ frameRate: { ideal: 60 } }),
        })
      );
    });
  });

  // ===== closeProducer =====

  describe('closeProducer', () => {
    it('closes mic', async () => {
      const { micProducer } = await joinVoiceChannel();
      await voiceService.closeProducer('mic');
      expect(micProducer.close).toHaveBeenCalled();
    });

    it('closes camera and resets state', async () => {
      const { sendTransport } = await joinVoiceChannel();
      mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('cp', 'camera'));
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().isVideoOn).toBe(true);
      await voiceService.closeProducer('camera');
      expect(useVoiceStore.getState().isVideoOn).toBe(false);
    });

    it('handles nonexistent source', async () => {
      await joinVoiceChannel();
      await expect(voiceService.closeProducer('nope')).resolves.toBeUndefined();
    });
  });

  // ===== Audio settings =====

  describe('audio settings', () => {
    it('applies noise cancellation', async () => {
      useAudioSettingsStore.setState({
        noiseCancellation: true,
        echoCancellation: true,
        autoGainControl: true,
        musicMode: false,
      });
      await joinVoiceChannel();
      const audioCalls = mockGetUserMedia.mock.calls.filter((c: any) => c[0]?.audio);
      expect(audioCalls.length).toBeGreaterThanOrEqual(1);
      expect(audioCalls[0][0].audio.noiseSuppression).toBe(true);
    });

    it('disables processing in music mode', async () => {
      useAudioSettingsStore.setState({
        noiseCancellation: true,
        echoCancellation: true,
        autoGainControl: true,
        musicMode: true,
      });
      await joinVoiceChannel();
      const audioCalls = mockGetUserMedia.mock.calls.filter((c: any) => c[0]?.audio);
      expect(audioCalls[0][0].audio.noiseSuppression).toBe(false);
    });

    it('applies audio priority', async () => {
      useAudioSettingsStore.setState({ audioPriority: 'high' });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].encodings[0].priority).toBe('high');
    });

    it('omits priority when off', async () => {
      useAudioSettingsStore.setState({ audioPriority: 'off' });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].encodings[0].priority).toBeUndefined();
    });
  });

  // ===== Advanced opus settings =====

  describe('advanced opus settings', () => {
    it('uses overrides', async () => {
      useAudioSettingsStore.setState({
        advancedMode: true,
        inlineFec: false,
        silenceDetection: true,
        stereoOverride: true,
        frameSize: 40,
        adaptivePtime: false,
        opusNack: true,
      });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      const co = mc[0][0].codecOptions;
      expect(co.opusFec).toBe(false);
      expect(co.opusStereo).toBe(true);
      expect(co.opusPtime).toBe(40);
      expect(co.opusNack).toBe(true);
    });

    it('uses explicit frame size in advanced mode', async () => {
      // When advancedMode=true and frameSize is explicit (non-zero), use that value
      useAudioSettingsStore.setState({
        advancedMode: true,
        frameSize: 60,
        adaptivePtime: false,
      });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].codecOptions.opusPtime).toBe(60);
    });

    it('enables adaptivePtime', async () => {
      useAudioSettingsStore.setState({ advancedMode: true, adaptivePtime: true, frameSize: 10 });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].encodings[0].adaptivePtime).toBe(true);
    });

    it('stereo from tier when null', async () => {
      useAudioSettingsStore.setState({ advancedMode: true, stereoOverride: null });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].codecOptions.opusStereo).toBe(true);
    });

    it('DTX combines settings', async () => {
      useAudioSettingsStore.setState({ advancedMode: true, silenceDetection: true });
      const { sendTransport } = await joinVoiceChannel();
      const mc = sendTransport.produce.mock.calls.filter(
        (c: any) => c[0].appData?.source === 'mic'
      );
      expect(mc[0][0].codecOptions.opusDtx).toBe(true);
    });
  });

  // ===== Video error handling =====

  describe('video error handling', () => {
    it('NotAllowedError', async () => {
      const m = await import('@/renderer/stores/osPermissionStore');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
      await joinVoiceChannel();
      mockGetUserMedia.mockRejectedValue(new DOMException('d', 'NotAllowedError'));
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().videoSlotError).toContain('Camera access denied');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
    });

    it('NotFoundError', async () => {
      const m = await import('@/renderer/stores/osPermissionStore');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
      await joinVoiceChannel();
      mockGetUserMedia.mockRejectedValue(new DOMException('n', 'NotFoundError'));
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().videoSlotError).toContain('No camera found');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
    });

    it('generic error', async () => {
      const m = await import('@/renderer/stores/osPermissionStore');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
      await joinVoiceChannel();
      mockGetUserMedia.mockRejectedValue(new Error('boom'));
      await voiceService.toggleVideo();
      expect(useVoiceStore.getState().videoSlotError).toContain('Could not start camera');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
    });

    it('falls back on OverconstrainedError', async () => {
      const m = await import('@/renderer/stores/osPermissionStore');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
      useVideoSettingsStore.setState({ cameraPreset: '4K60' });
      const { sendTransport } = await joinVoiceChannel();
      mockGetUserMedia
        .mockRejectedValueOnce(new DOMException('oc', 'OverconstrainedError'))
        .mockRejectedValueOnce(new DOMException('oc', 'OverconstrainedError'))
        .mockRejectedValueOnce(new DOMException('oc', 'OverconstrainedError'))
        .mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('cp', 'camera'));
      await voiceService.toggleVideo();
      const videoCalls = mockGetUserMedia.mock.calls.filter((c: any) => c[0]?.video !== undefined);
      expect(videoCalls.length).toBeGreaterThanOrEqual(2);
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
    });
  });

  // ===== Tune in/out =====

  describe('tuneInToScreenShare', () => {
    it('enforces 5-stream limit', async () => {
      await joinVoiceChannel();
      const store = useVoiceStore.getState();
      for (let i = 0; i < 5; i++) store.tuneIn(`p${i}`, `c${i}`);
      await voiceService.tuneInToScreenShare('p6', 'u6');
      expect(useVoiceStore.getState().videoSlotError).toContain('Maximum 5');
    });
  });

  // ===== Codec floor =====

  describe('codec floor', () => {
    it('stores in store', async () => {
      await joinVoiceChannel();
      useVoiceStore.getState().setCodecFloor(['video/vp8', 'video/vp9']);
      expect(useVoiceStore.getState().codecFloor).toEqual(['video/vp8', 'video/vp9']);
    });
  });

  // ===== Connection state =====

  describe('connection state', () => {
    it('connecting -> connected', async () => {
      const states: string[] = [];
      const un = useVoiceStore.subscribe((s) => {
        if (!states.length || states[states.length - 1] !== s.connectionState)
          states.push(s.connectionState);
      });
      await joinVoiceChannel();
      un();
      expect(states).toContain('connecting');
      expect(states).toContain('connected');
    });

    it('error on failure', async () => {
      setupAuth();
      mockApiFetch.mockRejectedValueOnce(new Error('fail'));
      await expect(voiceService.joinChannel('ch')).rejects.toThrow('fail');
      expect(useVoiceStore.getState().connectionState).toBe('error');
    });
  });

  // ===== Electron desktop capturer =====

  describe('Electron capturer', () => {
    it('uses getDesktopSources', async () => {
      const { sendTransport } = await joinVoiceChannel();
      const orig = (globalThis as any).electron;
      (globalThis as any).electron = {
        ...orig,
        getDesktopSources: vi
          .fn()
          .mockResolvedValue([{ id: 'screen:0:0', name: 'S1', thumbnailDataURL: '' }]),
      };
      mockGetUserMedia.mockResolvedValue(createMockMediaStream([{ kind: 'video' }]));
      sendTransport.produce.mockResolvedValue(createMockProducer('sp', 'screen'));
      await voiceService.produceScreen();
      expect(mockGetUserMedia).toHaveBeenCalled();
      (globalThis as any).electron = orig;
    });
  });

  // ===== OS permission =====

  describe('OS permission', () => {
    it('throws for denied mic', async () => {
      const m = await import('@/renderer/stores/osPermissionStore');
      vi.mocked(m.ensureOsPermission).mockResolvedValue('denied');
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = true;
      const st = makeSendTransport();
      const rt = makeRecvTransport();
      mockCreateSendTransport.mockReturnValue(st);
      mockCreateRecvTransport.mockReturnValue(rt);
      setupEmitResponses({
        'join-room': makeRoomJoined(),
        'create-transport': makeTransportOpts(),
        produce: { id: 'p' },
      });
      mockGetUserMedia.mockRejectedValue(new DOMException('d', 'NotAllowedError'));
      st.produce.mockResolvedValue(createMockProducer());
      await expect(voiceService.joinChannel('ch')).rejects.toThrow();
      vi.mocked(m.ensureOsPermission).mockResolvedValue('granted');
    });
  });

  // ===== Socket timeout =====

  describe('socket timeout', () => {
    it('rejects after 10s', async () => {
      setupAuth();
      mockApiFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(makeJoinResponse()),
      });
      mockSocket.connected = false;
      const promise = voiceService.joinChannel('ch');
      // Attach no-op catch to prevent unhandled rejection before timers advance
      promise.catch(() => {});
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(promise).rejects.toThrow('Socket connection timeout');
    });
  });
});
