import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintReact from '@eslint-react/eslint-plugin';
import eslintPluginEslintComments from '@eslint-community/eslint-plugin-eslint-comments';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  // Global ignores (replaces ignorePatterns)
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/**', // Istanbul HTML report artifacts
      '*.js',
    ],
  },

  // ESLint recommended + typescript-eslint recommended
  ...tseslint.configs.recommended,

  // React + JSX + hooks (unified — TypeScript-aware, type-checked rules)
  // Provides rules-of-hooks, exhaustive-deps, no-missing-key, and the full
  // @eslint-react/* rule set. recommended-type-checked is a strict superset
  // of recommended-typescript (includes type-aware DOM and web-api rules).
  // Requires parserOptions.projectService below for type-aware analysis.
  eslintReact.configs['recommended-type-checked'],

  // Prettier (must be last to override formatting rules)
  eslintConfigPrettier,

  // Project-specific configuration
  {
    plugins: {
      '@eslint-community/eslint-comments': eslintPluginEslintComments,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.node,
      },
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
        // Type-aware linting via typescript-eslint v8's projectService.
        // Auto-discovers tsconfig.json (covers renderer + preload via its
        // broad `include: ["src/**/*"]`) and tsconfig.main.json (main
        // process). Required for @eslint-react's recommended-type-checked
        // rules to function.
        //
        // allowDefaultProject: the two __lint-fixture__ paths are virtual
        // files used by eslint-no-raw-err-console.test.ts and
        // eslint-no-bare-anchor.test.ts — they pass a filePath to
        // ESLint.lintText() but those files don't exist on disk, so the
        // projectService rejects them. Listing them here lets the tests
        // run against the default TS project without the files being
        // present in tsconfig.json. Glob '**' is disallowed by ts-eslint,
        // so we list the two paths explicitly.
        projectService: {
          allowDefaultProject: [
            'src/main/__lint-fixture__.ts',
            'src/renderer/__lint-fixture__.tsx',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },

    // settings.react.version (for the legacy eslint-plugin-react) is no longer
    // needed — @eslint-react reads its version detection from
    // settings['react-x'].version, which the recommended-type-checked preset
    // sets to 'detect' for us.

    rules: {
      // @eslint-react/unsupported-syntax fires on three pattern groups inside
      // React components / hooks:
      //   (a) IIFEs in JSX, e.g. {(() => { if (x) return <A/>; return <B/>; })()}
      //   (b) eval calls
      //   (c) with statements
      // Case (a) is idiomatic in this codebase for complex conditional rendering
      // that cannot be cleanly expressed via ternary (~35 sites at time of
      // writing, 2026-05-13). The rule exists primarily to prevent React Compiler
      // from stumbling on these patterns, but this project does not use React
      // Compiler. Cases (b) and (c) are independently prohibited by internal-reference
      // and reviewed out at PR time via the RCI workflow + AI-Code Assurance —
      // not via this lint rule. If lint-level eval/with detection is desired
      // later, prefer the `no-eval` rule from eslint:recommended rather than
      // re-enabling unsupported-syntax with its IIFE noise. Extraction of the
      // IIFE sites to named helpers (and re-enabling this rule at error) is
      // tracked by #987 — dormant until either React Compiler is adopted or
      // a Compiler-dependent feature lands.
      '@eslint-react/unsupported-syntax': 'off',

      // Web-API leak rules promoted from `warn` (preset default) to `error`.
      // These rules catch resource-cleanup bugs in useEffect/useLayoutEffect
      // that silently leak fetch handles, event listeners, timers, and
      // observers across re-renders and unmounts. Resource leakage is a
      // correctness issue that should block CI, not a warning to skim past.
      //
      // Surfaced via the @eslint-react/recommended-type-checked preset
      // adoption in #530. See PR #986 review for rationale.
      '@eslint-react/web-api-no-leaked-fetch': 'error',
      '@eslint-react/web-api-no-leaked-event-listener': 'error',
      '@eslint-react/web-api-no-leaked-timeout': 'error',
      '@eslint-react/web-api-no-leaked-interval': 'error',
      '@eslint-react/web-api-no-leaked-resize-observer': 'error',

      // TypeScript — practical strictness
      // no-unused-vars / no-explicit-any / no-non-null-assertion promoted to
      // error severity repo-wide per #667. Test-file exemption below.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-require-imports': 'off', // Electron main process uses require()

      // React + Hooks: severities provided by @eslint-react's
      // recommended-type-checked preset already match our targets:
      //   @eslint-react/rules-of-hooks: error  (matches old react-hooks/rules-of-hooks)
      //   @eslint-react/exhaustive-deps: warn  (matches old react-hooks/exhaustive-deps)
      // The legacy react/prop-types, react/display-name, and
      // react/no-unescaped-entities rules have no equivalents enabled by
      // the @eslint-react preset, so no overrides are needed. See spec §4.3.

      // General
      'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-restricted-syntax': [
        'error',
        {
          selector: String.raw`CallExpression[callee.name=/^use\w+Store$/][arguments.length=0]`,
          message:
            'Use a selector: useXStore(s => s.field), not useXStore(). Whole-store subscriptions cause unnecessary re-renders. See #656.',
        },
      ],

      // Require a `--` rationale on every eslint-disable directive so future
      // readers and auditors (SonarQube AI-Code Assurance, code review) can
      // evaluate each suppression on its merits. "intentional" alone is
      // insufficient — rationales must cite the specific invariant.
      '@eslint-community/eslint-comments/require-description': [
        'error',
        { ignore: [] },
      ],
    },
  },

  // Forbid raw `err` / `Error` objects as console.error/warn arguments in
  // main-process code. `Error.cause` (ES2022) propagates underlying errors,
  // which can carry secret material — refresh tokens, response-body fragments —
  // up through any log sink (stdout, crash dumps, future telemetry).
  // See PR #714.
  //
  // NOTE: flat-config `files:`-scoped blocks OVERRIDE the global rules for
  // matched files. That means the global `no-restricted-syntax` (with its
  // `useXStore()` selector above) does NOT apply inside src/main/**. This
  // is harmless today because main-process code doesn't use React hooks,
  // but if future global `no-restricted-syntax` selectors should also apply
  // to main/, they must be duplicated into this override block as well.
  //
  // The selector's `:not(:first-child)` clause intentionally permits the
  // single-argument form `console.error(err)` (where the sole arg is both
  // first- and last-child). The audit found no such sites in src/main/,
  // and the rule targets the documented failure mode — `console.error('prefix',
  // err)` — so single-arg forms are out of scope. If this decision changes,
  // update the "permits single-argument console.error(err)" test case in
  // tests/unit/main/eslint-no-raw-err-console.test.ts.
  //
  // See internal-reference "Console error logging".
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.object.name="console"][callee.property.name=/^(error|warn)$/] > Identifier:last-child:not(:first-child)',
          message:
            'Do not pass raw err/Error objects to console.error/warn — err.cause (ES2022) may propagate secrets (refresh tokens, response-body fragments). Use `(err as Error).message` instead. See internal-reference "Console error logging". If the raw argument is intentional (e.g., a safe structured detail), add `eslint-disable-next-line no-restricted-syntax -- <rationale>`.',
        },
      ],
    },
  },

  // Drift defense for renderer external links (#754). The will-navigate
  // handler at client/desktop/src/main/main.ts has a runtime safety net
  // that externalizes bare <a href="https://..."> clicks to the OS browser,
  // but target="_blank" is the canonical pattern (it goes through
  // setWindowOpenHandler, which is the documented externalization path).
  // This rule prevents regression to bare anchors at authoring time.
  //
  // Selector scope: checks for the *presence* of the `target` attribute
  // and rejects the JSX element if absent. It does not statically verify
  // `target="_blank"` value or the `rel` attribute — asserting attribute
  // values across literal vs JSXExpression vs constant-import shapes is
  // brittle. The rule message documents the full convention.
  //
  // Out of scope by design: <a href={someVar}> and <a href={MODULE_CONST}>
  // are not flagged (variable hrefs aren't statically https; module
  // constants are hand-audited at definition time).
  //
  // See internal-reference
  //
  // Also widens the main-process raw-err console rule to renderer (the
  // raw-err selector previously lived in the src/main/** block; renderer
  // services / hooks / stores can leak just as readily — see PR #1046).
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      // IMPORTANT: flat-config files-scoped rules OVERRIDE the global
      // `no-restricted-syntax` for matched files (same caveat documented at
      // the src/main/** override above). When adding a renderer-scoped
      // selector, we MUST also re-list the global useXStore() selector here
      // so renderer files keep enforcing the #656 store-subscription rule.
      // Per Copilot review on PR #774.
      'no-restricted-syntax': [
        'error',
        // Re-listed from global rules: forbid useXStore() whole-store
        // subscriptions in renderer (see #656).
        {
          selector: String.raw`CallExpression[callee.name=/^use\w+Store$/][arguments.length=0]`,
          message:
            'Use a selector: useXStore(s => s.field), not useXStore(). Whole-store subscriptions cause unnecessary re-renders. See #656.',
        },
        // String-literal href shape: <a href="https://...">
        {
          selector:
            'JSXOpeningElement[name.name="a"]' +
            ':has(JSXAttribute[name.name="href"] > Literal[value=/^https:/])' +
            ':not(:has(JSXAttribute[name.name="target"]))',
          message:
            'Renderer <a href="https://..."> must use target="_blank" rel="noopener noreferrer". ' +
            'Bare anchors trigger the will-navigate drift safety net (which externalizes via ' +
            'shell.openExternal) but target="_blank" is the canonical pattern. ' +
            'See internal-reference',
        },
        // Template-literal href shape: <a href={`https://${x}/...`}>
        {
          selector:
            'JSXOpeningElement[name.name="a"]' +
            ':has(JSXAttribute[name.name="href"] > JSXExpressionContainer > TemplateLiteral[quasis.0.value.raw=/^https:/])' +
            ':not(:has(JSXAttribute[name.name="target"]))',
          message:
            'Renderer <a href={`https://...`}> must use target="_blank" rel="noopener noreferrer". ' +
            'See internal-reference',
        },
        // Raw-err logging guard — widened from src/main/** to src/renderer/**
        // per PR #1046. The renderer ws service was logging `event.target.url`
        // (containing the single-use auth ticket query param) via raw-Event
        // arguments. Same Error.cause / Error.message propagation concern
        // applies to all renderer code that catches exceptions from network,
        // crypto, or storage APIs. Annotated exceptions require an inline
        // `eslint-disable-next-line no-restricted-syntax -- <rationale>` per
        // internal-reference
        {
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.object.name="console"][callee.property.name=/^(error|warn)$/] > Identifier:last-child:not(:first-child)',
          message:
            'Do not pass raw err/Error objects to console.error/warn — err.cause (ES2022) may propagate secrets (auth tickets, refresh tokens, response-body fragments). Use `(err as Error).message` or `error instanceof Error ? error.message : "unknown"` instead. See internal-reference "Console error logging". If the raw argument is an audit-safe structured value (server-sent WS payload for diagnostics, etc.), add `eslint-disable-next-line no-restricted-syntax -- <rationale>`.',
        },
      ],
    },
  },

  // Test files: relaxed rules for mocks, partial fixtures, and scaffolding imports.
  // Production-code discipline (src/) still runs at error severity for all
  // three typing rules below. Test files get different posture because:
  //   - no-explicit-any: mocks often need `any` to spoof narrow interfaces
  //   - no-non-null-assertion: test fixtures set up known-good state where
  //     `!` on .find()/.get() is semantically equivalent to a "fail the
  //     test if the setup is wrong" assertion
  //   - no-unused-vars: scaffolding imports (React for JSX type inference,
  //     helper util imports kept for readability) are idiomatic
  //   - @eslint-community/eslint-comments/require-description: test-file
  //     disables don't need the same audit trail as production; new
  //     disables in src/ still require rationales
  // See spec: internal-reference
  {
    files: [
      'tests/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@eslint-community/eslint-comments/require-description': 'off',
    },
  },
];
