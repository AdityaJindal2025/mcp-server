import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: process.env.LIVE_TESTS ? [] : ['test/live/**'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        'src/lib/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
      },
    },
  },
});
