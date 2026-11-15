// red-team pass for #242 (PR #243): adversarial sequences against the mic-resume policy
// desktop/tests/unit/services/voiceService.redteam242.test.ts
/**
 * Oracle: while the store says isMuted or isDeafened (self or server), the local mic
 * producer is never resumed (producer.resume() / resume-producer) and never left live.
 * Harness: voiceService.reconnectMuteState.test.ts, with a STATEFUL producer stub
 * (pause/resume flip `paused`, as mediasoup-client 3.26 does synchronously), because
 * test-suspension restore only resumes a producer whose `paused` is true.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import { resetAllStores } from '../../helpers/store-helpers';
import { useVoiceStore, type VoiceParticipant } from '@/renderer/stores/voice/voiceStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';

const LOCAL = 'local-user';
const PEER = 'peer-user';

/* eslint-disable @typescript-eslint/no-explicit-any -- private members under test. */
const statefulMic = (id: string, paused = false) => {
  const p: any = {
    id,
    kind: 'audio',
    closed: false,
    paused,
    close: vi.fn(),
    on: vi.fn(),
    replaceTrack: vi.fn().mockResolvedValue(undefined),
  };
  p.pause = vi.fn(() => {
    p.paused = true;
  });
  p.resume = vi.fn(() => {
    p.paused = false;
  });
  return p;
};

const participant = (userId: string, over: Partial<VoiceParticipant> = {}): VoiceParticipant => ({
  userId,
  username: userId,
  isMuted: false,
  isDeafened: false,
  serverMuted: false,
  serverDeafened: false,
  isVideoOn: false,
  isScreenSharing: false,
  isSpeaking: false,
  ...over,
});

const liveGraph = () => ({
  failed: false,
  track: { readyState: 'live' },
  settings: { musicMode: false, autoGainControl: true },
});

describe('red team #242: mic must stay paused while muted or deafened', () => {
  let svc: any;
  let socket: {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    io: { on: ReturnType<typeof vi.fn> };
  };

  const handler = (event: string): ((...args: unknown[]) => unknown) => {
    const call = socket.on.mock.calls.find((c: unknown[]) => c[0] === event);
    if (!call) throw new Error(`no handler registered for ${event}`);
    return call[1] as (...args: unknown[]) => unknown;
  };
  const emitted = (event: string) =>
    socket.emit.mock.calls.filter((c: unknown[]) => c[0] === event);

  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    useUserStore.setState({ user: { id: LOCAL } as any });
    svc = voiceService as any;
    svc.producers.clear();
    svc.micGraph = null;
    svc.consumers = new Map();
    svc.consumerMeta = new Map();
    svc.testSuspensionDepth = 0;
    svc.testSuspendedProducerIds.clear();
    svc.testRestoreEligibleProducerIds.clear();
    socket = { emit: vi.fn(), on: vi.fn(), disconnect: vi.fn(), io: { on: vi.fn() } };
    svc.socket = socket;
    svc.drainSendTransportQueue = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.getState().setParticipants([participant(LOCAL), participant(PEER)]);
    svc.setupSocketListeners();
  });

  afterEach(() => {
    svc.testSuspensionDepth = 0;
    vi.restoreAllMocks();
  });

  // EXPLOIT 1: the third resume site (test-suspension restore) was not migrated.
  // The PR's own state table, applied to endTestSuspension(). The PR moved the solo-exit
  // loop and resumeLocalProducer onto canResumeMic; restoreTestSuspendedProducer still
  // re-derives a subset (isMuted || serverMuted || serverDeafened || solo) and omits
  // self-deafen.
  const states: Array<[string, () => void, number]> = [
    ['CONTROL (nothing set)', () => {}, 1],
    ['muted', () => useVoiceStore.getState().setMuted(true), 0],
    ['deafened (not self-muted)', () => useVoiceStore.getState().setDeafened(true), 0],
    [
      'serverMuted',
      () =>
        useVoiceStore
          .getState()
          .setParticipants([participant(LOCAL, { serverMuted: true }), participant(PEER)]),
      0,
    ],
    [
      'serverDeafened',
      () =>
        useVoiceStore
          .getState()
          .setParticipants([participant(LOCAL, { serverDeafened: true }), participant(PEER)]),
      0,
    ],
    ['latched', () => useVoiceStore.getState().setMediaPolicyPaused('mic', 'mic-1'), 0],
  ];

  describe('endTestSuspension (mic test ends)', () => {
    it.each(states)('%s', (stateName, arrange, expected) => {
      const mic = statefulMic('mic-1', false);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      svc.beginTestSuspension();
      expect(mic.paused, 'beginTestSuspension must pause the live mic').toBe(true);
      socket.emit.mockClear();
      mic.resume.mockClear();
      arrange();
      svc.endTestSuspension();
      expect(
        emitted('resume-producer').length,
        `endTestSuspension must emit ${expected} resume-producer while ${stateName}`
      ).toBe(expected);
      expect(
        mic.resume.mock.calls.length,
        `endTestSuspension must ${expected ? '' : 'not '}call mic.resume() while ${stateName}`
      ).toBe(expected);
    });

    it('real sequence: deafen, unmute during the mic test, end the test -> UI and mic agree', async () => {
      const mic = statefulMic('mic-1', false);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      svc.beginTestSuspension();
      svc.toggleDeafen();
      await vi.waitFor(() => expect(useVoiceStore.getState().isMuted).toBe(true));
      await svc.toggleMute(); // policy (#242): unmute also undeafens
      expect(useVoiceStore.getState().isDeafened, 'unmute must undeafen').toBe(false);
      expect(mic.resume, 'unmute during a test must not resume').not.toHaveBeenCalled();
      socket.emit.mockClear();
      svc.endTestSuspension();
      // The mic may now resume, and the store says unmuted and undeafened: truthful.
      expect(emitted('resume-producer')).toHaveLength(1);
      const { isMuted, isDeafened } = useVoiceStore.getState();
      expect({ isMuted, isDeafened }).toEqual({ isMuted: false, isDeafened: false });
    });
  });

  // EXPLOIT 2 (resolved by policy): unmute while deafened undeafens first, on both branches.
  it('toggleMute (unmute) while deafened with a mapped mic undeafens, then resumes', async () => {
    const mic = statefulMic('mic-1', false);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    svc.toggleDeafen();
    await vi.waitFor(() => expect(useVoiceStore.getState().isMuted).toBe(true));
    expect(mic.paused).toBe(true);
    socket.emit.mockClear();
    await svc.toggleMute();
    expect(useVoiceStore.getState().isDeafened, 'unmute must undeafen').toBe(false);
    expect(useVoiceStore.getState().isMuted).toBe(false);
    expect(emitted('set-deafen')).toEqual([['set-deafen', { isDeafened: false }]]);
    expect(emitted('resume-producer')).toEqual([['resume-producer', { producerId: 'mic-1' }]]);
  });

  it('toggleMute (unmute) while deafened with a dead mic graph changes nothing', async () => {
    const mic = statefulMic('mic-1', true);
    svc.producers.set('mic', mic);
    svc.micGraph = { ...liveGraph(), failed: true };
    useVoiceStore.getState().setDeafened(true);
    useVoiceStore.getState().setMuted(true);
    socket.emit.mockClear();
    await svc.toggleMute();
    const { isMuted, isDeafened } = useVoiceStore.getState();
    expect({ isMuted, isDeafened }).toEqual({ isMuted: true, isDeafened: true });
    expect(emitted('set-deafen')).toEqual([]);
    expect(emitted('resume-producer')).toEqual([]);
  });

  it('toggleMute (unmute) while server-deafened is refused: stays deafened and paused', async () => {
    const mic = statefulMic('mic-1', true);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    useVoiceStore
      .getState()
      .setParticipants([participant(LOCAL, { serverDeafened: true }), participant(PEER)]);
    useVoiceStore.getState().setDeafened(true);
    useVoiceStore.getState().setMuted(true);
    socket.emit.mockClear();
    await svc.toggleMute();
    const { isMuted, isDeafened } = useVoiceStore.getState();
    expect({ isMuted, isDeafened }).toEqual({ isMuted: true, isDeafened: true });
    expect(emitted('resume-producer')).toEqual([]);
    expect(mic.resume).not.toHaveBeenCalled();
  });

  // EXPLOIT 3: a versioned server-deafen snapshot leaves the mic live.
  it('server-deafen snapshot {serverMuted:false, serverDeafened:true} must not leave the mic live', async () => {
    const mic = statefulMic('mic-1', false);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    await handler('server-deafen-changed')({
      userId: LOCAL,
      serverMuted: false,
      serverDeafened: true,
    });
    expect(useVoiceStore.getState().isDeafened).toBe(true);
    expect(mic.paused, 'store says deafened but the mic producer is still live').toBe(true);
  });

  // Cleared surfaces (passing coverage).
  it('deafen with no producer, then mic adoption (device/codec re-produce) keeps it paused', async () => {
    vi.spyOn(svc, 'startPacketLossMonitor').mockImplementation(() => {});
    vi.spyOn(svc, 'startLocalVAD').mockImplementation(() => {});
    svc.toggleDeafen();
    await vi.waitFor(() => expect(useVoiceStore.getState().isMuted).toBe(true));
    const mic = statefulMic('mic-2', false);
    svc.micGraph = liveGraph();
    svc.adoptMicProducer(mic, { getTracks: () => [] });
    expect(mic.resume).not.toHaveBeenCalled();
    expect(mic.paused).toBe(true);
    expect(emitted('pause-producer')).toContainEqual(['pause-producer', { producerId: 'mic-2' }]);
  });

  it('server unmute after server mute never auto-resumes the mic', async () => {
    const mic = statefulMic('mic-1', false);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    const apply = handler('server-mute-changed');
    await apply({ userId: LOCAL, serverMuted: true, serverDeafened: false });
    expect(mic.paused).toBe(true);
    await apply({ userId: LOCAL, serverMuted: false, serverDeafened: false });
    expect(mic.resume).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().isMuted).toBe(true);
  });

  it('server-muted (not self-muted) resume re-emits pause-producer for the rebuilt mic', () => {
    const mic = statefulMic('mic-1', true);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    useVoiceStore
      .getState()
      .setParticipants([participant(LOCAL, { serverMuted: true }), participant(PEER)]);
    svc.restorePostResumeMuteState(socket);
    expect(emitted('pause-producer')).toEqual([['pause-producer', { producerId: 'mic-1' }]]);
  });

  it('muted user: peer leave/rejoin never resumes the mic', async () => {
    const mic = statefulMic('mic-1', false);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    await svc.toggleMute(); // mute
    await handler('user-left')({ userId: PEER });
    await handler('user-joined')({ userId: PEER, username: PEER });
    expect(mic.resume).not.toHaveBeenCalled();
    expect(emitted('resume-producer')).toEqual([]);
  });
});
