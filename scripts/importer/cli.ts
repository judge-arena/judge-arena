#!/usr/bin/env npx tsx
/**
 * Judge Arena v1 -> v2 importer CLI.
 *
 * Usage:
 *   npm run import:v1 -- --mode=report --owner-map=owners.json
 *   npm run import:v1 -- --mode=apply  --owner-map=owners.json [--force]
 *
 * Modes (see ImportMode in ./context):
 *   report (default) - read-only: walks the v1 database (V1_DATABASE_URL)
 *                       and tallies what an import would do, without
 *                       writing to v2.
 *   apply             - performs the import against the v2 database
 *                       (DATABASE_URL). Refuses to run if the v2 database
 *                       already has any Project rows, unless --force is
 *                       passed — this guards against double-importing into
 *                       a database that already has real v2 data.
 *
 * Flags:
 *   --mode=report|apply   Defaults to "report".
 *   --owner-map=<path>    JSON file matching the OwnerMap shape (see
 *                         ./context). Required for --mode=apply; optional
 *                         for --mode=report (an empty map is used if
 *                         omitted, so report mode can run with zero setup).
 *   --force               Bypasses the apply-mode "no existing Project
 *                         rows" guard.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createImportCtx, type ImportCtx, type ImportMode, type OwnerMap } from './context';
import { resolveOwners } from './owners';
import { synthesizeJudges } from './judges';
import { importArtifacts } from './artifacts';
import { importRuns } from './runs';
import { reconcile, formatReconcileReport, mergeCollisionPreflight } from './reconcile';

const VALID_MODES: readonly ImportMode[] = ['report', 'apply'];

export interface ParsedArgs {
  mode: ImportMode;
  ownerMapPath?: string;
  force: boolean;
}

/**
 * Hand-rolled argv parser — deliberately no CLI-parsing dependency for a
 * three-flag surface. Throws a plain Error with a human-readable message on
 * any invalid input; callers (main()) turn that into a non-zero exit.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let mode: ImportMode = 'report';
  let ownerMapPath: string | undefined;
  let force = false;

  for (const arg of argv) {
    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!VALID_MODES.includes(value as ImportMode)) {
        throw new Error(`Invalid --mode: "${value}" (expected "report" or "apply")`);
      }
      mode = value as ImportMode;
      continue;
    }

    if (arg.startsWith('--owner-map=')) {
      ownerMapPath = arg.slice('--owner-map='.length);
      continue;
    }

    throw new Error(`Unrecognized argument: "${arg}"`);
  }

  if (mode === 'apply' && !ownerMapPath) {
    throw new Error('--mode=apply requires --owner-map=<path>');
  }

  return { mode, ownerMapPath, force };
}

/** Reads and JSON-parses the owner-map file. Throws if missing/invalid JSON. */
export function loadOwnerMap(path: string): OwnerMap {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as OwnerMap;
}

/**
 * apply mode refuses to run against a v2 database that already has Project
 * rows (a live database) unless --force is passed. report mode and
 * --force both short-circuit before touching the database.
 */
export async function assertApplyAllowed(ctx: ImportCtx, force: boolean): Promise<void> {
  if (ctx.mode !== 'apply' || force) return;

  const existingProjects = await ctx.v2.project.count();
  if (existingProjects > 0) {
    throw new Error(
      `Refusing to run --mode=apply: v2 database already has ${existingProjects} ` +
        'Project row(s). Pass --force to override.',
    );
  }
}

export interface RunImportResult {
  exitCode: number;
}

/**
 * The importer's full body of work, factored out of `main()` so tests can
 * drive it (and inspect its returned exit code) without `main()`'s own
 * `process.exit(...)` call tearing down the test process. `main()` below is
 * a thin wrapper: parse real argv, call this, exit with whatever it returns.
 *
 * Phase order (owners -> judges -> artifacts -> runs) matches the
 * dependency chain each phase's own module doc describes: resolveOwners's
 * map feeds every later phase; synthesizeJudges's map feeds importRuns;
 * importArtifacts's IdMaps feed both importRuns and reconcile.
 *
 * Mode semantics:
 *   - `report`: every phase runs (each no-ops its v2 writes internally per
 *     its own `ctx.mode !== 'apply'` guard — see owners.ts/judges.ts/
 *     artifacts.ts/runs.ts) so the printed tallies show what an apply run
 *     WOULD do. `reconcile` is deliberately NOT called — there is nothing
 *     to reconcile against yet (v2 stays untouched), so its row counts
 *     would trivially "fail" against an empty database.
 *   - `apply`: after all four phases actually write, `reconcile` runs and
 *     its `ok` flag is the program-doc abort criterion made real: `ok:false`
 *     forces `exitCode: 1` unconditionally. `--force` (see
 *     `assertApplyAllowed`) only bypasses the pre-existing-data guard
 *     before any phase runs — it has no effect on this check.
 */
export async function runImport(argv: string[]): Promise<RunImportResult> {
  // parseArgs/loadOwnerMap both throw synchronously — caught here, before
  // createImportCtx, so a bad argv or a missing/invalid owner-map file never
  // needs a ctx (and its Prisma clients) to be created just to be torn back
  // down again in a finally block.
  let args: ParsedArgs;
  let ownerMap: OwnerMap;
  try {
    args = parseArgs(argv);
    ownerMap = args.ownerMapPath ? loadOwnerMap(args.ownerMapPath) : {};
  } catch (e) {
    console.error('Import failed:', e instanceof Error ? e.message : e);
    return { exitCode: 1 };
  }

  const ctx = createImportCtx({ mode: args.mode, ownerMap });

  try {
    await assertApplyAllowed(ctx, args.force);

    // v1-only pre-flight (v2b, Task 6) — reported up front, in EITHER mode,
    // before any phase runs: how many ModelJudgment merge collisions (the
    // NULLS NOT DISTINCT DB-level backstop in ./runs.ts) this import is
    // about to hit. report mode has no other way to see this number (it
    // never attempts the v2 write that would actually conflict).
    const preflight = await mergeCollisionPreflight(ctx);
    console.log(
      `Pre-flight: ${preflight.runsWithCollisions} v1 run(s) have >=2 judgments mapping to the same ` +
        `synthesized JudgeModelVersion — expect ~${preflight.expectedDroppedJudgments} judgment(s) to merge ` +
        '(dropped, not lost — see the reconciliation report) under the NULLS NOT DISTINCT unique index.\n'
    );

    const owners = await resolveOwners(ctx);
    const judges = await synthesizeJudges(ctx, owners);
    const ids = await importArtifacts(ctx, owners);
    await importRuns(ctx, owners, ids, judges);

    console.log(JSON.stringify({ mode: ctx.mode, counts: ctx.report.counts() }, null, 2));

    if (ctx.mode !== 'apply') {
      console.log(
        '\nreport mode: reconciliation skipped (nothing written to v2 yet) — ' +
          'the counts above show what an apply run would do.'
      );
      return { exitCode: 0 };
    }

    const result = await reconcile(ctx, ids);
    console.log('\n' + formatReconcileReport(result));

    if (!result.ok) {
      console.error(
        '\nReconciliation FAILED — aborting per the program-doc abort criterion ' +
          '(architecture spec §8). See the failing row(s)/check(s) above; --force does ' +
          'not bypass this gate.'
      );
      return { exitCode: 1 };
    }

    return { exitCode: 0 };
  } catch (e) {
    console.error('Import failed:', e instanceof Error ? e.message : e);
    return { exitCode: 1 };
  } finally {
    // Each disconnect is isolated in its own try/catch: a throw from either
    // client (e.g. a network blip mid-teardown) must never reject this
    // finally block itself — that would turn an already-decided
    // exitCode/thrown-error above into an unhandled rejection instead,
    // masking the real outcome. Best-effort cleanup, never load-bearing for
    // the returned result.
    try {
      await ctx.v1.$disconnect();
    } catch (e) {
      console.error('Failed to disconnect v1 client:', e instanceof Error ? e.message : e);
    }
    try {
      await ctx.v2.$disconnect();
    } catch (e) {
      console.error('Failed to disconnect v2 client:', e instanceof Error ? e.message : e);
    }
  }
}

export async function main(): Promise<void> {
  const { exitCode } = await runImport(process.argv.slice(2));
  process.exit(exitCode);
}

// Only run when invoked directly (`tsx scripts/importer/cli.ts` / `npm run
// import:v1`) — not when this module is imported by tests.
const isDirectRun = (() => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error('Import failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
