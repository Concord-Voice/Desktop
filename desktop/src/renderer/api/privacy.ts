/**
 * Privacy API client — wraps the control-plane /api/v1/privacy/* erasure
 * endpoints.
 *
 * PRIVACY CONTRACT: erasure proofs and email-confirmation secrets are
 * sensitive transient data. This module MUST NOT:
 *   - log them (no console.* calls)
 *   - persist it (no storage, no Zustand)
 *   - leak it into error messages (see PrivacyApiError — status only)
 *
 * The server upholds the same discipline on the receiving side; see
 * services/control-plane/internal/privacy.
 *
 */

import { apiFetchInContext, type ApiRequestContext } from '../services/system/requestContext';
import { classifyStepUpRefusal, type StepUpRefusal } from '../services/system/stepUpRefusal';

export interface AccountErasureRequest {
  password: string;
  mfa_code?: string;
  /** Canonical, lexicographically sorted UUIDs acknowledged by the caller. */
  confirmed_owned_server_ids: string[];
  email_confirmation?: { request_id: string; token: string };
}

export interface ProtectedOwnedServer {
  id: string;
  name: string;
  member_count: number;
}

/** Pending-email accounts may read only the servers they must acknowledge for erasure. */
export async function getProtectedOwnedServers(
  context?: ApiRequestContext
): Promise<ProtectedOwnedServer[]> {
  const response = await apiFetchInContext(
    '/api/v1/privacy/erase-account/owned-servers',
    { method: 'GET' },
    context
  );
  if (!response.ok) throw new Error(`owned-server read failed with status ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('servers' in body)) {
    throw new Error('Invalid owned-server response');
  }
  const servers = body.servers;
  if (
    !Array.isArray(servers) ||
    !servers.every(
      (server): server is ProtectedOwnedServer =>
        typeof server === 'object' &&
        server !== null &&
        typeof server.id === 'string' &&
        typeof server.name === 'string' &&
        Number.isInteger(server.member_count) &&
        server.member_count > 1
    )
  ) {
    throw new Error('Invalid owned-server response');
  }
  return servers;
}

export type AccountErasureResult =
  | { kind: 'erased' }
  | { kind: 'email_confirmation_required'; requestId: string; expiresIn: number };

export type PrivacyApiErrorCode =
  | 'owned_server_confirmation_stale'
  | 'email_confirmation_stale'
  | 'step_up_budget_exhausted'
  | 'step_up_budget_unavailable'
  | 'unknown';

export class PrivacyApiError extends Error {
  public readonly status: number;
  public readonly code: PrivacyApiErrorCode;
  public readonly requiredOwnedServerIds: string[] | undefined;
  public readonly stepUpRefusal: StepUpRefusal;

  constructor(
    status: number,
    code: PrivacyApiErrorCode = 'unknown',
    requiredOwnedServerIds?: string[],
    stepUpRefusal?: StepUpRefusal
  ) {
    const message = `erase-account failed with status ${status}`;
    super(message);
    this.name = 'PrivacyApiError';
    this.status = status;
    this.code = code;
    this.requiredOwnedServerIds = requiredOwnedServerIds;
    this.stepUpRefusal = stepUpRefusal ?? { kind: 'failed' };
  }
}

/**
 * Request full account erasure. The server treats `confirmed_owned_server_ids`
 * as an exact, transactional acknowledgement set; callers must sort it before
 * submission. 202 intentionally contains no email secret.
 */
export async function eraseAccount(
  request: AccountErasureRequest,
  context?: ApiRequestContext
): Promise<AccountErasureResult> {
  const response = await apiFetchInContext(
    '/api/v1/privacy/erase-account',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    context
  );
  if (response.status === 204) return { kind: 'erased' };
  if (response.status === 202) {
    const body: unknown = await response.json().catch(() => null);
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { status?: unknown }).status === 'email_confirmation_required' &&
      typeof (body as { request_id?: unknown }).request_id === 'string' &&
      typeof (body as { expires_in?: unknown }).expires_in === 'number'
    ) {
      return {
        kind: 'email_confirmation_required',
        requestId: (body as { request_id: string }).request_id,
        expiresIn: (body as { expires_in: number }).expires_in,
      };
    }
  }
  const body: unknown = await response.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const errorCode = typeof record.error_code === 'string' ? record.error_code : 'unknown';
  const code: PrivacyApiErrorCode =
    errorCode === 'owned_server_confirmation_stale' ||
    errorCode === 'email_confirmation_stale' ||
    errorCode === 'step_up_budget_exhausted' ||
    errorCode === 'step_up_budget_unavailable'
      ? errorCode
      : 'unknown';
  const requiredOwnedServerIds = Array.isArray(record.required_owned_server_ids)
    ? record.required_owned_server_ids.filter((id): id is string => typeof id === 'string')
    : undefined;
  throw new PrivacyApiError(
    response.status,
    code,
    requiredOwnedServerIds,
    classifyStepUpRefusal(response.status, body)
  );
}
