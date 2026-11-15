import { render, screen, fireEvent, waitFor } from '../../../test-utils';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import SSOAccountLinkConfirm from '@/renderer/components/Auth/SSOAccountLinkConfirm';
import { abandonSSOReservation } from '@/renderer/services/system/ssoService';
import { useSSOStore } from '@/renderer/stores/auth/ssoStore';
import { useAuthStore } from '@/renderer/stores/auth/authStore';
import { useE2EEStore } from '@/renderer/stores/auth/e2eeStore';
import { useMFAChallengeStore } from '@/renderer/stores/auth/mfaChallengeStore';
import {
  resetRuntimeServerBase,
  setRuntimeServerBase,
} from '@/renderer/services/system/runtimeServerBase';
import { resetAllStores } from '../../../helpers/store-helpers';

vi.mock('@/renderer/services/system/apiClient', async (orig) => {
  const actual = (await orig()) as typeof import('@/renderer/services/system/apiClient');
  return { ...actual, revokeAbortedSession: vi.fn().mockResolvedValue(undefined) };
});

// #2394: replace only abandonSSOReservation. completeSSOLink stays real so the
// existing tests keep asserting against the electron sso.completeLink bridge.
vi.mock('@/renderer/services/system/ssoService', async (orig) => {
  const actual = (await orig()) as typeof import('@/renderer/services/system/ssoService');
  return { ...actual, abandonSSOReservation: vi.fn().mockResolvedValue(true) };
});

const storeRefreshToken = vi.fn().mockResolvedValue(41);
const clearTokensIfOwner = vi.fn().mockResolvedValue(true);
const originalElectron = globalThis.electron;

const linkedSessionResponse = {
  kind: 'tokens' as const,
  accessToken: 'linked-token',
  sessionId: 'linked-session',
  credentialOwner: 41,
};
const completeLink = vi.fn().mockResolvedValue(linkedSessionResponse);

beforeEach(() => {
  vi.clearAllMocks();
  resetAllStores();
  resetRuntimeServerBase();
  completeLink.mockResolvedValue(linkedSessionResponse);
  Object.defineProperty(globalThis, 'electron', {
    value: {
      ...originalElectron,
      storeRefreshToken,
      clearTokensIfOwner,
      sso: { ...originalElectron?.sso, completeLink },
    },
    writable: true,
  });
  useSSOStore.getState().setState({
    phase: 'link_required',
    provider: 'google',
    ssoToken: 'tok-link',
    maskedEmail: 'a***@example.test',
  });
});

afterEach(() => {
  resetRuntimeServerBase();
  Object.defineProperty(globalThis, 'electron', {
    value: originalElectron,
    writable: true,
  });
});

describe('SSOAccountLinkConfirm', () => {
  it('renders masked email + password input', () => {
    render(<SSOAccountLinkConfirm />);
    expect(screen.getByText(/a\*\*\*@example\.test/)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('delegates complete-link to main without renderer refresh-token custody', async () => {
    let gateWasArmedAtAdmission = false;
    const unsubscribe = useAuthStore.subscribe((auth) => {
      if (auth.accessToken === 'linked-token') {
        const e2ee = useE2EEStore.getState();
        gateWasArmedAtAdmission =
          e2ee.needsSSOUnlock && e2ee.ssoCredentialOwner === linkedSessionResponse.credentialOwner;
      }
    });
    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));

    await waitFor(() => expect(completeLink).toHaveBeenCalledTimes(1));
    expect(completeLink).toHaveBeenCalledWith('http://localhost:8080', {
      provider: 'google',
      ssoToken: 'tok-link',
      password: 'CorrectPW!', // pragma: allowlist secret
    });

    await waitFor(() => {
      expect(useAuthStore.getState().accessToken).toBe('linked-token');
    });
    unsubscribe();
    expect(gateWasArmedAtAdmission).toBe(true);
    expect(useAuthStore.getState().sessionId).toBe('linked-session');
    expect(storeRefreshToken).not.toHaveBeenCalled();
    expect(useE2EEStore.getState()).toMatchObject({
      needsSSOUnlock: true,
      ssoCredentialOwner: 41,
    });
    expect(useSSOStore.getState().state.phase).toBe('idle');
  });

  it('routes a complete-link challenge through the SSO MFA modal before admission', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    let gateWasArmedAtAdmission = false;
    const unsubscribe = useAuthStore.subscribe((auth) => {
      if (auth.accessToken === 'linked-after-mfa') {
        gateWasArmedAtAdmission =
          useE2EEStore.getState().ssoCredentialOwner === 41 &&
          useE2EEStore.getState().needsSSOUnlock;
      }
    });

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));

    await waitFor(() =>
      expect(useMFAChallengeStore.getState().challengeToken).toBe('link-challenge')
    );
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useMFAChallengeStore.getState()).toMatchObject({
      purpose: 'sso_login',
      ssoContext: { provider: 'google', credentialOwner: 41 },
    });
    useMFAChallengeStore.getState().completeChallenge(
      {
        verified: true,
        ssoCompletion: {
          accessToken: 'linked-after-mfa',
          sessionId: 'session-after-mfa',
          credentialOwner: 41,
        },
      },
      'link-challenge'
    );

    await waitFor(() => expect(useAuthStore.getState().accessToken).toBe('linked-after-mfa'));
    unsubscribe();
    expect(gateWasArmedAtAdmission).toBe(true);
    expect(useSSOStore.getState().state.phase).toBe('idle');
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });

  it('abandons the reservation when complete-link MFA is cancelled', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'cancel-link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() =>
      expect(useMFAChallengeStore.getState().challengeToken).toBe('cancel-link-challenge')
    );

    useMFAChallengeStore.getState().clearChallenge();
    await waitFor(() => expect(abandonSSOReservation).toHaveBeenCalledTimes(1));
    expect(useSSOStore.getState().state.phase).toBe('idle');
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('abandons the reservation when complete-link MFA settles unverified', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'unverified-link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() =>
      expect(useMFAChallengeStore.getState().challengeToken).toBe('unverified-link-challenge')
    );

    useMFAChallengeStore
      .getState()
      .completeChallenge({ verified: false }, 'unverified-link-challenge');
    await waitFor(() => expect(abandonSSOReservation).toHaveBeenCalledTimes(1));
    expect(useSSOStore.getState().state.phase).toBe('idle');
    expect(clearTokensIfOwner).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('abandons the reservation when the link challenge cannot be raised', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'unraisable-link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    const { showChallenge } = useMFAChallengeStore.getState();
    useMFAChallengeStore.setState({
      showChallenge: vi.fn().mockRejectedValue(new Error('modal unavailable')),
    });
    try {
      render(<SSOAccountLinkConfirm />);
      fireEvent.change(screen.getByLabelText(/password/i), {
        target: { value: 'CorrectPW!' }, // pragma: allowlist secret
      });
      fireEvent.click(screen.getByRole('button', { name: /link account/i }));

      await waitFor(() => expect(abandonSSOReservation).toHaveBeenCalledTimes(1));
      // Not stranded on a challenge phase nothing renders, and not dropped to
      // sign-in silently either: the SSO error screen says what happened.
      expect(useSSOStore.getState().state).toEqual({ phase: 'error', message: 'sso_mfa_failed' });
      expect(useAuthStore.getState().accessToken).toBeNull();
    } finally {
      useMFAChallengeStore.setState({ showChallenge });
    }
  });

  it('a stale challenge that ends unverified clears only its own owner', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'stale-unverified-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() =>
      expect(useMFAChallengeStore.getState().challengeToken).toBe('stale-unverified-challenge')
    );

    setRuntimeServerBase('https://server-b.example');
    setRuntimeServerBase('http://localhost:8080');
    useMFAChallengeStore
      .getState()
      .completeChallenge({ verified: false }, 'stale-unverified-challenge');

    await waitFor(() => expect(clearTokensIfOwner).toHaveBeenCalledWith(41));
    // A newer request may own the reservation now; a stale one must not retire it.
    expect(abandonSSOReservation).not.toHaveBeenCalled();
  });

  it('discards a verified link MFA session after the server selection changes', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'mfa_challenge',
      mfaChallengeToken: 'stale-link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    });
    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() =>
      expect(useMFAChallengeStore.getState().challengeToken).toBe('stale-link-challenge')
    );

    setRuntimeServerBase('https://server-b.example');
    setRuntimeServerBase('http://localhost:8080');
    useMFAChallengeStore.getState().completeChallenge(
      {
        verified: true,
        ssoCompletion: {
          accessToken: 'stale-mfa-access',
          sessionId: 'stale-mfa-session',
          credentialOwner: 41,
        },
      },
      'stale-link-challenge'
    );

    const { revokeAbortedSession } = await import('@/renderer/services/system/apiClient');
    await waitFor(() =>
      expect(revokeAbortedSession).toHaveBeenCalledWith({
        accessToken: 'stale-mfa-access',
        sessionId: 'stale-mfa-session',
        apiBase: 'http://localhost:8080',
      })
    );
    expect(clearTokensIfOwner).toHaveBeenCalledWith(41);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('rejects an in-flight response after an A → B → A server switch', async () => {
    let resolveResponse: (response: typeof linkedSessionResponse) => void = () => {};
    completeLink.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      })
    );

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() => expect(completeLink).toHaveBeenCalledTimes(1));

    setRuntimeServerBase('https://server-b.example');
    setRuntimeServerBase('http://localhost:8080');
    resolveResponse(linkedSessionResponse);

    const { revokeAbortedSession } = await import('@/renderer/services/system/apiClient');
    await waitFor(() => expect(revokeAbortedSession).toHaveBeenCalledTimes(1));
    expect(revokeAbortedSession).toHaveBeenCalledWith({
      accessToken: 'linked-token',
      sessionId: 'linked-session',
      apiBase: 'http://localhost:8080',
    });
    expect(clearTokensIfOwner).toHaveBeenCalledWith(41);
    expect(storeRefreshToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useSSOStore.getState().state.phase).toBe('link_required');
  });

  it('clears only the stale challenge owner after an A → B → A server switch', async () => {
    const challenge = {
      kind: 'mfa_challenge' as const,
      mfaChallengeToken: 'late-link-challenge',
      methods: ['totp'],
      credentialOwner: 41,
    };
    let resolveResponse: (response: typeof challenge) => void = () => {};
    completeLink.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveResponse = resolve;
      })
    );

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));
    await waitFor(() => expect(completeLink).toHaveBeenCalledTimes(1));

    setRuntimeServerBase('https://server-b.example');
    setRuntimeServerBase('http://localhost:8080');
    resolveResponse(challenge);

    await waitFor(() => expect(clearTokensIfOwner).toHaveBeenCalledWith(41));
    expect(useMFAChallengeStore.getState().challengeToken).toBeNull();
    expect(abandonSSOReservation).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useSSOStore.getState().state.phase).toBe('link_required');
  });

  it('clears only its main-process owner when a successor wins during completion', async () => {
    completeLink.mockImplementationOnce(async () => {
      useAuthStore.getState().beginAuthLifecycle('successor-token', 'successor-session');
      return linkedSessionResponse;
    });

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));

    await waitFor(() => expect(clearTokensIfOwner).toHaveBeenCalledWith(41));
    expect(useAuthStore.getState().accessToken).toBe('successor-token');
    expect(useAuthStore.getState().sessionId).toBe('successor-session');
    expect(useSSOStore.getState().state.phase).toBe('link_required');
  });

  it('keeps the form open for a retry when no HTTP answer arrived', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'error',
      status: 0,
      code: 'sso_complete-link_failed',
    });

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'CorrectPW!' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't reach the server. Please try again."
    );
    expect(screen.getByRole('button', { name: /link account/i })).toBeEnabled();
    expect(abandonSSOReservation).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  // The server spends the SSO token before it checks the password, so any answer
  // it gave leaves nothing to retry: the copy says why, and the form offers only
  // the way back. Codes are the server's real complete-link codes.
  it.each([
    [401, { error_code: 'invalid_credentials' }, 'Wrong password. Sign in again to try once more.'],
    [401, { error_code: 'sso_token_invalid' }, 'This sign-in expired. Please sign in again.'],
    [401, undefined, 'Wrong password. Sign in again to try once more.'],
    [403, { error_code: 'account_disabled' }, 'This account is disabled.'],
    [423, undefined, 'Too many failed attempts. Try again in 15 minutes.'],
    [
      500,
      { error_code: 'password_verify_failed' },
      "Couldn't link your account. Please sign in again.",
    ],
    // main's own codes, which arrive as { error_code: code }
    [409, undefined, 'This sign-in was cancelled. Please sign in again.', 'sso_cancelled'],
    [
      502,
      undefined,
      "The account couldn't be linked. Please sign in again.",
      'sso_session_rejected',
    ],
    // the code decides over the status
    [401, { error_code: 'sso_cancelled' }, 'This sign-in was cancelled. Please sign in again.'],
    // unknown or hostile codes fall back without selecting an inherited property
    [409, { error_code: 'something_new' }, "Couldn't link your account. Please sign in again."],
    [400, { error_code: '__proto__' }, "Couldn't link your account. Please sign in again."],
    [400, { error_code: 'constructor' }, "Couldn't link your account. Please sign in again."],
  ])(
    'treats a %i (%j) completion failure as final',
    async (status, body, copy, code = 'sso_complete-link_failed') => {
      completeLink.mockResolvedValueOnce({
        kind: 'error',
        status,
        code,
        ...(body ? { body } : {}),
      });

      render(<SSOAccountLinkConfirm />);
      fireEvent.change(screen.getByLabelText(/password/i), {
        target: { value: 'CorrectPW!' }, // pragma: allowlist secret
      });
      fireEvent.click(screen.getByRole('button', { name: /link account/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
      expect(screen.queryByRole('button', { name: /link account/i })).toBeNull();
      expect(screen.getByLabelText(/password/i)).toBeDisabled();
      expect(abandonSSOReservation).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: /back to sign in/i }));
      expect(useSSOStore.getState().state.phase).toBe('idle');
      expect(useAuthStore.getState().accessToken).toBeNull();
    }
  );

  it('shows lockout message on 423', async () => {
    completeLink.mockResolvedValueOnce({
      kind: 'error',
      status: 423,
      code: 'account_locked',
      body: { error_code: 'account_locked' },
    });

    render(<SSOAccountLinkConfirm />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'whatever' }, // pragma: allowlist secret
    });
    fireEvent.click(screen.getByRole('button', { name: /link account/i }));

    const lockoutMessage = await screen.findByText(/too many failed attempts/i);
    expect(lockoutMessage).toBeInTheDocument();
    // Lockout must NOT mint an access token — verifies the 423 path
    // does not accidentally fall through to the success-token handler.
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('Cancel abandons the SSO reservation and returns the store to idle (#2394)', async () => {
    // Backing out of account linking abandons the SSO flow, so the orphaned
    // main-process reservation is retired eagerly rather than left to block a
    // later password registration's E2EE key staging.
    render(<SSOAccountLinkConfirm />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    await waitFor(() => expect(useSSOStore.getState().state.phase).toBe('idle'));
    expect(abandonSSOReservation).toHaveBeenCalledTimes(1);
    // Cancelling never touches credentials — it only releases the reservation.
    expect(clearTokensIfOwner).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
