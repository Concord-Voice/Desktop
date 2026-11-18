# Fix dependency risks — design (ad-hoc, 2026-11-18)

Issueless hygiene sweep. Resolves the 21 open SonarCloud dependency risks on the
Desktop project and the osv-scanner code-scanning alerts #45 and #46. Scope is
package manifests and lockfiles only.

## Findings and decisions

| Package | Where | Advisory | Patched release | Decision |
|---|---|---|---|---|
| undici 7.30.1 | `desktop` (via `@electron/get`, dev) | CVE-2026-116592, -120474, -116630, -120222, -120415, -120423 | 7.30.2 | Refresh lockfile; `^7.24.4` already allows 7.30.2 |
| undici 8.12.3 | `desktop` (via `jsdom`, `node-gyp`, dev) | same six | 8.12.4 | Refresh lockfile; `^8.12.1` / `^8.4.1` allow 8.12.4 |
| qs 6.16.1 | `tools/concord-bridge` (via `express`, runtime) | CVE-2026-110910 | 6.17.0 | Refresh lockfile to 6.17.1 |
| express-rate-limit 8.7.1 | `tools/concord-bridge` (via `@modelcontextprotocol/sdk`, runtime) | CVE-2026-126204 | 8.7.2 | Refresh lockfile to 8.7.4 |
| eslint 8.57.1 | `desktop` (nested under `@microsoft/eslint-formatter-sarif`, dev) | CVE-2025-50537 (advisory withdrawn) | n/a | Scoped override `"@microsoft/eslint-formatter-sarif": { "eslint": "$eslint" }`. The formatter never loads its own copy: it calls `require.main.require('eslint')`, which is the host eslint 10. The override removes the eslint 8 tree |
| picomatch 4.0.4, 4.0.7 | `desktop`, `tools/concord-bridge` (vite, vitest, tinyglobby, dev) | CVE-2026-112366 (osv #45, #46) | none (`<= 4.0.7`, no first patched version; 4.0.7 is latest) | Accept. Dev-only test and build tooling. Globs come from repo-authored config, never from untrusted input |
| plist 3.1.0 | `desktop` (electron packagers, dev) | CVE-2026-124078 | 5.0.1 (ESM-only major) | Accept as not affected. The flaw is in the binary plist parser, which plist added in 5.0.0. The 3.1.0 tarball has only `lib/parse.js` and `lib/build.js` (XML). Forcing the ESM-only 5.x onto four CJS packager consumers is a risk with no security gain |
| uri-js 4.4.1 | `desktop` (via `ajv@6` under eslint, roarr, dev) | CVE-2026-103387, -93690, -93751 | none (unmaintained; 4.4.1 is latest) | Accept. Dev-only. ajv 6 resolves URIs only in schemas that ship inside eslint and roarr, never in user data |

## Constraints

- Regenerate lockfiles with `npm install` / `npm update`, never by hand.
- The override-range lint (`scripts/security/override-range-lint.mjs`) accepts
  only upward skews. The sarif-formatter override is upward (8.x range resolves
  to 10.x), so the baseline gets a new row.
- Open Dependabot PRs 260, 262, 263, 264 touch `desktop/package-lock.json` but not
  these packages. Rebase on whichever merges first.

## Acceptance

- `npm audit --package-lock-only` shows no undici, qs or express-rate-limit
  entries, and no eslint 8 in `desktop/package-lock.json`.
- `npm run lint` with the SARIF formatter still writes a valid SARIF file.
- Desktop and bridge unit tests and builds pass.
- Every accepted risk is marked in SonarCloud with the reason above, and osv
  alerts #45/#46 are dismissed with the same reason.
