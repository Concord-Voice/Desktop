// regression for #242
// desktop/tests/unit/services/voiceService.reconnectMuteState.test.ts
/**
 * Oracle: while the local user is deafened, server-muted, server-deafened or
 * test-suspended (even when not self-muted), neither exitSoloBandwidthSaving() nor
 * resumeLocalProducer('mic') emits resume-producer or calls mic.resume().
 * Harness: real voiceService singleton + stub socket (voiceService.mediaPolicy.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import { resetAllStores } from '../../helpers/store-helpers';
import { useVoiceStore, type VoiceParticipant } from '@/renderer/stores/voice/voiceStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';

const LOCAL = 'local-user';
const PEER = 'peer-user';

const producerStub = (id: string, paused = false) => ({
  id,
  closed: false,
  paused,
  close: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn().mockResolvedValue(undefined),
  replaceTrack: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
});

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

describe('voiceService reconnect mute-state resume guard (#242)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any -- private members under test. */
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

  afterEach(() => vi.restoreAllMocks());

  const paths: Array<[string, () => void]> = [
    ['exitSoloBandwidthSaving', () => svc.exitSoloBandwidthSaving()],
    ["resumeLocalProducer('mic')", () => svc.resumeLocalProducer('mic')],
  ];

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
    [
      'test-suspended',
      () => {
        // A real suspension always has depth > 0 (shouldKeepProducerSuspendedForTest).
        svc.testSuspensionDepth = 1;
        svc.testSuspendedProducerIds.add('mic-1');
      },
      0,
    ],
    ['latched', () => useVoiceStore.getState().setMediaPolicyPaused('mic', 'mic-1'), 0],
    ['dead mic graph', () => (svc.micGraph = { ...liveGraph(), failed: true }), 0],
  ];

  describe.each(paths)('%s', (pathName, run) => {
    it.each(states)('%s', (stateName, arrange, expectedEmits) => {
      const mic = producerStub('mic-1', true);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      arrange();
      run();
      const resumes = emitted('resume-producer');
      expect(
        resumes.length,
        `${pathName} must emit ${expectedEmits} resume-producer while ${stateName}`
      ).toBe(expectedEmits);
      if (expectedEmits === 1) {
        expect(resumes[0], `${pathName} CONTROL must resume mic-1`).toEqual([
          'resume-producer',
          { producerId: 'mic-1' },
        ]);
      }
      expect(
        mic.resume.mock.calls.length,
        `${pathName} must ${expectedEmits ? '' : 'not '}call mic.resume() while ${stateName}`
      ).toBe(expectedEmits);
    });
  });

  it('deafened before the mic exists, then the peer leaves and rejoins, never resumes the mic', async () => {
    // 1. deafen with no producer present
    svc.toggleDeafen();
    // 2. mic + live graph appear afterwards (reconnect path)
    const mic = producerStub('mic-1', true);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    // 3. peer leaves (enters solo) and rejoins (exits solo) through the real handlers
    await handler('user-left')({ userId: PEER });
    expect(useVoiceStore.getState().isSoloBandwidthSaving, 'user-left must enter solo').toBe(true);
    await handler('user-joined')({ userId: PEER, username: PEER });
    expect(useVoiceStore.getState().isSoloBandwidthSaving, 'user-joined must exit solo').toBe(
      false
    );
    // 4.
    expect(
      emitted('resume-producer').filter((c) => (c[1] as any)?.producerId === 'mic-1'),
      "peer rejoin must not emit resume-producer for a deafened user's mic"
    ).toEqual([]);
    expect(
      mic.resume,
      "peer rejoin must not locally resume a deafened user's mic"
    ).not.toHaveBeenCalled();
  });

  it('CONTROL: an unmuted, undeafened user resumes the mic on peer rejoin', async () => {
    const mic = producerStub('mic-1', true);
    svc.producers.set('mic', mic);
    svc.micGraph = liveGraph();
    await handler('user-left')({ userId: PEER });
    await handler('user-joined')({ userId: PEER, username: PEER });
    expect(
      emitted('resume-producer').filter((c) => (c[1] as any)?.producerId === 'mic-1')
    ).toHaveLength(1);
  });

  it('solo exit still resumes a paused camera while the user is deafened', () => {
    const camera = producerStub('cam-1', true);
    svc.producers.set('camera', camera);
    useVoiceStore.getState().setDeafened(true);
    svc.exitSoloBandwidthSaving();
    expect(emitted('resume-producer')).toEqual([['resume-producer', { producerId: 'cam-1' }]]);
  });

  describe('state after a resume (#242 Task 2)', () => {
    it('restorePostResumeMuteState pauses a live mic when muted', () => {
      const mic = producerStub('mic-1', false);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      useVoiceStore.getState().setMuted(true);
      svc.restorePostResumeMuteState(socket);
      expect(mic.pause).toHaveBeenCalledTimes(1);
      expect(emitted('pause-producer')).toEqual([['pause-producer', { producerId: 'mic-1' }]]);
    });

    it('restorePostResumeMuteState emits no pause-producer when policy allows the mic', () => {
      const mic = producerStub('mic-1', false);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      svc.restorePostResumeMuteState(socket);
      expect(mic.pause).not.toHaveBeenCalled();
      expect(emitted('pause-producer')).toEqual([]);
    });

    it('restorePostResumeMuteState re-emits pause-producer when muted even if the mic is already paused', () => {
      const mic = producerStub('mic-1', true);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      useVoiceStore.getState().setMuted(true);
      svc.restorePostResumeMuteState(socket);
      expect(
        emitted('pause-producer'),
        'muted resume must re-emit pause-producer for an already-paused mic so the fresh server session learns it'
      ).toEqual([['pause-producer', { producerId: 'mic-1' }]]);
    });

    it('restorePostResumeMuteState re-emits pause-producer when deafened-only even if the mic is already paused', () => {
      const mic = producerStub('mic-1', true);
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      useVoiceStore.getState().setDeafened(true);
      svc.restorePostResumeMuteState(socket);
      expect(
        emitted('pause-producer'),
        'deafened-only resume must emit one pause-producer for mic-1'
      ).toEqual([['pause-producer', { producerId: 'mic-1' }]]);
      expect(emitted('set-deafen'), 'deafened resume must still rebroadcast set-deafen').toEqual([
        ['set-deafen', { isDeafened: true }],
      ]);
    });

    it("buildParticipantList seeds the local user's own mute and deafen state from the store", () => {
      useVoiceStore.getState().setMuted(true);
      useVoiceStore.getState().setDeafened(true);
      const list = svc.buildParticipantList(
        {
          participants: [
            { userId: LOCAL, username: 'l' },
            { userId: PEER, username: 'p', isDeafened: false },
          ],
          existingProducers: [],
        },
        { server_muted: false, server_deafened: false }
      ) as VoiceParticipant[];
      const local = list.find((p) => p.userId === LOCAL);
      const peer = list.find((p) => p.userId === PEER);
      expect(local?.isMuted, 'local participant isMuted must be seeded from the store').toBe(true);
      expect(local?.isDeafened, 'local participant isDeafened must be seeded from the store').toBe(
        true
      );
      expect(peer?.isMuted, 'peer participant isMuted must stay false').toBe(false);
      expect(peer?.isDeafened, 'peer participant isDeafened must stay false').toBe(false);
    });

    // regression for #247: the rebuilt roster must carry the join data's server
    // moderation for the local user, so no store subscriber ever sees it cleared.
    it.each([
      ['server-muted', { server_muted: true, server_deafened: false }, true, false],
      ['server-deafened', { server_muted: false, server_deafened: true }, false, true],
      [
        'server-deafened (real shape: both set)',
        { server_muted: true, server_deafened: true },
        true,
        true,
      ],
      ['not moderated', { server_muted: false, server_deafened: false }, false, false],
    ])(
      'buildParticipantList seeds the local server flags from join data (%s)',
      (_name, joinData, serverMuted, serverDeafened) => {
        const list = svc.buildParticipantList(
          {
            participants: [
              { userId: LOCAL, username: 'l' },
              { userId: PEER, username: 'p' },
            ],
            existingProducers: [],
          },
          joinData
        ) as VoiceParticipant[];
        const local = list.find((p) => p.userId === LOCAL);
        const peer = list.find((p) => p.userId === PEER);
        expect(
          { serverMuted: local?.serverMuted, serverDeafened: local?.serverDeafened },
          'local entry must carry the join data server moderation'
        ).toEqual({ serverMuted, serverDeafened });
        expect({ serverMuted: peer?.serverMuted, serverDeafened: peer?.serverDeafened }).toEqual({
          serverMuted: false,
          serverDeafened: false,
        });
      }
    );

    it('toggleDeafen with no mic producer still records mute intent', async () => {
      expect(useVoiceStore.getState().isMuted).toBe(false);
      svc.toggleDeafen();
      expect(useVoiceStore.getState().isDeafened, 'toggleDeafen must set isDeafened').toBe(true);
      await vi.waitFor(() =>
        expect(
          useVoiceStore.getState().isMuted,
          'deafen must record mute intent even when toggleMute cannot act'
        ).toBe(true)
      );
    });

    it('deafen then undeafen before the mute settles does not force-mute', async () => {
      svc.toggleDeafen();
      svc.toggleDeafen();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      const { isMuted, isDeafened } = useVoiceStore.getState();
      expect({ isMuted, isDeafened }).toEqual({ isMuted: false, isDeafened: false });
    });

    it('deafen pauses the mic even when the mute fails and its revert resumed it', async () => {
      const mic: any = producerStub('mic-1', false);
      mic.pause = vi
        .fn()
        .mockRejectedValueOnce(new Error('pause failed'))
        .mockImplementation(() => {
          mic.paused = true;
        });
      svc.producers.set('mic', mic);
      svc.micGraph = liveGraph();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      svc.toggleDeafen();
      await vi.waitFor(() => expect(mic.paused, 'deafened mic must end up paused').toBe(true));
      expect(useVoiceStore.getState().isMuted).toBe(true);
      expect(emitted('pause-producer')).toEqual([['pause-producer', { producerId: 'mic-1' }]]);
    });
  });
});
