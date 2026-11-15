/**
 * SSOAccountLinkConfirm — modal for the email-match account-linking flow (#270, Task 18).
 *
 * Reached when the SSO callback returns `account_link_available`: the email
 * returned by the OAuth IdP matches an existing password-authenticated Concord
 * account. To prove ownership of that existing account, the user enters their
 * Concord password; the server then permanently links the SSO identity to it.
 *
 * Submitting calls `POST /api/v1/auth/sso/{provider}/complete-link` via the
 * `completeSSOLink` service helper. The server spends the single-use SSO token
 * before it checks the password, so once a request has reached the server this
 * form cannot succeed again: every such failure is terminal and offers only a way
 * back to sign-in. Only a failure that may never have reached the server (no
 * status) keeps the form open for a retry. Copy is chosen by the server's or
 * main's `error_code` first and by status only as a fallback, and never shows
 * the status code itself.
 *
 * Cancel resets the SSO store back to `idle`, which causes AuthFlow (Task 21)
 * to re-render the standard login screen — the user can choose to register a
 * new account or restart the SSO flow.
 *
 * Defensive render: returns null when ssoStore phase !== 'link_required' so
 * this component is safe to mount unconditionally inside an AuthFlow that
 * hasn't yet routed to it.
 *
 * Privacy: the secret never enters logs or telemetry — it is held only in
 * component state, passed once to `completeSSOLink`, then released when the
 * component unmounts on phase transition.
 */

import React, { useState } from 'react';
import LoadingSpinner from './LoadingSpinner';
import { useSSOStore } from '../../stores/auth/ssoStore';
import { useAuthStore } from '../../stores/auth/authStore';
import { useE2EEStore } from '../../stores/auth/e2eeStore';
import { useMFAChallengeStore, type MFAChallengeResult } from '../../stores/auth/mfaChallengeStore';
import {
  completeSSOLink,
  abandonSSOReservation,
  SSOServiceError,
  type SSOCompletionResult,
  type SSOLinkCompletionResult,
} from '../../services/system/ssoService';
import { recordChallengeIssuer } from '../../services/system/challengeIssuer';
import { methodsForOptions, webauthnOptionsOrNull } from '../../utils/webauthnOptions';
import { revokeAbortedSession, type AbortedSessionRef } from '../../services/system/apiClient';
import {
  captureRuntimeServerSelection,
  runtimeServerSelectionIsCurrent,
} from '../../services/system/runtimeServerBase';
import type { CredentialOwner } from '../../../main/ipcContract';
import './SSOAccountLinkConfirm.css';

const WRONG_PASSWORD = 'Wrong password. Sign in again to try once more.';
const LOCKED = 'Too many failed attempts. Try again in 15 minutes.';

// Copy by `error_code`: the server's complete-link codes, then the two main
// raises itself (409 completion gone, 502 server answer refused).
const LINK_ERRORS: Record<string, string> = {
  invalid_credentials: WRONG_PASSWORD,
  sso_token_invalid: 'This sign-in expired. Please sign in again.',
  account_locked: LOCKED,
  account_disabled: 'This account is disabled.',
  sso_cancelled: 'This sign-in was cancelled. Please sign in again.',
  sso_session_rejected: "The account couldn't be linked. Please sign in again.",
};
// Fallbacks by status, for a server that sends no recognised code.
const LINK_STATUS_ERRORS: Record<number, string> = { 401: WRONG_PASSWORD, 423: LOCKED };
const LINK_TERMINAL_ERROR = "Couldn't link your account. Please sign in again.";
const LINK_RETRYABLE_ERROR = "Couldn't reach the server. Please try again.";

interface LinkError {
  message: string;
  /** The SSO token is spent (or the completion gone), so the form cannot retry. */
  terminal: boolean;
}

/**
 * Map a completeSSOLink failure to user-facing copy. ssoService throws
 * SSOServiceError carrying the status and either the server's sanitized body or
 * main's own `error_code`. The code is server-controlled, so it is matched only
 * against our own keys (`Object.hasOwn`): a code such as `__proto__` must not
 * select an inherited property. Status 0 means main never got an HTTP answer, so
 * the token may be unspent and a retry is offered; anything else is terminal.
 * Kept out of handleSubmit's catch so the decode does not add to its cognitive
 * complexity (S3776).
 */
function mapCompleteLinkError(err: unknown): LinkError {
  if (!(err instanceof SSOServiceError) || err.status === 0) {
    return { message: LINK_RETRYABLE_ERROR, terminal: false };
  }
  const code = err.body?.error_code;
  if (typeof code === 'string' && Object.hasOwn(LINK_ERRORS, code)) {
    return { message: LINK_ERRORS[code], terminal: true };
  }
  const message = Object.hasOwn(LINK_STATUS_ERRORS, err.status)
    ? LINK_STATUS_ERRORS[err.status]
    : LINK_TERMINAL_ERROR;
  return { message, terminal: true };
}

const SSOAccountLinkConfirm: React.FC = () => {
  const state = useSSOStore((s) => s.state);
  const setSSOState = useSSOStore((s) => s.setState);

  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);

  // Defensive: only render in the link_required phase. Any other phase
  // routing is the responsibility of AuthFlow (Task 21).
  if (state.phase !== 'link_required') {
    return null;
  }

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (submitting || terminal || password.length === 0) {
      return;
    }
    const requestSelection = captureRuntimeServerSelection();
    const requestAuthGeneration = useAuthStore.getState().authGeneration;
    const requestIsCurrent = () =>
      runtimeServerSelectionIsCurrent(requestSelection) &&
      useAuthStore.getState().authGeneration === requestAuthGeneration;
    setSubmitting(true);
    setError(null);

    let issuedSession: AbortedSessionRef | null = null;
    let credentialOwner: CredentialOwner | null = null;
    let admittedGeneration: number | null = null;
    const cleanupIssuedSession = async () => {
      const auth = useAuthStore.getState();
      if (admittedGeneration !== null && auth.authGeneration === admittedGeneration) {
        auth.clearAccessToken();
      }
      if (credentialOwner !== null) {
        const e2ee = useE2EEStore.getState();
        if (e2ee.ssoCredentialOwner === credentialOwner) {
          e2ee.setNeedsSSOUnlock(false);
        }
        try {
          await globalThis.electron?.clearTokensIfOwner?.(credentialOwner);
        } catch {
          // Explicit server revocation below is the cleanup backstop.
        }
      }
      if (issuedSession) await revokeAbortedSession(issuedSession);
    };

    const completeLinkMFA = async (
      result: Extract<SSOLinkCompletionResult, { kind: 'mfa_required' }>
    ): Promise<SSOCompletionResult | null> => {
      credentialOwner = result.credentialOwner;
      if (!requestIsCurrent()) {
        await cleanupIssuedSession();
        return null;
      }
      // Leaving the challenge unfinished, by a cancel or by a failure to raise
      // it, retires main's reservation while this request is still current; a
      // stale one clears only its own owner. A cancel returns to sign-in; a
      // failure to raise the challenge says so on the SSO error screen.
      const abandonChallenge = async (raiseFailed: boolean) => {
        if (requestIsCurrent()) {
          void abandonSSOReservation();
          setSSOState(
            raiseFailed ? { phase: 'error', message: 'sso_mfa_failed' } : { phase: 'idle' }
          );
        } else {
          await cleanupIssuedSession();
        }
      };
      setSSOState({ phase: 'mfa_required', mfaChallengeToken: result.mfaChallengeToken });
      let mfaResult: MFAChallengeResult;
      try {
        recordChallengeIssuer(result.mfaChallengeToken, requestSelection);
        const webauthnOptions = webauthnOptionsOrNull(
          result.webauthnOptions,
          requestSelection.apiBase
        );
        mfaResult = await useMFAChallengeStore
          .getState()
          .showChallenge(
            result.mfaChallengeToken,
            methodsForOptions(result.methods, webauthnOptions),
            'sso_login',
            result.recoveryOnlyMethods,
            { provider: state.provider, credentialOwner: result.credentialOwner },
            webauthnOptions,
            result.defaultMethod
          );
      } catch {
        // The phase is already mfa_required, which this form does not render:
        // without this the user is left on a challenge nothing shows. The store's
        // showChallenge does not reject today; this guards a future change.
        await abandonChallenge(true);
        return null;
      }
      if (!mfaResult.verified || !('ssoCompletion' in mfaResult)) {
        await abandonChallenge(false);
        return null;
      }
      return mfaResult.ssoCompletion;
    };

    try {
      const result = await completeSSOLink(
        {
          provider: state.provider,
          ssoToken: state.ssoToken,
          password,
        },
        requestSelection
      );
      const completion = 'kind' in result ? await completeLinkMFA(result) : result;
      if (!completion) return;
      issuedSession = {
        accessToken: completion.accessToken,
        sessionId: completion.sessionId,
        apiBase: requestSelection.apiBase,
      };
      credentialOwner = completion.credentialOwner;
      if (!requestIsCurrent()) {
        await cleanupIssuedSession();
        return;
      }

      // Arm the post-auth gate before publishing the access token so React
      // can never observe an admitted SSO session without its owner-bound
      // unlock requirement.
      useE2EEStore.getState().setNeedsSSOUnlock(true, credentialOwner);
      admittedGeneration = useAuthStore
        .getState()
        .beginAuthLifecycleIfCurrent(
          requestAuthGeneration,
          completion.accessToken,
          completion.sessionId
        );
      if (admittedGeneration === null) {
        await cleanupIssuedSession();
        return;
      }
      // Returning to phase 'idle' lets AuthFlow re-evaluate based on the
      // new accessToken in authStore (the user is now logged in).
      if (
        runtimeServerSelectionIsCurrent(requestSelection) &&
        useAuthStore.getState().authGeneration === admittedGeneration
      ) {
        setSSOState({ phase: 'idle' });
      } else {
        await cleanupIssuedSession();
      }
    } catch (err) {
      await cleanupIssuedSession();
      if (!requestIsCurrent()) return;
      const failure = mapCompleteLinkError(err);
      // A spent token cannot be retried: release main's reservation now, and
      // leave only the way back to sign-in.
      if (failure.terminal) void abandonSSOReservation();
      setTerminal(failure.terminal);
      setError(failure.message);
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    // #2394: backing out here abandons the SSO flow, so retire the orphaned
    // main-process reservation eagerly rather than leaving it to block a later
    // password registration's E2EE key staging. Fire-and-forget: the helper
    // never throws, and nothing below depends on its result.
    void abandonSSOReservation();
    setSSOState({ phase: 'idle' });
  };

  return (
    <div className="sso-link-confirm">
      <form onSubmit={handleSubmit} className="sso-link-confirm__form" noValidate>
        <h2 className="sso-link-confirm__title">Link your Google account</h2>
        <p className="sso-link-confirm__intro">
          An account with the email <strong>{state.maskedEmail}</strong> already exists. Enter your
          Concord password to link your Google account.
        </p>

        <div className="sso-link-confirm__field">
          <label htmlFor="sso-link-password" className="sso-link-confirm__label">
            Password
          </label>
          <input
            id="sso-link-password"
            type="password"
            className="sso-link-confirm__input"
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            autoComplete="current-password"
            disabled={submitting || terminal}
          />
        </div>

        {error && (
          <div className="sso-link-confirm__error" role="alert">
            {error}
          </div>
        )}

        <div className="sso-link-confirm__actions">
          <button
            type="button"
            className="sso-link-confirm__cancel"
            onClick={handleCancel}
            disabled={submitting}
          >
            {terminal ? 'Back to sign in' : 'Cancel'}
          </button>
          {!terminal && (
            <button
              type="submit"
              className="sso-link-confirm__submit"
              disabled={submitting || password.length === 0}
            >
              {submitting ? (
                <>
                  Linking…
                  <LoadingSpinner size="small" inline />
                </>
              ) : (
                'Link account'
              )}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default SSOAccountLinkConfirm;
