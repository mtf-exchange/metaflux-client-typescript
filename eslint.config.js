// ESLint v9 flat config. TypeScript-aware (syntax only — no type-checked rules,
// so it stays fast and doesn't need a tsconfig project wiring). `tsc` already
// does the type checking via `pnpm run typecheck`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'pkg/**', 'node_modules/**', 'wasm/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // TypeScript resolves identifiers; the core no-undef rule only produces
      // false positives on ambient/runtime globals here.
      'no-undef': 'off',
      // Allow intentionally-unused names prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
