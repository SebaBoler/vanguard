import tseslint from 'typescript-eslint';

// Lean, high-signal lint on top of strict TypeScript: typescript-eslint's non-type-checked
// `recommended` set (no full type-info pass — fast and low-noise). Ratchet stricter rules in later.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.mjs', '**/*.fixture.ts'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Underscore-prefixed names are the repo's intentional-unused convention.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
