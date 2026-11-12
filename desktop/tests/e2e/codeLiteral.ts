/**
 * A JavaScript literal for `value`, safe to splice into source that `execIn` hands to
 * `webContents.executeJavaScript` (CodeQL js/bad-code-sanitization, PR 206).
 *
 * `executeJavaScript` takes source text and no arguments, and the view's main world has
 * no structured-clone channel from main (the preload's `ipcRenderer` lives in the
 * isolated world), so a value can reach a probe only inside its source. `JSON.stringify`
 * alone is not a code sanitizer: it leaves `<`, `>` and `/` raw, so a `</script>` or
 * `<!--` in the value ends or comments out the code wherever that text is embedded in
 * markup, and it leaves the U+2028 / U+2029 line terminators raw. Each of those is
 * rewritten to its four-digit backslash-u escape. They can only occur inside JSON
 * strings, where that escape means the same character, so the literal still evaluates
 * (and `JSON.parse`s) to `value`.
 *
 * A value with no JSON form (`undefined`, a function, a symbol) throws instead of
 * splicing the text `undefined` into the probe.
 */
const UNSAFE_IN_CODE = /[<>\/\p{Zl}\p{Zp}]/gu;

export function codeLiteral(value: unknown): string {
  const json = JSON.stringify(value) as string | undefined;
  if (json === undefined) throw new TypeError('codeLiteral: value has no JSON form');
  return json.replace(UNSAFE_IN_CODE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}
