import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginReact from 'eslint-plugin-react';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
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

  // React recommended (flat config)
  eslintPluginReact.configs.flat.recommended,

  // React JSX runtime (no need to import React in scope)
  eslintPluginReact.configs.flat['jsx-runtime'],

  // React hooks
  eslintPluginReactHooks.configs['recommended-latest'],

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
      },
    },

    settings: {
      react: { version: 'detect' },
    },

    rules: {
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

      // React
      'react/prop-types': 'off', // TypeScript handles this
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'warn',

      // React Hooks
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // General
      'no-console': ['warn', { allow: ['warn', 'error', 'debug'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/main/clientId', '**/main/clientId.ts', '**/main/clientId.js'],
          message: 'clientId.ts is RESERVED FOR SENTRY ANONYMIZATION. Any new import site requires security-reviewer approval.',
        }],
      }],

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

  // Electron main-process override (#706): forbid raw err/Error objects
  // as arguments to console.error/warn. Error.cause (ES2022) can propagate
  // refresh tokens, DSN strings, or HTTP response fragments up through a
  // catch-handler log even when the handler believes it is logging a
  // high-level error. Scoped to src/main/** because the audit (and the
  // corresponding rule in internal-reference) explicitly covers
  // Electron main-process code; a separate sweep of src/renderer/** is
  // tracked as future work outside #706 scope.
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
  // update tests/unit/main/eslint-no-raw-err-console.test.ts fixture 6.
  //
  // See internal-reference "Console error logging" and
  // internal-reference
  {
    files: ['src/main/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.type="MemberExpression"][callee.object.name="console"][callee.property.name=/^(error|warn)$/] > Identifier:last-child:not(:first-child)',
          message:
            'Do not pass raw err/Error objects to console.error/warn — err.cause (ES2022) may propagate secrets (refresh tokens, DSNs, HTTP response fragments). Use `(err as Error).message` instead. See internal-reference "Console error logging". If the raw argument is intentional (e.g., a safe structured detail), add `eslint-disable-next-line no-restricted-syntax -- <rationale>`.',
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

  {
    files: ['src/main/sentry.ts', 'tests/**/*'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // sentry-scrubbers.ts is content-hashed against TELEMETRY_POLICY_VERSION —
  // any source edit forces a policy-version bump that re-prompts every user
  // for telemetry consent. Adding `--` rationales to its two eslint-disable
  // directives would cosmetically edit the file for no behavioral reason.
  // Exempt this one file from require-description; the block comments
  // adjacent to each `eslint-disable` directive in `sentry-scrubbers.ts`
  // already document WHY the disables exist.
  {
    files: ['src/shared/sentry-scrubbers.ts'],
    rules: {
      '@eslint-community/eslint-comments/require-description': 'off',
    },
  },
];
