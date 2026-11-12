// Server user id admission rule (#86 spec §3.11, Self-Hosted#113).
//
// Pure and import-free: main applies it at both entry points that accept a server
// user id (auth:storeRefreshToken in main.ts, the SSO publish in ipc/sso.ts) and in
// preferenceOwnership; the renderer applies the same rule before it sends one, so an
// id main would refuse is dropped rather than failing the whole payload.

/** A server user id is a UUID today; the cap bounds the hash input from the renderer. */
export const MAX_SERVER_USER_ID_LENGTH = 256;

// C0 controls (NUL included), DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Non-empty, bounded, no control characters. */
export function isServerUserId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SERVER_USER_ID_LENGTH &&
    !CONTROL_CHARACTER.test(value)
  );
}
