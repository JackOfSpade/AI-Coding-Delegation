import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['artifacts/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
      // This codebase deliberately uses control-character regexes and empty
      // catch blocks for input hardening and best-effort cleanup. Keep lint
      // focused on actionable correctness issues rather than those idioms.
      'no-control-regex': 'off',
      'no-empty': 'off',
      'no-regex-spaces': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
      'preserve-caught-error': 'off',
      'require-yield': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
