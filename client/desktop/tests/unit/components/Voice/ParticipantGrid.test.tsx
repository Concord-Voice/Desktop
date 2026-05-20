import React from 'react';
import { render, screen } from '../../../test-utils';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { useUserStore } from '@/renderer/stores/userStore';
import { useAudioSettingsStore } from '@/renderer/stores/audioSettingsStore';
import { resetAllStores } from '../../../helpers/store-helpers';

// ── Child component mocks ──────────────────────────────────────────────────────
vi.mock('@/renderer/components/Voice/ParticipantTile', () => ({
  default: ({ participant }: { participant: { userId: string; username: string } }) => (
    <div data-testid={`participant-tile-${participant.userId}`}>{participant.username}</div>
  ),
}));

vi.mock('@/renderer/components/Voice/useVoiceMagnification', () => ({
  useVoiceMagnification: () => ({}),
}));

const mockUseGridLayout = vi.fn(() => ({ tileWidth: 300, tileHeight: 169, columns: 3 }));
vi.mock('@/renderer/hooks/useGridLayout', () => ({
  useGridLayout: (...args: unknown[]) => mockUseGridLayout(...args),
}));

vi.mock('@/renderer/components/Voice/ParticipantGrid.css', () => ({}));

// ── AudioContext mock objects ─────────────────────────────────────────────────
// Defined at module scope so individual test assertions can reference them,
// but the globals are only installed / removed inside beforeAll / afterAll
// to avoid leaking into other test files.

const mockClose = vi.fn().mockResolvedValue(undefined);
const mockResume = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

const mockAnalyserNode = {
  fftSize: 256,
  smoothingTimeConstant: 0.3,
  frequencyBinCount: 128,
  connect: mockConnect,
  getByteFrequencyData: vi.fn(),
};
const mockGainNode = {
  gain: { value: 1, setTargetAtTime: vi.fn() },
  connect: mockConnect,
  disconnect: mockDisconnect,
};
const mockSourceNode = { connect: mockConnect };
const mockAudioContext = {
  state: 'running',
  currentTime: 0,
  destination: {},
  sampleRate: 48000,
  createAnalyser: vi.fn(() => mockAnalyserNode),
  createGain: vi.fn(() => ({ ...mockGainNode })),
  createMediaElementSource: vi.fn(() => mockSourceNode),
  resume: mockResume,
  close: mockClose,
  setSinkId: vi.fn().mockResolvedValue(undefined),
};

// Install / restore globals in beforeAll/afterAll so they don't leak into
// other test files when Vitest runs suites concurrently.
beforeAll(() => {
  // jsdom doesn't implement HTMLAudioElement.play
  vi.spyOn(HTMLAudioElement.prototype, 'play').mockResolvedValue(undefined);

  // Regular function (not arrow) so `new AudioContext(...)` works.
  // A constructor that returns an object uses that returned object.
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function MockAudioContextCtor() {
      return mockAudioContext;
    })
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import {
  AudioOutputs,
  AudioOutput,
  UserFrameGrid,
} from '@/renderer/components/Voice/ParticipantGrid';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockStream(id = 'stream-1'): MediaStream {
  return { id, active: true, getAudioTracks: () => [] } as unknown as MediaStream;
}

describe('AudioOutputs', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useVoiceStore.setState({ participants: {}, audioOutputDeviceId: null });
    useUserStore.setState({
      user: {
        id: 'local-user',
        username: 'me',
        email: '',
        display_name: 'Me',
        bio: null,
        avatar_url: null,
        header_image_url: null,
        links: [],
        email_verified: false,
        age_verified: true,
        e2ee_preference: false,
        created_at: '',
        updated_at: '',
      },
    });
  });

  it('renders nothing when there are no participants', () => {
    useVoiceStore.setState({ participants: {} });
    const { container } = render(<AudioOutputs />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the only participant is the local user', () => {
    useVoiceStore.setState({
      participants: {
        'local-user': {
          userId: 'local-user',
          username: 'me',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream(),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an audio element for a remote participant with audioStream', () => {
    useVoiceStore.setState({
      participants: {
        'remote-1': {
          userId: 'remote-1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('audio-stream-1'),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    expect(container.querySelectorAll('audio').length).toBeGreaterThanOrEqual(1);
  });

  it('renders an audio element for a remote participant with screenAudioStream', () => {
    useVoiceStore.setState({
      participants: {
        'remote-1': {
          userId: 'remote-1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          screenAudioStream: makeMockStream('screen-audio-stream-1'),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    expect(container.querySelectorAll('audio').length).toBeGreaterThanOrEqual(1);
  });

  it('renders separate audio elements for audioStream and screenAudioStream', () => {
    useVoiceStore.setState({
      participants: {
        'remote-1': {
          userId: 'remote-1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('audio-stream-1'),
          screenAudioStream: makeMockStream('screen-audio-stream-1'),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    expect(container.querySelectorAll('audio').length).toBe(2);
  });

  it('renders audio elements for multiple remote participants', () => {
    useVoiceStore.setState({
      participants: {
        'remote-1': {
          userId: 'remote-1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('a1'),
        },
        'remote-2': {
          userId: 'remote-2',
          username: 'bob',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('a2'),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    expect(container.querySelectorAll('audio').length).toBe(2);
  });

  it('excludes local user from audio outputs even if they have a stream', () => {
    useVoiceStore.setState({
      participants: {
        'local-user': {
          userId: 'local-user',
          username: 'me',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('local-audio'),
        },
        'remote-1': {
          userId: 'remote-1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
          audioStream: makeMockStream('remote-audio'),
        },
      },
    });
    const { container } = render(<AudioOutputs />);
    // Only 1 audio element — for remote-1, not local-user
    expect(container.querySelectorAll('audio').length).toBe(1);
  });
});

describe('AudioOutput', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useAudioSettingsStore.setState({
      outputVolume: 100,
      quietBoost: false,
      quietBoostThreshold: -30,
    });
  });

  it('renders a hidden audio element', () => {
    const stream = makeMockStream();
    const { container } = render(<AudioOutput stream={stream} />);
    expect(container.querySelector('audio')).toBeInTheDocument();
  });

  it('sets up AudioContext on mount', () => {
    const stream = makeMockStream();
    render(<AudioOutput stream={stream} />);
    expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
  });

  it('creates audio processing chain nodes', () => {
    const stream = makeMockStream();
    render(<AudioOutput stream={stream} />);
    expect(mockAudioContext.createAnalyser).toHaveBeenCalled();
    expect(mockAudioContext.createGain).toHaveBeenCalled();
    expect(mockAudioContext.createMediaElementSource).toHaveBeenCalled();
  });

  it('cleans up AudioContext on unmount', () => {
    const stream = makeMockStream();
    const { unmount } = render(<AudioOutput stream={stream} />);
    unmount();
    expect(mockClose).toHaveBeenCalled();
  });

  it('logs redacted warning when HTMLAudioElement.play() rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLAudioElement.prototype, 'play').mockRejectedValueOnce(new Error('boom'));

    const stream = makeMockStream();
    render(<AudioOutput stream={stream} />);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Audio element play() rejected:', 'boom');
    });
  });

  it('logs redacted warning when AudioContext.resume() rejects on suspended state', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Flip mock ctx to suspended so the resume() branch executes
    const origState = mockAudioContext.state;
    mockAudioContext.state = 'suspended';
    mockAudioContext.resume = vi.fn().mockRejectedValueOnce(new Error('boom'));

    const stream = makeMockStream();
    render(<AudioOutput stream={stream} />);

    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('AudioContext resume failed:', 'boom');
    });

    mockAudioContext.state = origState;
  });
});

describe('UserFrameGrid', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useVoiceStore.setState({ participants: {} });
    useUserStore.setState({
      user: {
        id: 'local-user',
        username: 'me',
        email: '',
        display_name: 'Me',
        bio: null,
        avatar_url: null,
        header_image_url: null,
        links: [],
        email_verified: false,
        age_verified: true,
        e2ee_preference: false,
        created_at: '',
        updated_at: '',
      },
    });
  });

  it('renders the user frame grid container', () => {
    const { container } = render(<UserFrameGrid />);
    expect(container.querySelector('.user-frame-grid')).toBeInTheDocument();
  });

  it('renders a ParticipantTile for each participant', () => {
    useVoiceStore.setState({
      participants: {
        u1: {
          userId: 'u1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
        u2: {
          userId: 'u2',
          username: 'bob',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
      },
    });
    render(<UserFrameGrid />);
    expect(screen.getByTestId('participant-tile-u1')).toBeInTheDocument();
    expect(screen.getByTestId('participant-tile-u2')).toBeInTheDocument();
  });

  it('renders no tiles when participants is empty', () => {
    useVoiceStore.setState({ participants: {} });
    const { container } = render(<UserFrameGrid />);
    expect(container.querySelectorAll('[data-testid^="participant-tile"]').length).toBe(0);
  });

  it('sets --tile-w and --tile-h CSS custom properties on the grid container', () => {
    useVoiceStore.setState({
      participants: {
        u1: {
          userId: 'u1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
      },
    });
    const { container } = render(<UserFrameGrid />);
    const grid = container.querySelector('.user-frame-grid') as HTMLElement;
    expect(grid.style.getPropertyValue('--tile-w')).toBe('300px');
    expect(grid.style.getPropertyValue('--tile-h')).toBe('169px');
  });

  it('attaches a ref to the grid container element', () => {
    const { container } = render(<UserFrameGrid />);
    const grid = container.querySelector('.user-frame-grid');
    expect(grid).toBeInstanceOf(HTMLDivElement);
  });

  it('passes square aspect ratio when no participant has video', () => {
    mockUseGridLayout.mockReturnValue({ tileWidth: 200, tileHeight: 200, columns: 2 });
    useVoiceStore.setState({
      participants: {
        u1: {
          userId: 'u1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
        u2: {
          userId: 'u2',
          username: 'bob',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
      },
    });
    const { container } = render(<UserFrameGrid />);

    // Verify useGridLayout was called with aspectRatio: 1 (square)
    const lastCall = mockUseGridLayout.mock.calls[mockUseGridLayout.mock.calls.length - 1];
    expect(lastCall[2]).toEqual(expect.objectContaining({ aspectRatio: 1 }));

    // Verify CSS variables reflect square tiles
    const grid = container.querySelector('.user-frame-grid') as HTMLElement;
    expect(grid.style.getPropertyValue('--tile-w')).toBe('200px');
    expect(grid.style.getPropertyValue('--tile-h')).toBe('200px');
  });

  it('passes 16:9 aspect ratio when any participant has video', () => {
    mockUseGridLayout.mockReturnValue({ tileWidth: 300, tileHeight: 169, columns: 2 });
    useVoiceStore.setState({
      participants: {
        u1: {
          userId: 'u1',
          username: 'alice',
          isMuted: false,
          isDeafened: false,
          isVideoOn: true,
          isScreenSharing: false,
          isSpeaking: false,
        },
        u2: {
          userId: 'u2',
          username: 'bob',
          isMuted: false,
          isDeafened: false,
          isVideoOn: false,
          isScreenSharing: false,
          isSpeaking: false,
        },
      },
    });
    render(<UserFrameGrid />);

    // Verify useGridLayout was called with aspectRatio: 16/9
    const lastCall = mockUseGridLayout.mock.calls[mockUseGridLayout.mock.calls.length - 1];
    expect(lastCall[2]).toEqual(expect.objectContaining({ aspectRatio: 16 / 9 }));
  });
});
