/** @type {import('ts-jest').JestConfigWithTSJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/printers/printer-resolver.ts',
    'src/printers/printer-roles.ts',
    'src/api/origin-policy.ts',
    'src/escpos/builder.ts'
  ],
  // The Windows-facing modules shell out to PowerShell; they are exercised by
  // the integration harness (scripts/deep-qa.js) against a real machine rather
  // than mocked here, where the mock would only assert our own assumptions.
  testTimeout: 15000
};
