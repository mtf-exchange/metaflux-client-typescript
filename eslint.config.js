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
  {
    // Wire values are exact decimal strings. `Number` and `parseFloat` return
    // an IEEE-754 double, which holds 15-17 significant digits — a share count
    // carries up to 18 fraction digits and a wei balance far more. So the
    // conversion silently changes the number, and the result still looks like a
    // plausible amount. WARN, not error: reading a small field as a number is
    // sometimes fine, and the author is the one who can tell.
    files: ['src/types/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'warn',
        {
          name: 'parseFloat',
          message:
            'A wire value is an exact decimal string. parseFloat drops digits past a double. Keep the string, or use a decimal library.',
        },
        {
          name: 'parseInt',
          message:
            'A wire value is an exact decimal string. parseInt truncates at the decimal point and past 2^53. Keep the string, or use BigInt.',
        },
      ],
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.name='Number']",
          message:
            'A wire value is an exact decimal string. Number() drops digits past a double. Keep the string, or use a decimal library.',
        },
      ],
    },
  },
);
