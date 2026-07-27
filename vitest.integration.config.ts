import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate config for integration tests (tests/integration/**) that need a
// live Redis instance (see .env.test's REDIS_URL, and the podman
// judge-arena-redis container). Kept out of the default `vitest.config.ts`
// include/exclude — same reasoning as vitest.db.config.ts for tests/db/**:
// plain `npm test` must stay green with no external services running.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // The rate limiter's atomicity test intentionally races many concurrent
    // `check()` calls against one shared Redis key, and the window-expiry
    // test is timing-sensitive. Running test *files* in parallel would let
    // one file's key churn/timing interfere with another's — force serial
    // execution, mirroring vitest.db.config.ts's fileParallelism:false for
    // the same "one shared external resource" reason.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
