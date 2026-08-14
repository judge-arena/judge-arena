import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts'],
    // tests/db/** requires a live Postgres connection and is run separately
    // via `npm run test:db` (see vitest.db.config.ts) so plain `npm test`
    // stays green in environments without a database. Same reasoning for
    // tests/importer/**/*.db.test.ts (needs BOTH the v1 scratch DB and the
    // v2 test DB reachable) — note this exclude is necessary in addition to
    // the `.db.test.ts` naming convention: `tests/**/*.test.ts` above still
    // matches those filenames (they end in `.test.ts`), so without this
    // exclude they'd be picked up here too. tests/integration/** requires a
    // live Redis connection and is run separately via `npm run
    // test:integration` (see vitest.integration.config.ts), same reasoning.
    exclude: [
      'node_modules',
      '.next',
      'prisma',
      'tests/db/**',
      'tests/importer/**/*.db.test.ts',
      'tests/integration/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      // Task 17 (1b): broadened from the 1a-era `src/lib/**/*.ts` to also
      // pull in src/worker/** and scripts/importer/** — the 1b-rewritten
      // subsystems (queue, worker, providers/llm, auth-guard, importer,
      // realtime) are no longer coverage-blind. See CONTRIBUTING.md's "Test
      // coverage" section for what each of the 3 vitest configs (this one,
      // vitest.db.config.ts, vitest.integration.config.ts) actually measures
      // — coverage is NOT merged across them, each gates on its own actuals.
      include: ['src/lib/**/*.ts', 'src/worker/**/*.ts', 'scripts/importer/**/*.ts'],
      exclude: [
        'src/lib/db.ts',
        'src/**/*.test.ts',
        // Integration-level code requiring external services (DB, APIs) that
        // this DB-free unit run structurally cannot exercise — these remain
        // pass/fail-verified by test:db/test:integration, just not
        // coverage-gated by any of the 3 configs (documented limitation).
        'src/lib/auth.ts',
        'src/lib/env.ts',
        'src/lib/logger.ts',
        'src/lib/pagination.ts',
        'src/lib/huggingface.ts',
        'src/lib/run-launch.ts',
        'src/lib/judge-identity.ts',
        'src/lib/dataset-evaluation-summary.ts',
        'src/lib/dataset-run-groups.ts',
        'src/lib/export.ts',
        'src/lib/audit.ts',
      ],
      // Task 17 (1b): per-directory thresholds (vitest glob-keyed
      // `coverage.thresholds`) for the subsystems 1a excluded.
      // IMPORTANT: the top-level lines/functions/branches/statements keys
      // below are an AGGREGATE floor over every file matched by `include`
      // (not just files left over after the per-glob entries) — vitest
      // checks both independently. The aggregate is dragged down by
      // worker/importer/realtime/auth-guard, which are exercised by
      // test:db/test:integration, not this DB-free unit run (see
      // vitest.db.config.ts + CONTRIBUTING.md's "Test coverage" section for
      // where those actually get measured).
      //
      // ── THRESHOLD POLICY (2026-08-12) ──────────────────────────────────
      // Floors sit BELOW the measured actual rather than at it: -2pp for the
      // aggregate keys, -3pp for the per-glob entries. See vitest.db.config.ts
      // for the full argument; the short version is that a sub-1pp margin is a
      // tripwire on rounding, not a gate, and the predictable response to one
      // is someone editing the number until it goes green.
      //
      // The two buffers differ because the denominators do. Measured, by
      // deleting tests/lib/backends.test.ts and re-running: the AGGREGATE
      // moved 0.36pp (35.20 -> 34.84) while src/lib/llm/** moved 1.15pp
      // (93.97 -> 92.82). Aggregates over ~2k statements barely move; a glob
      // of three files swings several points from one file.
      //
      // THIS run is reproducible — five runs at the 2026-08-13 re-baseline
      // returned byte-identical numbers on every key. The DB run is NOT (see
      // the jitter section in vitest.db.config.ts: ±2 branches run to run with
      // nothing changed). Do not assume determinism here means determinism
      // there when re-baselining the two together.
      //
      // ── THE 100s BELOW ARE NOT COVERAGE. READ THIS BEFORE RAISING THEM ──
      // `src/worker/**` reports branches 100 / functions 100 alongside
      // statements 3.4. That is not a well-tested subsystem: only
      // dispatch-failure.ts is imported by this DB-free unit run, so v8
      // reports branches and functions for that file alone (10/10 and 6/6)
      // and nothing at all for its six siblings.
      //
      // Pinning a floor to that artifact inverts the incentive: the first
      // real unit test that imports src/worker/reaper.ts would surface its
      // genuine branch coverage (well under 100), drag the glob average down,
      // and fail this gate — so the config would punish exactly the change it
      // exists to encourage. The floors for those entries are therefore set
      // deliberately low, and they are floors against gross regression only.
      // The real coverage for worker/realtime/queue-publish lives in
      // test:db and test:integration.
      //
      // THE 2026-08-13 RE-BASELINE DELIBERATELY DID NOT APPLY -3pp TO THOSE
      // TWO KEYS. Policy applied literally would set src/worker/** functions
      // and branches to 97, which is precisely the inversion described above:
      // it would hard-code the not-imported artifact as a requirement. They
      // stay at 80. This carve-out is part of the policy, not an exception to
      // it — the -3pp rule assumes the measured number means what it says.
      // src/lib/realtime/** is the same shape (80 / 71.42 are mostly
      // not-imported artifact); there, -3pp happens to reproduce the floors
      // already in place, so no judgement call was needed.
      //
      // ── ACTUALS: END-OF-BRANCH RE-BASELINE (2026-08-13) ─────────────────
      // Every floor in this file was re-measured and re-set here, once,
      // deliberately, with both coverage configs visible at the same time, at
      // the end of feat/a0-golden-set-substrate. Floors were frozen for that
      // branch's 24 tasks so no single task could ratchet them. This block
      // replaces the per-task narration Tasks 12, 24, 14 and 19-22 layered on.
      //
      // Five runs of `npm run test:coverage`, all identical
      // (stmts / branch / funcs / lines):
      //   all-files            37.69 / 84.91 / 67.54 / 37.69   <- see UPDATE
      //   src/lib/queue/**     47.30 / 84.37 / 73.33 / 47.30
      //   src/worker/**         3.40 / 100   / 100   /  3.40   <- artifact
      //   src/lib/llm/**       94.62 / 86.72 / 97.64 / 94.62
      //   src/lib/auth-guard.ts 0    /  0    /  0    /  0      <- not imported
      //   scripts/importer/**   6.15 / 83.87 / 10.29 /  6.15
      //   src/lib/realtime/**   1.55 / 80    / 71.42 /  1.55
      //
      // CORRECTION worth knowing about if you re-measure by eye from the text
      // reporter: the src/lib/llm/** figures above are the GLOB total, which
      // includes src/lib/llm/backends/** (three files, all at 100%). The text
      // reporter prints `src/lib/llm` as its own row EXCLUDING that
      // subdirectory (94.50 / 86.57 / 97.56), and every prose block in this
      // file from Task 11 to Task 22 recorded that row as if it were the glob
      // actual. It is not, and it is what a glob threshold is checked against.
      // The floors for that entry were ~0.1pp tighter than intended as a
      // result. Verified by running vitest with --coverage.thresholds.autoUpdate
      // against a throwaway copy of this config and reading back what vitest
      // itself computed — the reliable way to get glob actuals.
      //
      // ── UPDATE: FINAL FIX WAVE (2026-08-13, after the re-baseline) ──────
      // PROSE ONLY. No floor below is touched — the re-baseline above stands,
      // and the wave moved actuals UP, so every margin widened.
      //
      // Four runs of `npm run test:coverage`, all identical:
      //   all-files            38.22 / 85.19 / 68.14 / 38.22
      //
      // Nothing else moved and nothing else could: the wave added
      // `findGoldenSetsPinningDataset`, `assertGoldenSetInCirculation`,
      // `assertGoldenSetNotTombstoned` and `GoldenSetNotInCirculationError` to
      // src/lib/golden-sets.ts (the last two MOVED there from
      // src/app/api/golden-sets/[id]/items/route.ts, which no coverage config
      // includes), all four unit-tested in tests/lib/golden-sets.test.ts —
      // that file is now 94.68 / 98.14 / 94.44 / 94.68, its only uncovered
      // lines being `nextGoldenItemIndex`, which needs a live DB. No file
      // under any per-glob entry was touched by this wave.
      thresholds: {
        lines: 35,
        functions: 65,
        branches: 82,
        statements: 35,
        // queue/connection.ts is unit-tested (tests/lib/queue-connection.test.ts);
        // publish.ts/topology.ts are exercised by test:integration/test:db
        // instead. Actual: 47.30/84.37/73.33/47.30.
        'src/lib/queue/**': { statements: 44, functions: 70, branches: 81, lines: 44 },
        // Only dispatch-failure.ts is unit-tested; claim/main/reaper/*-consumer
        // are integration-only (tests/integration/**). Actual: 3.40/100/100/3.40
        // — where those two 100s are the not-imported artifact, not coverage,
        // which is why functions/branches are NOT set to actual-minus-3.
        'src/worker/**': { statements: 0, functions: 80, branches: 80, lines: 0 },
        // Provider backends + resilience/registry/render are heavily unit-tested.
        // Actual: 94.62/86.72/97.64/94.62 — the GLOB total, backends/** included.
        'src/lib/llm/**': { statements: 91, functions: 94, branches: 83, lines: 91 },
        // auth-guard.ts is exercised transitively through API route handlers
        // under a live DB (tests/db/access-matrix.test.ts) — not reachable
        // from this DB-free run at all, so it measures a literal 0/0/0/0 here
        // and -3pp clamps to zero. Real gate: vitest.db.config.ts
        // (actual there: 87.37/85.07/91.66/87.37).
        'src/lib/auth-guard.ts': { statements: 0, functions: 0, branches: 0, lines: 0 },
        // Only cli.ts is unit-tested; owners/judges/runs/artifacts.ts need a
        // live v1 scratch DB + v2 test DB (tests/importer/*.db.test.ts,
        // vitest.db.config.ts — actual there: 96.42/87.52-87.58/98.63/96.42).
        // Actual here: 6.15/83.87/10.29/6.15.
        'scripts/importer/**': { statements: 3, functions: 7, branches: 80, lines: 3 },
        // Only ownership.ts is unit-tested; bus/redis-bus/factory/in-memory-bus/
        // events/types are exercised by tests/integration/{realtime,sse-lifecycle}.test.ts.
        // Actual: 1.55/80/71.42/1.55 — the 80/71.42 are mostly the same
        // not-imported artifact as src/worker/**.
        'src/lib/realtime/**': { statements: 0, functions: 68, branches: 77, lines: 0 },
      },
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
