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
    // exclude they'd be picked up here too.
    exclude: ['node_modules', '.next', 'prisma', 'tests/db/**', 'tests/importer/**/*.db.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'html'],
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/lib/db.ts',
        'src/**/*.test.ts',
        // Integration-level code requiring external services (DB, APIs, Redis)
        'src/lib/auth.ts',
        'src/lib/auth-guard.ts',
        'src/lib/env.ts',
        'src/lib/logger.ts',
        'src/lib/pagination.ts',
        'src/lib/huggingface.ts',
        'src/lib/evaluation-run-manager.ts',
        'src/lib/dataset-evaluation-summary.ts',
        'src/lib/dataset-run-groups.ts',
        'src/lib/export.ts',
        'src/lib/audit.ts',
        'src/lib/llm/**',
        'src/lib/realtime/**',
      ],
      thresholds: {
        lines: 60,
        functions: 70,
        branches: 50,
        statements: 60,
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
