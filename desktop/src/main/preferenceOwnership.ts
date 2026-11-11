// Preference ownership handles (#86 spec §3.11, Self-Hosted#113).
//
// A connection's preferences belong to one account on one service. The handle that
// names them is a `PreferenceScope` = { serviceId, accountKey }, where
//
//   accountKey = hex16(sha256(compositeKey(serviceId, serverUserId)))
//
// Invariants:
//   - the same serverUserId on two services yields two keys: compositeKey is injective
//     over (ServiceId, localId), so a colliding id on saas, A and B never shares a key.
//   - serverUserId is renderer-supplied. It is only ever input to the hash: never
//     persisted, logged, or returned. `isServerUserId` is the one admission rule, used
//     at the IPC boundary (main.ts) and again here.
//   - the scope is null until the service's custody holds an account, and null again
//     once the credential ends (the custody clears the key).
//   - a renderer receives only the scope. `prefsDirFor` stays in main; it never sees an
//     origin or a user id in clear, and its path stays beneath profiles/<dirKey>/.

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  compositeKey,
  isAccountKey,
  SAAS_SERVICE_ID,
  type AccountKey,
  type PreferenceScope,
  type ServiceId,
} from '../shared/connectionIdentity';
import type { ConnectionRecord, ServiceRecord } from './connectionRegistry';

/** A server user id is a UUID today; the cap bounds the hash input from the renderer. */
export const MAX_SERVER_USER_ID_LENGTH = 256;

// C0 controls (NUL included), DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

const HEX = /^[0-9a-f]+$/;

/** Non-empty, bounded, no control characters. */
export function isServerUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SERVER_USER_ID_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}

/** hex16(sha256(compositeKey(serviceId, serverUserId))). Throws TypeError on a refused id. */
export function accountKeyFor(serviceId: ServiceId, serverUserId: string): AccountKey {
  if (!isServerUserId(serverUserId)) throw new TypeError('accountKeyFor: invalid serverUserId');
  // compositeKey throws TypeError for an invalid ServiceId.
  return createHash('sha256')
    .update(compositeKey(serviceId, serverUserId))
    .digest('hex')
    .slice(0, 16) as AccountKey;
}

/**
 * The connection's scope, or null while its service's custody holds no account. A
 * record that names another service than `service` answers null.
 */
export function preferenceScopeFor(
  record: ConnectionRecord,
  service: ServiceRecord
): PreferenceScope | null {
  if (record.serviceId !== service.serviceId) return null;
  const accountKey = service.custody.getAccountKey();
  if (!isAccountKey(accountKey)) return null;
  return Object.freeze({ serviceId: service.serviceId, accountKey });
}

/**
 * `dirKey` is '' for saas in packaged builds and the origin hash otherwise (an unpackaged
 * build's pinned dev base is saas with an origin-keyed directory, #86 Task 7B). A
 * self-hosted service id embeds the first 16 hex characters of its dirKey.
 */
function dirKeyBelongsTo(dirKey: string, serviceId: ServiceId): boolean {
  if (dirKey !== '' && !HEX.test(dirKey)) return false;
  if (serviceId === SAAS_SERVICE_ID) return true;
  return dirKey !== '' && serviceId === `selfhost-${dirKey.slice(0, 16)}`;
}

/**
 * `<root>/profiles/<dirKey>/prefs/<accountKey>`. Main-only: no renderer ever receives
 * it. Throws TypeError for a malformed accountKey or a dirKey that is not the scope's
 * service, so a scope cannot name a directory under another service's profile.
 */
export function prefsDirFor(userDataRoot: string, dirKey: string, scope: PreferenceScope): string {
  if (!isAccountKey(scope.accountKey) || !dirKeyBelongsTo(dirKey, scope.serviceId)) {
    throw new TypeError('prefsDirFor: scope does not name a directory of this service');
  }
  return path.join(userDataRoot, 'profiles', dirKey, 'prefs', scope.accountKey);
}
