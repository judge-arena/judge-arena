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
    include: ['tests/db/**/*.test.ts', 'tests/importer/**/*.db.test.ts'],
    // DB test files all share one live Postgres instance and each file's
    // `beforeEach(truncateAll)` truncates every table. Running test *files*
    // in parallel (Vitest's default) lets one file's truncate race another
    // file's in-flight test, producing nondeterministic FK/P2025 failures.
    // Tests within a single file already run sequentially (no `.concurrent`
    // usage anywhere in tests/db/**), so forcing cross-file sequencing here
    // is sufficient and keeps the DB suite deterministic.
    fileParallelism: false,
    // Task 17 (1b): this run is where `src/lib/auth-guard.ts` and most of
    // `scripts/importer/**` actually execute (access-matrix.test.ts drives
    // auth-guard transitively through the real API route handlers under a
    // live DB; the importer/*.db.test.ts files exercise owners/judges/runs/
    // artifacts against both the v1 scratch DB and the v2 test DB) — the
    // DB-free unit run (vitest.config.ts) shows these near-0%. Same
    // include set as vitest.config.ts's coverage so the two reports are
    // directly comparable; see CONTRIBUTING.md's "Test coverage" section
    // for why coverage isn't merged into one number across the 3 configs.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      reportsDirectory: './coverage-db',
      include: ['src/lib/**/*.ts', 'src/worker/**/*.ts', 'scripts/importer/**/*.ts'],
      exclude: [
        'src/lib/db.ts',
        'src/**/*.test.ts',
        'src/lib/env.ts',
        'src/lib/logger.ts',
      ],
      // Actuals as of Task 17 (2026-07-30): all-files 47.31/80.84/60.58/47.31
      // (stmts/branch/funcs/lines), auth-guard.ts 86.15/80.95/91.66/86.15,
      // scripts/importer/** 96.42/87.58/98.63/96.42 — thresholds below are
      // each set at or a hair under those, per file/glob.
      thresholds: {
        lines: 47,
        functions: 60,
        branches: 80,
        statements: 47,
        'src/lib/auth-guard.ts': { statements: 86, functions: 91, branches: 80, lines: 86 },
        'scripts/importer/**': { statements: 96, functions: 98, branches: 87, lines: 96 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
