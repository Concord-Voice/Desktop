import { vi, describe, it, expect, beforeEach } from 'vitest';
import React from 'react';

const mockStartMicTest = vi.fn();
let micStoppedReason: 'held' | 'backgrounded' | null = null;

const defaultAudioSettings: Record<string, unknown> = {
  noiseCancellation: true,
  echoCancellation: true,
  autoGainControl: false,
  noiseGateMode: 'dynamic',
  noiseGateLevel: -50,
  quietBoost: false,
  quietBoostThreshold: -38,
  musicMode: false,
  inputVolume: 100,
  outputVolume: 100,
};

vi.mock('@/renderer/hooks/ui/useDraftSettings', () => ({
  useDraftAudioSetting: vi.fn((key: string) => defaultAudioSettings[key] ?? false),
  setDraftAudioSetting: vi.fn(),
  batchSetAudioDrafts: vi.fn(),
  useStashAndSwapAudioMode: vi.fn(() => vi.fn()),
}));

vi.mock('@/renderer/hooks/device/useMicTest', () => ({
  useMicTest: () => ({
    isTesting: false,
    isPending: false,
    dbfsLevel: -Infinity,
    inputOverloaded: false,
    dynamicGateStatus: null,
    error: null,
    stoppedReason: micStoppedReason,
    startTest: mockStartMicTest,
    stopTest: vi.fn(),
    startCalibration: vi.fn(async () => null),
    getActivityVersion: vi.fn(() => 0),
    subscribeActivity: vi.fn(() => () => {}),
  }),
}));

vi.mock('@/renderer/hooks/device/useOutputTest', () => ({
  useOutputTest: () => ({
    isTesting: false,
    error: null,
    playTestTone: vi.fn(),
    stopTest: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/Voice/DeviceSelector', () => ({
  default: ({ kind }: { kind: string }) => <div data-testid={`device-${kind}`} />,
}));

vi.mock('@/renderer/components/Settings/AudioOpusSection', () => ({
  default: () => <div data-testid="audio-opus-section" />,
}));

import { render, screen, act } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voice/voiceStore';
import { CAPTURE_LEASE_COPY } from '@/renderer/services/voice/captureLeaseClient';
import AudioConfigSection from '@/renderer/components/Settings/AudioConfigSection';

function micTestButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Test', description: /./ });
}

beforeEach(() => {
  resetAllStores();
  vi.clearAllMocks();
  micStoppedReason = null;
});

describe('AudioConfigSection capture lease rows (#87)', () => {
  it('shows no lease row when nothing holds the microphone', () => {
    render(<AudioConfigSection />);
    expect(screen.queryByText(CAPTURE_LEASE_COPY.deviceTestHeld)).not.toBeInTheDocument();
    expect(screen.queryByText(CAPTURE_LEASE_COPY.deviceTestBackgrounded)).not.toBeInTheDocument();
  });

  it('shows the held line before any click while another connection holds the lease', () => {
    act(() => useVoiceStore.setState({ captureLease: 'other' }));
    render(<AudioConfigSection />);
    const row = screen.getByText(CAPTURE_LEASE_COPY.deviceTestHeld);
    expect(row.closest('[role="status"]')).not.toBeNull();
    expect(mockStartMicTest).not.toHaveBeenCalled();
  });

  it('keeps Test natively enabled and describes it by the held line, never by title', () => {
    act(() => useVoiceStore.setState({ captureLease: 'other' }));
    render(<AudioConfigSection />);
    const button = micTestButton();
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('disabled');
    expect(button).not.toHaveAttribute('title');
    expect(button).toHaveAccessibleDescription(CAPTURE_LEASE_COPY.deviceTestHeld);
    act(() => button.click());
    expect(mockStartMicTest).toHaveBeenCalledTimes(1);
  });

  it('shows the held line after a held acquire even when the view has not caught up', () => {
    micStoppedReason = 'held';
    render(<AudioConfigSection />);
    expect(screen.getByText(CAPTURE_LEASE_COPY.deviceTestHeld)).toBeInTheDocument();
  });

  it('shows the backgrounded copy in a role="status" row', () => {
    micStoppedReason = 'backgrounded';
    render(<AudioConfigSection />);
    const row = screen.getByText(CAPTURE_LEASE_COPY.deviceTestBackgrounded);
    expect(row.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(CAPTURE_LEASE_COPY.deviceTestHeld)).not.toBeInTheDocument();
  });
});
