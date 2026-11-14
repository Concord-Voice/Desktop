import { vi, describe, it, expect, beforeEach } from 'vitest';

const calls: string[] = [];

vi.mock('@/renderer/services/voice/captureLeaseClient', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/renderer/services/voice/captureLeaseClient')>();
  return { ...actual, acquire: vi.fn(), release: vi.fn() };
});

import {
  acquire,
  release,
  dispatchCaptureRevoked,
} from '@/renderer/services/voice/captureLeaseClient';
import { enumerateWebcamCapabilities } from '@/renderer/services/voice/mediaCapabilities';

const getUserMedia = vi.fn();
let deviceSeq = 0;
const nextDevice = () => `cam-${++deviceSeq}`;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  vi.mocked(acquire).mockImplementation(async (intent) => {
    calls.push(`acquire:${intent}`);
    return { status: 'granted' };
  });
  vi.mocked(release).mockImplementation(async (intent) => {
    calls.push(`release:${intent}`);
    return true;
  });
  getUserMedia.mockImplementation(async () => {
    calls.push('getUserMedia');
    return { getTracks: () => [{ stop: vi.fn() }] };
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
    writable: true,
  });
});

describe('enumerateWebcamCapabilities capture lease (#87)', () => {
  it('acquires device-test before probing and releases after', async () => {
    const caps = await enumerateWebcamCapabilities(nextDevice());
    expect(caps.length).toBeGreaterThan(0);
    expect(calls[0]).toBe('acquire:device-test');
    expect(calls.at(-1)).toBe('release:device-test');
    expect(calls.filter((c) => c.startsWith('release'))).toHaveLength(1);
  });

  it('held: returns [] without getUserMedia and does not cache the empty result', async () => {
    const id = nextDevice();
    vi.mocked(acquire).mockResolvedValueOnce({ status: 'held' });
    await expect(enumerateWebcamCapabilities(id)).resolves.toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    const retry = await enumerateWebcamCapabilities(id);
    expect(retry.length).toBeGreaterThan(0);
  });

  it('rejected: returns [] without getUserMedia', async () => {
    vi.mocked(acquire).mockResolvedValueOnce({ status: 'rejected', reason: 'busy' });
    await expect(enumerateWebcamCapabilities(nextDevice())).resolves.toEqual([]);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('releases even when every probe fails', async () => {
    getUserMedia.mockRejectedValue(new DOMException('no', 'OverconstrainedError'));
    await expect(enumerateWebcamCapabilities(nextDevice())).resolves.toEqual([]);
    expect(release).toHaveBeenCalledWith('device-test', expect.any(Number));
  });

  it('a capture-revoked event stops the remaining probes and skips the cache', async () => {
    const id = nextDevice();
    getUserMedia.mockImplementationOnce(async () => {
      dispatchCaptureRevoked('backgrounded');
      return { getTracks: () => [{ stop: vi.fn() }] };
    });
    await enumerateWebcamCapabilities(id);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('device-test', expect.any(Number));
    getUserMedia.mockClear();
    await enumerateWebcamCapabilities(id);
    expect(getUserMedia.mock.calls.length).toBeGreaterThan(1);
  });
});
