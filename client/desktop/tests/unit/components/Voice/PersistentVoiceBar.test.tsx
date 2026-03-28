import React from 'react';
import { render, screen } from '../../../test-utils';
import { resetAllStores } from '../../../helpers/store-helpers';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { useChannelStore } from '@/renderer/stores/channelStore';
import { vi } from 'vitest';

// ── Child component mocks ────────────────────────────────────────────────────
vi.mock('@/renderer/components/Voice/VoiceControls', () => ({
  default: ({ context, onPopOut }: { context?: string; onPopOut?: () => void }) => (
    <div data-testid="voice-controls" data-context={context} data-has-popout={!!onPopOut}>
      {onPopOut && <button onClick={onPopOut}>Pop Out</button>}
    </div>
  ),
}));

vi.mock('@/renderer/components/Voice/VoiceTextChat', () => ({
  default: () => <div data-testid="voice-text-chat" />,
}));

// ── CSS mock ─────────────────────────────────────────────────────────────────
vi.mock('@/renderer/components/Voice/PersistentVoiceBar.css', () => ({}));

import PersistentVoiceBar from '@/renderer/components/Voice/PersistentVoiceBar';

// ── Helpers ──────────────────────────────────────────────────────────────────
const VOICE_CHANNEL_ID = 'voice-1';

const linkedTextChannel = {
  id: 'text-1',
  server_id: 's1',
  name: 'voice-text',
  type: 'text' as const,
  is_encrypted: false,
  position: 0,
  linked_voice_channel_id: VOICE_CHANNEL_ID,
  created_at: '',
  updated_at: '',
};

function setBarState(overrides: Record<string, unknown> = {}) {
  useVoiceStore.setState({
    activeChannelId: VOICE_CHANNEL_ID,
    voiceControlsPinned: true,
    voiceControlsPoppedOut: false,
    showVoiceTextChat: false,
    voiceTextChatLayout: 'horizontal',
    persistentTextChatHeight: 250,
    ...overrides,
  });
}

describe('PersistentVoiceBar', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    useVoiceStore.setState({
      activeChannelId: null,
      voiceControlsPinned: false,
      voiceControlsPoppedOut: false,
      showVoiceTextChat: false,
      voiceTextChatLayout: 'horizontal',
      persistentTextChatHeight: 250,
    });
    useChannelStore.setState({ channels: [] });
  });

  // ── Basic rendering ──────────────────────────────────────────────────────

  it('renders VoiceControls with persistent context', () => {
    setBarState();
    render(<PersistentVoiceBar />);
    const controls = screen.getByTestId('voice-controls');
    expect(controls).toHaveAttribute('data-context', 'persistent');
  });

  it('returns null when voiceControlsPoppedOut is true', () => {
    setBarState({ voiceControlsPoppedOut: true });
    const { container } = render(<PersistentVoiceBar />);
    expect(container.firstChild).toBeNull();
  });

  // ── Pinned vs unpinned ───────────────────────────────────────────────────

  it('applies pinned class when voiceControlsPinned is true', () => {
    setBarState({ voiceControlsPinned: true });
    const { container } = render(<PersistentVoiceBar />);
    expect(container.querySelector('.persistent-voice-bar--pinned')).toBeInTheDocument();
  });

  it('applies unpinned class when voiceControlsPinned is false', () => {
    setBarState({ voiceControlsPinned: false });
    const { container } = render(<PersistentVoiceBar />);
    expect(container.querySelector('.persistent-voice-bar--unpinned')).toBeInTheDocument();
  });

  // ── Text chat drawer ─────────────────────────────────────────────────────

  it('does not show text chat when showVoiceTextChat is false', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: false,
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    render(<PersistentVoiceBar />);
    expect(screen.queryByTestId('voice-text-chat')).not.toBeInTheDocument();
  });

  it('shows text chat drawer when showVoiceTextChat is true, pinned, and horizontal layout', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'horizontal',
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    render(<PersistentVoiceBar />);
    expect(screen.getByTestId('voice-text-chat')).toBeInTheDocument();
  });

  it('does not show text chat when layout is vertical (rendered by MainView instead)', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'vertical',
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    render(<PersistentVoiceBar />);
    expect(screen.queryByTestId('voice-text-chat')).not.toBeInTheDocument();
  });

  it('does not show text chat when unpinned even if showVoiceTextChat is true', () => {
    setBarState({
      voiceControlsPinned: false,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'horizontal',
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    render(<PersistentVoiceBar />);
    expect(screen.queryByTestId('voice-text-chat')).not.toBeInTheDocument();
  });

  it('does not show text chat when no linked text channel', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'horizontal',
    });
    useChannelStore.setState({ channels: [] });
    render(<PersistentVoiceBar />);
    expect(screen.queryByTestId('voice-text-chat')).not.toBeInTheDocument();
  });

  // ── Resize handle ────────────────────────────────────────────────────────

  it('shows resize handle when chat drawer is visible', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'horizontal',
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    const { container } = render(<PersistentVoiceBar />);
    expect(container.querySelector('.persistent-voice-bar__chat-resize')).toBeInTheDocument();
  });

  it('applies persistentTextChatHeight to chat drawer', () => {
    setBarState({
      voiceControlsPinned: true,
      showVoiceTextChat: true,
      voiceTextChatLayout: 'horizontal',
      persistentTextChatHeight: 300,
    });
    useChannelStore.setState({ channels: [linkedTextChannel] });
    const { container } = render(<PersistentVoiceBar />);
    const drawer = container.querySelector('.persistent-voice-bar__chat-drawer');
    expect(drawer).toHaveStyle({ height: '300px' });
  });
});
