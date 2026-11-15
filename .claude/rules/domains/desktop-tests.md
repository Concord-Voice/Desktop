---
description: Desktop unit and e2e test-file conventions that CI scanners enforce
paths:
  - "desktop/tests/**/*.ts"
  - "desktop/tests/**/*.tsx"
---

# Desktop test files

## Mock factories: name the module type, never inline `typeof import()` as a generic

The protected Semgrep community scan fails the PR on any scanner error in a changed
file. Semgrep cannot parse a generic argument that is an inline import type
followed by a call, and reports `PartialParsing` (`` `>()` was unexpected ``):

```ts
// Fails the scan
vi.mock('../../../src/main/tray', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/main/tray')>();
```

Import the module type at the top of the file and pass that name:

```ts
import type * as TrayModule from '../../../src/main/tray';

vi.mock('../../../src/main/tray', async (importActual) => {
  const actual = await importActual<typeof TrayModule>();
```

This applies to `importOriginal<…>()`, `importActual<…>()` and
`vi.importActual<…>()`. A plain `typeof import('…')` in a type annotation, not
followed by `()`, parses fine.

Check before you push:

```bash
semgrep scan --config=p/security-audit --config=p/owasp-top-ten --json <changed test files>
```

Expect no `PartialParsing` or `Syntax` entries in `errors`. The engine's
"Internal matching error" entries on unrelated rules are local noise.
