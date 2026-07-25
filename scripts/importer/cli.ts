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

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ownerMap: OwnerMap = args.ownerMapPath ? loadOwnerMap(args.ownerMapPath) : {};

  const ctx = createImportCtx({ mode: args.mode, ownerMap });

  try {
    await assertApplyAllowed(ctx, args.force);

    // PHASES (Tasks 8-10) run here — wired up in Task 10 along with
    // ./reconcile.ts's post-import verification gate:
    //   Task 8  - resolveOwners (./owners) + synthesizeJudges (./judges)
    //   Task 9  - importArtifacts (./artifacts: projects, rubrics+criteria,
    //             datasets+samples, evaluations) + importRuns (./runs:
    //             EvaluationRun, ModelJudgment, HumanJudgment)
    //   Task 10 - reconcile (./reconcile): row-count + provenance spot
    //             checks; apply mode exits non-zero on failure
    // Each phase reads through ctx.v1, writes through ctx.v2 when
    // ctx.mode === 'apply', and records outcomes via ctx.report.add(...).

    console.log(JSON.stringify({ mode: ctx.mode, counts: ctx.report.counts() }, null, 2));
  } finally {
    await ctx.v1.$disconnect();
    await ctx.v2.$disconnect();
  }
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
