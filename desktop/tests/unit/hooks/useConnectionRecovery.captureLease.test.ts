/**
 * #87 §3.8 — the sustained-outage teardown and the capture lease.
 *
 * The outage teardown keeps the lease only while a rejoin ticket for that teardown is
 * still pending: the rejoin is a holder re-acquire, and a background outage must not
 * hand the microphone to another connection without the user's say. A teardown no rejoin
 * can follow, or a ticket abandoned after it, gives the lease back; otherwise it outlives
 * the call. A user's own join or leave decides the lease itself, so those paths stay
 * silent here.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConnectionStore } from '@/renderer/stores/ui/connectionStore';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useUserStore } from '@/renderer/stores/auth/userStore';

const mockWsService = {
  setAggressiveReconnect: vi.fn(),
  getState: vi.fn().mockReturnValue('DISCONNECTED'),
};

vi.mock('@/renderer/services/messaging/websocketService', () => ({
  getWebSocketService: () => mockWsService,
  ConnectionState: {
    DISCONNECTED: 'DISCONNECTED',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    RECONNECTING: 'RECONNECTING',
  },
}));

vi.mock('@/renderer/services/e2ee/e2eeService', () => ({
  e2eeService: { isInitialized: false },
}));

vi.mock('@/renderer/services/system/postLoginHydration', () => ({
  hydratePostLogin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/renderer/services/system/postLoginHydrationLifecycle', () => ({
  beginPostLoginHydrationGuard: vi.fn(() => ({
    signal: new AbortController().signal,
    isCurrent: () => true,
  })),
  isHydrationLifecycleCurrent: vi.fn(() => true),
  resetPostLoginHydrationLifecycle: vi.fn(),
}));

vi.mock('@/renderer/services/system/recoveryService', () => ({
  runPreflight: vi.fn().mockResolvedValue({
    internet: 'ok',
    serverReachable: 'ok',
    tokenValid: 'ok',
    sessionRevoked: false,
    rendererStable: 'ok',
  }),
  clearCrashFlag: vi.fn(),
}));

vi.mock('@/renderer/services/system/resetService', () => ({
  gracefulReset: vi.fn(),
  recoveryReset: vi.fn(),
  softRestart: vi.fn(),
}));

vi.mock('@/renderer/services/voice/voiceService', () => ({
  voiceService: {
    emergencyCleanup: vi.fn(),
    joinChannel: vi.fn().mockResolvedValue(undefined),
    getVoiceActionGeneration: vi.fn(() => 0),
  },
}));

vi.mock('@/renderer/services/voice/captureLeaseClient', () => ({
  release: vi.fn().mockResolvedValue(true),
}));

import { useConnectionRecovery } from '@/renderer/hooks/voice/useConnectionRecovery';
import { voiceService } from '@/renderer/services/voice/voiceService';
import { release } from '@/renderer/services/voice/captureLeaseClient';

const emergencyCleanup = vi.mocked(voiceService.emergencyCleanup);
const joinChannel = vi.mocked(voiceService.joinChannel);
const getVoiceActionGeneration = vi.mocked(voiceService.getVoiceActionGeneration);
const mockRelease = vi.mocked(release);

function inCall(channelId = 'voice-1'): void {
  useVoiceStore.setState({ activeChannelId: channelId, connectionState: 'connected' });
}

// The real teardown resets the voice store; the mock has to, or every later guard
// reads a live call that no longer exists.
function teardownResetsVoice(): void {
  emergencyCleanup.mockImplementation(() => {
    useVoiceStore.setState({ activeChannelId: null, connectionState: 'disconnected' });
  });
}

async function outage(): Promise<(state: never) => void> {
  const { result } = renderHook(() =>
    useConnectionRecovery(mockWsService as never, vi.fn().mockResolvedValue(undefined))
  );
  result.current('RECONNECTING' as never);
  await vi.advanceTimersByTimeAsync(15_000);
  await vi.waitFor(() => expect(useConnectionStore.getState().phase).not.toBe('preflight'));
  return result.current as (state: never) => void;
}

const ticket = () => useConnectionStore.getState().pendingVoiceRejoin;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useConnectionStore.getState().reset();
  useVoiceStore.setState({ activeChannelId: null, connectionState: 'disconnected' });
  useUserStore.setState({ fetchUser: vi.fn().mockResolvedValue(undefined) } as never);
  getVoiceActionGeneration.mockImplementation(() => 0);
  emergencyCleanup.mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useConnectionRecovery — capture lease across a sustained outage (#87)', () => {
  it('an outage with a rejoin ticket tears down with keepCaptureLease', async () => {
    inCall();
    teardownResetsVoice();

    await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));

    expect(emergencyCleanup).toHaveBeenCalledWith({ keepCaptureLease: true });
    expect(ticket()?.channelId).toBe('voice-1');
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('a successful rejoin re-acquires through the join and releases nothing', async () => {
    inCall();
    teardownResetsVoice();

    const onState = await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));
    onState('CONNECTED' as never);

    await vi.waitFor(() => expect(joinChannel).toHaveBeenCalledTimes(1));
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('the ticket retraction with no teardown (the cleanup .catch) releases nothing', async () => {
    inCall();
    getVoiceActionGeneration.mockImplementation(() => {
      throw new Error('voice service unusable');
    });

    await outage();
    await vi.waitFor(() => expect(ticket()).toBeNull());

    expect(emergencyCleanup).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
    // The session was never torn down, so it is still the live call.
    expect(useVoiceStore.getState().connectionState).toBe('connected');
  });

  it('a teardown whose ticket was retracted (room replaced mid-outage) does not keep the lease', async () => {
    inCall('voice-1');
    // An internal rebuild replaces the room after preflight captured voice-1 (the
    // ticket is minted synchronously, the teardown runs after the lazy import). The
    // ticket is retracted and nothing will rejoin, so nothing may keep the lease.
    const unsubscribe = useConnectionStore.subscribe((s) => {
      if (!s.pendingVoiceRejoin) return;
      unsubscribe();
      useVoiceStore.setState({ activeChannelId: 'voice-2' });
    });

    await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));

    expect(ticket()).toBeNull();
    expect(emergencyCleanup).toHaveBeenCalledWith({ keepCaptureLease: false });
  });

  it('a mid-join teardown with no channel id (no ticket) does not keep the lease', async () => {
    useVoiceStore.setState({ activeChannelId: null, connectionState: 'connecting' });

    await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));

    expect(ticket()).toBeNull();
    expect(emergencyCleanup).toHaveBeenCalledWith({ keepCaptureLease: false });
  });

  it('a ticket abandoned after the kept-lease teardown releases voice-join', async () => {
    inCall();
    teardownResetsVoice();

    const onState = await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));
    // The account changed before the reconnect: the rejoin is abandoned.
    useAuthStore.setState({ authGeneration: useAuthStore.getState().authGeneration + 1 });
    onState('CONNECTED' as never);

    await vi.waitFor(() => expect(ticket()).toBeNull());
    expect(joinChannel).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledWith('voice-join');
  });

  it("a user's own join that superseded the rejoin keeps its lease", async () => {
    inCall();
    teardownResetsVoice();

    const onState = await outage();
    await vi.waitFor(() => expect(emergencyCleanup).toHaveBeenCalledTimes(1));
    // The user joined another channel themselves while the control plane was down.
    inCall('voice-9');
    onState('CONNECTED' as never);

    await vi.waitFor(() => expect(ticket()).toBeNull());
    expect(joinChannel).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });
});
