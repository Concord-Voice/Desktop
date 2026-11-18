# Test hygiene sweep (2026-11-18) — Design

Ad-hoc, issueless. Part of the weekly Desktop hygiene sweep. This slice covers test code only:
`desktop/tests/**` and `desktop/scripts/voice-runtime-probe/witness-contract.test.mjs`.
Production code under `desktop/src/**` is out of scope. If a test finding shows a production
bug, the PR body records it and the fix goes to the production-code slice.

## Inputs

- SonarCloud `typescript:S5906` ("use a dedicated matcher"): 172 open issues in 77 test files.
- GitHub CodeQL Code Quality findings on test files: #15, #16, #22–#50.

## Decisions

1. **`expect(x.length).toBe(n)` becomes `expect(x).toHaveLength(n)`** when `x` is array-like
   (an array, a `NodeList`, a string, a `Buffer`/typed array, or `mock.calls`). The failure
   message then prints the collection, not only two numbers. The assertion is the same.
2. **Not array-like → false positive.** Three subjects have a numeric `length` field that is not
   a collection size: `AesKeyAlgorithm` (key size in bits, 2 rows), `EditVerdict` (character
   count, 4 rows) and `ByteReader` (byte span, 2 rows). `toHaveLength` would pass, but it reads
   as "a collection of n items", which is wrong. These 8 rows are marked false positive in
   SonarCloud with that reason and recorded in `docs/ci/sonarqube-false-positive-register.md`.
3. **Other dedicated-matcher variants:** `toBe(null)` becomes `toBeNull()`, and
   `expect(a === b).toBe(true)` becomes `expect(a).toBe(b)`, with no loss of strength.
4. **`mock.calls.length`** may become `toHaveBeenCalledTimes(n)` where the expression is a plain
   mock. `toHaveLength(n)` on `.mock.calls` is also accepted.
5. **CodeQL dead code** (unused imports and variables, useless assignments, a superfluous
   argument, an overwritten property) is removed. When a "useless" comparison or assignment is
   a weak assertion (for example, a value the test computed and then never checked), the test is
   made stronger, not deleted.
6. No assertion is weakened, no test is skipped, no production file changes.
7. **Semgrep parse safety.** A touched test file that uses
   `importOriginal<typeof import('…')>()` is changed to a type-only namespace import
   (`import type * as M from '…'` and `importOriginal<typeof M>()`), because Semgrep cannot
   parse the inline form and the scan covers changed files. See
   `.claude/rules/domains/desktop-tests.md`.

## Acceptance criteria

- Every S5906 row is fixed or marked false positive with a reason.
- Every listed CodeQL finding is fixed, or the PR body explains why it is not a defect.
- `npm run test:unit`, `npm run lint` and `npm run typecheck` in `desktop/` are green.
- `git diff --name-only origin/main` lists only test files and these two docs.
- The PR body lists counts fixed vs. marked false positive, with each false positive's reason.
