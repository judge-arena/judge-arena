import { defineConfig } from 'vitest/config';
import path from 'path';

// Separate config for DB-backed tests (tests/db/**).
// Kept out of the default `vitest.config.ts` include/exclude so that plain
// `npm test` (unit run) never requires a live Postgres connection — only
// `npm run test:db` (which points DATABASE_URL/TEST_DATABASE_URL at the
// test database via .env.test) runs this suite.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    // DB test files all share one live Postgres instance and each file's
    // `beforeEach(truncateAll)` truncates every table. Running test *files*
    // in parallel (Vitest's default) lets one file's truncate race another
    // file's in-flight test, producing nondeterministic FK/P2025 failures.
    // Tests within a single file already run sequentially (no `.concurrent`
    // usage anywhere in tests/db/**), so forcing cross-file sequencing here
    // is sufficient and keeps the DB suite deterministic.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
