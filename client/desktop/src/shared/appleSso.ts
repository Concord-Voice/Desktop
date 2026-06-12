/**
 * Shared types for the client-driven Apple SSO exchange (#974).
 *
 * AppleSignInResult is the discriminated union the main-process orchestrator
 * (src/main/oauth/apple/appleFlow.ts) relays to the renderer over the
 * `sso:appleSignIn` IPC channel. It mirrors the server's /session response
 * shapes one-to-one so the renderer's existing ssoStore paths (registration /
 * link / MFA modals) stay unchanged.
 *
 * SECURITY: this union is the ONLY Apple-flow data that crosses IPC. The
 * authorization code, PKCE verifier, broker client_secret, Apple token
 * response, and pre-verification id_token live and die inside the
 * main-process flow closure (spec §Secrets lifetime).
 */

/**
 * Stable renderer-visible error codes (spec §Failure taxonomy).
 * `oauth_provider_error:<x>` passes through the provider's error code from
 * the loopback callback; `state_mismatch` is folded into that family (the
 * provider/bridge returned a state that does not match the initiated flow).
 */
export type AppleSignInErrorCode =
  | 'sso_initiate_failed'
  | 'sso_cancelled'
  | `oauth_provider_error:${string}`
  | 'sso_state_expired'
  | 'sso_rate_limited'
  | 'apple_exchange_rejected'
  | 'apple_unavailable'
  | 'apple_verification_unavailable'
  | 'apple_id_token_invalid'
  | 'sso_session_rejected';

export type AppleSignInResult =
  | { kind: 'tokens'; accessToken: string }
  | {
      kind: 'mfa_challenge';
      mfaChallengeToken: string;
      /** Login-eligible methods (drives MFAChallengeModal layout). */
      methods: string[];
      /** Methods enrolled but disqualified for login (e.g. backup_code). */
      recoveryOnlyMethods?: string[];
      /** PublicKeyCredentialRequestOptions when "webauthn" is in methods. */
      webauthnOptions?: unknown;
    }
  | { kind: 'sso_token'; branch: 'new_user'; ssoToken: string; email: string; name?: string }
  | { kind: 'sso_token'; branch: 'account_link'; ssoToken: string; maskedEmail: string }
  | { kind: 'error'; code: AppleSignInErrorCode };
