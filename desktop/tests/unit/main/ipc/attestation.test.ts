/**
 * Unit tests for the attestation:* IPC handlers (#677).
 *
 * Coverage:
 *   - sender-frame validation rejects untrusted origins on both channels
 *   - get-token returns the cached token (delegates to attestationService)
 *   - clear-token delegates to clearAttestationToken
 *
 * The attestationService is mocked — these tests exercise the IPC plumbing
 * (frame validation + delegation), not the token cache itself (that's covered
 * by attestationService.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocked = vi.hoisted(() => {
  const handleSpy = vi.fn();
  const getAttestationToken = vi.fn();
  const clearAttestationToken = vi.fn();
  return { handleSpy, getAttestationToken, clearAttestationToken };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocked.handleSpy,
  },
}));

vi.mock('@/main/attestationService', () => ({
  getAttestationToken: mocked.getAttestationToken,
  clearAttestationToken: mocked.clearAttestationToken,
}));

import { registerAttestationIpc } from '@/main/ipc/attestation';
import { bindTestSender, type BoundSenderFixture } from './boundSenderFixture';

interface FakeInvokeEvent {
  senderFrame: { url: string };
}

const TRUSTED = 'http://localhost:3001';
const UNTRUSTED = 'https://attacker.example';

describe('attestation IPC handlers', () => {
  let getTokenHandler: (event: FakeInvokeEvent) => string | null;
  let clearTokenHandler: (event: FakeInvokeEvent) => void;
  // #86 Task 7B: events come from a bound saas primary; only the frame URL varies.
  let fx: BoundSenderFixture;

  beforeEach(() => {
    vi.clearAllMocks();
    fx = bindTestSender();
    registerAttestationIpc();

    const getCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'attestation:get-token');
    const clearCall = mocked.handleSpy.mock.calls.find((c) => c[0] === 'attestation:clear-token');
    if (!getCall || !clearCall) {
      throw new Error('IPC handlers not registered');
    }
    getTokenHandler = getCall[1];
    clearTokenHandler = clearCall[1];
  });

  describe('sender-frame validation', () => {
    it('attestation:get-token throws for untrusted sender frames', () => {
      expect(() => getTokenHandler(fx.event(UNTRUSTED))).toThrow(/untrusted/i);
      expect(mocked.getAttestationToken).not.toHaveBeenCalled();
    });

    it('attestation:clear-token throws for untrusted sender frames', () => {
      expect(() => clearTokenHandler(fx.event(UNTRUSTED))).toThrow(/untrusted/i);
      expect(mocked.clearAttestationToken).not.toHaveBeenCalled();
    });
  });

  describe('delegation on trusted frames', () => {
    it('attestation:get-token returns the cached token from attestationService', () => {
      mocked.getAttestationToken.mockReturnValue('tok-abc');
      const result = getTokenHandler(fx.event(TRUSTED));
      expect(result).toBe('tok-abc');
      expect(mocked.getAttestationToken).toHaveBeenCalledTimes(1);
    });

    it('attestation:get-token returns null when no token is cached', () => {
      mocked.getAttestationToken.mockReturnValue(null);
      const result = getTokenHandler(fx.event(TRUSTED));
      expect(result).toBeNull();
    });

    it('attestation:clear-token delegates to clearAttestationToken', () => {
      clearTokenHandler(fx.event(TRUSTED));
      expect(mocked.clearAttestationToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('connection scoping (#86 Task 7B)', () => {
    it('an unbound sender is refused even with a trusted frame URL', () => {
      expect(() => getTokenHandler({ senderFrame: { url: TRUSTED } })).toThrow(/untrusted/i);
      expect(mocked.getAttestationToken).not.toHaveBeenCalled();
    });

    it('a bound self-hosted primary reads null and cannot clear the saas token', () => {
      const selfHosted = bindTestSender({ origin: 'https://voice.example', id: 9, reset: false });
      mocked.getAttestationToken.mockReturnValue('tok-abc');
      expect(getTokenHandler(selfHosted.event())).toBeNull();
      clearTokenHandler(selfHosted.event());
      expect(mocked.getAttestationToken).not.toHaveBeenCalled();
      expect(mocked.clearAttestationToken).not.toHaveBeenCalled();
    });
  });
});
