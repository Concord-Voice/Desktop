# Concord Voice Desktop

Electron desktop application and the concord-bridge development workspace.

Use Node.js 24 and the checked-in npm lockfiles:

```bash
cd desktop
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

The bridge has its own lockfile and commands under `tools/concord-bridge`.

Local checks run through [pre-commit](https://pre-commit.com/) (secret scanning,
workflow lints, Semgrep, Prettier, ESLint and tsc):

```bash
pipx install pre-commit
pre-commit install --hook-type pre-commit --hook-type commit-msg
```
Root contract fixtures, legal documents and scripts are required build inputs.
The encryption engine and event schema remain in-tree.

CI packages unsigned test artifacts. Signing and publication remain outside this
repository; Alpha's desktop release lane remains authoritative during extraction.
The update endpoint and its trust model are unchanged.

See [the extraction record](docs/extraction/D1.md) for scope and CI deviations.
