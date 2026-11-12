import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquire,
  captureLeaseMessage,
  CaptureLeaseError,
  dispatchCaptureRevoked,
  isAcquirePending,
  leaseViewOf,
  release,
  subscribeAcquirePending,
  subscribeLeaseState,
} from '@/renderer/services/voice/captureLeaseClient';
import type { CaptureAcquireResult, CaptureLeaseState } from '@/shared/captureLease';

// The preload bridge is installed on the shared `window.electron` mock from
// tests/setup.ts; a shell below contract 35 simply has no `capture` key.
function setBridge(bridge: Record<string, unknown> | undefined): void {
  const host = globalThis.electron as unknown as Record<string, unknown>;
  if (bridge === undefined) delete host.capture;
  else host.capture = bridge;
}

afterEach(() => {
  setBridge(undefined);
});

describe('captureLeaseClient — bridge absent (legacy shell)', () => {
  it('acquire resolves granted and release resolves false', async () => {
    setBridge(undefined);
    await expect(acquire('voice-join')).resolves.toEqual({ status: 'granted' });
    await expect(release('voice-join')).resolves.toBe(false);
  });

  it('subscribeLeaseState is a no-op that still returns an unsubscribe', () => {
    setBridge(undefined);
    const cb = vi.fn();
    const off = subscribeLeaseState(cb);
    off();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('captureLeaseClient — bridge present', () => {
  it('forwards { intent } and returns the validated result', async () => {
    const acquireFn = vi.fn().mockResolvedValue({ status: 'declined' });
    setBridge({ acquire: acquireFn, release: vi.fn().mockResolvedValue(true) });
    await expect(acquire('device-test')).resolves.toEqual({ status: 'declined' });
    expect(acquireFn).toHaveBeenCalledWith({ intent: 'device-test' });
    await expect(release('device-test')).resolves.toBe(true);
  });

  it('a throwing invoke becomes rejected/ipc-error, and release resolves false', async () => {
    setBridge({
      acquire: vi.fn().mockRejectedValue(new Error('boom')),
      release: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(acquire('voice-join')).resolves.toEqual({
      status: 'rejected',
      reason: 'ipc-error',
    });
    await expect(release('voice-join')).resolves.toBe(false);
  });

  it('a malformed result fails closed as ipc-error', async () => {
    setBridge({ acquire: vi.fn().mockResolvedValue({ status: 'granted', extra: 1 }) });
    await expect(acquire('voice-join')).resolves.toEqual({
      status: 'rejected',
      reason: 'ipc-error',
    });
  });

  it('isAcquirePending is true between call and settle for voice-join; subscribers notified twice', async () => {
    let settle: (r: CaptureAcquireResult) => void = () => undefined;
    setBridge({
      acquire: vi.fn(
        () =>
          new Promise<CaptureAcquireResult>((resolve) => {
            settle = resolve;
          })
      ),
    });
    const cb = vi.fn();
    const off = subscribeAcquirePending(cb);
    expect(isAcquirePending()).toBe(false);
    const pending = acquire('voice-join');
    expect(isAcquirePending()).toBe(true);
    settle({ status: 'granted' });
    await pending;
    expect(isAcquirePending()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
  });

  it('a device-test acquire does not mark the join pending', async () => {
    setBridge({ acquire: vi.fn().mockResolvedValue({ status: 'held' }) });
    const pending = acquire('device-test');
    expect(isAcquirePending()).toBe(false);
    await expect(pending).resolves.toEqual({ status: 'held' });
  });

  it('subscribeLeaseState maps pushes to the view and unsubscribes', () => {
    let push: (s: CaptureLeaseState) => void = () => undefined;
    const off = vi.fn();
    setBridge({
      onLeaseChanged: vi.fn((cb: (s: CaptureLeaseState) => void) => {
        push = cb;
        return off;
      }),
    });
    const views: string[] = [];
    const unsubscribe = subscribeLeaseState((v) => views.push(v));
    push({ held: true, mine: false });
    push({ held: true, mine: true });
    push({ held: false, mine: false });
    expect(views).toEqual(['other', 'mine', 'none']);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe('leaseViewOf', () => {
  it.each([
    [{ held: true, mine: true }, 'mine'],
    [{ held: true, mine: false }, 'other'],
    [{ held: false, mine: false }, 'none'],
  ] as const)('%o → %s', (state, view) => {
    expect(leaseViewOf(state)).toBe(view);
  });
});

describe('captureLeaseMessage (spec §3.8 copy, verbatim)', () => {
  const RESTART = "Couldn't start voice. Restart Concord Voice and try again.";
  it.each([
    ['busy', "You've asked to switch a few times quickly. Wait a moment, then try again."],
    [
      'not-foreground',
      "Voice can start only on the connection you're viewing. Join again from here.",
    ],
    ['unavailable', "This connection doesn't offer voice."],
    ['superseded', 'Your connection restarted before voice could start. Join again.'],
    ['untrusted-sender', RESTART],
    ['ipc-error', RESTART],
    ['unknown', RESTART],
  ] as const)('%s', (reason, text) => {
    expect(captureLeaseMessage(reason)).toBe(text);
  });

  it('CaptureLeaseError carries the reason and the copy as its message', () => {
    const err = new CaptureLeaseError('busy');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('busy');
    expect(err.message).toBe(captureLeaseMessage('busy'));
  });
});

describe('captureLeaseClient — overlapping device tests share one claim', () => {
  function bridgeWith(release: ReturnType<typeof vi.fn>): void {
    setBridge({
      acquire: vi.fn().mockResolvedValue({ status: 'granted' }),
      release,
    });
  }

  it('sends the release only when the last device test lets go', async () => {
    const releaseFn = vi.fn().mockResolvedValue(true);
    bridgeWith(releaseFn);
    await acquire('device-test');
    await acquire('device-test');
    await expect(release('device-test')).resolves.toBe(true);
    expect(releaseFn).not.toHaveBeenCalled();
    await expect(release('device-test')).resolves.toBe(true);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it('counts an acquire still in flight, so an overlapping release cannot free the claim', async () => {
    const releaseFn = vi.fn().mockResolvedValue(true);
    let grantFirst: (r: { status: 'granted' }) => void = () => undefined;
    let grantSecond: (r: { status: 'granted' }) => void = () => undefined;
    const acquireFn = vi
      .fn()
      .mockImplementationOnce(() => new Promise((res) => (grantFirst = res)))
      .mockImplementationOnce(() => new Promise((res) => (grantSecond = res)));
    setBridge({ acquire: acquireFn, release: releaseFn });
    const first = acquire('device-test');
    const second = acquire('device-test');
    // The first test is stopped and restarted: its stale grant lands, then the successor's.
    grantFirst({ status: 'granted' });
    await first;
    await release('device-test'); // the stale grant gives its count back
    expect(releaseFn).not.toHaveBeenCalled();
    grantSecond({ status: 'granted' });
    await second;
    await release('device-test'); // the successor stops: now the last hold
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it('a release while another acquire is still in flight does not free the claim', async () => {
    const releaseFn = vi.fn().mockResolvedValue(true);
    let grant: (r: { status: 'granted' }) => void = () => undefined;
    const acquireFn = vi
      .fn()
      .mockResolvedValueOnce({ status: 'granted' })
      .mockImplementationOnce(() => new Promise((res) => (grant = res)));
    setBridge({ acquire: acquireFn, release: releaseFn });
    await acquire('device-test'); // the webcam probe
    const pending = acquire('device-test'); // a mic test, still waiting on main
    await release('device-test'); // the probe finishes
    expect(releaseFn).not.toHaveBeenCalled();
    grant({ status: 'granted' });
    await pending;
  });

  it('a revocation clears the count so the stopping tests still release', async () => {
    const releaseFn = vi.fn().mockResolvedValue(true);
    bridgeWith(releaseFn);
    await acquire('device-test');
    await acquire('device-test');
    dispatchCaptureRevoked('backgrounded');
    await release('device-test');
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it('a refused acquire holds nothing and voice-join is never counted', async () => {
    const releaseFn = vi.fn().mockResolvedValue(true);
    setBridge({ acquire: vi.fn().mockResolvedValue({ status: 'held' }), release: releaseFn });
    await acquire('device-test');
    await release('device-test');
    expect(releaseFn).toHaveBeenCalledTimes(1);
    await release('voice-join');
    expect(releaseFn).toHaveBeenCalledTimes(2);
  });
});
