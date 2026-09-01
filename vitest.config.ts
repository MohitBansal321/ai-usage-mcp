import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        // Static help text and the public re-export barrel have nothing to assert.
        'src/cli/commands/help.ts',
        'src/index.ts',
      ],
      // These are a regression floor, not a target, and they are calibrated to
      // the current provider's accounting -- the v8 provider changed how it maps
      // statements and branches between vitest 2 and 4, which moved every number
      // here without a line of source changing. Recalibrate after a major bump.
      //
      // The headline percentage understates real coverage: `src/cli/**`,
      // `src/mcp/**` and `src/version.ts` are exercised by the integration and
      // parity suites, which launch the CLI and the MCP server as child
      // processes. v8 cannot attribute a subprocess's lines back to this run, so
      // those directories report 0% despite every tool and command being
      // called end-to-end. They are deliberately left in the report rather than
      // excluded, so nobody is misled about what is measured in-process.
      thresholds: {
        statements: 58,
        branches: 47,
        functions: 60,
        lines: 60,
      },
    },
  },
});
