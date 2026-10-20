import { defineConfig } from 'vitest/config';

// Integration tests need a real PostgreSQL. The global setup starts an embedded server (or uses
// TEST_DATABASE_URL) and builds a migrated template database; each test file clones its own copy.
export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    globalSetup: ['server/test/helpers/global-setup.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 60_000,
    restoreMocks: true,
  },
});
