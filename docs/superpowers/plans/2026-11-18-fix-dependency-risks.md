# Fix dependency risks — plan (ad-hoc, 2026-11-18)

Spec: `docs/superpowers/specs/2026-11-18-fix-dependency-risks-design.md`.

1. `tools/concord-bridge`: `npm update qs express-rate-limit`. Run `npm run build` and `npm test`.
2. `desktop/package.json`: add the scoped override for `@microsoft/eslint-formatter-sarif` → `$eslint`. Run `npm install`, then `npm update undici`.
3. `desktop`: refresh `.override-range-baseline.json` with `node ../scripts/security/override-range-lint.mjs --dir desktop --update-baseline` (repo root), then run the lint with no flags.
4. `desktop`: run `npm run lint`, the SARIF formatter command from `.github/workflows/eslint-sarif.yml`, `npm run typecheck` and the unit tests.
5. Confirm with `npm audit --package-lock-only` that only picomatch, plist and uri-js remain.
6. Mark picomatch, plist and uri-js as accepted in SonarCloud. Dismiss osv alerts #45 and #46.
7. Open a draft PR with the package → resolution table. Rebase on any Dependabot PR that merges first.
