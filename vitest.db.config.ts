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
      // ── THRESHOLD POLICY (2026-08-12) ──────────────────────────────────
      // Floors sit BELOW the measured actual rather than at it: -2pp for the
      // aggregate keys, -3pp for the per-glob entries.
      //
      // They previously sat AT the measured actuals, "a hair under". That
      // left 0.15–0.65pp of headroom, which is not a gate — it is a tripwire
      // on rounding. Adding one modestly-sized untested file to any of these
      // globs moves the number by more than that, so the next person to
      // touch this code would have hit a red CI with no regression in it and
      // learned to edit the numbers to make it pass. A gate that gets edited
      // to pass is worse than no gate, because it still reads as protection.
      //
      // The buffers differ because the denominators do. Measured on the unit
      // run by deleting one test file: the aggregate moved 0.36pp while a
      // three-file glob moved 1.15pp. Aggregates barely move; small globs
      // swing. So the aggregate can afford a tighter floor than a glob can.
      //
      // BE HONEST ABOUT WHAT THESE CATCH. They catch a large untested landing
      // or wholesale test removal. They do NOT reliably catch one deleted test
      // file — that moves the aggregate by a third of a point, and no
      // threshold can distinguish it from rounding without firing on rounding
      // too. The guard for THAT is the test-count floor in
      // .gitea/workflows/ci.yml, which asserts the suite actually ran.
      //
      // The ratchet is preserved by RE-BASELINING UPWARD when actuals rise
      // materially — not by pinning to the last measurement.
      //
      // Actuals as of 2026-08-13 (stmts/branch/funcs/lines), re-measured in
      // Task 12 (a0). The previous set recorded here (47.41 / 81.04 / 60.43,
      // auth-guard 86.36 / 80.95 / 91.66) predated Tasks 9b-11 and was already
      // stale before Task 12 touched anything — measured at Task 12's parent
      // commit, all-files was 49.37 / 79.22 / 61.82. Task 12 itself moved only
      // statements/lines (49.37 -> 48.67), and only by growing the denominator:
      // it added statements to src/worker/judgment-consumer.ts, which this run
      // never imports. Prose only — no threshold below was touched.
      //
      // NOTE for the end-of-branch re-baseline: the branches actual (79.37)
      // sits ~0.4pp above its floor of 79, not the -2pp this file's own policy
      // calls for. That margin predates Task 12 (79.22 at its parent commit);
      // flagged here rather than fixed, since floors are frozen mid-branch.
      //   all-files            48.67 / 79.37 / 61.82 / 48.67
      //   auth-guard.ts        87.37 / 84.61 / 91.66 / 87.37
      //   scripts/importer/**  96.42 / 87.58 / 98.63 / 96.42
      thresholds: {
        lines: 45,
        functions: 58,
        branches: 79,
        statements: 45,
        'src/lib/auth-guard.ts': { statements: 83, functions: 88, branches: 77, lines: 83 },
        'scripts/importer/**': { statements: 93, functions: 95, branches: 84, lines: 93 },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
