# Desktop lockfile refresh compatibility guard

## Design

An npm re-hoist can remove a legacy consumer’s nested adapter while leaving the same file reference elsewhere in the lockfile. The pre-PR refresh guard must check the adapter resolved by each covered consumer using the lockfile’s ancestor order. The existing packaging tests continue to check the installed dependencies.
