// Connection identity contract (spec 2026-11-09-86-connection-context-isolation §3.1).
//
// Exported for #87–#93 and Self-Hosted#113. Shared by main (mints and validates),
// the preload (re-validates `connection:whoAmI`) and the renderer (boot contract).
// This module MUST stay import-free: the preload bundle inlines it, and
// `tests/integration/preload-sandbox-contract.test.ts` pins that the bundle
// requires nothing but `electron`.
//
// Brands are compile-time only. Every value that crosses a process boundary is
// re-checked by a guard below before it is treated as branded; a cast is legal
// only where the value is minted (main) or has just passed its guard.
//
// COMPOSITE-KEY INVARIANT. `compositeKey(s, l)` is injective over (ServiceId,
// localId): a ServiceId never contains NUL (its guard's alphabet excludes it) and
// compositeKey refuses a localId containing NUL, so the FIRST NUL in a key is the
// separator and splits it back into exactly one pair. That is what keeps an
// identical service-local id (a `serverUserId`, a username) from colliding across
// `saas`, self-hosted A and self-hosted B. It breaks if either check is dropped:
// `compositeKey(a, 'x\0y')` would equal a key whose ServiceId ended in `\0x`.

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** `profileIdForApiBase()`: `'saas'` | `selfhost-${hex16}`. */
export type ServiceId = Brand<string, 'ServiceId'>;
export type ServiceKind = 'saas' | 'selfhost';
/** hex16(sha256(serviceId + '\0' + serverUserId)). */
export type AccountKey = Brand<string, 'AccountKey'>;
/** 128-bit random base64url, minted in main, runtime-only, never persisted. */
export type ConnectionId = Brand<string, 'ConnectionId'>;
/** Safe integer >= 1, strictly monotonic per ConnectionId. */
export type Generation = Brand<number, 'Generation'>;

export interface AccountId {
  readonly serviceId: ServiceId;
  readonly accountKey: AccountKey;
}

/** #87's lease key. */
export interface ConnectionRef {
  readonly connectionId: ConnectionId;
  readonly generation: Generation;
}

export interface ConnectionIdentity extends ConnectionRef {
  readonly serviceId: ServiceId;
  readonly kind: ServiceKind;
  readonly apiOrigin: string;
}

export type GenerationReason =
  'document' | 'renderer-gone' | 'credential-start' | 'credential-end' | 'disposed';

/** Self-Hosted#113 preference-ownership handle. */
export interface PreferenceScope {
  readonly serviceId: ServiceId;
  readonly accountKey: AccountKey;
}

export const SAAS_SERVICE_ID = 'saas' as ServiceId;

/** Random bytes in a ConnectionId; base64url without padding encodes 16 bytes in 22 chars. */
export const CONNECTION_ID_BYTES = 16;

const SELFHOST_SERVICE_ID = /^selfhost-[0-9a-f]{16}$/;
const CONNECTION_ID = /^[A-Za-z0-9_-]{22}$/;
const ACCOUNT_KEY = /^[0-9a-f]{16}$/;

export function isServiceId(v: unknown): v is ServiceId {
  return v === SAAS_SERVICE_ID || (typeof v === 'string' && SELFHOST_SERVICE_ID.test(v));
}

export function isConnectionId(v: unknown): v is ConnectionId {
  return typeof v === 'string' && CONNECTION_ID.test(v);
}

export function isGeneration(v: unknown): v is Generation {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

export function isAccountKey(v: unknown): v is AccountKey {
  return typeof v === 'string' && ACCOUNT_KEY.test(v);
}

export function serviceKindOf(id: ServiceId): ServiceKind {
  return id === SAAS_SERVICE_ID ? 'saas' : 'selfhost';
}

/**
 * The only way to key a store, queue, notification or dispatch entry by a
 * service-local id. Throws rather than return a key that could alias another
 * pair (see the composite-key invariant at the top of this file).
 */
export function compositeKey(serviceId: ServiceId, localId: string): string {
  if (!isServiceId(serviceId)) throw new TypeError('compositeKey: invalid ServiceId');
  if (localId.includes('\0')) throw new TypeError('compositeKey: localId contains NUL');
  return `${serviceId}\0${localId}`;
}

const IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'connectionId',
  'generation',
  'serviceId',
  'kind',
  'apiOrigin',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * True when every own key of `obj` (strings AND symbols, enumerable or not) is
 * in `allowed`, the count matches, and each is a data property — so a value
 * cannot change between the check and the read.
 */
function hasExactDataKeys(obj: object, allowed: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== allowed.size) return false;
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) return false;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc === undefined || !('value' in desc)) return false;
  }
  return true;
}

/**
 * True only for a canonical http(s) origin: exactly what `new URL(x).origin`
 * yields, so no path, query, fragment, credentials, default port, trailing
 * slash or upper-case host. `URL` is a global, not an import.
 */
function isCanonicalHttpOrigin(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === v;
}

/**
 * Exact-key codec for a {@link ConnectionIdentity}. Any extra or missing key,
 * any field failing its guard, a non-canonical `apiOrigin`, or a `kind` that
 * disagrees with `serviceId` yields `null`. Returns a fresh frozen object, never
 * the caller's.
 */
export function parseConnectionIdentity(v: unknown): ConnectionIdentity | null {
  if (!isPlainRecord(v) || !hasExactDataKeys(v, IDENTITY_KEYS)) return null;
  const { connectionId, generation, serviceId, kind, apiOrigin } = v;
  if (!isConnectionId(connectionId) || !isGeneration(generation)) return null;
  if (!isServiceId(serviceId)) return null;
  const expectedKind = serviceKindOf(serviceId);
  if (kind !== expectedKind || !isCanonicalHttpOrigin(apiOrigin)) return null;
  return Object.freeze({ connectionId, generation, serviceId, kind: expectedKind, apiOrigin });
}
