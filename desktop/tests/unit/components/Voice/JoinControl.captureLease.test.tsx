/**
 * Join controls under the capture lease (#87 §3.8). One `describe` per control that
 * calls `voiceService.joinChannel` from a click: the voice channel's Join Voice button
 * (`VoiceView`) and the DM header's Join voice call button (`DMChatArea`).
 *
 * The pending state is driven through the REAL `captureLeaseClient`: the mocked
 * `joinChannel` awaits `acquire('voice-join')` exactly as the service does, against a
 * stubbed preload bridge whose answer the test settles by hand.
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, act, waitFor } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { acquire, CAPTURE_LEASE_COPY } from '@/renderer/services/voice/captureLeaseClient';
import type { CaptureAcquireResult } from '@/shared/captureLease';

vi.mock('@/renderer/components/Voice/ParticipantGrid', () => ({
  UserFrameGrid: () => <div data-testid="user-frame-grid" />,
  AudioOutputs: () => <div data-testid="audio-outputs" />,
}));
vi.mock('@/renderer/components/Voice/UserFrameBar', () => ({ default: () => null }));
vi.mock('@/renderer/components/Voice/VoiceStage', () => ({ default: () => null }));
vi.mock('@/renderer/components/Voice/StreamBar', () => ({ default: () => null }));
vi.mock('@/renderer/components/Voice/VoiceControls', () => ({ default: () => null }));
vi.mock('@/renderer/components/Voice/VoiceTextChat', () => ({ default: () => null }));
vi.mock('@/renderer/components/Voice/VoiceView.css', () => ({}));

const { mockJoinChannel } = vi.hoisted(() => ({ mockJoinChannel: vi.fn() }));
vi.mock('@/renderer/services/voice/voiceService', () => ({
  voiceService: { joinChannel: mockJoinChannel },
}));

import VoiceView from '@/renderer/components/Voice/VoiceView';
import { DMJoinCallButton } from '@/renderer/components/DirectMessages/DMChatArea';

let settleAcquire: (r: CaptureAcquireResult) => void = () => undefined;
let priorElectron: unknown;

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  useVoiceStore.setState({ connectionState: 'disconnected', activeChannelId: null });
  priorElectron = (globalThis as { electron?: unknown }).electron;
  const capture = {
    acquire: vi.fn(
      () =>
        new Promise<CaptureAcquireResult>((resolve) => {
          settleAcquire = resolve;
        })
    ),
    release: vi.fn().mockResolvedValue(true),
    onLeaseChanged: vi.fn(() => () => undefined),
    onLeaseRevoked: vi.fn(() => () => undefined),
  };
  (globalThis as { electron?: unknown }).electron = {
    ...(priorElectron as Record<string, unknown> | undefined),
    capture,
  };
  // The service's order: acquire first; `declined` bumps the seq and resolves quietly.
  mockJoinChannel.mockImplementation(async () => {
    const result = await acquire('voice-join');
    if (result.status === 'declined') useVoiceStore.getState().bumpCaptureDeclined();
  });
});

afterEach(async () => {
  // Never leave an acquire pending into the next test: the pending count is module state.
  await act(async () => {
    settleAcquire({ status: 'declined' });
  });
  (globalThis as { electron?: unknown }).electron = priorElectron;
});

interface ControlCase {
  name: string;
  renderControl: () => void;
  getControl: () => HTMLElement;
}

const CASES: ControlCase[] = [
  {
    name: 'VoiceView Join Voice',
    renderControl: () => {
      render(<VoiceView channelId="vc-1" channelName="General" />);
    },
    getControl: () => {
      const el = document.querySelector<HTMLElement>('.voice-view__join-btn');
      if (!el) throw new Error('join button not rendered');
      return el;
    },
  },
  {
    name: 'DMChatArea Join voice call',
    renderControl: () => {
      render(<DMJoinCallButton conversationId="dm-1" availability="available" />);
    },
    getControl: () => {
      const el = document.querySelector<HTMLElement>('.dm-chat-header-join-call-btn');
      if (!el) throw new Error('join button not rendered');
      return el;
    },
  },
];

describe.each(CASES)('$name (#87 capture lease)', ({ renderControl, getControl }) => {
  it('has no hint and no title while the microphone is not held elsewhere', () => {
    useVoiceStore.setState({ captureLease: 'none' });
    renderControl();
    const control = getControl();
    expect(control).not.toHaveAttribute('aria-describedby');
    expect(control).not.toHaveAttribute('title');
    expect(screen.queryByText(CAPTURE_LEASE_COPY.hint)).toBeNull();
  });

  it('describes the hint through aria-describedby, never title, when held elsewhere', () => {
    useVoiceStore.setState({ captureLease: 'other' });
    renderControl();
    const control = getControl();
    const id = control.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? '')?.textContent).toBe(CAPTURE_LEASE_COPY.hint);
    expect(control).toHaveAccessibleDescription(CAPTURE_LEASE_COPY.hint);
    expect(control).not.toHaveAttribute('title');
  });

  it('is aria-busy and aria-disabled, never natively disabled, while the acquire is pending', async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(getControl());
    await waitFor(() => expect(getControl()).toHaveAttribute('aria-busy', 'true'));
    const control = getControl();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).not.toHaveAttribute('disabled');
    expect(mockJoinChannel).toHaveBeenCalledTimes(1);

    // A second click and an Enter press are both swallowed by the activation guard.
    await user.click(control);
    control.focus();
    await user.keyboard('{Enter}');
    expect(mockJoinChannel).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the control after the prompt settles as declined', async () => {
    const user = userEvent.setup();
    renderControl();
    const control = getControl();
    control.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(getControl()).toHaveAttribute('aria-busy', 'true'));
    await act(async () => {
      settleAcquire({ status: 'declined' });
    });
    await waitFor(() => expect(getControl()).not.toHaveAttribute('aria-busy'));
    expect(document.activeElement).toBe(getControl());
    expect(getControl()).not.toHaveAttribute('aria-disabled');
    expect(useVoiceStore.getState().captureDeclinedSeq).toBe(1);
  });

  it('can be used again after a declined prompt', async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(getControl());
    await waitFor(() => expect(getControl()).toHaveAttribute('aria-busy', 'true'));
    await act(async () => {
      settleAcquire({ status: 'declined' });
    });
    await waitFor(() => expect(getControl()).not.toHaveAttribute('aria-busy'));
    await user.click(getControl());
    await waitFor(() => expect(mockJoinChannel).toHaveBeenCalledTimes(2));
  });
});
