import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Several suites (llm-proxy-server, egress-network, gc) spawn real child processes / docker probes;
    // their boot contends under parallel load, so give them headroom above vitest's 5s default.
    testTimeout: 20_000,
  },
});
