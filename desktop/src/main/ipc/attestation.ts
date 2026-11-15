/**
 * Attestation IPC bridge — exposes the main-process attestation token cache to
 * the renderer (#677).
 *
 * Channel surface (2):
 *   - `attestation:get-token`   (invoke) — return the cached attestation token
 *                                          (string), or null when none is cached
 *                                          or the cached token has expired. The
 *                                          renderer attaches this to outbound
 *                                          requests as `X-Attestation-Token`.
 *   - `attestation:clear-token` (invoke) — drop the cached token so the next
 *                                          request path re-attests. Called by the
 *                                          renderer after a 403 attestation
 *                                          failure triggers re-verification.
 *
 * The token itself is minted and cached by `attestationService.ts`; this module
 * is a thin, read-only-plus-clear bridge. It never mints — that happens in the
 * main process post-login flow, not in response to renderer requests.
 *
 * Sender-frame validation (the only layer the renderer cannot bypass) is
 * enforced via `isPermittedFrameUrl` — the same helper `sso.ts` and
 * `openExternal.ts` use, keeping the trust boundary consistent across IPC
 * handlers. An untrusted frame causes both invoke handlers to throw, so the
 * renderer sees a rejected promise rather than a token or a silent clear.
 */
import { SAAS_SERVICE_ID } from '../../shared/connectionIdentity';
import { getAttestationToken, clearAttestationToken } from '../attestationService';

import { CHANNEL_CLASSES } from './channelClassification';
import type { ConnectionSender } from './connectionSender';
import { registerIpc } from './registry';

/** The token cache is app-global and minted for the saas control plane only, so a
 *  non-saas connection neither reads it nor clears it (#86 Task 7B, fail closed). */
function isSaasSender(sender: ConnectionSender): boolean {
  return sender.service.serviceId === SAAS_SERVICE_ID && sender.service.kind === 'saas';
}

/**
 * registerAttestationIpc wires the two attestation:* IPC channels used by the
 * renderer to read and clear the main-process attestation token cache.
 *
 * #86 Task 7B: both channels go through `registerIpc` (`connection-bound`); an
 * unbound or untrusted sender throws, as before. A bound non-saas sender reads null
 * and its clear is a no-op.
 */
export function registerAttestationIpc(): void {
  const untrusted = (channel: string) => (): never => {
    throw new Error(`${channel} rejected: untrusted sender frame`);
  };
  registerIpc(
    'attestation:get-token',
    CHANNEL_CLASSES['attestation:get-token'],
    (sender): string | null => (isSaasSender(sender) ? getAttestationToken() : null),
    { refusal: untrusted('attestation:get-token') }
  );

  registerIpc(
    'attestation:clear-token',
    CHANNEL_CLASSES['attestation:clear-token'],
    (sender): void => {
      if (isSaasSender(sender)) clearAttestationToken();
    },
    { refusal: untrusted('attestation:clear-token') }
  );
}
