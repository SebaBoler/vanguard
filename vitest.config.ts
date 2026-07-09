import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Several suites (llm-proxy-server, egress-network, gc) spawn real child processes / docker probes;
    // their boot contends under parallel load, so give them headroom above vitest's 5s default.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude non-logic files: tests, fixtures, pure type declarations, barrel re-exports, CLI entry,
      // and the .mjs sidecar servers (not run under vitest).
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.fixture.ts',
        'src/**/types.ts',
        'src/index.ts',
        'src/*-labels.ts',
      ],
      reporter: ['text-summary'],
      // Floor set ~2pts below the 2026-07-04 baseline (stmts 80 / branch 69 / func 76 / lines 82) as a
      // ratchet: catches a real regression without flaking on v8's run-to-run variance. Raise over time.
      thresholds: { statements: 78, branches: 66, functions: 73, lines: 80 },
    },
  },
});
