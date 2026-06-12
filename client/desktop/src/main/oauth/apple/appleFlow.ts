/**
 * Apple sign-in orchestrator (#974) — spec flow steps 2–7, main-process only.
 *
 *   pkce → loopback (flow-deadline timeout) → GET /initiate (challenge out,
 *   {auth_url, state, nonce} back) → system browser → loopback callback →
 *   constant-time state check → POST /sign-client-secret → POST Apple
 *   /auth/token → local jose verification (nonce binding) → POST /session →
 *   discriminated AppleSignInResult.
 *
 * Lifecycle: ONE AbortController + the loopback handle per flow, torn down by
 * (a) sso:appleCancel, (b) main-window 'closed', (c) the 5-minute overall
 * deadline (spec R2 — also passed to startLoopback, superseding its 60s
 * Google default), or (d) a superseding invocation. Single-flight by design.
 *
 * SECURITY:
 *   - The verifier, broker JWT, Apple token response, and pre-verification
 *     id_token exist only inside runAppleSignIn's scope — never logged,
 *     never IPC'd (spec §Secrets lifetime).
 *   - This function NEVER rejects: every failure folds to
 *     { kind: 'error', code } so no raw Error (with a potential cause chain)
 *     crosses the IPC boundary (internal-reference).
 *   - client_id and redirect_uri for the token call are parsed from the
 *     SERVER-built authorize URL (plan deviation D5): the /auth/token POST
 *     replays exactly what Apple saw at /authorize — RFC 6749 §4.1.3 —
 *     including whatever bridge redirect #973 lands.
 */
import { timingSafeEqual } from 'node:crypto';

import type { AppleSignInErrorCode, AppleSignInResult } from '../../../shared/appleSso';
import type { startLoopback as startLoopbackFn, LoopbackHandle } from '../../ssoLoopback';

import type { appleTokenCall as appleTokenCallFn } from './appleTokenCall';
import { AppleFlowError } from './errors';
import type { verifyAppleIDToken as verifyAppleIDTokenFn } from './idTokenVerifier';
import { codeChallengeS256, generateCodeVerifier } from './pkce';
import type { signClientSecret as signClientSecretFn } from './signClientSecret';

/** Overall flow deadline (spec R2). */
export const APPLE_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface AppleFlowDeps {
  apiBase: string;
  /**
   * fetch for control-plane calls. MUST be Electron net.fetch bound with
   * credentials:'include' so /session's Set-Cookie (the refresh token) lands
   * in the default-session jar the renderer reads at /auth/refresh (plan
   * deviation D2). Node's global fetch would silently drop the cookie.
   */
  controlPlaneFetch: typeof fetch;
  /** fetch for Apple endpoints (cookie-less by design). */
  appleFetch: typeof fetch;
  openExternal: (url: string) => Promise<void>;
  startLoopback: typeof startLoopbackFn;
  signClientSecret: typeof signClientSecretFn;
  appleTokenCall: typeof appleTokenCallFn;
  verifyIdToken: typeof verifyAppleIDTokenFn;
  /** Test seam — production callers omit (defaults to APPLE_FLOW_TIMEOUT_MS). */
  flowTimeoutMs?: number;
}

interface ActiveFlow {
  abort: AbortController;
  loopback: LoopbackHandle | null;
}

let activeFlow: ActiveFlow | null = null;

/**
 * Tears down the in-flight Apple flow: renderer cancel (sso:appleCancel),
 * window close, deadline, or supersession. Idempotent — safe to call with
 * no flow active.
 */
export function cancelActiveAppleFlow(): void {
  if (!activeFlow) return;
  const flow = activeFlow;
  activeFlow = null;
  flow.loopback?.close(); // rejects the loopback promise with oauth_cancelled
  flow.abort.abort(); // aborts any in-flight fetch
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // Length is not secret here (both values are CSPRNG-shaped); the compare
  // over equal-length buffers is what must be constant-time.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

interface InitiateResponse {
  auth_url: string;
  state: string;
  nonce: string;
}

async function initiate(
  deps: AppleFlowDeps,
  redirectURI: string,
  codeChallenge: string,
  signal: AbortSignal
): Promise<InitiateResponse> {
  let res: Response;
  try {
    const qs = new URLSearchParams({ redirect_uri: redirectURI, code_challenge: codeChallenge });
    res = await deps.controlPlaneFetch(`${deps.apiBase}/api/v1/auth/sso/apple?${qs.toString()}`, {
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new AppleFlowError('sso_cancelled', 'initiate');
    throw new AppleFlowError('sso_initiate_failed', 'initiate');
  }
  if (!res.ok) throw new AppleFlowError('sso_initiate_failed', 'initiate');
  const body = (await res.json().catch(() => null)) as Partial<InitiateResponse> | null;
  if (
    !body ||
    typeof body.auth_url !== 'string' ||
    typeof body.state !== 'string' ||
    typeof body.nonce !== 'string'
  ) {
    throw new AppleFlowError('sso_initiate_failed', 'initiate');
  }
  return body as InitiateResponse;
}

/** Parses client_id + redirect_uri out of the server-built authorize URL (D5). */
function parseAuthUrl(authUrl: string): { clientId: string; redirectUri: string } {
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    throw new AppleFlowError('sso_initiate_failed', 'initiate');
  }
  if (parsed.protocol !== 'https:') throw new AppleFlowError('sso_initiate_failed', 'initiate');
  const clientId = parsed.searchParams.get('client_id') ?? '';
  const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
  if (!clientId || !redirectUri) throw new AppleFlowError('sso_initiate_failed', 'initiate');
  return { clientId, redirectUri };
}

async function postSession(
  deps: AppleFlowDeps,
  args: { idToken: string; state: string; appleUserData?: string },
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const payload: Record<string, string> = { id_token: args.idToken, state: args.state };
  if (args.appleUserData !== undefined) payload.apple_user_data = args.appleUserData;
  let res: Response;
  try {
    res = await deps.controlPlaneFetch(`${deps.apiBase}/api/v1/auth/sso/apple/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new AppleFlowError('sso_cancelled', 'session');
    throw new AppleFlowError('sso_session_rejected', 'session');
  }
  if (!res.ok) throw new AppleFlowError('sso_session_rejected', 'session');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) throw new AppleFlowError('sso_session_rejected', 'session');
  return body;
}

/**
 * Maps the /session response (Callback-shape parity) into the IPC-safe
 * discriminated union. Exported for direct unit coverage.
 */
export function mapSessionResponse(body: Record<string, unknown>): AppleSignInResult {
  if (typeof body.access_token === 'string' && body.access_token.length > 0) {
    return { kind: 'tokens', accessToken: body.access_token };
  }
  if (typeof body.mfa_challenge_token === 'string' && body.mfa_challenge_token.length > 0) {
    return {
      kind: 'mfa_challenge',
      mfaChallengeToken: body.mfa_challenge_token,
      methods: Array.isArray(body.methods) ? (body.methods as string[]) : [],
      recoveryOnlyMethods: Array.isArray(body.recovery_only_methods)
        ? (body.recovery_only_methods as string[])
        : undefined,
      webauthnOptions: body.webauthn_options,
    };
  }
  if (
    body.sso_registration_required === true &&
    typeof body.sso_token === 'string' &&
    typeof body.email === 'string'
  ) {
    return {
      kind: 'sso_token',
      branch: 'new_user',
      ssoToken: body.sso_token,
      email: body.email,
      name: typeof body.name === 'string' && body.name.length > 0 ? body.name : undefined,
    };
  }
  if (
    body.account_link_available === true &&
    typeof body.sso_token === 'string' &&
    typeof body.masked_email === 'string'
  ) {
    return {
      kind: 'sso_token',
      branch: 'account_link',
      ssoToken: body.sso_token,
      maskedEmail: body.masked_email,
    };
  }
  return { kind: 'error', code: 'sso_session_rejected' };
}

/** Retries fn exactly once when it fails with the given retryable code. */
async function retryOnce<T>(fn: () => Promise<T>, retryableCode: AppleSignInErrorCode): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppleFlowError && err.code === retryableCode) {
      return await fn();
    }
    throw err;
  }
}

function logFlowFailure(stage: string, code: string): void {
  // Stage + taxonomy code only — never raw errors (Error.cause may carry
  // token material; internal-reference).
  console.error(`[appleFlow] sign-in failed at ${stage}: ${code}`);
}

function toErrorCode(err: unknown): AppleSignInErrorCode {
  if (err instanceof AppleFlowError) {
    logFlowFailure(err.stage, err.code);
    return err.code;
  }
  const message = err instanceof Error ? err.message : 'unknown';
  if (message === 'oauth_cancelled' || message === 'oauth_timeout') {
    // Loopback teardown paths (renderer cancel, deadline, window close).
    logFlowFailure('loopback', 'sso_cancelled');
    return 'sso_cancelled';
  }
  if (message.startsWith('oauth_provider_error:')) {
    logFlowFailure('loopback', message);
    return message as AppleSignInErrorCode;
  }
  // Unknown failure — fold into the generic flow-setup code. Only the
  // stable message string is logged, never the error object.
  logFlowFailure('unknown', 'sso_initiate_failed');
  return 'sso_initiate_failed';
}

export async function runAppleSignIn(deps: AppleFlowDeps): Promise<AppleSignInResult> {
  // Single-flight: a new invocation supersedes any in-flight flow — the
  // user double-clicked the Apple button after a stuck browser tab.
  cancelActiveAppleFlow();

  const abort = new AbortController();
  const flow: ActiveFlow = { abort, loopback: null };
  activeFlow = flow;

  const timeoutMs = deps.flowTimeoutMs ?? APPLE_FLOW_TIMEOUT_MS;
  const deadline = setTimeout(() => {
    if (activeFlow === flow) cancelActiveAppleFlow();
  }, timeoutMs);

  try {
    const verifier = generateCodeVerifier();
    const challenge = codeChallengeS256(verifier);

    // Loopback timeout = the flow deadline (spec R2): Apple's consent +
    // form_post round-trip regularly exceeds the 60s Google default.
    const loopback = await deps.startLoopback({ timeoutMs });
    flow.loopback = loopback;
    if (abort.signal.aborted) {
      // Cancelled while the loopback was binding — activeFlow is already
      // null, so the finally block won't close it for us. Close here or the
      // listener leaks until its own timeout.
      loopback.close();
      throw new AppleFlowError('sso_cancelled', 'loopback');
    }

    const init = await initiate(deps, loopback.redirectURI, challenge, abort.signal);
    const { clientId, redirectUri } = parseAuthUrl(init.auth_url);

    await deps.openExternal(init.auth_url);

    // Rejects with oauth_cancelled / oauth_timeout / oauth_provider_error:<x>.
    const cb = await loopback.promise;

    if (!constantTimeEquals(cb.state, init.state)) {
      // The provider/bridge returned a state that does not match this flow —
      // folded into the provider-error family (plan deviation D3).
      throw new AppleFlowError('oauth_provider_error:state_mismatch', 'state');
    }

    const clientSecret = await deps.signClientSecret({
      apiBase: deps.apiBase,
      state: init.state,
      fetchFn: deps.controlPlaneFetch,
      signal: abort.signal,
    });

    const { idToken } = await retryOnce(
      () =>
        deps.appleTokenCall({
          code: cb.code,
          codeVerifier: verifier,
          clientId,
          clientSecret,
          redirectUri,
          fetchFn: deps.appleFetch,
          signal: abort.signal,
        }),
      'apple_unavailable'
    );

    // Local gate only (spec step 5): a tampered token never leaves the
    // device. The server re-derives identity itself at /session.
    await retryOnce(
      () =>
        deps.verifyIdToken({ idToken, clientId, expectedNonce: init.nonce, signal: abort.signal }),
      'apple_verification_unavailable'
    );

    const sessionBody = await postSession(
      deps,
      { idToken, state: init.state, appleUserData: cb.appleUserData },
      abort.signal
    );
    return mapSessionResponse(sessionBody);
  } catch (err) {
    return { kind: 'error', code: toErrorCode(err) };
  } finally {
    clearTimeout(deadline);
    if (activeFlow === flow) {
      activeFlow = null;
      flow.loopback?.close();
    }
  }
}
