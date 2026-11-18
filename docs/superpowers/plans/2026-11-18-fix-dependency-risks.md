# Fix dependency risks — plan (ad-hoc, 2026-11-18)

Spec: `docs/superpowers/specs/2026-11-18-fix-dependency-risks-design.md`.

1. `tools/concord-bridge`: `npm update qs express-rate-limit`. Run `npm run build` and `npm test`.
2. `desktop/package.json`: add the scoped override for `@microsoft/eslint-formatter-sarif` → `$eslint`. Run `npm install`, then `npm update undici`.
3. `desktop`: refresh `.override-range-baseline.json` with `node scripts/security/override-range-lint.mjs --dir desktop --update-baseline` (from the repo root), then run the lint with no flags.
4. `desktop/tools`: drop the rimraf 3 and `@eslint/eslintrc` consumers from `dependency-compat.test.mjs`, `README.md` and the adapter comments, since they leave the tree with eslint 8. Then run `npm run test:dependency-compat`.
5. `desktop`: run `npm run lint`, the SARIF formatter command from `.github/workflows/eslint-sarif.yml`, `npm run typecheck` and the unit tests.
6. Confirm with `npm audit --package-lock-only` that only picomatch remains. osv-scanner additionally reports uri-js: add ID-scoped `[[IgnoredVulns]]` entries for the three uri-js CVEs (pre-emptive: SonarCloud reports them, OSV and npm audit do not), and check that osv-scanner reports no issues.
7. Mark picomatch, plist and uri-js as accepted in SonarCloud. Dismiss osv alerts #45 and #46.
8. Open a draft PR with the package → resolution table. Rebase on any Dependabot PR that merges first.
