import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintPluginReact from 'eslint-plugin-react';
import eslintPluginReactHooks from 'eslint-plugin-react-hooks';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  // Global ignores (replaces ignorePatterns)
  {
    ignores: ['dist/', 'node_modules/', '*.js'],
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
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
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
    },
  },
];
