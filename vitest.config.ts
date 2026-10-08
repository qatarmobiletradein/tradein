import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Database tests share one throwaway server; run files one at a time
    // so connection counts and timings stay predictable.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
