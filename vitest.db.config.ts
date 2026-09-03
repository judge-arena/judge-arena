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
        // This DB run only LOADS src/lib/calibration/latency.ts transitively
        // (launch.ts imports judgeThroughputEstimate/budgetWarningFor for the
        // stacked-limits warning) and exercises only a handful of its
        // branches through that wiring — the db tests here drive "does
        // launch.ts call the right functions with the right values", not the
        // arithmetic in latency.ts itself. Its real gate is the unit run
        // (vitest.config.ts), where it measures 100% lines / 100% branches
        // (166/166 lines, 67/67 branches, 10/10 functions —
        // coverage/lcov.info, measured 2026-09-02 on 58139bb). Excluding it
        // here keeps this DB run's report honest about what it actually
        // exercises, the same class of entry as src/lib/auth.ts /
        // src/lib/audit.ts above.
        'src/lib/calibration/latency.ts',
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
      // ── RUN-TO-RUN JITTER: WHY THE BUFFER BEATS THE POINT ESTIMATE ─────
      // This suite's branch coverage is NOT reproducible run to run with the
      // code held fixed. Both the numerator AND the denominator move, by up
      // to ±2 branches, across runs with nothing changed:
      //   Task 15      (2 runs)   685/865, 685/864
      //   Task 18     (10 runs)   685/865 ×7, 687/866 ×2, 683/863 ×1
      //   Tasks 19-22  (4 runs)   691/871 ×3, 693/872 ×1
      //   This re-baseline (10)   691/871 ×8, 693/872 ×1, 689/869 ×1
      // On a denominator near 870 that is roughly ±0.23pp of pure noise on a
      // clean tree. A margin smaller than the jitter is not a margin — CI can
      // land under the floor with nobody having touched a line. This is the
      // strongest single argument for the buffers above: the point estimate
      // is not stable enough to floor against. So do NOT re-baseline by
      // pinning a floor to one lucky run — measure at least three times and
      // take the LOWEST value observed, which is what the floors below are.
      //
      // At this re-baseline the jitter localises to exactly two files, both
      // moving in the same shape (covered and total rising together):
      // scripts/importer/artifacts.ts (105/116 <-> 107/118) and
      // src/lib/golden-set-versions.ts (13/21 <-> 15/22). Root cause is still
      // unidentified; v8 attributes a different branch set depending on which
      // paths actually executed, so module-load ordering or a timing-dependent
      // path remains the likely culprit. NOTE this also falsifies the claim
      // made repeatedly in the prose this block replaces, that the per-glob
      // entries were stable across runs: scripts/importer/** moves too
      // (87.52 <-> 87.58). It is only the aggregate that anyone had watched
      // closely enough to notice.
      //
      // BE HONEST ABOUT WHAT THESE CATCH. They catch a large untested landing
      // or wholesale test removal. They do NOT reliably catch one deleted test
      // file — that moves the aggregate by a third of a point, and no
      // threshold can distinguish it from rounding without firing on rounding
      // too. The guard for THAT is the test-count floor in
      // .gitea/workflows/ci.yml, which asserts the suite actually ran.
      //
      // The ratchet is preserved by RE-BASELINING UPWARD when actuals rise
      // materially — not by pinning to the last measurement. Re-baselining a
      // floor DOWNWARD is legitimate in exactly one situation: the floor is
      // TIGHTER than the buffer this policy mandates, on a suite that is
      // green. Restoring a mandated buffer on a passing gate is repairing the
      // gate, not weakening it. Lowering a floor to turn a RED run green is
      // never legitimate — that is the failure mode this whole block exists
      // to prevent.
      //
      // ── ACTUALS: END-OF-BRANCH RE-BASELINE (2026-08-13) ─────────────────
      // Every floor in this file was re-measured and re-set here, once,
      // deliberately, with both coverage configs visible at the same time, at
      // the end of feat/a0-golden-set-substrate. Floors were frozen for that
      // branch's 24 tasks precisely so that no single task could ratchet them
      // and no later task could trip a floor a predecessor had tightened.
      // This block replaces the per-task narration Tasks 12, 14, 18 and 19-22
      // each layered on; several of those notes were stale by the time the
      // branch ended, and one was wrong (see auth-guard below).
      //
      // Ten runs of `npm run test:db:coverage` (stmts / branch / funcs / lines):
      //   all-files            49.17 / 79.28-79.47 / 62.58 / 49.17
      //   auth-guard.ts        87.37 / 85.07       / 91.66 / 87.37
      //   scripts/importer/**  96.42 / 87.52-87.58 / 98.63 / 96.42
      // Only the branches column moved; statements, functions and lines were
      // identical on all ten runs. Floors are the lowest value in each range
      // minus the policy buffer, rounded DOWN to the integer style already in
      // use here. Every resulting margin (2.17-3.63pp) exceeds the ±0.23pp
      // jitter by at least 9x.
      //
      // Two corrections the frozen-floor rule had deferred landed here:
      //   - branches: floor was 79 against an actual of 79.28-79.47. That is
      //     a 0.28pp margin where policy calls for 2pp — six times too tight,
      //     and only 0.05pp clear of the jitter's own low. Tasks 12, 14 and
      //     18 each flagged it and correctly left it alone. Now 77.
      //   - auth-guard.ts branches: floor was 77 against an actual of 85.07
      //     (57/67), i.e. 8pp of slack where policy calls for 3. The prose
      //     from Task 12 onward recorded this actual as 84.61 (55/65) and
      //     asserted it never moved; it did, consistent with the golden-set
      //     rows Tasks 19-22 added to tests/db/access-matrix.test.ts reaching
      //     two further branches. Now 82.
      //
      // ── UPDATE: FINAL FIX WAVE (2026-08-13, after the re-baseline) ──────
      // PROSE ONLY. No floor below is touched — the wave moved actuals UP, so
      // every margin widened.
      //
      // Three runs of `npm run test:db:coverage` (444 tests, 35 files), all
      // three IDENTICAL including the branches column that jitters above:
      //   all-files            49.55 / 79.59 / 63.19 / 49.55
      //   auth-guard.ts        87.37 / 85.07 / 91.66 / 87.37   (unmoved)
      //   scripts/importer/**  96.42 / 87.58 / 98.63 / 96.42   (top of range)
      //
      // Three identical runs is NOT evidence the jitter is gone — the ranges
      // above were observed over ten. Read these as "one more sample inside
      // the same band", which is exactly why the floors carry a buffer rather
      // than tracking the point estimate.
      thresholds: {
        lines: 47,
        functions: 60,
        branches: 77,
        statements: 47,
        'src/lib/auth-guard.ts': { statements: 84, functions: 88, branches: 82, lines: 84 },
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
