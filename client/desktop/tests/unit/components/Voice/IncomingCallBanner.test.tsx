// Tests for IncomingCallBanner — the root-mounted corner banner for
// incoming DM voice calls (#1209 plan task F1). Covers render-gating on
// voiceStore.callState, avatar fallback (initials), and the accept /
// decline button → callStateMachine dispatch.
//
// Filed per PR #1231 SonarCloud Quality Gate coverage gap.

import React from 'react';
import { render, screen, fireEvent } from '../../../test-utils';
import { useVoiceStore } from '@/renderer/stores/voiceStore';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/components/Voice/IncomingCallBanner.css', () => ({}));

// Mocks return resolved Promises so the click-handler `.catch(...)` chains
// (added per Copilot #1231 C9/C10) don't TypeError on undefined.
const mockAccept = vi.fn(() => Promise.resolve());
const mockDecline = vi.fn(() => Promise.resolve());

vi.mock('@/renderer/services/voiceService/callStateMachine', () => ({
  acceptIncomingCall: () => mockAccept(),
  declineIncomingCall: () => mockDecline(),
}));

import { IncomingCallBanner } from '@/renderer/components/Voice/IncomingCallBanner';

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';
const RING_ID = '22222222-2222-2222-2222-222222222222';

function setIncomingRingingState(callerOverrides: Record<string, unknown> = {}): void {
  useVoiceStore.getState().setCallState({
    kind: 'incoming-ringing',
    conversationId: CONVERSATION_ID,
    ringId: RING_ID,
    caller: {
      userId: 'caller-id',
      username: 'caller-username',
      ...callerOverrides,
    },
    expiresAt: Date.now() + 30000,
  });
}

describe('IncomingCallBanner', () => {
  beforeEach(() => {
    resetAllStores();
    mockAccept.mockReset();
    mockDecline.mockReset();
  });

  describe('render gating', () => {
    it('returns null when callState is idle', () => {
      const { container } = render(<IncomingCallBanner />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when callState is in-call', () => {
      useVoiceStore.getState().setCallState({ kind: 'in-call' });
      const { container } = render(<IncomingCallBanner />);
      expect(container.firstChild).toBeNull();
    });

    it('returns null when callState is outgoing-ringing', () => {
      useVoiceStore.getState().setCallState({
        kind: 'outgoing-ringing',
        conversationId: CONVERSATION_ID,
        ringId: RING_ID,
        calleeUserIds: ['callee'],
        startedAt: 1000,
      });
      const { container } = render(<IncomingCallBanner />);
      expect(container.firstChild).toBeNull();
    });

    it('renders when callState is incoming-ringing', () => {
      setIncomingRingingState();
      render(<IncomingCallBanner />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  describe('avatar rendering', () => {
    it('renders <img> when caller has avatarUrl', () => {
      setIncomingRingingState({ avatarUrl: 'https://example.com/a.png' });
      render(<IncomingCallBanner />);
      const img = screen.getByRole('img');
      expect(img).toHaveAttribute('src', 'https://example.com/a.png');
    });

    it('renders initials when caller has no avatarUrl (uses displayName)', () => {
      setIncomingRingingState({ displayName: 'Alice Smith' });
      render(<IncomingCallBanner />);
      // Initials are first 2 chars uppercased: 'AL'
      expect(screen.getByText('AL')).toBeInTheDocument();
    });

    it('falls back to username for initials when displayName is not set', () => {
      setIncomingRingingState({ username: 'bob' });
      render(<IncomingCallBanner />);
      // First 2 chars uppercased: 'BO'
      expect(screen.getByText('BO')).toBeInTheDocument();
    });
  });

  describe('name display', () => {
    it('prefers displayName when present', () => {
      setIncomingRingingState({ username: 'bob', displayName: 'Bob Builder' });
      render(<IncomingCallBanner />);
      expect(screen.getByText('Bob Builder')).toBeInTheDocument();
    });

    it('falls back to username when displayName is undefined', () => {
      setIncomingRingingState({ username: 'bob' });
      render(<IncomingCallBanner />);
      expect(screen.getByText('bob')).toBeInTheDocument();
    });
  });

  describe('button interactions', () => {
    it('invokes acceptIncomingCall when Accept is clicked', () => {
      setIncomingRingingState();
      render(<IncomingCallBanner />);
      fireEvent.click(screen.getByRole('button', { name: /accept call/i }));
      expect(mockAccept).toHaveBeenCalledTimes(1);
      expect(mockDecline).not.toHaveBeenCalled();
    });

    it('invokes declineIncomingCall when Decline is clicked', () => {
      setIncomingRingingState();
      render(<IncomingCallBanner />);
      fireEvent.click(screen.getByRole('button', { name: /decline call/i }));
      expect(mockDecline).toHaveBeenCalledTimes(1);
      expect(mockAccept).not.toHaveBeenCalled();
    });
  });
});
