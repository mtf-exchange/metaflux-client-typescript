import { defineConfig } from 'vitest/config';

// Minimal vitest config. The package.json `test` script invokes
// `vitest run` (no-watch CI mode); developers running `vitest`
// directly get watch mode.
//
// We intentionally do NOT pre-build the WASM artifact as a test
// hook — the sign.test.ts spec checks for `pkg/` and skips with a
// helpful pointer when it is absent. That keeps `vitest run` a
// pure-TS command runnable on a fresh clone before `wasm-pack`
// has run.
export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    environment: 'node',
    // WASM init in pkg/ is async; bump the per-test timeout to allow
    // for one-time WebAssembly.instantiate compilation.
    testTimeout: 10_000,
    globals: false,
  },
});
