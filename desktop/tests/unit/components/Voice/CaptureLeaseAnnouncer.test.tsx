/**
 * CaptureLeaseAnnouncer (#87 §3.8): the screen-reader line for a pending join and a
 * declined prompt. #3394 live-region pattern: the region mounts empty, its text is set
 * one frame later, and a module-level guard stops a remount re-announcing a decline.
 */
import React from 'react';
import { render, screen, act } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { acquire, CAPTURE_LEASE_COPY } from '@/renderer/services/voice/captureLeaseClient';
import type { CaptureAcquireResult } from '@/shared/captureLease';
import CaptureLeaseAnnouncer from '@/renderer/components/Voice/CaptureLeaseAnnouncer';
import MediaPolicyNotice from '@/renderer/components/Voice/MediaPolicyNotice';

let frames: FrameRequestCallback[] = [];
let settleAcquire: (r: CaptureAcquireResult) => void = () => undefined;
let priorElectron: unknown;

function flushFrame(): void {
  const queued = frames;
  frames = [];
  act(() => {
    for (const cb of queued) cb(0);
  });
}

beforeEach(() => {
  resetAllStores();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  priorElectron = (globalThis as { electron?: unknown }).electron;
  (globalThis as { electron?: unknown }).electron = {
    ...(priorElectron as Record<string, unknown> | undefined),
    capture: {
      acquire: vi.fn(
        () =>
          new Promise<CaptureAcquireResult>((resolve) => {
            settleAcquire = resolve;
          })
      ),
      release: vi.fn().mockResolvedValue(true),
      onLeaseChanged: vi.fn(() => () => undefined),
      onLeaseRevoked: vi.fn(() => () => undefined),
    },
  };
});

afterEach(async () => {
  await act(async () => {
    settleAcquire({ status: 'granted' });
  });
  vi.unstubAllGlobals();
  (globalThis as { electron?: unknown }).electron = priorElectron;
});

describe('CaptureLeaseAnnouncer', () => {
  it('mounts no region until there is something to say', () => {
    render(<CaptureLeaseAnnouncer />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('announces a decline one frame after its region mounts', () => {
    render(<CaptureLeaseAnnouncer />);
    act(() => useVoiceStore.getState().bumpCaptureDeclined());
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('');
    flushFrame();
    expect(region).toHaveTextContent(CAPTURE_LEASE_COPY.declined);
  });

  it('does not re-announce the same decline after a remount', () => {
    const first = render(<CaptureLeaseAnnouncer />);
    act(() => useVoiceStore.getState().bumpCaptureDeclined());
    flushFrame();
    first.unmount();

    render(<CaptureLeaseAnnouncer />);
    flushFrame();
    expect(screen.queryByText(CAPTURE_LEASE_COPY.declined)).toBeNull();

    // A NEW decline is still announced.
    act(() => useVoiceStore.getState().bumpCaptureDeclined());
    flushFrame();
    expect(screen.getByRole('status')).toHaveTextContent(CAPTURE_LEASE_COPY.declined);
  });

  it('announces the pending join while the acquire is in flight, and stops when it settles', async () => {
    render(<CaptureLeaseAnnouncer />);
    let pendingAcquire: Promise<unknown> = Promise.resolve();
    act(() => {
      pendingAcquire = acquire('voice-join');
    });
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('');
    flushFrame();
    expect(region).toHaveTextContent(CAPTURE_LEASE_COPY.pending);

    await act(async () => {
      settleAcquire({ status: 'granted' });
      await pendingAcquire;
    });
    expect(screen.queryByText(CAPTURE_LEASE_COPY.pending)).toBeNull();
  });

  it('is not inside the media-policy notice region', () => {
    render(
      <>
        <MediaPolicyNotice />
        <CaptureLeaseAnnouncer />
      </>
    );
    act(() => useVoiceStore.getState().bumpCaptureDeclined());
    flushFrame();
    const region = screen.getByText(CAPTURE_LEASE_COPY.declined);
    expect(region.closest('.media-policy-notice')).toBeNull();
  });
});
