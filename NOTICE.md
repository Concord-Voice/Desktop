# NOTICE — Third-Party Software Used by Concord Voice

**Generated:** 2026-10-31
**Concord Voice License:** [Concord Voice Source License 1.0 (CVSL 1.0)](./LICENSE) → AGPL-3.0-or-later on 2030-02-15

This NOTICE file lists the third-party open-source software used by Concord
Voice and acknowledges the copyright holders of that software, as required by
each component's license. Concord Voice LLC gratefully acknowledges the
contributions of these projects to the Concord Voice platform.

## Summary

Concord Voice distributes 281 third-party software components across Desktop and concord-bridge:

- **189** npm packages in the desktop client production bundle (plus Electron and its bundled components)
- **92** npm packages in the concord-bridge production bundle

Counts exclude Concord Voice's own private packages and first-party overrides.

Application-dependency license distribution:

| License family | Share | Compatible with CVSL 1.0 + AGPL-3.0 |
|---|---|---|
| MIT | 89.3% (251) | ✓ |
| ISC | 8.2% (23) | ✓ |
| BSD-3-Clause | 1.1% (3) | ✓ |
| Apache-2.0 | 0.4% (1) | ✓ |
| BSD-2-Clause | 0.4% (1) | ✓ |
| BlueOak-1.0.0 | 0.4% (1) | ✓ |
| Python-2.0 | 0.4% (1) | ✓ |
| MPL-2.0 (build-time only) | not in the count above | ✓ |
| CC-BY-3.0 / CC-BY-4.0 (build-data only) | not in the count above | ✓ (attribution required) |

Shares are exact counts over the 281 components tabulated below, not estimates.
The final two rows cover build-time and build-data dependencies, which are not
part of that 281 and therefore carry no share of it. Build tooling is
not part of the 281-component count.

## License Texts

The license texts for each license family are available at the canonical
SPDX URLs:

- **MIT** — [https://opensource.org/license/mit](https://opensource.org/license/mit)
- **ISC** — [https://opensource.org/license/isc](https://opensource.org/license/isc)
- **Apache-2.0** — [https://www.apache.org/licenses/LICENSE-2.0](https://www.apache.org/licenses/LICENSE-2.0)
- **BSD-2-Clause** — [https://opensource.org/license/bsd-2-clause](https://opensource.org/license/bsd-2-clause)
- **BSD-3-Clause** — [https://opensource.org/license/bsd-3-clause](https://opensource.org/license/bsd-3-clause)
- **0BSD** — [https://opensource.org/license/0bsd](https://opensource.org/license/0bsd)
- **MPL-2.0** — [https://www.mozilla.org/en-US/MPL/2.0/](https://www.mozilla.org/en-US/MPL/2.0/)
- **AGPL-3.0-or-later** — [https://www.gnu.org/licenses/agpl-3.0.html](https://www.gnu.org/licenses/agpl-3.0.html)
- **BlueOak-1.0.0** — [https://blueoakcouncil.org/license/1.0.0](https://blueoakcouncil.org/license/1.0.0)
- **Unlicense** — [https://unlicense.org/](https://unlicense.org/)
- **Python-2.0** — [https://docs.python.org/3/license.html](https://docs.python.org/3/license.html)
- **CC0-1.0** — [https://creativecommons.org/publicdomain/zero/1.0/](https://creativecommons.org/publicdomain/zero/1.0/)
- **CC-BY-3.0** — [https://creativecommons.org/licenses/by/3.0/](https://creativecommons.org/licenses/by/3.0/)
- **CC-BY-4.0** — [https://creativecommons.org/licenses/by/4.0/](https://creativecommons.org/licenses/by/4.0/)

Individual project copyright notices and full license texts are preserved
in the redistributed source / binary form (npm `node_modules`, Go module
cache, Electron credits at `about:credits` in the application). For
projects that ship their own NOTICE file (Apache-2.0 § 4 requirement),
that content is included with the project in its `node_modules` directory
or Go module cache and is not duplicated here.

**Exception — the admin portal bundle.** Only the compiled `dist` output is
copied out of the `admin-ui-builder` stage, so that family's `node_modules`
(and the license texts inside it) stay in the builder stage and never reach the
runtime image. Attribution for those four packages therefore rests on the
Admin Portal table in this file and the canonical SPDX URLs above, not on
shipped `node_modules`.

## Electron and Chromium

The Concord Voice desktop application is built on Electron and embeds
Chromium. Electron itself is licensed under MIT. Chromium and its
components are licensed under multiple compatible licenses (predominantly
BSD-3-Clause, with various permissive licenses for individual components).
The full Chromium credits are included in the desktop application
installer and accessible at runtime via the in-app About section. The
Electron and Chromium teams are gratefully acknowledged.

- **Electron** — [https://www.electronjs.org/](https://www.electronjs.org/) — MIT License
- **Chromium** — [https://www.chromium.org/](https://www.chromium.org/) — see in-app `about:credits`

---

## Desktop Client Production Dependencies

The following npm packages are included in the desktop client production
bundle (desktop):

| Package | Version | License | Repository |
|---|---|---|---|
| @lukeed/csprng | 1.1.0 | MIT | https://github.com/lukeed/csprng |
| @lukeed/uuid | 2.0.1 | MIT | https://github.com/lukeed/uuid |
| @msgpack/msgpack | 3.1.3 | ISC | https://github.com/msgpack/msgpack-javascript |
| @noble/hashes | 2.4.0 | MIT | https://github.com/paulmillr/noble-hashes |
| @remix-run/route-pattern | 0.22.1 | MIT | https://github.com/remix-run/remix |
| @socket.io/component-emitter | 3.1.2 | MIT | https://github.com/socketio/emitter |
| @types/debug | 4.1.13 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/estree-jsx | 1.0.5 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/estree | 1.0.8 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/events | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/hast | 3.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/mdast | 4.0.4 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/ms | 2.1.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react-dom | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/react | 19.3.0 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/unist | 2.0.11 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @types/unist | 3.0.3 | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| @ungap/structured-clone | 1.3.0 | ISC | https://github.com/ungap/structured-clone |
| ansi-regex | 5.0.1 | MIT | https://github.com/chalk/ansi-regex |
| ansi-styles | 4.3.0 | MIT | https://github.com/chalk/ansi-styles |
| argparse | 2.0.1 | Python-2.0 | https://github.com/nodeca/argparse |
| awaitqueue | 3.3.1 | ISC | https://github.com/versatica/awaitqueue |
| bail | 2.0.2 | MIT | https://github.com/wooorm/bail |
| builder-util-runtime | 9.7.0 | MIT | https://github.com/electron-userland/electron-builder |
| camelcase | 5.3.1 | MIT | https://github.com/sindresorhus/camelcase |
| ccount | 2.0.1 | MIT | https://github.com/wooorm/ccount |
| character-entities-html4 | 2.1.0 | MIT | https://github.com/wooorm/character-entities-html4 |
| character-entities-legacy | 3.0.0 | MIT | https://github.com/wooorm/character-entities-legacy |
| character-entities | 2.0.2 | MIT | https://github.com/wooorm/character-entities |
| character-reference-invalid | 2.0.1 | MIT | https://github.com/wooorm/character-reference-invalid |
| cliui | 6.0.0 | ISC | https://github.com/yargs/cliui |
| color-convert | 2.0.1 | MIT | https://github.com/Qix-/color-convert |
| color-name | 1.1.4 | MIT | https://github.com/colorjs/color-name |
| comma-separated-tokens | 2.0.3 | MIT | https://github.com/wooorm/comma-separated-tokens |
| cookie-es | 3.1.1 | MIT | https://github.com/unjs/cookie-es |
| csstype | 3.2.3 | MIT | https://github.com/frenic/csstype |
| debug | 2.6.9 | MIT | https://github.com/visionmedia/debug |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| decamelize | 1.2.0 | MIT | https://github.com/sindresorhus/decamelize |
| decode-named-character-reference | 1.3.0 | MIT | https://github.com/wooorm/decode-named-character-reference |
| dequal | 2.0.3 | MIT | https://github.com/lukeed/dequal |
| devlop | 1.1.0 | MIT | https://github.com/wooorm/devlop |
| dijkstrajs | 1.0.3 | MIT | https://github.com/tcort/dijkstrajs |
| electron-squirrel-startup | 1.0.1 | Apache-2.0 | https://github.com/mongodb-js/electron-squirrel-startup |
| electron-updater | 6.8.11 | MIT | https://github.com/electron-userland/electron-builder |
| emoji-regex | 8.0.0 | MIT | https://github.com/mathiasbynens/emoji-regex |
| engine.io-client | 6.6.5 | MIT | https://github.com/socketio/socket.io |
| engine.io-parser | 5.2.3 | MIT | https://github.com/socketio/socket.io |
| escape-string-regexp | 5.0.0 | MIT | https://github.com/sindresorhus/escape-string-regexp |
| estree-util-is-identifier-name | 3.0.0 | MIT | https://github.com/syntax-tree/estree-util-is-identifier-name |
| events | 3.3.0 | MIT | https://github.com/Gozala/events |
| extend | 3.0.2 | MIT | https://github.com/justmoon/node-extend |
| fake-mediastreamtrack | 2.2.1 | ISC | https://github.com/ibc/fake-mediastreamtrack |
| find-up | 4.1.0 | MIT | https://github.com/sindresorhus/find-up |
| fs-extra | 10.1.0 | MIT | https://github.com/jprichardson/node-fs-extra |
| get-caller-file | 2.0.5 | ISC | https://github.com/stefanpenner/get-caller-file |
| graceful-fs | 4.2.11 | ISC | https://github.com/isaacs/node-graceful-fs |
| h264-profile-level-id | 2.3.3 | ISC | https://github.com/versatica/h264-profile-level-id |
| hash-wasm | 4.12.0 | MIT | https://github.com/Daninet/hash-wasm |
| hast-util-is-element | 3.0.0 | MIT | https://github.com/syntax-tree/hast-util-is-element |
| hast-util-sanitize | 5.0.2 | MIT | https://github.com/syntax-tree/hast-util-sanitize |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | https://github.com/syntax-tree/hast-util-to-jsx-runtime |
| hast-util-to-text | 4.0.2 | MIT | https://github.com/syntax-tree/hast-util-to-text |
| hast-util-whitespace | 3.0.0 | MIT | https://github.com/syntax-tree/hast-util-whitespace |
| highlight.js | 11.11.1 | BSD-3-Clause | https://github.com/highlightjs/highlight.js |
| html-url-attributes | 3.0.1 | MIT | https://github.com/rehypejs/rehype-minify/tree/main/packages/html-url-attributes |
| inline-style-parser | 0.2.7 | MIT | https://github.com/remarkablemark/inline-style-parser |
| is-alphabetical | 2.0.1 | MIT | https://github.com/wooorm/is-alphabetical |
| is-alphanumerical | 2.0.1 | MIT | https://github.com/wooorm/is-alphanumerical |
| is-decimal | 2.0.1 | MIT | https://github.com/wooorm/is-decimal |
| is-fullwidth-code-point | 3.0.0 | MIT | https://github.com/sindresorhus/is-fullwidth-code-point |
| is-hexadecimal | 2.0.1 | MIT | https://github.com/wooorm/is-hexadecimal |
| is-plain-obj | 4.1.0 | MIT | https://github.com/sindresorhus/is-plain-obj |
| jose | 6.2.13 | MIT | https://github.com/panva/jose |
| js-yaml | 4.3.2 | MIT | https://github.com/nodeca/js-yaml |
| jsonfile | 6.2.0 | MIT | https://github.com/jprichardson/node-jsonfile |
| lazy-val | 1.0.5 | MIT | https://github.com/develar/lazy-val |
| locate-path | 5.0.0 | MIT | https://github.com/sindresorhus/locate-path |
| lodash.escaperegexp | 4.1.2 | MIT | https://github.com/lodash/lodash |
| lodash.isequal | 4.5.0 | MIT | https://github.com/lodash/lodash |
| longest-streak | 3.1.0 | MIT | https://github.com/wooorm/longest-streak |
| lowlight | 3.3.0 | MIT | https://github.com/wooorm/lowlight |
| lucide-react | 1.64.0 | ISC | https://github.com/lucide-icons/lucide |
| markdown-table | 3.0.4 | MIT | https://github.com/wooorm/markdown-table |
| mdast-util-find-and-replace | 3.0.2 | MIT | https://github.com/syntax-tree/mdast-util-find-and-replace |
| mdast-util-from-markdown | 2.0.3 | MIT | https://github.com/syntax-tree/mdast-util-from-markdown |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-gfm-autolink-literal |
| mdast-util-gfm-footnote | 2.1.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-footnote |
| mdast-util-gfm-strikethrough | 2.0.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-strikethrough |
| mdast-util-gfm-table | 2.0.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-table |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm-task-list-item |
| mdast-util-gfm | 3.1.0 | MIT | https://github.com/syntax-tree/mdast-util-gfm |
| mdast-util-mdx-expression | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-mdx-expression |
| mdast-util-mdx-jsx | 3.2.0 | MIT | https://github.com/syntax-tree/mdast-util-mdx-jsx |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | https://github.com/syntax-tree/mdast-util-mdxjs-esm |
| mdast-util-phrasing | 4.1.0 | MIT | https://github.com/syntax-tree/mdast-util-phrasing |
| mdast-util-to-hast | 13.2.1 | MIT | https://github.com/syntax-tree/mdast-util-to-hast |
| mdast-util-to-markdown | 2.1.2 | MIT | https://github.com/syntax-tree/mdast-util-to-markdown |
| mdast-util-to-string | 4.0.0 | MIT | https://github.com/syntax-tree/mdast-util-to-string |
| mediasoup-client | 3.25.3 | ISC | https://github.com/versatica/mediasoup-client |
| micromark-core-commonmark | 2.0.3 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-autolink-literal |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-footnote |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-strikethrough |
| micromark-extension-gfm-table | 2.1.1 | MIT | https://github.com/micromark/micromark-extension-gfm-table |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | https://github.com/micromark/micromark-extension-gfm-tagfilter |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | https://github.com/micromark/micromark-extension-gfm-task-list-item |
| micromark-extension-gfm | 3.0.0 | MIT | https://github.com/micromark/micromark-extension-gfm |
| micromark-factory-destination | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-destination |
| micromark-factory-label | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-label |
| micromark-factory-space | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space |
| micromark-factory-title | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-title |
| micromark-factory-whitespace | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-whitespace |
| micromark-util-character | 2.1.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-character |
| micromark-util-chunked | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-chunked |
| micromark-util-classify-character | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character |
| micromark-util-combine-extensions | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-combine-extensions |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference |
| micromark-util-decode-string | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string |
| micromark-util-encode | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-encode |
| micromark-util-html-tag-name | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-html-tag-name |
| micromark-util-normalize-identifier | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-normalize-identifier |
| micromark-util-resolve-all | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-resolve-all |
| micromark-util-sanitize-uri | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri |
| micromark-util-subtokenize | 2.1.0 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-subtokenize |
| micromark-util-symbol | 2.0.1 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol |
| micromark-util-types | 2.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark-util-types |
| micromark | 4.0.2 | MIT | https://github.com/micromark/micromark/tree/main/packages/micromark |
| minisearch | 7.2.0 | MIT | https://github.com/lucaong/minisearch |
| ms | 2.0.0 | MIT | https://github.com/zeit/ms |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| p-limit | 2.3.0 | MIT | https://github.com/sindresorhus/p-limit |
| p-locate | 4.1.0 | MIT | https://github.com/sindresorhus/p-locate |
| p-try | 2.2.0 | MIT | https://github.com/sindresorhus/p-try |
| parse-entities | 4.0.2 | MIT | https://github.com/wooorm/parse-entities |
| path-exists | 4.0.0 | MIT | https://github.com/sindresorhus/path-exists |
| pngjs | 5.0.0 | MIT | https://github.com/lukeapage/pngjs |
| property-information | 7.1.0 | MIT | https://github.com/wooorm/property-information |
| qrcode | 1.5.4 | MIT | https://github.com/soldair/node-qrcode |
| react-dom | 19.3.1 | MIT | https://github.com/react/react |
| react-markdown | 10.1.0 | MIT | https://github.com/remarkjs/react-markdown |
| react-router | 8.5.0 | MIT | https://github.com/remix-run/react-router |
| react | 19.3.1 | MIT | https://github.com/react/react |
| rehype-highlight | 7.0.2 | MIT | https://github.com/rehypejs/rehype-highlight |
| rehype-sanitize | 6.0.0 | MIT | https://github.com/rehypejs/rehype-sanitize |
| remark-gfm | 4.0.1 | MIT | https://github.com/remarkjs/remark-gfm |
| remark-parse | 11.0.0 | MIT | https://github.com/remarkjs/remark/tree/main/packages/remark-parse |
| remark-rehype | 11.1.2 | MIT | https://github.com/remarkjs/remark-rehype |
| remark-stringify | 11.0.0 | MIT | https://github.com/remarkjs/remark/tree/main/packages/remark-stringify |
| require-directory | 2.1.1 | MIT | https://github.com/troygoode/node-require-directory |
| require-main-filename | 2.0.0 | ISC | https://github.com/yargs/require-main-filename |
| sax | 1.6.0 | BlueOak-1.0.0 | https://github.com/isaacs/sax-js |
| scheduler | 0.28.0 | MIT | https://github.com/react/react |
| sdp-transform | 3.0.0 | MIT | https://github.com/clux/sdp-transform |
| semver | 7.7.4 | ISC | https://github.com/npm/node-semver |
| set-blocking | 2.0.0 | ISC | https://github.com/yargs/set-blocking |
| socket.io-client | 4.8.4 | MIT | https://github.com/socketio/socket.io |
| socket.io-parser | 4.2.7 | MIT | https://github.com/socketio/socket.io |
| space-separated-tokens | 2.0.2 | MIT | https://github.com/wooorm/space-separated-tokens |
| string-width | 4.2.3 | MIT | https://github.com/sindresorhus/string-width |
| stringify-entities | 4.0.4 | MIT | https://github.com/wooorm/stringify-entities |
| strip-ansi | 6.0.1 | MIT | https://github.com/chalk/strip-ansi |
| style-to-js | 1.1.21 | MIT | https://github.com/remarkablemark/style-to-js |
| style-to-object | 1.0.14 | MIT | https://github.com/remarkablemark/style-to-object |
| supports-color | 11.0.0 | MIT | https://github.com/chalk/supports-color |
| tiny-typed-emitter | 2.1.0 | MIT | https://github.com/binier/tiny-typed-emitter |
| trim-lines | 3.0.1 | MIT | https://github.com/wooorm/trim-lines |
| trough | 2.2.0 | MIT | https://github.com/wooorm/trough |
| unified | 11.0.5 | MIT | https://github.com/unifiedjs/unified |
| unist-util-find-after | 5.0.0 | MIT | https://github.com/syntax-tree/unist-util-find-after |
| unist-util-is | 6.0.1 | MIT | https://github.com/syntax-tree/unist-util-is |
| unist-util-position | 5.0.0 | MIT | https://github.com/syntax-tree/unist-util-position |
| unist-util-stringify-position | 4.0.0 | MIT | https://github.com/syntax-tree/unist-util-stringify-position |
| unist-util-visit-parents | 6.0.2 | MIT | https://github.com/syntax-tree/unist-util-visit-parents |
| unist-util-visit | 5.1.0 | MIT | https://github.com/syntax-tree/unist-util-visit |
| universalify | 2.0.1 | MIT | https://github.com/RyanZim/universalify |
| use-sync-external-store | 1.7.0 | MIT | https://github.com/react/react |
| vfile-message | 4.0.3 | MIT | https://github.com/vfile/vfile-message |
| vfile | 6.0.3 | MIT | https://github.com/vfile/vfile |
| which-module | 2.0.1 | ISC | https://github.com/nexdrew/which-module |
| wrap-ansi | 6.2.0 | MIT | https://github.com/chalk/wrap-ansi |
| ws | 8.21.3 | MIT | https://github.com/websockets/ws |
| xmlhttprequest-ssl | 2.1.2 | MIT | https://github.com/mjwwit/node-XMLHttpRequest |
| y18n | 4.0.3 | ISC | https://github.com/yargs/y18n |
| yargs-parser | 18.1.3 | ISC | https://github.com/yargs/yargs-parser |
| yargs | 15.4.1 | MIT | https://github.com/yargs/yargs |
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |
| zustand | 5.0.13 | MIT | https://github.com/pmndrs/zustand |
| zwitch | 2.0.4 | MIT | https://github.com/wooorm/zwitch |

---

## Concord Bridge Production Dependencies

| Package | Version | License | Repository |
|---|---|---|---|
| @hono/node-server | 2.1.5 | MIT | https://github.com/honojs/node-server |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| accepts | 2.0.0 | MIT | https://github.com/jshttp/accepts |
| ajv-formats | 3.0.1 | MIT | https://github.com/ajv-validator/ajv-formats |
| ajv | 8.20.0 | MIT | https://github.com/ajv-validator/ajv |
| body-parser | 2.4.0 | MIT | https://github.com/expressjs/body-parser |
| bytes | 3.1.2 | MIT | https://github.com/visionmedia/bytes.js |
| call-bind-apply-helpers | 1.0.2 | MIT | https://github.com/ljharb/call-bind-apply-helpers |
| call-bound | 1.0.4 | MIT | https://github.com/ljharb/call-bound |
| content-disposition | 2.0.1 | MIT | https://github.com/jshttp/content-disposition |
| content-type | 1.0.5 | MIT | https://github.com/jshttp/content-type |
| content-type | 2.1.0 | MIT | https://github.com/jshttp/content-type |
| cookie-signature | 1.2.2 | MIT | https://github.com/visionmedia/node-cookie-signature |
| cookie | 0.7.2 | MIT | https://github.com/jshttp/cookie |
| cors | 2.8.6 | MIT | https://github.com/expressjs/cors |
| cross-spawn | 7.0.6 | MIT | https://github.com/moxystudio/node-cross-spawn |
| debug | 4.4.3 | MIT | https://github.com/debug-js/debug |
| depd | 2.0.0 | MIT | https://github.com/dougwilson/nodejs-depd |
| dunder-proto | 1.0.1 | MIT | https://github.com/es-shims/dunder-proto |
| ee-first | 1.1.1 | MIT | https://github.com/jonathanong/ee-first |
| encodeurl | 2.0.0 | MIT | https://github.com/pillarjs/encodeurl |
| es-define-property | 1.0.1 | MIT | https://github.com/ljharb/es-define-property |
| es-errors | 1.3.0 | MIT | https://github.com/ljharb/es-errors |
| es-object-atoms | 1.1.2 | MIT | https://github.com/ljharb/es-object-atoms |
| escape-html | 1.0.3 | MIT | https://github.com/component/escape-html |
| etag | 1.8.1 | MIT | https://github.com/jshttp/etag |
| eventsource-parser | 3.1.1 | MIT | https://github.com/rexxars/eventsource-parser |
| eventsource | 3.0.7 | MIT | git://git@github.com/EventSource/eventsource |
| express-rate-limit | 8.7.1 | MIT | https://github.com/express-rate-limit/express-rate-limit |
| express | 5.3.0 | MIT | https://github.com/expressjs/express |
| fast-deep-equal | 3.1.3 | MIT | https://github.com/epoberezkin/fast-deep-equal |
| fast-uri | 3.1.9 | BSD-3-Clause | https://github.com/fastify/fast-uri |
| finalhandler | 2.1.1 | MIT | https://github.com/pillarjs/finalhandler |
| forwarded | 0.2.0 | MIT | https://github.com/jshttp/forwarded |
| fresh | 2.0.0 | MIT | https://github.com/jshttp/fresh |
| function-bind | 1.1.2 | MIT | https://github.com/Raynos/function-bind |
| get-intrinsic | 1.3.0 | MIT | https://github.com/ljharb/get-intrinsic |
| get-proto | 1.0.1 | MIT | https://github.com/ljharb/get-proto |
| gopd | 1.2.0 | MIT | https://github.com/ljharb/gopd |
| has-symbols | 1.1.0 | MIT | https://github.com/inspect-js/has-symbols |
| hasown | 2.0.4 | MIT | https://github.com/inspect-js/hasOwn |
| hono | 4.13.13 | MIT | https://github.com/honojs/hono |
| http-errors | 2.0.1 | MIT | https://github.com/jshttp/http-errors |
| iconv-lite | 0.7.3 | MIT | https://github.com/pillarjs/iconv-lite |
| inherits | 2.0.4 | ISC | https://github.com/isaacs/inherits |
| ip-address | 10.7.4 | MIT | https://github.com/beaugunderson/ip-address |
| ipaddr.js | 1.9.1 | MIT | https://github.com/whitequark/ipaddr.js |
| is-promise | 4.0.0 | MIT | https://github.com/then/is-promise |
| isexe | 2.0.0 | ISC | https://github.com/isaacs/isexe |
| jose | 6.2.13 | MIT | https://github.com/panva/jose |
| json-schema-traverse | 1.0.0 | MIT | https://github.com/epoberezkin/json-schema-traverse |
| json-schema-typed | 8.0.2 | BSD-2-Clause | https://github.com/RemyRylan/json-schema-typed |
| math-intrinsics | 1.1.0 | MIT | https://github.com/es-shims/math-intrinsics |
| media-typer | 1.1.1 | MIT | https://github.com/jshttp/media-typer |
| merge-descriptors | 2.0.0 | MIT | https://github.com/sindresorhus/merge-descriptors |
| mime-db | 1.54.0 | MIT | https://github.com/jshttp/mime-db |
| mime-types | 3.0.2 | MIT | https://github.com/jshttp/mime-types |
| ms | 2.1.3 | MIT | https://github.com/vercel/ms |
| negotiator | 1.1.0 | MIT | https://github.com/jshttp/negotiator |
| object-assign | 4.1.1 | MIT | https://github.com/sindresorhus/object-assign |
| object-inspect | 1.13.4 | MIT | https://github.com/inspect-js/object-inspect |
| on-finished | 2.4.1 | MIT | https://github.com/jshttp/on-finished |
| once | 1.4.0 | ISC | https://github.com/isaacs/once |
| parseurl | 1.3.3 | MIT | https://github.com/pillarjs/parseurl |
| path-key | 3.1.1 | MIT | https://github.com/sindresorhus/path-key |
| path-to-regexp | 8.4.2 | MIT | https://github.com/pillarjs/path-to-regexp |
| pkce-challenge | 5.0.1 | MIT | https://github.com/crouchcd/pkce-challenge |
| proxy-addr | 2.0.8 | MIT | https://github.com/jshttp/proxy-addr |
| qs | 6.16.1 | BSD-3-Clause | https://github.com/ljharb/qs |
| range-parser | 1.3.0 | MIT | https://github.com/jshttp/range-parser |
| raw-body | 3.0.2 | MIT | https://github.com/stream-utils/raw-body |
| require-from-string | 2.0.2 | MIT | https://github.com/floatdrop/require-from-string |
| router | 2.2.0 | MIT | https://github.com/pillarjs/router |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| send | 1.2.1 | MIT | https://github.com/pillarjs/send |
| serve-static | 2.2.1 | MIT | https://github.com/expressjs/serve-static |
| setprototypeof | 1.2.0 | ISC | https://github.com/wesleytodd/setprototypeof |
| shebang-command | 2.0.0 | MIT | https://github.com/kevva/shebang-command |
| shebang-regex | 3.0.0 | MIT | https://github.com/sindresorhus/shebang-regex |
| side-channel-list | 1.0.1 | MIT | https://github.com/ljharb/side-channel-list |
| side-channel-map | 1.0.1 | MIT | https://github.com/ljharb/side-channel-map |
| side-channel-weakmap | 1.0.2 | MIT | https://github.com/ljharb/side-channel-weakmap |
| side-channel | 1.1.1 | MIT | https://github.com/ljharb/side-channel |
| statuses | 2.0.2 | MIT | https://github.com/jshttp/statuses |
| toidentifier | 1.0.1 | MIT | https://github.com/component/toidentifier |
| type-is | 2.1.0 | MIT | https://github.com/jshttp/type-is |
| unpipe | 1.0.0 | MIT | https://github.com/stream-utils/unpipe |
| vary | 1.1.2 | MIT | https://github.com/jshttp/vary |
| which | 2.0.2 | ISC | https://github.com/isaacs/node-which |
| wrappy | 1.0.2 | ISC | https://github.com/npm/wrappy |
| zod-to-json-schema | 3.25.2 | ISC | https://github.com/StefanTerdell/zod-to-json-schema |
| zod | 4.6.7 | MIT | https://github.com/colinhacks/zod |

---

## Build-Time and Development Dependencies

Build tools, test frameworks, linters and type checkers are listed in each
workspace's `package.json`; they are not bundled in the desktop application.

- **lightningcss** (MPL-2.0): build-time CSS transformation.
- **caniuse-lite** (CC-BY-4.0): browser compatibility build data.
- **spdx-exceptions** (CC-BY-3.0): license metadata used by build tooling.

## Regenerating This File

Install the locked dependencies in `desktop`, `tools/concord-bridge` and
`.github/tools/license-checker`, then run:

```bash
python3 scripts/update-notice-md.py --desktop-only --apply
```

CI checks the same attribution inventory with `--desktop-only --check`.

## Contact

For licensing questions about Concord Voice's use of these dependencies,
contact: [contact-us@concordvoice.com](mailto:contact-us@concordvoice.com).

For licensing questions about Concord Voice itself, see [LICENSE](./LICENSE)
and [docs/legal/commercial-license.md](docs/legal/commercial-license.md).
