/**
 * useSSOFlow (#270)
 *
 * Thin React hook that wraps `startSSOFlow()` and dispatches its
 * `SSOResult` into the global `useSSOStore`. Components call `begin(provider)`
 * and then read `useSSOStore((s) => s.state)` to render the right next step.
 *
 * On `logged_in`, the hook also writes the access token into `useAuthStore`
 * and resets the SSO store back to idle (the user is now authenticated).
 *
 * Errors are caught and surfaced as `{ phase: 'error', message }` so the UI
 * can show a non-blocking error rather than the hook throwing into a
 * component-level error boundary.
 */

import { useCallback } from 'react';
import { useSSOStore } from '../stores/ssoStore';
import { startSSOFlow, type SSOProvider } from '../services/ssoService';
import { useAuthStore } from '../stores/authStore';
import { useE2EEStore } from '../stores/e2eeStore';
import { useMFAChallengeStore } from '../stores/mfaChallengeStore';

export function useSSOFlow(): { begin: (provider: SSOProvider) => Promise<void> } {
  const setState = useSSOStore((s) => s.setState);
  const setAccessToken = useAuthStore((s) => s.setAccessToken);

  const begin = useCallback(
    async (provider: SSOProvider): Promise<void> => {
      setState({ phase: 'authenticating', provider });
      try {
        const result = await startSSOFlow(provider);
        switch (result.kind) {
          case 'logged_in':
            setAccessToken(result.accessToken);
            // Signal the post-auth gate (#270 Task 21b) that an SSO user has
            // arrived without unwrapped E2EE keys. The gate mounts
            // SSOEagerUnlock until e2eeService.initialize succeeds and flips
            // `ready=true` in the same store, at which point both flags
            // combine to fall through to MainApp.
            useE2EEStore.getState().setNeedsSSOUnlock(true);
            setState({ phase: 'idle' });
            break;
          case 'mfa_required':
            // Bridge to the canonical MFA modal. The store records the SSO-side
            // phase (so AuthFlow / Login can render fall-back UI if needed) AND
            // the global useMFAChallengeStore is loaded so MFAChallengeModal —
            // mounted at the App root — picks up the challenge identically to
            // the password path. Without this bridge, the SSO mfa_required
            // branch sets a phase nothing renders against and the user is
            // stranded.
            setState({ phase: 'mfa_required', mfaChallengeToken: result.mfaChallengeToken });
            useMFAChallengeStore
              .getState()
              .showChallenge(
                result.mfaChallengeToken,
                result.methods ?? [],
                'sso_login',
                result.recoveryOnlyMethods
              )
              .then((verified) => {
                if (verified) {
                  // MFA modal verifies via /api/v1/auth/mfa/verify which returns
                  // a full login response. The modal calls completeChallenge(true)
                  // after a successful verify, but does NOT itself wire tokens
                  // into useAuthStore — the password path (Login.tsx) handles
                  // completeLoginFromResponse. For SSO, the post-verify token
                  // wiring happens at the next page load (the access_token in
                  // the verify response is set into authStore by the modal's
                  // verify handler — see MFAChallengeModal.handleVerify).
                  //
                  // Reset the SSO phase so any SSOPassphraseSetup mounting is
                  // also dismissed. The user is logged in.
                  setState({ phase: 'idle' });
                  useE2EEStore.getState().setNeedsSSOUnlock(true);
                } else {
                  // User cancelled or verification failed — clear SSO state so
                  // the auth screen returns to the connection selector.
                  setState({ phase: 'idle' });
                }
              })
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : 'sso_mfa_failed';
                setState({ phase: 'error', message });
              });
            break;
          case 'register_required':
            setState({
              phase: 'register_required',
              provider,
              ssoToken: result.ssoToken,
              email: result.email,
              name: result.name,
            });
            break;
          case 'link_available':
            setState({
              phase: 'link_required',
              provider,
              ssoToken: result.ssoToken,
              maskedEmail: result.maskedEmail,
            });
            break;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'sso_failed';
        setState({ phase: 'error', message });
      }
    },
    [setState, setAccessToken]
  );

  return { begin };
}
