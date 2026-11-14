import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { resetAllStores } from '../../helpers/store-helpers';

vi.mock('@/renderer/stores/voice/voiceStore', () => {
  const initialState = {
    videoDeviceId: null as string | null,
    connectionState: 'disconnected',
  };
  type VoiceState = typeof initialState;
  let state: VoiceState = { ...initialState };
  const listeners = new Set<(next: VoiceState, previous: VoiceState) => void>();
  const setState = vi.fn((partial: Partial<VoiceState>) => {
    const previous = state;
    state = { ...state, ...partial };
    listeners.forEach((listener) => listener(state, previous));
  });
  const useVoiceStore = Object.assign(
    vi.fn((selector: (state: VoiceState) => unknown) => selector(state)),
    {
      getState: vi.fn(() => ({ ...state, reset: () => setState(initialState) })),
      setState,
      subscribe: vi.fn((listener: (next: VoiceState, previous: VoiceState) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    }
  );
  return { useVoiceStore };
});

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>();
  return { ...actual, acquire: vi.fn(), release: vi.fn() };
});

import { useCameraTest } from '@/renderer/hooks/device/useCameraTest';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import {
  acquire,
  release,
  captureLeaseMessage,
  captureRevokedEvents,
  dispatchCaptureRevoked,
  CAPTURE_REVOKED_EVENT,
} from '@/renderer/services/voice/captureLeaseClient';

const mockTrackStop = vi.fn();
let mockGetUserMedia: ReturnType<typeof vi.fn>;
let callOrder: string[] = [];

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  vi.mocked(acquire).mockResolvedValue({ status: 'granted' });
  vi.mocked(release).mockResolvedValue(true);
  (useVoiceStore as any).setState({ videoDeviceId: 'camera-1' });
  mockGetUserMedia = vi.fn().mockResolvedValue({
    getTracks: () => [{ stop: mockTrackStop }],
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: mockGetUserMedia },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCameraTest', () => {
  it('returns correct initial state', () => {
    const { result } = renderHook(() => useCameraTest());
    expect(result.current.isTesting).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.stream).toBeNull();
  });

  it('starts camera preview on toggle', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(mockGetUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: 'camera-1' } },
    });
    expect(result.current.isTesting).toBe(true);
    expect(result.current.stream).not.toBeNull();
  });

  it('#3635 starts normally when deferred camera capture resolves', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    mockGetUserMedia.mockReturnValueOnce(pending);
    const { result } = renderHook(() => useCameraTest());
    let start!: Promise<void>;
    await act(async () => {
      start = result.current.toggleTest();
      // #87: the capture lease is answered before getUserMedia starts.
      await vi.waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    });
    await act(async () => {
      resolveCapture(stream);
      await start;
    });
    expect(result.current.stream).toBe(stream);
    expect(result.current.isTesting).toBe(true);
  });

  it('#3635 stops a camera stream resolved after cancellation', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    mockGetUserMedia.mockReturnValueOnce(pending);
    const { result } = renderHook(() => useCameraTest());
    let start!: Promise<void>;
    await act(async () => {
      start = result.current.toggleTest();
      // #87: the capture lease is answered before getUserMedia starts.
      await vi.waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    });
    act(() => result.current.stopTest());
    await act(async () => {
      resolveCapture(stream);
      await start;
    });
    expect(stop, 'cancelled capture must release its late track').toHaveBeenCalledOnce();
    expect(result.current.stream).toBeNull();
    expect(result.current.isTesting).toBe(false);
  });

  it('#3635 stops a camera stream resolved after unmount', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    mockGetUserMedia.mockReturnValueOnce(pending);
    const { result, unmount } = renderHook(() => useCameraTest());
    let start!: Promise<void>;
    await act(async () => {
      start = result.current.toggleTest();
      // #87: the capture lease is answered before getUserMedia starts.
      await vi.waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    });
    unmount();
    await act(async () => {
      resolveCapture(stream);
      await start;
    });
    expect(stop, 'unmounted capture must release its late track').toHaveBeenCalledOnce();
  });

  it('uses video: true when no device selected', async () => {
    (useVoiceStore as any).setState({ videoDeviceId: null });
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(mockGetUserMedia).toHaveBeenCalledWith({ video: true });
  });

  it('stops preview on second toggle', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stream).toBeNull();
    expect(mockTrackStop).toHaveBeenCalled();
  });

  it('stopTest cleans up tracks', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    act(() => {
      result.current.stopTest();
    });
    expect(mockTrackStop).toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
  });

  it('#3635 stops an active camera preview when a voice call starts', async () => {
    const stop = vi.fn();
    mockGetUserMedia.mockResolvedValueOnce({ getTracks: () => [{ stop }] });
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    act(() => (useVoiceStore as any).setState({ connectionState: 'connected' }));
    expect(stop, 'call admission must stop the active camera preview').toHaveBeenCalledOnce();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stream).toBeNull();
  });

  it('#3635 releases a pending camera capture when a voice call starts', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    const stop = vi.fn();
    mockGetUserMedia.mockReturnValueOnce(pending);
    const { result } = renderHook(() => useCameraTest());
    let start!: Promise<void>;
    await act(async () => {
      start = result.current.toggleTest();
      // #87: the capture lease is answered before getUserMedia starts.
      await vi.waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
    });
    act(() => (useVoiceStore as any).setState({ connectionState: 'connected' }));
    await act(async () => {
      resolveCapture({ getTracks: () => [{ stop }] } as unknown as MediaStream);
      await start;
    });
    expect(stop, 'call admission must release a pending camera stream').toHaveBeenCalledOnce();
    expect(result.current.stream).toBeNull();
    expect(result.current.isTesting).toBe(false);
  });

  it('sets denied error for NotAllowedError', async () => {
    mockGetUserMedia.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'));
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(result.current.error).toBe('Camera access denied');
    expect(result.current.isTesting).toBe(false);
  });

  it('sets generic error for other failures', async () => {
    mockGetUserMedia.mockRejectedValueOnce(new Error('No device'));
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(result.current.error).toBe('Failed to access camera');
  });

  it('stops tracks on unmount', async () => {
    const { result, unmount } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    unmount();
    expect(mockTrackStop).toHaveBeenCalled();
  });
});

describe('useCameraTest capture lease (#87)', () => {
  beforeEach(() => {
    const order: string[] = [];
    vi.mocked(acquire).mockImplementation(async (intent) => {
      order.push(`acquire:${intent}`);
      return { status: 'granted' };
    });
    vi.mocked(release).mockResolvedValue(true);
    mockGetUserMedia.mockImplementation(async () => {
      order.push('getUserMedia');
      return { getTracks: () => [{ stop: mockTrackStop }] };
    });
    callOrder = order;
  });

  it('acquires device-test before getUserMedia', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(callOrder).toEqual(['acquire:device-test', 'getUserMedia']);
    expect(result.current.isTesting).toBe(true);
    expect(result.current.stoppedReason).toBeNull();
  });

  it('held: does not capture and reports stoppedReason "held"', async () => {
    vi.mocked(acquire).mockResolvedValue({ status: 'held' });
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(mockGetUserMedia).not.toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stoppedReason).toBe('held');
    expect(result.current.error).toBeNull();
  });

  it('other rejects: does not capture and shows the captureLeaseMessage copy', async () => {
    vi.mocked(acquire).mockResolvedValue({ status: 'rejected', reason: 'not-foreground' });
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(mockGetUserMedia).not.toHaveBeenCalled();
    expect(result.current.error).toBe(captureLeaseMessage('not-foreground'));
    expect(result.current.stoppedReason).toBeNull();
  });

  it('granted: toggling off releases device-test', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(release).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('device-test', expect.any(Number));
  });

  it('granted: unmount releases device-test and removes the revoke listener', async () => {
    const removeSpy = vi.spyOn(captureRevokedEvents, 'removeEventListener');
    const { result, unmount } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    unmount();
    expect(release).toHaveBeenCalledWith('device-test', expect.any(Number));
    expect(removeSpy).toHaveBeenCalledWith(CAPTURE_REVOKED_EVENT, expect.any(Function));
  });

  it('capture-revoked "backgrounded" while testing stops tracks and reports it', async () => {
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    act(() => dispatchCaptureRevoked('backgrounded'));
    expect(mockTrackStop).toHaveBeenCalled();
    expect(result.current.isTesting).toBe(false);
    expect(result.current.stream).toBeNull();
    expect(result.current.stoppedReason).toBe('backgrounded');
    expect(release).toHaveBeenCalledWith('device-test', expect.any(Number));
  });

  it('the next start clears stoppedReason', async () => {
    vi.mocked(acquire).mockResolvedValueOnce({ status: 'held' });
    const { result } = renderHook(() => useCameraTest());
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(result.current.stoppedReason).toBe('held');
    await act(async () => {
      await result.current.toggleTest();
    });
    expect(result.current.stoppedReason).toBeNull();
    expect(result.current.isTesting).toBe(true);
  });
});
