/**
 * SSO IPC bridge — wires the loopback HTTP server in `ssoLoopback.ts` to the
 * renderer's OAuth flow.
 *
 * Channel surface (11):
 *   - `sso:startLoopback` (invoke)  — spin up a 127.0.0.1 ephemeral-port server
 *                                     and return `{port, redirectURI}` for the
 *                                     renderer to embed in the provider URL.
 *   - `sso:awaitCallback` (invoke)  — await the captured `{code, state}` for a
 *                                     previously started loopback (keyed by
 *                                     port, since the renderer already knows it).
 *   - `sso:cancelLoopback` (send)   — best-effort tear-down for a port the
 *                                     renderer abandoned (user closed the
 *                                     auth tab, switched flows, etc).
 *   - `sso:appleSignIn` (invoke)    — run the FULL client-driven Apple flow
 *                                     (#974) in the main process: PKCE,
 *                                     loopback, broker client_secret, Apple
 *                                     /auth/token, local jose verification,
 *                                     /session POST. Resolves to the
 *                                     discriminated AppleSignInResult; no
 *                                     OAuth material crosses IPC.
 *   - `sso:appleCancel` (send)      — tear down the in-flight Apple flow.
 *   - `sso:googleSignIn` (invoke)   — run the FULL client-driven Google flow
 *                                     (#975): PKCE, loopback, Google /token with
 *                                     the embedded client_secret, local jose
 *                                     verification, /session POST. Resolves to
 *                                     SSOSignInResult; no OAuth material crosses
 *                                     IPC. Simpler than Apple — no broker.
 *   - `sso:googleCancel` (send)     — tear down the in-flight Google flow.
 *   - `sso:completeRegistration` / `sso:completeLink` (invoke) — submit the
 *                                     final server exchange in main, store the
 *                                     refresh credential under the reserved
 *                                     SSO owner, and return no refresh token.
 *   - `sso:completeMFA` (invoke)    — submit the SSO MFA proof (#2424) in main,
 *                                     store the refresh credential under the
 *                                     owner reserved at sign-in, and return no
 *                                     refresh token. Keeps the MFA path at parity
 *                                     with the direct/registration custody model.
 *   - `sso:abandonReservation` (invoke) — release an ORPHANED credential
 *                                     reservation (#2394) so the pre-credential
 *                                     E2EE staging lane reopens for password
 *                                     registration. Zero-argument: main resolves
 *                                     the target from its own state, so the
 *                                     renderer carries no authority.
 *
 * Admission (#86 contract v34): every channel registers through `registerIpc` as
 * `connection-bound`, so the sender is a bound primary main frame whose URL its
 * service kind permits, and the handler receives that main-held binding. A
 * refused sender makes the invoke handlers reject (the renderer sees a rejected
 * promise; `sso:abandonReservation` resolves false) and the send handlers no-op.
 *
 * Authority comes from the binding alone: the API origin a handler dials is the
 * sender's service origin (a supplied `apiBase` is only cross-checked, and a
 * mismatch is refused as wrong-owner before any dial or custody call), custody is
 * the sender's service custody, and the four credentials:'include' requests go
 * through that service's session (`sessionFetchFor`), whose cookie jar is the one
 * the connection's renderer reads. Pending SSO state is keyed by ConnectionId and
 * fenced by an owner binding re-checked after every `await`.
 *
 * Per-port handle accounting lets `sso:cancelLoopback` and `sso:awaitCallback`
 * find the running server, and only the connection document that started a
 * loopback may await or cancel it. We also auto-clean the entry once the loopback
 * promise settles — if the renderer never calls awaitCallback the active map
 * does not leak forever.
 */
// `isIP` is imported as a NAMED binding, not a default `net` namespace: `net` is
// already bound to Electron's `net` above/below, and a default import would shadow it.
import { isIP } from 'node:net';

import { shell } from 'electron';

import { getApiBaseUrl, PRODUCTION_API_BASE } from '../apiBaseUrl';
import { AUTH_REQUEST_TIMEOUT_MS, readAuthJson } from '../authResponse';
import {
  bindOwner,
  isOwnerCurrent,
  requireOwner,
  type OwnerBinding,
} from '../connectionCapability';
import { onGenerationAdvanced, recordFor, refOf, type ProfileCustody } from '../connectionRegistry';
import { sessionFetchFor } from '../connectionSession';
import { classifyAddress } from '../egressPolicy';
import { guardedRequest } from '../guardedRequest';
import { getMachineId } from '../machineId';
import { cancelActiveAppleFlow, runAppleSignIn } from '../oauth/apple/appleFlow';
import { appleTokenCall } from '../oauth/apple/appleTokenCall';
import { verifyAppleIDToken } from '../oauth/apple/idTokenVerifier';
import { signClientSecret } from '../oauth/apple/signClientSecret';
import { loadGoogleClientSecret } from '../oauth/google/clientSecret';
import { cancelActiveGoogleFlow, runGoogleSignIn } from '../oauth/google/googleFlow';
import { googleTokenCall } from '../oauth/google/googleTokenCall';
import { verifyGoogleIDToken } from '../oauth/google/idTokenVerifier';
import { isServerUserId } from '../preferenceOwnership';
import { normalizeSelfHostedUrl } from '../selfHostedProbe';
import { isTier2DialApproved, isValidatedSelfHostedApiBase } from '../selfHostedProfile';
import { startLoopback, type LoopbackHandle } from '../ssoLoopback';

import type { MainSSOSignInResult } from '../oauth/ssoFlowShared';
import type { CredentialOwner } from '../ipcContract';
import type {
  SSOCompleteLinkPayload,
  SSOCompleteMFAPayload,
  SSOCompleteRegistrationPayload,
  SSOCompletionErrorBody,
  SSOCompletionResult,
  SSOSignInResult,
} from '../../shared/sso';
import type { ConnectionId } from '../../shared/connectionIdentity';

import { crossCheckApiBase, type ConnectionSender, type SenderRefusal } from './connectionSender';
import { registerIpc } from './registry';

/** A connection service's own session fetch (`sessionFetchFor`). */
type SessionFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Resolves any fetch-input shape to its URL string — String(input) on a
 * Request would coerce to '[object Request]' (sonar S6551). Typed via
 * Parameters<typeof fetch>[0] instead of naming RequestInfo: the
 * main-process build (tsconfig.main.json) has no DOM lib, so the
 * RequestInfo alias doesn't exist there — CI's build:main rejects it
 * while the root tsconfig's typecheck accepts it.
 */
function resolveFetchUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A loopback and the connection document that started it (#86: owner-scoped). */
interface OwnedLoopback {
  readonly handle: LoopbackHandle;
  readonly owner: OwnerBinding;
}

const active = new Map<number, OwnedLoopback>();
const SESSION_ID_HEADER = 'X-Concord-Session-ID';
// Well above a healthy verify, which answers in well under the control plane's
// 15 s WriteTimeout. It fires for a stuck connection or a stalled handler
// alike, and either way fails closed. The challenge token's 5-minute TTL and
// single-use claim remain the security bound; this one is liveness.
const SSO_MFA_VERIFY_TIMEOUT_MS = 30_000;
// The best-effort logout after a failed completion must not re-open the hang
// the verify timeout closes; server-side session expiry is the backstop.
const COOKIE_SESSION_REVOKE_TIMEOUT_MS = 10_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PendingSSOCompletion {
  apiBase: string;
  credentialOwner: CredentialOwner;
  provider: 'google' | 'apple';
  branch: 'new_user' | 'account_link';
  ssoToken: string;
  /** The connection document the sign-in ran for; stale once its generation moves. */
  owner: OwnerBinding;
}

// #2424: the reserved owner + challenge token held across an SSO MFA challenge.
// The renderer collects the MFA proof (TOTP code or WebAuthn assertion) and calls
// sso:completeMFA; main re-validates this state, submits the proof, and stores the
// resulting refresh credential under `credentialOwner` — the raw refresh token
// never crosses back to the renderer (parity with the direct SSO path).
interface PendingSSOMFA {
  apiBase: string;
  credentialOwner: CredentialOwner;
  provider: 'google' | 'apple';
  mfaChallengeToken: string;
  /** The connection document the sign-in ran for; stale once its generation moves. */
  owner: OwnerBinding;
}

/** One Apple/Google sign-in, captured in the admission tick. */
interface SignInContext {
  readonly id: ConnectionId;
  readonly owner: OwnerBinding;
  readonly signIn: number;
  readonly custody: ProfileCustody;
  readonly fetch: SessionFetch;
  readonly apiBase: string;
  readonly provider: 'google' | 'apple';
  readonly credentialOwner: CredentialOwner;
}

interface MainCompletionTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  rememberMe: boolean;
}

// Google's client_secret is a non-confidential build constant (Google's
// native-app guidance — PKCE is the control), read once from the
// main-process-only resource. Never IPC-exposed to the renderer.
let cachedGoogleClientSecret: string | undefined;
function googleClientSecret(): string {
  cachedGoogleClientSecret ??= loadGoogleClientSecret();
  return cachedGoogleClientSecret;
}

export function approvedApiBase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeSelfHostedUrl(value);
  if (!normalized.ok || normalized.apiBase !== value) return null;

  // Tier-1 pre-flight (#2354 §6.5). DEFENSE IN DEPTH ONLY — this does NOT close the
  // TOCTOU window, and it does NOT protect the four un-movable credentials:'include'
  // sites below against DNS rebinding: it inspects the URL's own text, not the address
  // the socket ultimately dials. Its threat model is narrower — a hand-edited or
  // tampered self-hosted-approvals.json, or a future code path that adds to the
  // validated set outside the approval ceremony. It is deliberately SYNCHRONOUS and
  // IP-LITERAL-ONLY (no name lookup) so approvedApiBase stays synchronous for its
  // callers; making it async would ripple through every sso: handler. It is also
  // TIER-1-ONLY: a tier-2 literal (loopback / RFC1918 / ULA / CGNAT) in a tampered
  // approvals file passes this check, and the four credentials:'include' sites below
  // carry no egress guard of their own, so they would dial it. The real
  // connection-time guarantee lives in guardedRequest. Reuses classifyAddress so there
  // is never a second, drifting address predicate.
  const host = new URL(value).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && classifyAddress(host).tier === 'tier1') return null;

  return value === PRODUCTION_API_BASE ||
    value === getApiBaseUrl() ||
    isValidatedSelfHostedApiBase(value)
    ? value
    : null;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isProvider(value: unknown): value is 'google' | 'apple' {
  return value === 'google' || value === 'apple';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCompleteRegistrationPayload(value: unknown): value is SSOCompleteRegistrationPayload {
  return (
    isRecord(value) &&
    isProvider(value.provider) &&
    isBoundedString(value.ssoToken, 8192) &&
    isBoundedString(value.username, 128) &&
    isBoundedString(value.passphrase, 1024) &&
    isBoundedString(value.wrappedPrivateKey, 16_384) &&
    isBoundedString(value.keyDerivationSalt, 1024) &&
    isBoundedString(value.publicKey, 8192)
  );
}

function isCompleteLinkPayload(value: unknown): value is SSOCompleteLinkPayload {
  return (
    isRecord(value) &&
    isProvider(value.provider) &&
    isBoundedString(value.ssoToken, 8192) &&
    isBoundedString(value.password, 1024)
  );
}

// #2424: the SSO MFA proof the renderer routes to sso:completeMFA. `credentialOwner`
// is the opaque number reserved at sign-in and echoed back through the mfa_challenge
// result; `code` (TOTP/backup) and `assertion` (WebAuthn) are mutually exclusive by
// method, but the control plane is the authority on which is required — this guard
// only bounds shapes at the trust boundary.
function isCompleteMFAPayload(value: unknown): value is SSOCompleteMFAPayload {
  return (
    isRecord(value) &&
    isProvider(value.provider) &&
    isBoundedString(value.mfaChallengeToken, 8192) &&
    typeof value.credentialOwner === 'number' &&
    Number.isSafeInteger(value.credentialOwner) &&
    isBoundedString(value.method, 32) &&
    (value.code === undefined || isBoundedString(value.code, 256)) &&
    (value.assertion === undefined || isRecord(value.assertion))
  );
}

/**
 * #86: the preference-scope input for an SSO publish, read from the `user_id` claim
 * of the access token the control plane just returned to main's own fetch. No SSO
 * response body carries a user object, so main derives the id rather than taking it
 * from the renderer. Unverified decode, like tokenManager's decodeJwtExp: the value
 * is only ever hashed into this service's account key, and the issuing server
 * already names the account. Anything that is not a valid server user id yields no
 * key (a null scope), never a throw that would strand the reserved owner.
 */
function serverUserIdClaim(accessToken: string): { serverUserId?: string } {
  const payload = accessToken.split('.')[1];
  if (payload === undefined) return {};
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return {};
  }
  if (!isRecord(claims)) return {};
  const userId = claims.user_id;
  return isServerUserId(userId) ? { serverUserId: userId } : {};
}

function parseCompletionTokens(value: unknown): MainCompletionTokens | null {
  if (
    !isRecord(value) ||
    !isBoundedString(value.access_token, 32_768) ||
    !isBoundedString(value.refresh_token, 32_768) ||
    !isBoundedString(value.session_id, 256) ||
    !UUID_PATTERN.test(value.session_id) ||
    (value.remember_me !== undefined && typeof value.remember_me !== 'boolean')
  ) {
    return null;
  }
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    sessionId: value.session_id,
    rememberMe: value.remember_me ?? true,
  };
}

function sanitizeCompletionErrorBody(value: unknown): SSOCompletionErrorBody | undefined {
  if (!isRecord(value)) return undefined;
  const body: SSOCompletionErrorBody = {};
  if (isBoundedString(value.error_code, 256)) body.error_code = value.error_code;
  if (isBoundedString(value.error, 2048)) body.error = value.error;
  if (isBoundedString(value.detail, 4096)) body.detail = value.detail;
  if (
    typeof value.attempts_remaining === 'number' &&
    Number.isSafeInteger(value.attempts_remaining)
  ) {
    body.attempts_remaining = value.attempts_remaining;
  }
  if (
    typeof value.retry_after_seconds === 'number' &&
    Number.isSafeInteger(value.retry_after_seconds)
  ) {
    body.retry_after_seconds = value.retry_after_seconds;
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await readAuthJson(response, signal);
  } catch {
    return null;
  }
}

async function revokeExplicitSession(apiBase: string, tokens: MainCompletionTokens): Promise<void> {
  try {
    // #2354 §6.4: this is the ONLY sso.ts egress that may move to the guarded Node
    // transport, because it is credentials:'omit' and writes its own headers — it needs
    // no cookie jar. The public SaaS origin is permitted by policy; a self-hosted origin
    // has already been approved through the native ceremony. The four credentials:'include'
    // sites CANNOT follow it (Node's fetch has no cookie jar — see the notes below).
    await guardedRequest(`${apiBase}/api/v1/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'X-Refresh-Token': tokens.refreshToken,
      },
      // Same split as the probe: origin trust admitted this apiBase for credential
      // custody, but dialling a tier-2 address needs consent taken AT tier 2.
      isOriginApproved: (origin) => isTier2DialApproved(origin),
    });
  } catch {
    // Best effort; the server-side expiry remains the cleanup backstop.
  }
}

/** Test seam for the #2354 guarded-egress contract. Not part of the IPC surface. */
export const __revokeExplicitSessionForTest = revokeExplicitSession;

async function revokeCookieBoundSession(
  fetchFn: SessionFetch,
  apiBase: string,
  sessionId: string | null
): Promise<void> {
  if (!sessionId || !UUID_PATTERN.test(sessionId)) return;
  try {
    await fetchFn(`${apiBase}/api/v1/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Session-ID': sessionId },
      signal: AbortSignal.timeout(COOKIE_SESSION_REVOKE_TIMEOUT_MS),
    });
  } catch {
    // Best effort; the session ID + cookie hash match prevents successor revoke.
  }
}

function captureSessionId(response: Response): string | null {
  const sessionId = response.headers.get(SESSION_ID_HEADER);
  return sessionId && UUID_PATTERN.test(sessionId) ? sessionId : null;
}

/** A refused `handle` channel rejects (the renderer sees a rejected promise). */
const rejectUntrusted =
  (channel: string) =>
  (reason: SenderRefusal): Promise<never> =>
    Promise.reject(new Error(`${channel} rejected: untrusted sender frame (${reason})`));

/** A refused `on` channel is a silent no-op; the registry already logged the refusal. */
const ignoreRefused = (): void => undefined;

type SenderApiBase = { ok: true; apiBase: string } | { ok: false; wrongOwner: boolean };

/**
 * D3: the API base a handler speaks to is the sender's own service origin. The
 * renderer-supplied value is a cross-check, never a selector: it must be a string,
 * name the sender's service origin (`crossCheckApiBase`, else `wrongOwner`), and pass
 * the existing exact-form approval. Synchronous, so a caller refuses before any dial,
 * custody call or budget spend.
 */
function senderApiBase(sender: ConnectionSender, requested: unknown): SenderApiBase {
  if (typeof requested !== 'string') return { ok: false, wrongOwner: false };
  if (!crossCheckApiBase(sender, requested)) return { ok: false, wrongOwner: true };
  const apiBase = approvedApiBase(requested);
  return apiBase !== null && apiBase === sender.service.origin
    ? { ok: true, apiBase }
    : { ok: false, wrongOwner: false };
}

/**
 * The fence for effects after an `await`, bound to the sender's connection as it
 * stands NOW. Call it in the same tick as the admission and after any reserve:
 * `reserveCredentialOwner` advances the generation ('credential-start'), so a binding
 * minted from the admission-time ref would be stale at birth.
 */
function ownerNow(sender: ConnectionSender): OwnerBinding {
  const record = recordFor(sender.ref.connectionId);
  if (!record) throw new Error('sso: connection is gone');
  return bindOwner('sso-loopback', refOf(record));
}

/**
 * registerSSOIPC wires the eleven sso:* IPC channels through `registerIpc`
 * (connection-bound, except the two sign-in starts, which are app-global-mutate:
 * foreground primary only, #86 RT2). The admitted sender's binding names the connection, its
 * service (the only API origin a handler dials) and its custody (the only custody a
 * handler touches). Pending SSO state, sign-in generations and loopbacks are keyed
 * by ConnectionId, so one connection can neither read nor clear another's.
 */
export function registerSSOIPC(): void {
  const pendingCompletion = new Map<ConnectionId, PendingSSOCompletion>();
  const pendingMFA = new Map<ConnectionId, PendingSSOMFA>();
  // A newer sign-in on the same connection supersedes an older one still in flight.
  const signInGeneration = new Map<ConnectionId, number>();
  // The connection that started the provider flow now in flight (one per provider
  // module); only it may cancel that flow.
  const flowOwner: Record<'apple' | 'google', ConnectionId | null> = {
    apple: null,
    google: null,
  };

  const discardPendingCompletion = (id: ConnectionId, completion: PendingSSOCompletion): void => {
    if (pendingCompletion.get(id) === completion) pendingCompletion.delete(id);
  };
  const discardPendingMFA = (id: ConnectionId, mfa: PendingSSOMFA): void => {
    if (pendingMFA.get(id) === mfa) pendingMFA.delete(id);
  };

  // Any advance (new document, renderer gone, credential event, disposal) makes every
  // owner binding of that connection stale, so the fences below already refuse what
  // this drops; dropping it frees the ceremony state and the loopback port promptly.
  onGenerationAdvanced((id, _from, _to, reason) => {
    pendingCompletion.delete(id);
    pendingMFA.delete(id);
    if (reason === 'disposed') {
      signInGeneration.delete(id);
      // A disposed connection's provider flow can never finish usefully (its finish is
      // fenced), so end it and release the provider: signIn refuses every other
      // connection while this one owns it, and the reset in signIn's finally no longer
      // matches once the generation entry above is gone.
      for (const p of ['apple', 'google'] as const) {
        if (flowOwner[p] !== id) continue;
        flowOwner[p] = null;
        if (p === 'apple') cancelActiveAppleFlow();
        else cancelActiveGoogleFlow();
      }
    }
    for (const [port, entry] of active) {
      if (entry.owner.ref.connectionId !== id) continue;
      active.delete(port);
      entry.handle.close();
    }
  });

  const isLive = (ctx: SignInContext): boolean =>
    isOwnerCurrent(ctx.owner) && signInGeneration.get(ctx.id) === ctx.signIn;

  const finishSignIn = async (
    result: MainSSOSignInResult,
    ctx: SignInContext,
    cookieBoundSessionId: string | null
  ): Promise<SSOSignInResult> => {
    const { apiBase, custody, credentialOwner, id } = ctx;
    if (!isLive(ctx) || !custody.credentialOwnerIsCurrent(credentialOwner)) {
      await revokeCookieBoundSession(ctx.fetch, apiBase, cookieBoundSessionId);
      if (result.kind === 'tokens') {
        await revokeExplicitSession(apiBase, { ...result, rememberMe: true });
      }
      return { kind: 'error', code: 'sso_cancelled' };
    }

    if (result.kind === 'tokens') {
      const storedOwner = custody.storeRefreshTokenIfOwner(
        {
          refreshToken: result.refreshToken,
          rememberMe: true,
          apiBase,
          accessToken: result.accessToken,
          ...serverUserIdClaim(result.accessToken),
        },
        credentialOwner
      );
      if (storedOwner === null) {
        await revokeCookieBoundSession(ctx.fetch, apiBase, cookieBoundSessionId);
        await revokeExplicitSession(apiBase, { ...result, rememberMe: true });
        return { kind: 'error', code: 'sso_cancelled' };
      }
      pendingCompletion.delete(id);
      return {
        kind: 'tokens',
        accessToken: result.accessToken,
        sessionId: result.sessionId,
        credentialOwner: storedOwner,
      };
    }

    if (result.kind === 'sso_token') {
      pendingCompletion.set(id, {
        apiBase,
        credentialOwner,
        provider: ctx.provider,
        branch: result.branch,
        ssoToken: result.ssoToken,
        owner: ctx.owner,
      });
      return result;
    }

    if (result.kind === 'mfa_challenge') {
      // #2424: preserve the reserved owner across the MFA challenge and return it
      // to the renderer as opaque challenge context. sso:completeMFA re-validates
      // it and stores the resulting credential owner-scoped, keeping the raw
      // refresh token out of the renderer. Do NOT release the owner here — a
      // released owner would force the renderer onto the unrestricted
      // auth:storeRefreshToken path (the owner-CAS gap this change closes).
      pendingMFA.set(id, {
        apiBase,
        credentialOwner,
        provider: ctx.provider,
        mfaChallengeToken: result.mfaChallengeToken,
        owner: ctx.owner,
      });
      return { ...result, credentialOwner };
    }

    // Terminal error (the only remaining kind): revoke the cookie-bound session
    // and release this reservation so switching to registration can safely use
    // the pre-credential key staging path. A connection that moved on during the
    // revoke keeps its reservation; sso:abandonReservation releases an orphan.
    await revokeCookieBoundSession(ctx.fetch, apiBase, cookieBoundSessionId);
    if (isLive(ctx)) custody.clearTokensIfOwner(credentialOwner);
    return result;
  };

  const controlPlaneFetch = (
    fetchFn: SessionFetch,
    sessionUrl: string,
    onSession: (sessionId: string | null) => void
  ): typeof fetch =>
    (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      const response = await fetchFn(url, { ...init, credentials: 'include' });
      if (url === sessionUrl && response.ok) onSession(captureSessionId(response));
      return response;
    }) as typeof fetch;

  /**
   * After the exchange: revoke what the server issued and report cancellation when the
   * owner moved on while the request was in flight, so nothing is stored for it.
   */
  const revokeIfSuperseded = async (
    owner: OwnerBinding,
    fetchFn: SessionFetch,
    apiBase: string,
    response: Response,
    body: unknown
  ): Promise<boolean> => {
    if (isOwnerCurrent(owner)) return false;
    const issued = response.ok ? parseCompletionTokens(body) : null;
    await revokeCookieBoundSession(fetchFn, apiBase, captureSessionId(response));
    if (issued) await revokeExplicitSession(apiBase, issued);
    return true;
  };

  const completeSSO = async (
    sender: ConnectionSender,
    completion: PendingSSOCompletion,
    endpoint: 'complete-registration' | 'complete-link',
    requestBody: Record<string, string>
  ): Promise<SSOCompletionResult> => {
    const id = sender.ref.connectionId;
    const { custody } = sender;
    const fetchFn = sessionFetchFor(sender.service);
    if (!custody.credentialOwnerIsCurrent(completion.credentialOwner)) {
      discardPendingCompletion(id, completion);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }

    const signal = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(
        `${completion.apiBase}/api/v1/auth/sso/${completion.provider}/${endpoint}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(requestBody),
          signal,
        }
      );
    } catch {
      return { kind: 'error', status: 0, code: `sso_${endpoint}_failed` };
    }

    const cookieBoundSessionId = captureSessionId(response);
    const body = await responseJson(response, signal);
    if (await revokeIfSuperseded(completion.owner, fetchFn, completion.apiBase, response, body)) {
      discardPendingCompletion(id, completion);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }
    if (!response.ok) {
      await revokeCookieBoundSession(fetchFn, completion.apiBase, cookieBoundSessionId);
      const safeBody = sanitizeCompletionErrorBody(body);
      return {
        kind: 'error',
        status: response.status,
        code: safeBody?.error_code ?? `sso_${endpoint}_failed`,
        ...(safeBody ? { body: safeBody } : {}),
      };
    }

    const tokens = parseCompletionTokens(body);
    if (!tokens) {
      await revokeCookieBoundSession(fetchFn, completion.apiBase, cookieBoundSessionId);
      discardPendingCompletion(id, completion);
      if (isOwnerCurrent(completion.owner)) custody.clearTokensIfOwner(completion.credentialOwner);
      return { kind: 'error', status: 502, code: 'sso_session_rejected' };
    }

    const storedOwner = custody.storeRefreshTokenIfOwner(
      {
        refreshToken: tokens.refreshToken,
        rememberMe: tokens.rememberMe,
        apiBase: completion.apiBase,
        accessToken: tokens.accessToken,
        ...serverUserIdClaim(tokens.accessToken),
      },
      completion.credentialOwner
    );
    if (storedOwner === null) {
      await revokeCookieBoundSession(fetchFn, completion.apiBase, cookieBoundSessionId);
      await revokeExplicitSession(completion.apiBase, tokens);
      discardPendingCompletion(id, completion);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }

    pendingCompletion.delete(id);
    return {
      kind: 'tokens',
      accessToken: tokens.accessToken,
      sessionId: tokens.sessionId,
      credentialOwner: storedOwner,
    };
  };

  // #2424: submit the SSO MFA proof to the control plane IN MAIN and store the
  // resulting refresh credential under the reserved owner, so the raw refresh
  // token never crosses into the renderer (parity with completeSSO / the direct
  // SSO path). Mirrors completeSSO's owner-CAS + fail-closed shape.
  const completeMFA = async (
    sender: ConnectionSender,
    mfa: PendingSSOMFA,
    requestBody: Record<string, unknown>
  ): Promise<SSOCompletionResult> => {
    const id = sender.ref.connectionId;
    const { custody } = sender;
    const fetchFn = sessionFetchFor(sender.service);
    if (!custody.credentialOwnerIsCurrent(mfa.credentialOwner)) {
      discardPendingMFA(id, mfa);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }

    const signal = AbortSignal.timeout(SSO_MFA_VERIFY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(`${mfa.apiBase}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Same device-binding header the renderer sent pre-#2424; main now
          // owns the POST, so it supplies the machine id for this apiBase.
          'X-Machine-Id': getMachineId(mfa.apiBase),
        },
        credentials: 'include',
        body: JSON.stringify(requestBody),
        // The renderer disables the challenge's Cancel while this proof is in
        // flight, so it must settle. The bound lives HERE, where the
        // credential is stored: a renderer-side timeout cannot stop main from
        // storing a late credential that no session admits (#3423). It covers
        // the body read too; a cut body parses to null and stores nothing.
        signal,
      });
    } catch {
      return { kind: 'error', status: 0, code: 'sso_mfa_verify_failed' };
    }

    const cookieBoundSessionId = captureSessionId(response);
    const body = await responseJson(response, signal);
    if (await revokeIfSuperseded(mfa.owner, fetchFn, mfa.apiBase, response, body)) {
      discardPendingMFA(id, mfa);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }
    if (!response.ok) {
      await revokeCookieBoundSession(fetchFn, mfa.apiBase, cookieBoundSessionId);
      const safeBody = sanitizeCompletionErrorBody(body);
      return {
        kind: 'error',
        status: response.status,
        code: safeBody?.error_code ?? 'sso_mfa_verify_failed',
        ...(safeBody ? { body: safeBody } : {}),
      };
    }

    const tokens = parseCompletionTokens(body);
    if (!tokens) {
      await revokeCookieBoundSession(fetchFn, mfa.apiBase, cookieBoundSessionId);
      discardPendingMFA(id, mfa);
      if (isOwnerCurrent(mfa.owner)) custody.clearTokensIfOwner(mfa.credentialOwner);
      return { kind: 'error', status: 502, code: 'sso_session_rejected' };
    }

    const storedOwner = custody.storeRefreshTokenIfOwner(
      {
        refreshToken: tokens.refreshToken,
        rememberMe: tokens.rememberMe,
        apiBase: mfa.apiBase,
        accessToken: tokens.accessToken,
        ...serverUserIdClaim(tokens.accessToken),
      },
      mfa.credentialOwner
    );
    if (storedOwner === null) {
      await revokeCookieBoundSession(fetchFn, mfa.apiBase, cookieBoundSessionId);
      await revokeExplicitSession(mfa.apiBase, tokens);
      discardPendingMFA(id, mfa);
      return { kind: 'error', status: 409, code: 'sso_cancelled' };
    }

    discardPendingMFA(id, mfa);
    return {
      kind: 'tokens',
      accessToken: tokens.accessToken,
      sessionId: tokens.sessionId,
      credentialOwner: storedOwner,
    };
  };

  /**
   * The shared Apple/Google sign-in: cross-check, reserve in the sender's custody,
   * bind the fence, run the provider flow, then finish under the fence. Everything up
   * to `run` is synchronous with the admission.
   */
  const signIn = async (
    sender: ConnectionSender,
    requestedApiBase: unknown,
    provider: 'apple' | 'google',
    run: (
      apiBase: string,
      fetchFn: SessionFetch,
      onSession: (id: string | null) => void
    ) => Promise<MainSSOSignInResult>
  ): Promise<SSOSignInResult> => {
    const channel = provider === 'apple' ? 'sso:appleSignIn' : 'sso:googleSignIn';
    const checked = senderApiBase(sender, requestedApiBase);
    if (!checked.ok) {
      // Fixed vocabulary; the supplied value is never echoed.
      throw new Error(
        `${channel} rejected: unapproved API origin${checked.wrongOwner ? ' (wrong-owner)' : ''}`
      );
    }
    const { apiBase } = checked;
    const id = sender.ref.connectionId;
    // The provider module is single-flight process-wide, so `run` below cancels whatever
    // flow is in flight. Refuse, never supersede, while ANOTHER connection owns this
    // provider's flow, before any custody effect; a connection may restart its own.
    const inFlight = flowOwner[provider];
    if (inFlight !== null && inFlight !== id) {
      throw new Error(`${channel} rejected: another connection's sign-in is in flight`);
    }
    const { custody } = sender;
    const credentialOwner = custody.reserveCredentialOwner();
    const ctx: SignInContext = {
      id,
      owner: ownerNow(sender),
      signIn: (signInGeneration.get(id) ?? 0) + 1,
      custody,
      fetch: sessionFetchFor(sender.service),
      apiBase,
      provider,
      credentialOwner,
    };
    signInGeneration.set(id, ctx.signIn);
    pendingCompletion.delete(id);
    pendingMFA.delete(id);
    flowOwner[provider] = id;
    let cookieBoundSessionId: string | null = null;
    let result: MainSSOSignInResult;
    try {
      result = await run(apiBase, ctx.fetch, (sessionId) => {
        cookieBoundSessionId = sessionId;
      });
    } finally {
      if (flowOwner[provider] === id && signInGeneration.get(id) === ctx.signIn) {
        flowOwner[provider] = null;
      }
    }
    return finishSignIn(result, ctx, cookieBoundSessionId);
  };

  /** Only the connection whose flow is in flight may cancel it (nothing in flight: a no-op). */
  const cancelFlow = (sender: ConnectionSender, provider: 'apple' | 'google'): void => {
    const owner = flowOwner[provider];
    if (owner !== null && owner !== sender.ref.connectionId) return;
    if (provider === 'apple') cancelActiveAppleFlow();
    else cancelActiveGoogleFlow();
  };

  registerIpc(
    'sso:startLoopback',
    'connection-bound',
    async (sender) => {
      const owner = ownerNow(sender);
      const handle = await startLoopback();
      // Auto-cleanup if the promise settles outside an awaitCallback call —
      // e.g. the loopback timed out before the renderer wired up the await,
      // or a stale entry from a flow the renderer abandoned without sending
      // sso:cancelLoopback. Without this the active map would leak forever.
      handle.promise
        .catch(() => {})
        .finally(() => {
          if (active.get(handle.port)?.handle === handle) active.delete(handle.port);
        });
      if (!isOwnerCurrent(owner)) {
        handle.close();
        throw new Error('sso:startLoopback rejected: connection moved on');
      }
      active.set(handle.port, { handle, owner });
      return { port: handle.port, redirectURI: handle.redirectURI };
    },
    { refusal: rejectUntrusted('sso:startLoopback') }
  );

  registerIpc(
    'sso:awaitCallback',
    'connection-bound',
    async (_sender, event, port: number) => {
      const entry = active.get(port);
      // Another connection's port answers exactly like an unknown one.
      if (!entry || requireOwner(event, entry.owner) === null) {
        throw new Error('sso:awaitCallback: unknown port');
      }
      try {
        return await entry.handle.promise;
      } finally {
        if (active.get(port) === entry) active.delete(port);
      }
    },
    { refusal: rejectUntrusted('sso:awaitCallback') }
  );

  registerIpc(
    'sso:cancelLoopback',
    'connection-bound',
    (_sender, event, port: number): void => {
      const entry = active.get(port);
      if (!entry || requireOwner(event, entry.owner) === null) return;
      active.delete(port);
      entry.handle.close();
    },
    { method: 'on', refusal: ignoreRefused }
  );

  registerIpc(
    'sso:completeRegistration',
    'connection-bound',
    async (
      sender,
      _event,
      requestedApiBase: unknown,
      payload: unknown
    ): Promise<SSOCompletionResult> => {
      const checked = senderApiBase(sender, requestedApiBase);
      if (!checked.ok || !isCompleteRegistrationPayload(payload)) {
        if (!checked.ok && checked.wrongOwner) {
          console.warn('[sso] sso:completeRegistration refused (wrong-owner)');
        }
        return { kind: 'error', status: 400, code: 'sso_invalid_request' };
      }
      const completion = pendingCompletion.get(sender.ref.connectionId);
      if (
        !completion ||
        !isOwnerCurrent(completion.owner) ||
        completion.apiBase !== checked.apiBase ||
        completion.provider !== payload.provider ||
        completion.branch !== 'new_user' ||
        completion.ssoToken !== payload.ssoToken
      ) {
        return { kind: 'error', status: 409, code: 'sso_cancelled' };
      }
      return completeSSO(sender, completion, 'complete-registration', {
        sso_token: payload.ssoToken,
        username: payload.username,
        password: payload.passphrase,
        wrapped_private_key: payload.wrappedPrivateKey,
        key_derivation_salt: payload.keyDerivationSalt,
        public_key: payload.publicKey,
      });
    },
    { refusal: rejectUntrusted('sso:completeRegistration') }
  );

  registerIpc(
    'sso:completeLink',
    'connection-bound',
    async (
      sender,
      _event,
      requestedApiBase: unknown,
      payload: unknown
    ): Promise<SSOCompletionResult> => {
      const checked = senderApiBase(sender, requestedApiBase);
      if (!checked.ok || !isCompleteLinkPayload(payload)) {
        if (!checked.ok && checked.wrongOwner) {
          console.warn('[sso] sso:completeLink refused (wrong-owner)');
        }
        return { kind: 'error', status: 400, code: 'sso_invalid_request' };
      }
      const completion = pendingCompletion.get(sender.ref.connectionId);
      if (
        !completion ||
        !isOwnerCurrent(completion.owner) ||
        completion.apiBase !== checked.apiBase ||
        completion.provider !== payload.provider ||
        completion.branch !== 'account_link' ||
        completion.ssoToken !== payload.ssoToken
      ) {
        return { kind: 'error', status: 409, code: 'sso_cancelled' };
      }
      return completeSSO(sender, completion, 'complete-link', {
        sso_token: payload.ssoToken,
        password: payload.password,
      });
    },
    { refusal: rejectUntrusted('sso:completeLink') }
  );

  registerIpc(
    'sso:completeMFA',
    'connection-bound',
    async (
      sender,
      _event,
      requestedApiBase: unknown,
      payload: unknown
    ): Promise<SSOCompletionResult> => {
      const checked = senderApiBase(sender, requestedApiBase);
      if (!checked.ok || !isCompleteMFAPayload(payload)) {
        if (!checked.ok && checked.wrongOwner) {
          console.warn('[sso] sso:completeMFA refused (wrong-owner)');
        }
        return { kind: 'error', status: 400, code: 'sso_invalid_request' };
      }
      const mfa = pendingMFA.get(sender.ref.connectionId);
      if (
        !mfa ||
        !isOwnerCurrent(mfa.owner) ||
        mfa.apiBase !== checked.apiBase ||
        mfa.provider !== payload.provider ||
        mfa.credentialOwner !== payload.credentialOwner ||
        mfa.mfaChallengeToken !== payload.mfaChallengeToken
      ) {
        return { kind: 'error', status: 409, code: 'sso_cancelled' };
      }
      const requestBody: Record<string, unknown> = {
        mfa_challenge_token: payload.mfaChallengeToken,
        method: payload.method,
      };
      if (payload.code !== undefined) requestBody.code = payload.code;
      if (payload.assertion !== undefined) requestBody.assertion = payload.assertion;
      return completeMFA(sender, mfa, requestBody);
    },
    { refusal: rejectUntrusted('sso:completeMFA') }
  );

  // #2394: release an ORPHANED SSO reservation so a later password registration
  // can stage its E2EE keys. Zero-argument by design — main resolves the target
  // entirely from the sender's binding, so the renderer carries no authority here.
  registerIpc(
    'sso:abandonReservation',
    'connection-bound',
    (sender): boolean => {
      // Admission runs before this body and reads event.senderFrame in the same tick,
      // and this handler has no `await`. This channel fires while the renderer is
      // transitioning between auth screens — the riskiest window. A refused call
      // mutates nothing at all.
      //
      // Deliberate deviation: sibling sso:* handlers REJECT on a refused sender.
      // This one returns false because it is invoked from Register.handleSubmit,
      // where a throw would turn a fail-closed *release* into a fail-closed
      // *registration*. Precedent: the auth:getCapabilities handler in main.ts.
      // Do NOT copy this shape into a channel where a throw is required.
      const released = sender.custody.releaseCredentialReservation();
      // Discard the pendings ONLY when the release actually happened. A
      // successful release bumps the credential generation, which already
      // terminally fails every continuation bound to it, so clearing the
      // pendings is correct cleanup of state that is provably dead.
      //
      // A `false` release changed nothing, and must therefore destroy nothing.
      // This handler is invoked from stale UI (a Register submit, an MFA-modal
      // cancel, a link-confirm cancel) that can sit in the IPC queue, so an
      // unconditional discard could wipe a NEWER sign-in's live pendingMFA /
      // pendingCompletion while doing no useful work — e.g. once
      // restoreRefreshToken has nulled the reservation but a challenge is still
      // in flight. Every other pending-clearing site in this file is likewise
      // identity-checked (discardPendingCompletion / discardPendingMFA) or fires
      // from a supersede-everything context. (#2655 review.)
      if (released) {
        pendingCompletion.delete(sender.ref.connectionId);
        pendingMFA.delete(sender.ref.connectionId);
      }
      return released;
    },
    {
      refusal: () => {
        console.warn('[sso:abandonReservation] rejected — sender frame validation failed');
        return false;
      },
    }
  );

  registerIpc(
    'sso:appleSignIn',
    // Foreground primary only (RT2): a hidden view must not open a consent tab.
    'app-global-mutate',
    (sender, _event, requestedApiBase: unknown) =>
      signIn(sender, requestedApiBase, 'apple', (apiBase, fetchFn, onSession) =>
        runAppleSignIn({
          apiBase,
          // The service's own session fetch + credentials:'include' (NOT Node's
          // fetch): the /session response sets the refresh-token cookie, which must
          // land in this connection's jar — the SAME jar its renderer's /auth/refresh
          // reads (for saas, the default session, as before #86). Node's fetch would
          // silently drop it and strand the session at access-token expiry (15 min).
          // Plan deviation D2.
          controlPlaneFetch: controlPlaneFetch(
            fetchFn,
            `${apiBase}/api/v1/auth/sso/apple/session`,
            onSession
          ),
          // Apple endpoints are cookie-less by design — plain global fetch.
          appleFetch: fetch,
          openExternal: async (url: string) => {
            // Defense-in-depth: the authorize URL comes from our own server, but
            // an https-only gate keeps a tampered response from launching
            // arbitrary schemes (passive-nav posture, internal-reference
            // §External-link scheme policy).
            if (!url.startsWith('https://')) {
              throw new Error('sso_initiate_failed');
            }
            await shell.openExternal(url);
          },
          startLoopback,
          signClientSecret,
          appleTokenCall,
          verifyIdToken: verifyAppleIDToken,
        })
      ),
    { refusal: rejectUntrusted('sso:appleSignIn') }
  );

  registerIpc('sso:appleCancel', 'connection-bound', (sender) => cancelFlow(sender, 'apple'), {
    method: 'on',
    refusal: ignoreRefused,
  });

  registerIpc(
    'sso:googleSignIn',
    // Foreground primary only (RT2): a hidden view must not open a consent tab.
    'app-global-mutate',
    (sender, _event, requestedApiBase: unknown) =>
      signIn(sender, requestedApiBase, 'google', (apiBase, fetchFn, onSession) =>
        runGoogleSignIn({
          apiBase,
          // Embedded non-confidential client_secret (Google native-app guidance);
          // client_id is NOT supplied here — googleFlow parses it from the
          // server-built authorize URL (sourced from the control-plane's
          // GOOGLE_CLIENT_ID config).
          clientSecret: googleClientSecret(),
          // The service's session fetch + credentials:'include' so /session's
          // refresh-token cookie lands in this connection's jar (parity with Apple).
          controlPlaneFetch: controlPlaneFetch(
            fetchFn,
            `${apiBase}/api/v1/auth/sso/google/session`,
            onSession
          ),
          // Google endpoints are cookie-less by design — plain global fetch.
          googleFetch: fetch,
          openExternal: async (url: string) => {
            if (!url.startsWith('https://')) {
              throw new Error('sso_initiate_failed');
            }
            await shell.openExternal(url);
          },
          startLoopback,
          googleTokenCall,
          verifyIdToken: verifyGoogleIDToken,
        })
      ),
    { refusal: rejectUntrusted('sso:googleSignIn') }
  );

  registerIpc('sso:googleCancel', 'connection-bound', (sender) => cancelFlow(sender, 'google'), {
    method: 'on',
    refusal: ignoreRefused,
  });
}
