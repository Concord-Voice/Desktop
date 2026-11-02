# Packaging dependency compatibility

These private adapters preserve the small legacy API used by the dependency
versions in Desktop's lockfile. Matching and filesystem traversal are delegated
to upstream glob 14 and minimatch 11. They contain no matcher implementation and
must not recreate minimatch's removed regular-expression internals.

- `glob-compat`: ASAR 3 and electron-installer-common promisify callback glob;
  rimraf 2/3 use callback glob, `sync` and `hasMagic`; the CI license checker
  shares this adapter for read-package-json 2. Preserve default sorting,
  case behavior and forward-slash Windows results. Unexpected readdir errors
  reject the entire traversal even when upstream path-scurry suppresses them;
  ordinary missing/non-directory entries retain glob 7 semantics. Unsupported APIs/options fail
  explicitly; this is not a replacement for the full glob 7 API.
- `minimatch-compat`: ASAR 3 and dir-compare use a callable default export;
  eslintrc/filelist also access helpers or the `Minimatch` class. The class is the
  upstream implementation, including its `Matcher` entries in `set`. `makeRe`
  and the old RegExp representation are deliberately absent. Legacy glob must
  never be paired with this adapter. On Windows, upstream defaults preserve
  legacy backslash-as-separator patterns across the callable, helpers and class;
  an explicit `allowWindowsEscape: true` still opts into pattern escaping.
  POSIX escaping defaults remain unchanged.

Only legacy version ranges should resolve to these packages. Modern callers
must resolve directly to patched upstream packages. All adapters are development
dependencies and must be absent from packaged production dependencies.
Forge also excludes the top-level `tools/` source directory from `app.asar`;
the payload verifier must keep rejecting unexpected top-level entries.

Remove an adapter once the last audited parent releases compatible dependencies.
Any new consumer or option requires compatibility review and fixture coverage.
Do not loosen errors or add a security exception merely to pass a build.

Run `npm ci` and `npm run test:dependency-compat` from Desktop. The tests verify
every actual consumer resolution and packed source content, ASAR 3/4 archive
selection/extraction/unpacking, installer discovery, rimraf cleanup, dir-compare,
filelist, ESLint overrides and builder filters. Run `npm ci && npm test` from
`.github/tools/license-checker` for license inference, attribution, policy and
repository-URL regression coverage. These fixtures do not replace the platform
packaging matrix or release review.

The dependency-compat workflow runs these consumer and license fixtures on
native Windows and Linux from the PR revision. The protected build workflow
runs its definition from main, so it cannot validate newly added jobs before merge. Windows filesystem coverage is required;
the virtual Win32 fixtures on other hosts do not replace that job.
The Unix-installer discovery case runs on Linux/macOS only because its optional
Debian/RPM parents are not installed on Windows. Shared glob tests resolve through
ASAR on every platform; the remaining Windows consumer tests must run normally.

Keep `install-links=true` in both workspaces: the adapters must be packed, not
symlinked. npm can accept an incorrectly hoisted graph after override changes;
a successful install alone is insufficient. The consumer-resolution test must
pass after any lockfile regeneration. Preserve unrelated locked versions.

Both npm workspaces retain a seven-day minimum release age for newly resolved
registry versions. Keep the locked patched versions and the existing install-links
setting when refreshing dependencies. Use npm 11.10 or newer in both workspaces:
[npm 11.10 introduced `min-release-age`](https://github.com/npm/cli/releases/tag/v11.10.0),
so older clients cannot apply this policy. The manifests record this minimum;
`npm ci` still installs the versions already selected in the lockfile.
