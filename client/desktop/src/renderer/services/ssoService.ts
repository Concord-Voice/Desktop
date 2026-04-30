/**
 * SSO Service (#270)
 *
 * Drives the desktop OAuth flow: opens an ephemeral 127.0.0.1 loopback HTTP
 * listener (owned by the main process), starts the provider redirect via the
 * system browser, awaits the OAuth code+state callback, validates state, and
 * exchanges the code with the control plane.
 *
 * Returns a discriminated `SSOResult` union so callers (the `useSSOFlow` hook)
 * can dispatch into the right next-step UI: logged in directly, MFA challenge,
 * first-time SSO registration, or link-an-existing-account flow.
 *
 * Loopback is always cleaned up in the `finally` block — even on state
 * mismatch or HTTP error — so a failed flow never leaks the listening socket.
 *
 * Privacy: this module never logs the OAuth code, the SSO token, or the
 * mfa_challenge_token. Errors propagate as `Error` with stable string codes
 * (e.g. `oauth_state_mismatch`) so UI can localize without inspecting payload.
 */

import { apiFetch, safeJson } from './apiClient';

export type SSOProvider = 'google' | 'apple';

export type SSOResult =
  | { kind: 'logged_in'; accessToken: string }
  | {
      kind: 'mfa_required';
      mfaChallengeToken: string;
      /** Login-eligible methods (drives MFAChallengeModal layout) */
      methods: string[];
      /** Methods enrolled but disqualified for login (e.g. backup_code) */
      recoveryOnlyMethods?: string[];
      /** PublicKeyCredentialRequestOptions when "webauthn" is in methods */
      webauthnOptions?: unknown;
    }
  | { kind: 'register_required'; ssoToken: string; email: string; name?: string }
  | { kind: 'link_available'; ssoToken: string; maskedEmail: string };

/**
 * SSOServiceError carries the server response body for callers that need to
 * map error_code values to localized UX. Thrown from the *complete-* helpers
 * when the HTTP response is non-2xx; the body is best-effort parsed JSON.
 *
 * Plain `Error` was previously thrown with a synthetic message
 * (`sso_complete_registration_failed_400`), discarding the server's
 * `error_code` and `detail` fields. Components had to re-fetch or hard-code a
 * mapping. SSOServiceError keeps the structured payload so e.g. the passphrase
 * setup screen can render "username already taken" vs "weak password" vs
 * generic "registration failed".
 */
export class SSOServiceError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.name = 'SSOServiceError';
    this.status = status;
    this.body = body;
  }
}

interface StartResponse {
  auth_url: string;
  state: string;
}

/**
 * Begin an SSO flow for the given provider.
 *
 * 1. Asks the main process to open a 127.0.0.1 loopback listener.
 * 2. Calls GET /api/v1/auth/sso/{provider}?redirect_uri=... to obtain the
 *    provider authorization URL and the expected `state` value.
 * 3. Opens the URL in the user's default browser.
 * 4. Awaits the loopback callback (code + state).
 * 5. Verifies state matches; throws `oauth_state_mismatch` if not.
 * 6. Exchanges the code via POST /api/v1/auth/sso/{provider}/callback and
 *    interprets the response shape into an `SSOResult`.
 *
 * Always cleans up the loopback listener via `cancelLoopback` in `finally`.
 */
export async function startSSOFlow(provider: SSOProvider): Promise<SSOResult> {
  // Prefer globalThis over window for the preload-bridged Electron API surface
  // — keeps the service callable from any execution context (worker, ESM eval,
  // future server-side render of the renderer code) without a window binding.
  // The preload declares `var electron` on globalThis (see preload.ts), so the
  // reference resolves identically in renderer-process scripts.
  const lo = await globalThis.electron.sso.startLoopback();
  try {
    const startRes = await apiFetch(
      `/api/v1/auth/sso/${provider}?redirect_uri=${encodeURIComponent(lo.redirectURI)}`
    );
    if (!startRes.ok) {
      throw new Error(`sso_start_failed_${startRes.status}`);
    }
    const { auth_url: authURL, state } = await safeJson<StartResponse>(startRes);

    await globalThis.electron.openExternal(authURL);

    const { code, state: returnedState } = await globalThis.electron.sso.awaitCallback(lo.port);
    if (returnedState !== state) {
      throw new TypeError('oauth_state_mismatch');
    }

    const cbRes = await apiFetch(`/api/v1/auth/sso/${provider}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
    if (!cbRes.ok) {
      throw new Error(`sso_callback_failed_${cbRes.status}`);
    }
    const payload = await safeJson<Record<string, unknown>>(cbRes);
    return interpretCallbackResponse(payload);
  } finally {
    globalThis.electron.sso.cancelLoopback(lo.port);
  }
}

// Methods array drives the MFAChallengeModal — without it the modal has no
// way to render TOTP vs WebAuthn vs email/SMS choices. Default to empty
// array so the modal can still mount (it falls back to method-select when
// empty); the backend always populates this when MFA is enrolled.
//
// Extracted from interpretCallbackResponse so that function stays under
// SonarQube's S3776 cognitive-complexity threshold; behavior is unchanged.
function buildMfaRequiredResult(
  resp: Record<string, unknown>,
  mfaChallengeToken: string
): Extract<SSOResult, { kind: 'mfa_required' }> {
  const methods = Array.isArray(resp.methods) ? (resp.methods as string[]) : [];
  const recoveryOnlyMethods = Array.isArray(resp.recovery_only_methods)
    ? (resp.recovery_only_methods as string[])
    : undefined;
  return {
    kind: 'mfa_required',
    mfaChallengeToken,
    methods,
    recoveryOnlyMethods,
    webauthnOptions: resp.webauthn_options,
  };
}

function interpretCallbackResponse(resp: Record<string, unknown>): SSOResult {
  if (typeof resp.access_token === 'string' && resp.access_token.length > 0) {
    return { kind: 'logged_in', accessToken: resp.access_token };
  }
  if (typeof resp.mfa_challenge_token === 'string' && resp.mfa_challenge_token.length > 0) {
    return buildMfaRequiredResult(resp, resp.mfa_challenge_token);
  }
  if (resp.sso_registration_required === true) {
    if (typeof resp.sso_token !== 'string' || typeof resp.email !== 'string') {
      // TypeError, not Error: the field types do not match the documented
      // contract — this is a structural / shape mismatch, not a runtime fault.
      throw new TypeError('sso_response_invalid_register_required');
    }
    return {
      kind: 'register_required',
      ssoToken: resp.sso_token,
      email: resp.email,
      name: typeof resp.name === 'string' ? resp.name : undefined,
    };
  }
  if (resp.account_link_available === true) {
    if (typeof resp.sso_token !== 'string' || typeof resp.masked_email !== 'string') {
      // TypeError, not Error: shape mismatch on the documented response contract.
      throw new TypeError('sso_response_invalid_link_available');
    }
    return {
      kind: 'link_available',
      ssoToken: resp.sso_token,
      maskedEmail: resp.masked_email,
    };
  }
  throw new Error('sso_response_unrecognized');
}

/**
 * Complete first-time SSO registration. Submits the user's chosen username,
 * passphrase, and E2EE key material (wrapped private key + salt + public key)
 * along with the short-lived `sso_token` returned by the callback step.
 *
 * Returns a fresh access token on success.
 */
export async function completeSSORegistration(params: {
  provider: SSOProvider;
  ssoToken: string;
  username: string;
  passphrase: string;
  /** base64-encoded wrapped private key */
  wrappedPrivateKey: string;
  /** base64-encoded Argon2id salt used to derive the wrapping key */
  keyDerivationSalt: string;
  /** base64-encoded RSA public key */
  publicKey: string;
}): Promise<{ accessToken: string }> {
  const res = await apiFetch(`/api/v1/auth/sso/${params.provider}/complete-registration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sso_token: params.ssoToken,
      username: params.username,
      password: params.passphrase,
      wrapped_private_key: params.wrappedPrivateKey,
      key_derivation_salt: params.keyDerivationSalt,
      public_key: params.publicKey,
    }),
  });
  if (!res.ok) {
    // Best-effort body parse so the caller can read error_code / detail.
    // safeJson throws on parse failure → fall back to null body, not a fatal.
    let body: Record<string, unknown> | null = null;
    try {
      body = await safeJson<Record<string, unknown>>(res);
    } catch {
      body = null;
    }
    throw new SSOServiceError(res.status, `sso_complete_registration_failed_${res.status}`, body);
  }
  const data = await safeJson<{ access_token: string }>(res);
  return { accessToken: data.access_token };
}

/**
 * Link an SSO identity to an existing password-authenticated account.
 * The caller must provide the existing account password to authorize the link.
 */
export async function completeSSOLink(params: {
  provider: SSOProvider;
  ssoToken: string;
  password: string;
}): Promise<{ accessToken: string }> {
  const res = await apiFetch(`/api/v1/auth/sso/${params.provider}/complete-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sso_token: params.ssoToken,
      password: params.password,
    }),
  });
  if (!res.ok) {
    let body: Record<string, unknown> | null = null;
    try {
      body = await safeJson<Record<string, unknown>>(res);
    } catch {
      body = null;
    }
    throw new SSOServiceError(res.status, `sso_complete_link_failed_${res.status}`, body);
  }
  const data = await safeJson<{ access_token: string }>(res);
  return { accessToken: data.access_token };
}
