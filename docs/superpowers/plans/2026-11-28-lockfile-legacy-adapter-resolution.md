# Desktop lockfile refresh compatibility guard

## Implementation plan

1. Extend the refresh fixture with a partial ASAR adapter loss while its root copy remains.
2. Validate nearest lockfile resolution before the refresh can open a PR.
3. Verify the existing graph and fixture suite and check the workflow syntax.
