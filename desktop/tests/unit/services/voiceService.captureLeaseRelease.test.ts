/**
 * #87 §3.8 release classification for claim `voice-join`, one row per call-ending site.
 *
 * Each row drives the real condition (a socket event, a failed resume, an auth change)
 * rather than calling `emergencyCleanup` directly, so a site that stops routing through
 * the releasing teardown turns its own row red. The KEEP rows are the controls: a
 * release there would free the lease while the same document is about to re-acquire it,
 * or while its call is still live.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';
import { releaseVoiceJoinWhenCapturesSettle } from '@/renderer/services/voice/captureLeaseClient';
import { resetAllStores } from '../../helpers/store-helpers';

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>()),
  acquire: vi.fn().mockResolvedValue({ status: 'granted' }),
  // Every call-end site asks the client to release the claim (deferred behind in-flight
  // captures, which callCaptureBarrier.test.ts covers); this suite classifies the sites.
  releaseVoiceJoinWhenCapturesSettle: vi.fn(),
}));

type Handler = (...args: unknown[]) => void;

interface FakeSocket {
  connected: boolean;
  handlers: Map<string, Handler>;
  ioHandlers: Map<string, Handler>;
  on: (event: string, cb: Handler) => void;
  off: () => void;
  emit: () => void;
  disconnect: () => void;
  removeAllListeners: () => void;
  io: { on: (event: string, cb: Handler) => void; off: () => void };
}

interface ReleaseInternals {
  socket: FakeSocket | null;
  mediaEncryption: unknown;
  e2eeWorker: unknown;
  latestRequestedEncryptKeyVersion: number;
  setupSocketListeners: () => void;
  resumeAfterReconnect: () => Promise<void>;
  authorizeVoiceJoin: (...args: unknown[]) => Promise<unknown>;
  retryResumeAfterOwnershipRefusal: (...args: unknown[]) => Promise<void>;
  beginEncryptRebase: (channelId: string, keyVersion: number) => unknown;
  failEncryptRebase: (context: unknown, attempt: number, err: unknown) => void;
}

const internals = voiceService as unknown as ReleaseInternals;
const mockRelease = vi.mocked(releaseVoiceJoinWhenCapturesSettle);

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, Handler>();
  const ioHandlers = new Map<string, Handler>();
  return {
    connected: true,
    handlers,
    ioHandlers,
    on: (event, cb) => {
      handlers.set(event, cb);
    },
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    io: {
      on: (event, cb) => {
        ioHandlers.set(event, cb);
      },
      off: vi.fn(),
    },
  };
}

function listeningSocket(): FakeSocket {
  const socket = fakeSocket();
  internals.socket = socket;
  internals.setupSocketListeners();
  return socket;
}

function fire(map: Map<string, Handler>, event: string, ...args: unknown[]): void {
  const handler = map.get(event);
  if (!handler) throw new Error(`no ${event} handler registered`);
  handler(...args);
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetAllStores();
  mockRelease.mockClear();
  internals.socket = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  internals.socket = null;
  internals.mediaEncryption = null;
  internals.e2eeWorker = null;
});

const releaseSites: Array<[string, () => Promise<void> | void]> = [
  ['leaveChannel()', () => voiceService.leaveChannel()],
  ['emergencyCleanup()', () => voiceService.emergencyCleanup()],
  [
    'resumeAfterReconnect with no call context',
    async () => {
      useVoiceStore.setState({ activeChannelId: null, connectionState: 'reconnecting' });
      await internals.resumeAfterReconnect();
    },
  ],
  [
    'network-change resume failure while this resume owns the call',
    async () => {
      internals.socket = fakeSocket();
      useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'reconnecting' });
      vi.spyOn(internals, 'authorizeVoiceJoin').mockRejectedValue(new Error('authorize failed'));
      await internals.resumeAfterReconnect();
    },
  ],
  [
    "media socket disconnect('io server disconnect')",
    () => {
      useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'connected' });
      fire(listeningSocket().handlers, 'disconnect', 'io server disconnect');
    },
  ],
  [
    'reconnect_failed while not reconnecting',
    () => {
      useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'connected' });
      fire(listeningSocket().ioHandlers, 'reconnect_failed');
    },
  ],
  [
    'placement recovery failure',
    async () => {
      useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'reconnecting' });
      vi.spyOn(internals, 'retryResumeAfterOwnershipRefusal').mockRejectedValue(
        new Error('placement failed')
      );
      fire(listeningSocket().ioHandlers, 'reconnect_failed');
      await flush();
    },
  ],
  [
    'encrypt re-base final failure (fail closed)',
    () => {
      useUserStore.setState({ user: { id: 'user-1' } } as never);
      useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'connected' });
      internals.mediaEncryption = { getKeyVersion: () => 1, destroy: vi.fn() };
      internals.e2eeWorker = null;
      internals.latestRequestedEncryptKeyVersion = 0;
      const context = internals.beginEncryptRebase('ch-1', 2);
      expect(context).not.toBeNull();
      internals.failEncryptRebase(context, 3, new Error('terminal'));
    },
  ],
  [
    'auth session replaced (authGeneration change)',
    () => {
      const generation = useAuthStore.getState().authGeneration;
      useAuthStore.setState({ accessToken: 'token-a', authGeneration: generation + 1 });
      expect(mockRelease).not.toHaveBeenCalled();
      useAuthStore.setState({ accessToken: 'token-b', authGeneration: generation + 2 });
    },
  ],
];

describe('voice-join release classification (#87 §3.8)', () => {
  it.each(releaseSites)('%s releases voice-join exactly once', async (_site, drive) => {
    await drive();
    await flush();

    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith();
  });

  const keepSites: Array<[string, () => Promise<void> | void]> = [
    // The rebuild re-joins at once; the holder keeps its lease through it.
    [
      'leaveChannel({ internalRebuild: true })',
      () => voiceService.leaveChannel({ internalRebuild: true }),
    ],
    // A background outage keeps the lease for the rejoin ticket.
    [
      'emergencyCleanup({ keepCaptureLease: true })',
      () => voiceService.emergencyCleanup({ keepCaptureLease: true }),
    ],
    // A transient drop keeps the call (and its tracks) in 'reconnecting'.
    [
      "media socket disconnect('transport close')",
      () => {
        useVoiceStore.setState({ activeChannelId: 'ch-1', connectionState: 'connected' });
        fire(listeningSocket().handlers, 'disconnect', 'transport close');
      },
    ],
  ];

  it.each(keepSites)('%s keeps the lease', async (_site, drive) => {
    await drive();
    await flush();

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('emergencyCleanup releases after the local media is torn down, never awaiting main', () => {
    const socket = fakeSocket();
    internals.socket = socket;
    let socketGoneAtRelease = false;
    mockRelease.mockImplementationOnce(() => {
      socketGoneAtRelease = internals.socket === null;
    });

    const result: unknown = voiceService.emergencyCleanup();

    expect(result).toBeUndefined();
    expect(socket.disconnect).toHaveBeenCalled();
    expect(socketGoneAtRelease).toBe(true);
  });
});
