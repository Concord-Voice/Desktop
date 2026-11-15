/**
 * CaptureMovedBanner (#87 §3.8): the inline notice after a `moved` revocation.
 *
 * T0 row 7 chose `document.visibilityState` as the visibility signal, so the text is
 * set only once the document reports `visible` (one frame later, so the region is in
 * the tree empty first and the text change is what gets announced).
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, act } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { CAPTURE_LEASE_COPY } from '@/renderer/services/voice/captureLeaseClient';
import CaptureMovedBanner from '@/renderer/components/Voice/CaptureMovedBanner';

let frames: FrameRequestCallback[] = [];

function flushFrame(): void {
  const queued = frames;
  frames = [];
  act(() => {
    for (const cb of queued) cb(0);
  });
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  resetAllStores();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

describe('CaptureMovedBanner', () => {
  it('renders nothing while captureMovedNotice is false', () => {
    const { container } = render(<CaptureMovedBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps its status text empty until the document is visible, then sets the copy', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    useVoiceStore.setState({ captureMovedNotice: true });
    render(<CaptureMovedBanner />);
    const status = screen.getByRole('status');
    flushFrame();
    expect(status).not.toHaveTextContent(CAPTURE_LEASE_COPY.banner);

    setVisibility('visible');
    expect(status).not.toHaveTextContent(CAPTURE_LEASE_COPY.banner);
    flushFrame();
    expect(status).toHaveTextContent(CAPTURE_LEASE_COPY.banner);
    expect(screen.getByRole('button', { name: CAPTURE_LEASE_COPY.dismiss })).toBeInTheDocument();
  });

  it('keeps the copy once shown if the document is hidden again', () => {
    useVoiceStore.setState({ captureMovedNotice: true });
    render(<CaptureMovedBanner />);
    flushFrame();
    setVisibility('hidden');
    expect(screen.getByRole('status')).toHaveTextContent(CAPTURE_LEASE_COPY.banner);
  });

  it('Dismiss clears the flag and moves focus to the next tabbable after the banner', async () => {
    const user = userEvent.setup();
    useVoiceStore.setState({ captureMovedNotice: true });
    render(
      <div className="app">
        <button type="button">Before</button>
        <CaptureMovedBanner />
        <div>
          <button type="button" disabled>
            Disabled
          </button>
          <button type="button">After</button>
        </div>
      </div>
    );
    await user.click(screen.getByRole('button', { name: CAPTURE_LEASE_COPY.dismiss }));
    expect(useVoiceStore.getState().captureMovedNotice).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }));
  });

  it('with nothing tabbable after it, Dismiss focuses .app[tabindex="-1"], never body', async () => {
    const user = userEvent.setup();
    useVoiceStore.setState({ captureMovedNotice: true });
    const { container } = render(
      <div className="app">
        <CaptureMovedBanner />
      </div>
    );
    await user.click(screen.getByRole('button', { name: CAPTURE_LEASE_COPY.dismiss }));
    const app = container.querySelector('.app');
    expect(app).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(app);
    expect(document.activeElement).not.toBe(document.body);
  });
});
