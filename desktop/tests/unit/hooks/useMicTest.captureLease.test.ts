import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { resetAllStores } from '../../helpers/store-helpers';

const calls: string[] = [];

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>();
  return {
    ...actual,
    acquire: vi.fn(),
    release: vi.fn(),
  };
});

vi.mock('@/renderer/services/voice/voiceService', () => ({
  voiceService: {
    beginTestSuspension: vi.fn(),
    endTestSuspension: vi.fn(),
    setLocalTestingStatus: vi.fn(),
  },
}));

vi.mock('@/renderer/stores/voice/osPermissionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/stores/voice/osPermissionStore')>();
  return { ...actual, ensureOsPermission: vi.fn().mockResolvedValue('granted') };
});

vi.mock('@/renderer/services/voice/micProcessor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/services/voice/micProcessor')>();
  return {
    ...actual,
    createMicProcessor: vi.fn(async () => ({
      node: { connect: vi.fn(), disconnect: vi.fn() },
      close: vi.fn(),
      setGate: vi.fn(),
      setWindowReporting: vi.fn(),
      setCalibrationPhase: vi.fn(),
    })),
  };
});

import {
  acquire,
  release,
  captureLeaseMessage,
  captureRevokedEvents,
  dispatchCaptureRevoked,
  CAPTURE_REVOKED_EVENT,
} from '@/renderer/services/voice/captureLeaseClient';
import { useMicTest } from '@/renderer/hooks/device/useMicTest';

const trackStop = vi.fn();
const getUserMedia = vi.fn();

function makeNode() {
  return { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 1 } };
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  sampleRate = 48000;
  destination = {};
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createGain = vi.fn(makeNode);
  createMediaStreamSource = vi.fn(makeNode);
  createMediaStreamDestination = vi.fn(() => ({ stream: {} }));
}

class FakeAudio {
  srcObject: unknown = null;
  play = vi.fn(async () => undefined);
  pause = vi.fn();
}

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  calls.length = 0;
  vi.mocked(acquire).mockImplementation(async (intent) => {
    calls.push(`acquire:${intent}`);
    return { status: 'granted' };
  });
  vi.mocked(release).mockResolvedValue(true);
  getUserMedia.mockImplementation(async () => {
    calls.push('getUserMedia');
    return {
      getTracks: () => [
        { stop: trackStop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ],
    };
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
    writable: true,
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMicTest capture lease (#87)', () => {
  it('acquires device-test before getUserMedia', async () => {
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    expect(calls).toEqual(['acquire:device-test', 'getUserMedia']);
    expect(result.current.isTesting).toBe(true);
    expect(result.current.stoppedReason).toBeNull();
  });

  it('held: does not capture and reports stoppedReason "held"', async () => {
    vi.mocked(acquire).mockResolvedValue({ status: 'held' });
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.isPending).toBe(false);
    expect(result.current.stoppedReason).toBe('held');
    expect(result.current.error).toBeNull();
    expect(release).not.toHaveBeenCalled();
  });

  it('other rejects: does not capture and shows the captureLeaseMessage copy', async () => {
    vi.mocked(acquire).mockResolvedValue({ status: 'rejected', reason: 'busy' });
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stoppedReason).toBeNull();
    expect(result.current.error).toBe(captureLeaseMessage('busy'));
  });

  it('granted: stopTest releases device-test', async () => {
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    expect(release).not.toHaveBeenCalled();
    act(() => result.current.stopTest());
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('device-test');
  });

  it('granted: unmount releases device-test and removes the revoke listener', async () => {
    const removeSpy = vi.spyOn(captureRevokedEvents, 'removeEventListener');
    const { result, unmount } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    unmount();
    expect(release).toHaveBeenCalledWith('device-test');
    expect(removeSpy).toHaveBeenCalledWith(CAPTURE_REVOKED_EVENT, expect.any(Function));
  });

  it('capture-revoked "backgrounded" while testing stops tracks and reports it', async () => {
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    act(() => dispatchCaptureRevoked('backgrounded'));
    expect(trackStop).toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stoppedReason).toBe('backgrounded');
    expect(release).toHaveBeenCalledWith('device-test');
  });

  it('capture-revoked while idle changes nothing', () => {
    const { result } = renderHook(() => useMicTest());
    act(() => dispatchCaptureRevoked('backgrounded'));
    expect(result.current.stoppedReason).toBeNull();
    expect(release).not.toHaveBeenCalled();
  });

  it('the next startTest clears stoppedReason', async () => {
    vi.mocked(acquire).mockResolvedValueOnce({ status: 'held' });
    const { result } = renderHook(() => useMicTest());
    await act(async () => {
      await result.current.startTest();
    });
    expect(result.current.stoppedReason).toBe('held');
    await act(async () => {
      await result.current.startTest();
    });
    expect(result.current.stoppedReason).toBeNull();
    expect(result.current.isTesting).toBe(true);
  });

  it('a grant that lands after Stop is released without capturing', async () => {
    let resolveAcquire: (v: { status: 'granted' }) => void = () => undefined;
    vi.mocked(acquire).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAcquire = resolve;
        })
    );
    const { result } = renderHook(() => useMicTest());
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.startTest();
    });
    act(() => result.current.stopTest());
    await act(async () => {
      resolveAcquire({ status: 'granted' });
      await pending;
    });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(result.current.isTesting).toBe(false);
  });
});
