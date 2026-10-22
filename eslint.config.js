// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['dist/', 'build/', 'release/', '.cache/', 'coverage/', 'node_modules/', 'legacy/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // Build and QA scripts are plain Node.
    files: ['scripts/**/*.{js,mjs}', 'eslint.config.js', 'jest.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    rules: {
      // Catch blocks that deliberately ignore an error are common here and
      // always carry a comment saying why.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Timers declared before the cleanup closure that clears them.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // sql.js rows and a few JSON boundaries are untyped by nature.
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
);
