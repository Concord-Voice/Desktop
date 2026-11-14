/**
 * #87 §3.8 — `joinChannel` acquires the capture lease FIRST.
 *
 * The lease is main's answer to "may this connection hold the microphone". Asking for it
 * after authorization, E2EE init or `getUserMedia` would spend a control-plane join, a
 * media key context or a live capture on a call main is about to refuse, so the order is
 * asserted with a shared call log rather than by counting calls.
 *
 * Everything downstream of authorization needs its `joinData`: E2EE init and every
 * `getUserMedia` run inside `connectAuthorizedJoinSession`. Spying the authorize and
 * connect stages therefore pins the acquire ahead of all three.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { voiceService } from '@/renderer/services/voice/voiceService';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { getVoiceActionGeneration } from '@/renderer/services/voice/voiceActionGeneration';
import {
  acquire,
  release,
  captureLeaseMessage,
  CaptureLeaseError,
  type CaptureFailureReason,
} from '@/renderer/services/voice/captureLeaseClient';
import { resetAllStores } from '../../helpers/store-helpers';

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>()),
  acquire: vi.fn(),
  release: vi.fn().mockResolvedValue(true),
}));

interface JoinInternals {
  joinInFlight: boolean;
  authorizeVoiceJoin: (...args: unknown[]) => Promise<unknown>;
  resolveAuthorizedJoinChannel: (...args: unknown[]) => Promise<unknown>;
  connectAuthorizedJoinSession: (...args: unknown[]) => Promise<void>;
  initEncryptionCore: (...args: unknown[]) => Promise<void>;
}

const internals = voiceService as unknown as JoinInternals;
const mockAcquire = vi.mocked(acquire);
const mockRelease = vi.mocked(release);

let calls: string[];
let getUserMedia: ReturnType<typeof vi.fn>;

function stubDownstream(): void {
  vi.spyOn(internals, 'authorizeVoiceJoin').mockImplementation(async () => {
    calls.push('authorize');
    return { media_server_url: 'wss://media.invalid', token: 't' };
  });
  vi.spyOn(internals, 'resolveAuthorizedJoinChannel').mockResolvedValue({
    id: 'ch-1',
    name: 'General',
    server_id: 'srv-1',
  });
  // The connect stage owns E2EE init and every getUserMedia. Stop it there: the
  // assertions are about what ran BEFORE it, not about media.
  vi.spyOn(internals, 'connectAuthorizedJoinSession').mockImplementation(async () => {
    calls.push('connect');
    throw new Error('connect stopped by test');
  });
  vi.spyOn(internals, 'initEncryptionCore').mockImplementation(async () => {
    calls.push('e2ee');
  });
}

beforeEach(() => {
  resetAllStores();
  calls = [];
  mockAcquire.mockReset();
  mockRelease.mockReset();
  mockRelease.mockImplementation(async (intent) => {
    calls.push(`release:${intent}`);
    return true;
  });
  getUserMedia = vi.fn(async () => {
    calls.push('getUserMedia');
    throw new Error('no capture in this suite');
  });
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia, getDisplayMedia: vi.fn(), enumerateDevices: vi.fn() },
    configurable: true,
  });
  stubDownstream();
});

afterEach(() => {
  vi.restoreAllMocks();
  internals.joinInFlight = false;
});

function answer(result: Awaited<ReturnType<typeof acquire>>): void {
  mockAcquire.mockImplementation(async (intent) => {
    calls.push(`acquire:${intent}`);
    return result;
  });
}

describe('joinChannel acquires the capture lease first (#87 §3.8)', () => {
  it('awaits acquire(voice-join) before authorization, E2EE init and getUserMedia', async () => {
    answer({ status: 'granted' });

    await expect(voiceService.joinChannel('ch-1')).rejects.toThrow('connect stopped by test');

    expect(calls.slice(0, 3)).toEqual(['acquire:voice-join', 'authorize', 'connect']);
    expect(mockAcquire).toHaveBeenCalledTimes(1);
  });

  it('a grant clears the moved notice', async () => {
    useVoiceStore.getState().setCaptureMovedNotice(true);
    answer({ status: 'granted' });

    await expect(voiceService.joinChannel('ch-1')).rejects.toThrow();

    expect(useVoiceStore.getState().captureMovedNotice).toBe(false);
  });

  it('declined resolves silently and counts the decline', async () => {
    answer({ status: 'declined' });
    const before = useVoiceStore.getState().captureDeclinedSeq;

    await expect(voiceService.joinChannel('ch-1')).resolves.toBeUndefined();

    expect(useVoiceStore.getState().joinError).toBeNull();
    expect(useVoiceStore.getState().captureDeclinedSeq).toBe(before + 1);
    expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    expect(calls).toEqual(['acquire:voice-join']);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(internals.joinInFlight).toBe(false);
  });

  it('a non-grant hands back the DM join claim it made before the first await', async () => {
    answer({ status: 'declined' });

    const join = voiceService.joinChannel('dm-1', 'dm');
    // The claim stays synchronous (a second click must see it before any await).
    expect(useVoiceStore.getState().callState.kind).toBe('joining');
    await expect(join).resolves.toBeUndefined();

    expect(useVoiceStore.getState().callState).toEqual({ kind: 'idle' });
    expect(calls).toEqual(['acquire:voice-join']);
  });

  it('a Stay on a ring-owned join returns the joining state the ring set before calling in', async () => {
    answer({ status: 'declined' });
    // callStateMachine sets `joining` (with the ring id) BEFORE it calls joinChannel, so
    // this join claims nothing; its caller promotes `joining` to `in-call` on resolve.
    useVoiceStore
      .getState()
      .setCallState({ kind: 'joining', conversationId: 'dm-1', ringId: 'r-1' });

    await expect(voiceService.joinChannel('dm-1', 'dm')).resolves.toBeUndefined();

    expect(useVoiceStore.getState().callState).toEqual({ kind: 'idle' });
  });

  const rejected: Array<[CaptureFailureReason, Awaited<ReturnType<typeof acquire>>]> = [
    ['busy', { status: 'rejected', reason: 'busy' }],
    ['not-foreground', { status: 'rejected', reason: 'not-foreground' }],
    ['unavailable', { status: 'rejected', reason: 'unavailable' }],
    ['superseded', { status: 'rejected', reason: 'superseded' }],
    ['untrusted-sender', { status: 'rejected', reason: 'untrusted-sender' }],
    ['ipc-error', { status: 'rejected', reason: 'ipc-error' }],
    ['held', { status: 'held' }],
  ];

  it.each(rejected)('%s shows its copy and runs nothing downstream', async (reason, result) => {
    answer(result);

    const join = voiceService.joinChannel('ch-1');
    await expect(join).rejects.toBeInstanceOf(CaptureLeaseError);
    await expect(join).rejects.toMatchObject({ reason });

    expect(useVoiceStore.getState().joinError).toBe(captureLeaseMessage(reason));
    expect(calls).toEqual(['acquire:voice-join']);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().connectionState).toBe('disconnected');
    expect(internals.joinInFlight).toBe(false);
    // Nothing was granted, so there is nothing to give back.
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('an internal rebuild still acquires (cheap holder re-acquire) without a user-action advance', async () => {
    answer({ status: 'rejected', reason: 'superseded' });
    const generation = getVoiceActionGeneration();

    await expect(
      voiceService.joinChannel('ch-1', 'channel', { internalRebuild: true })
    ).rejects.toBeInstanceOf(CaptureLeaseError);

    expect(mockAcquire).toHaveBeenCalledWith('voice-join');
    expect(getVoiceActionGeneration()).toBe(generation);
  });

  it('a channel switch keeps the lease through its leave-before-join', async () => {
    // The old call's leave runs AFTER the grant. Releasing there would free the lease the
    // new join was just granted, and its getUserMedia would then run without it.
    useVoiceStore.setState({ activeChannelId: 'ch-old', connectionState: 'connected' });
    answer({ status: 'granted' });

    await expect(voiceService.joinChannel('ch-1')).rejects.toThrow('connect stopped by test');

    const authorizeAt = calls.indexOf('authorize');
    expect(authorizeAt).toBeGreaterThan(0);
    expect(calls.slice(0, authorizeAt)).toEqual(['acquire:voice-join']);
  });

  it('a join that fails after the grant gives the lease back once its media is torn down', async () => {
    answer({ status: 'granted' });

    await expect(voiceService.joinChannel('ch-1')).rejects.toThrow('connect stopped by test');

    expect(useVoiceStore.getState().connectionState).toBe('error');
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(calls.at(-1)).toBe('release:voice-join');
  });

  it('a join failure whose cleanup throws keeps the lease (the tracks may still be live)', async () => {
    answer({ status: 'granted' });
    vi.spyOn(
      voiceService as unknown as { cleanup: () => Promise<void> },
      'cleanup'
    ).mockRejectedValueOnce(new Error('cleanup failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(voiceService.joinChannel('ch-1')).rejects.toThrow('connect stopped by test');

    expect(useVoiceStore.getState().connectionState).toBe('error');
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
