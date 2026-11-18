/**
 * Redact a caught error for safe console logging.
 *
 * Background: the renderer's console.error/warn sites historically passed
 * raw `err` objects, which propagated Error.cause (ES2022) and — for
 * `new WebSocket(badUrl)` SyntaxError specifically — leaked the full URL
 * (including the single-use `?ticket=<hex>` auth query param) into log
 * sinks. These helpers extract a fixed, non-secret-bearing string from
 * an unknown caught value.
 *
 * Use `errorMessage` for typical catch blocks where the underlying
 * `err.message` is safe diagnostic content. Use `errorName` for
 * security-sensitive sites where the message itself could include
 * sensitive data (URLs with auth bearers, decrypted payloads).
 *
 * The ESLint rule `no-restricted-syntax` (see eslint.config.mjs renderer
 * block + internal-reference "Console error logging") flags
 * raw-identifier console.error/warn arguments. These helpers return
 * primitive strings, so call sites become `console.error('msg:',
 * errorMessage(err))` — the last argument is a CallExpression, not an
 * Identifier, so no eslint-disable directive is required.
 */

/**
 * Control characters (Unicode Cc), line/paragraph separators (U+2028/9) and every
 * Unicode bidi control (marks, embeddings, overrides, isolates) become spaces, so text
 * carrying server- or peer-supplied content cannot forge or visually reorder log lines.
 */
const LINE_FORGING = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;

export function errorMessage(err: unknown): string {
  return err instanceof Error ? String(err.message).replaceAll(LINE_FORGING, ' ') : 'unknown_error';
}

export function errorName(err: unknown): string {
  return err instanceof Error ? String(err.name).replaceAll(LINE_FORGING, ' ') : 'unknown';
}
