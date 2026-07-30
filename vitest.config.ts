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
      // `coverage.thresholds`) for the subsystems 1a excluded, set to this
      // run's actual measured coverage (see CONTRIBUTING.md) — tight enough
      // that a regression fails CI, loose enough that today's numbers pass.
      // IMPORTANT: the top-level lines/functions/branches/statements keys
      // below are an AGGREGATE floor over every file matched by `include`
      // (not just files left over after the per-glob entries) — vitest
      // checks both independently. Actuals as of Task 17 (2026-07-30):
      // all-files 35.1/82.93/64.7/35.1 (stmts/branch/funcs/lines); the
      // aggregate is dragged down by worker/importer/realtime/auth-guard,
      // which are exercised by test:db/test:integration, not this DB-free
      // unit run (see vitest.db.config.ts + CONTRIBUTING.md's "Test
      // coverage" section for where those actually get measured).
      thresholds: {
        lines: 35,
        functions: 64,
        branches: 82,
        statements: 35,
        // queue/connection.ts is unit-tested (tests/lib/queue-connection.test.ts);
        // publish.ts/topology.ts are exercised by test:integration/test:db
        // instead. Actual: 47.3/84.37/73.33/47.3.
        'src/lib/queue/**': { statements: 46, functions: 72, branches: 84, lines: 46 },
        // Only dispatch-failure.ts is unit-tested; claim/main/reaper/*-consumer
        // are integration-only (tests/integration/**). Actual: 3.77/100/100/3.77.
        'src/worker/**': { statements: 3, functions: 100, branches: 100, lines: 3 },
        // Provider backends + resilience/registry/render are heavily unit-tested.
        // Actual: 93.91/84.96/97.36/93.91.
        'src/lib/llm/**': { statements: 90, functions: 95, branches: 80, lines: 90 },
        // auth-guard.ts is exercised transitively through API route handlers
        // under a live DB (tests/db/access-matrix.test.ts) — not reachable
        // from this DB-free run at all. Real gate: vitest.db.config.ts
        // (actual there: 86.15/80.95/91.66/86.15).
        'src/lib/auth-guard.ts': { statements: 0, functions: 0, branches: 0, lines: 0 },
        // Only cli.ts is unit-tested; owners/judges/runs/artifacts.ts need a
        // live v1 scratch DB + v2 test DB (tests/importer/*.db.test.ts,
        // vitest.db.config.ts — actual there: 96.42/87.58/98.63/96.42).
        // Actual here: 6.15/83.87/10.29/6.15.
        'scripts/importer/**': { statements: 6, functions: 10, branches: 83, lines: 6 },
        // Only ownership.ts is unit-tested; bus/redis-bus/factory/in-memory-bus/
        // events/types are exercised by tests/integration/{realtime,sse-lifecycle}.test.ts.
        // Actual: 1.57/80/71.42/1.57.
        'src/lib/realtime/**': { statements: 1, functions: 70, branches: 79, lines: 1 },
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
