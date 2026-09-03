# Calibration Sampling Snapshot (v2k) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `CalibrationRun` records the RESOLVED sampling config (`{ temperature, max_tokens }`) it was launched under, so a historical run's config can never be rewritten by a later edit of the mutable `JudgeModelVersion.samplingDefaults`.

**Architecture:** One additive nullable JSONB column (`CalibrationRun.samplingParams`, migration v2k) written inside the existing launch transaction from `effectiveSamplingParams(version.samplingDefaults)` — the same resolver the worker uses per judgment, so header == every `ModelJudgment.samplingParams` of the run unless the version row moved mid-run (which makes header ≠ judgment the contamination detector) — or a judgment was persisted through `src/worker/judgment-consumer.ts:753`'s `?? version.samplingDefaults` fallback, which stores the RAW, possibly partial field and so can never equal a resolved header. That fallback exists for pre-Task-10 fixtures and no in-tree caller reaches it (nothing passes `samplingOverrides`, and `executePairwiseCall` reuses `prepareJudgmentCall`'s `samplingParamsUsed`), so it is latent, not live; the drift detector's ⚠ is a prompt to look, not a proof of an edit. To reach that resolver from `launch.ts` without bundling `@anthropic-ai/sdk` + redis into the esbuild CLI, the 48-line sampling section (:412-459) of `registry.ts` is first extracted verbatim into a leaf module `src/lib/llm/sampling.ts` (registry.ts and the barrel re-export it, so nothing else changes). The CLI prints the snapshot, renders NULL as "pre-v2k" (never as a config), and warns when judgments disagree with the header or each other; four docs get CORRECTION notes (the "passThreshold is already pinned" claim is false — nothing writes it).

**Tech Stack:** Next.js 15.5.22 / TypeScript / Prisma 6.19.2 on Postgres (Json → JSONB) / vitest (unit + db configs) / esbuild 0.27.3 for the CLI bundle.

**Spec:** `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §7 #1 (:326-330 — was :296-300 before Wave 1's CI commits) and §8 step 3 (:379-389 — was :342-352); `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md` §4.1 (:203-236, heading at :203, "Open follow-up" blockquote :232-236 — unmoved by Wave 1); register `docs/superpowers/plans/2026-08-30-state-and-next-steps.md` §5.6 #6 (:416-423); verified map `/tmp/ja-plan-inputs/snapshot-sampling-config.json` (its `verify.corrections` override the map) and cross-item critique `/tmp/ja-plan-inputs/critique.json` (`q2_missingInfoPerMap.snapshot-sampling-config`, `q3`, `q4[4]`).

**Priority / wave:** Wave 2 — **execution slot #1, MUST LAND FIRST** (register priority rank #4; size S). Task 1 moves every registry.ts line after :412, so the loop-detector and capture-field plans must be re-verified against this plan's post-Task-1 tree, not HEAD.

**Depends on:** none — lands BEFORE every other wave-2 plan (Task 1 moves every registry.ts line after :412; the loop-detector and capture-field plans cite registry.ts line numbers).

**Owner decisions needed:** none. Decided here (all from the binding brief): column name `samplingParams` (mirrors `ModelJudgment.samplingParams`, same shape, same fact); read the version row INSIDE the launch transaction; NO backfill of the 9 production rows (NULL = launched before v2k); `passThreshold` gets a doc CORRECTION only, no code; `registry.ts:673`'s "raise samplingDefaults.max_tokens" advice is NOT touched here (loop-detector plan's file). Tasks 2-3 stage only; the single `feat(calibration)` commit is Task 4 Step 6 — executors must not commit between them (Task 1 has its own `refactor(llm)` commit).

## Global Constraints

- Repo: /root/judge-arena (Next.js 15.5.22, TypeScript, Prisma on Postgres — Json maps to JSONB —, amqplib 2.0.1, vitest). Node >= 22. Always use `git -C /root/judge-arena` (handoff trap 2: a stale `cd` once hard-reset the wrong repo).
- Gates, in this order, all must be clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in vitest.config.ts:187-220 — NEVER lower a floor; if a new test import drags a module into a denominator, mock the seam as tests/lib/judgment-consumer-escalation.test.ts:41-69 does) → `npm run test:db:coverage` (RESETS the database at .env.test — verified today to be localhost:5432, the local podman `judge-arena-pg`, NOT the k8s `judge-arena-pg-1`; re-confirm with `grep DATABASE_URL /root/judge-arena/.env.test` before the first run) → `npm run test:integration` → `npm run build`. Baseline on HEAD 5e48187 (measured 2026-09-02): 877 unit / 55 files; 670 db / 46 files; 82 integration / 11 files. (Wave 1 added 3 tests to `tests/lib/llm-index.test.ts`, 5 to `tests/lib/worker-health.test.ts` and the new `tests/integration/consumer-loss-epoch.test.ts`; the plan was originally written against fc9e936's 869/670/80.)
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage of the implementation and GREEN again after; a test that stays green after injection is a finding. Each task's steps must include the injection.
- One concern per commit/PR (CONTRIBUTING.md:1639). Wrong statements in docs get an explicit CORRECTION note, never a silent overwrite (CONTRIBUTING.md:1653-1656 — Wave 1 rewrote CONTRIBUTING.md:1221-1247 and pushed everything after it down ~79 lines; the old :1560 / :1574-1577 cites now land in the v1-scratch-DB trap and the coverage-gate paragraph).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes seen: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line, then EXACTLY these trailers:
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
- Commit LOCALLY only. Never push, never promote; the operator does that (push-to-main fires CI and builds an image; promotion is a separate homelab-setup PR).
- Migration naming: `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`, timestamp must sort after 20260901000000 (v2j); narrative `-- v2x — ...` header in the v2i/v2j style; ZERO hand edits (content must equal what `prisma migrate diff` emits), then `npx prisma generate`.
- GREP TRAP live in HEAD: /root/judge-arena/src/lib/calibration/readings.ts:164 and /root/judge-arena/scripts/importer/reconcile.ts:294 contain a deliberate NUL byte; plain grep returns nothing for those files. Use `grep -a`. NEVER remove the NUL.
- Production is sha-d21f31d47c35; main is **5e48187**, nine commits ahead of fc9e936 — and they are NOT docs-only: three are code (`src/lib/llm/index.ts` + `src/lib/llm/resilience.ts` in 7e769c1; `src/worker/health.ts` + `src/worker/main.ts` in 80fc4ab/20fc4fc), the rest CI scripts and docs. `src/lib/llm/registry.ts`, `src/lib/calibration/launch.ts`, `scripts/calibration/run.ts`, `prisma/schema.prisma` and `tests/db/calibration-link.test.ts` are all untouched by Wave 1. Do not touch homelab-setup from a judge-arena task except where the plan explicitly says "separate PR in /root/homelab-setup".
- Any cluster/DB access in a plan step is READ-ONLY (psql SELECT, kubectl get/logs, rabbitmqctl list_queues). No requeue-peeks of judge.dlq (quorum delivery_limit 20 — every peek burns one).

---

## Facts re-verified against HEAD 5e48187 on 2026-09-02 (re-verify line numbers before editing; they drift)

| fact | where |
|---|---|
| The sampling section of registry.ts is lines **412-459** (`// ─── Sampling params` → closing `}` of `effectiveSamplingParams`); `RESPOND_DEFAULT_SAMPLING_PARAMS` is used at :1326, `effectiveSamplingParams` at :1107 and :1323; `JUDGE_DEFAULT_SAMPLING_PARAMS` is used only as the default parameter at :452 | `grep -n -a SamplingParams src/lib/llm/registry.ts` |
| The barrel re-exports `effectiveSamplingParams` (index.ts:**197**, inside the `export { … } from './registry';` block :193-201) and `type SamplingParams` (index.ts:**202**) **from './registry'** — unchanged by this plan. (Wave 1's 7e769c1 added 44 lines to index.ts; the pre-Wave-1 cite :157-166 is stale.) `./breaker-redis` — the redis client — is imported by **index.ts:43**, NOT by registry.ts | `src/lib/llm/index.ts:193-202`, `grep -n -a breaker-redis src/lib/llm/*.ts` |
| Importers of the two names: `src/worker/judgment-consumer.ts:179` (type, via barrel), `tests/lib/registry.test.ts:18` (via `@/lib/llm/registry`), nothing else | grep above |
| `tests/lib/llm-index.test.ts:31` mocks `@/lib/llm/registry` with `importOriginal` — re-exports survive | read |
| The ONLY `calibrationRun.create` in src/ + scripts/ is `src/lib/calibration/launch.ts:318` (seam count 1) | `grep -rn -a calibrationRun.create src scripts` |
| `launch.ts:39` is `import type { GoldenCandidate } from '@prisma/client';`; the `$transaction` is :316-331; `logger.info` :333-338; return :414-419; `CalibrationLaunchResult` :81-96 | read in full |
| `RunLaunchError(status, message)` at `src/lib/run-launch.ts:127-134`; `requireOwnedActiveEndpoints` refuses an unknown version with **400** before the transaction | read |
| Test DB `judge_arena_test` is at `20260901000000_v2j_queue_lanes`; dev DB `judge_arena` is at **v2h** (two behind) — so CONTRIBUTING.md:694-697's `--from-url` dev-DB diff would emit v2i+v2j statements too. This plan diffs against `$TEST_DATABASE_URL` BEFORE the first `npm run test:db` of Task 2 | `psql ... -Atc "select migration_name from _prisma_migrations order by finished_at desc limit 1"` |
| `.env.test` DATABASE_URL == TEST_DATABASE_URL == `postgresql://judge_arena:***@localhost:5432/judge_arena_test`; podman `judge-arena-pg` Up | grep + `podman ps` |
| Baseline esbuild bundle of `scripts/calibration/run.ts` (Dockerfile:150-157 flags) contains **0** occurrences of `@anthropic-ai/sdk`, 320 548 bytes | `npx esbuild ... --outfile=/tmp/...` |
| `tests/lib/registry.test.ts:146-165` — four `effectiveSamplingParams` tests (null → default; partial merge; override wins; malformed → default); 31 tests pass today | `npx vitest run tests/lib/registry.test.ts` |
| Nothing in tests asserts a whole `CalibrationRun` row, the whole `launchCalibrationRun` result, or the "golden set is now frozen" logger payload | map corrections |
| `scripts/calibration/run.ts` has no test harness; it is outside every coverage `include` | vitest.config.ts:37 |
| JSONB stores object keys shortest-first, so `{ temperature, max_tokens }` written by Prisma reads back as `{ max_tokens, temperature }` — a naive `JSON.stringify` comparison between the in-process header and a DB-loaded judgment reports drift on EVERY run. Task 3 canonicalises | Postgres jsonb semantics |
| `tests/db/calibration-link.test.ts` has **13** `it(` blocks today (not 12); `tests/lib/registry.test.ts` has **31**; `tests/lib/llm-index.test.ts` has **13** (it had 10 before Wave 1's 7e769c1 added three U3 tests) | `grep -c "^\s*it(" <file>` |
| **The local test DB is SHARED with anything else running vitest on this workstation.** With a concurrent `vitest.integration.config.ts` process alive, `tests/db/calibration-link.test.ts` fails 7/13 with Postgres `40P01 deadlock detected` and `Unique constraint failed on (slug)` — fixture collisions, not defects. Before EVERY db/integration gate below: `pgrep -af "[v]itest"` must print nothing (the bracket keeps pgrep from matching its own command line — handoff trap 6) | reproduced 2026-09-01 21:15 while a sibling session ran the integration suite |
| `.env.local` does not exist in this tree (only `.env` and `.env.test`), so CONTRIBUTING.md:707's `. ./.env.local` form cannot be used; every DB command in this plan sources `.env.test` | `ls -la .env.local` |
| **Task 1 shifts registry.ts line numbers**: the 48-line section :412-459 becomes 11 lines and one import line is added after :93, so after Task 1 every old line N ≥ 460 is at **N − 36** (:673 → :637, :1107 → :1071, :1208 → :1172, :1323 → :1287) and old :94-411 are at N + 1. The loop-detector and capture-field plans cite the OLD numbers; re-verify with `grep -n -a 'raise samplingDefaults.max_tokens' src/lib/llm/registry.ts` (expect :637 after Task 1). Wave 1 (fc9e936 → 5e48187) did **not** touch registry.ts, so the sibling plans' pre-Task-1 cites are still valid until this task lands; the −36 / +1 shift is the only correction they need | arithmetic on the exact edits in Task 1 Step 4; `git log fc9e936..HEAD -- src/lib/llm/registry.ts` is empty |

---

### Task 1: Extract the sampling resolver into a leaf module (`refactor(llm)`)

**Files:**
- Create: `src/lib/llm/sampling.ts`
- Modify: `src/lib/llm/registry.ts:93` (add one import line after it) and `src/lib/llm/registry.ts:412-459` (replace the section with re-exports)
- Test: `tests/lib/sampling.test.ts` (new); `tests/lib/registry.test.ts:146-165` (unchanged, must stay green)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks import these from `'@/lib/llm/sampling'`):
  - `export interface SamplingParams { temperature: number; max_tokens: number }`
  - `export const JUDGE_DEFAULT_SAMPLING_PARAMS: SamplingParams` (`{ temperature: 0.3, max_tokens: 4096 }`)
  - `export const RESPOND_DEFAULT_SAMPLING_PARAMS: SamplingParams` (`{ temperature: 0.4, max_tokens: 4096 }`)
  - `export function effectiveSamplingParams(versionDefaults: unknown, overrides?: Partial<SamplingParams>, registryDefault?: SamplingParams): SamplingParams`
  - `registry.ts` keeps exporting `SamplingParams` (type) and `effectiveSamplingParams` (value) under the same names; `@/lib/llm` barrel unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/sampling.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  effectiveSamplingParams,
  JUDGE_DEFAULT_SAMPLING_PARAMS,
  RESPOND_DEFAULT_SAMPLING_PARAMS,
} from '@/lib/llm/sampling';
import { effectiveSamplingParams as viaRegistry } from '@/lib/llm/registry';

// ─── src/lib/llm/sampling.ts is a LEAF, and that is its whole reason to exist ─
//
// `src/lib/calibration/launch.ts` resolves a version's effective sampling
// params to snapshot them on the CalibrationRun header (v2k). launch.ts is
// bundled into the image's calibration-run.js by esbuild with only
// @prisma/client external (Dockerfile, `scripts/calibration/run.ts` block), so
// if the resolver were reached through registry.ts or the `@/lib/llm` barrel
// the CLI would ship @anthropic-ai/sdk, every backend module and the redis
// client. The resolver's BEHAVIOUR is pinned by tests/lib/registry.test.ts
// (`registry: effectiveSamplingParams`, through the re-export); this file
// pins the two things that test cannot see.

const SOURCE = readFileSync(new URL('../../src/lib/llm/sampling.ts', import.meta.url), 'utf8');

describe('llm/sampling: a leaf module', () => {
  it('has NO value import or re-export at all — the property that keeps SDKs and redis out of the CLI bundle', () => {
    // WHOLE FILE, not line-by-line. A per-line regex misses the multi-line
    // form —
    //
    //     export {
    //       getDescriptor,
    //     } from './registry';
    //
    // — whose first line carries no `from` and whose last line starts with
    // `}`; esbuild bundles that re-export exactly like an import, so it has to
    // be caught here too, as does a top-level dynamic `import('./x')`.
    // Strip comment lines and type-only statements (esbuild erases those),
    // then require that NO module specifier survives anywhere in the file.
    const code = SOURCE.split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n')
      .replace(/\b(?:import|export)\s+type\s[^;]*;/g, '');
    const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]+['"]/g)].map((m) => m[0]);
    expect(
      specifiers,
      'src/lib/llm/sampling.ts must stay a LEAF: no value import, no `export … from`, no dynamic import'
    ).toEqual([]);
  });

  it('is what registry.ts hands out — one resolver, not a copy', () => {
    expect(viaRegistry).toBe(effectiveSamplingParams);
    expect(effectiveSamplingParams(null)).toEqual(JUDGE_DEFAULT_SAMPLING_PARAMS);
    expect(effectiveSamplingParams(null, undefined, RESPOND_DEFAULT_SAMPLING_PARAMS)).toEqual({
      temperature: 0.4,
      max_tokens: 4096,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/sampling.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/llm/sampling"` (the module does not exist yet).

- [ ] **Step 3: Create the leaf module — the registry section, verbatim**

Create `src/lib/llm/sampling.ts`. The code AND the two doc comments are copied from registry.ts:412-459 with exactly ONE deliberate change: the two mode defaults are promoted from `const` (registry.ts:432-433, un-exported today) to `export const`, because registry.ts now imports `RESPOND_DEFAULT_SAMPLING_PARAMS` from here and the Interfaces block above promises both are exported. (This commit lands before v2k exists, so nothing here mentions the snapshot.) Only the file-header comment is new:

```ts
/**
 * ─── Sampling params (LEAF MODULE) ─────────────────────────────────────────
 *
 * Extracted verbatim from `registry.ts`'s "Sampling params" section so that a
 * module which only needs to RESOLVE a version's effective params can do so
 * without value-importing registry.ts. registry.ts value-imports
 * `@anthropic-ai/sdk` (through `./anthropic`) and every backend module, and
 * the `@/lib/llm` barrel adds `./breaker-redis` (→ the redis client) on top;
 * `src/lib/calibration/launch.ts` is bundled into the image's
 * `calibration-run.js` by esbuild with only `@prisma/client` external
 * (Dockerfile, the `scripts/calibration/run.ts` block), so reaching this
 * resolver through registry.ts or the `@/lib/llm` barrel would ship the SDKs
 * and the redis client into a CLI that never calls a provider.
 *
 * THIS FILE MUST STAY A LEAF: no value `import` of anything, and no
 * `export … from` in ANY form — single-line, multi-line or dynamic
 * `import()` — because esbuild bundles a re-export exactly like an import.
 * tests/lib/sampling.test.ts reads this source and fails on any of them.
 *
 * registry.ts re-exports `SamplingParams` and `effectiveSamplingParams` from
 * here, and the `@/lib/llm` barrel re-exports them from registry.ts, so every
 * pre-existing importer is unchanged.
 */

export interface SamplingParams {
  temperature: number;
  max_tokens: number;
}

/**
 * Registry-level fallback sampling params — the hardcoded literals every
 * backend module used to declare independently (`anthropic.ts`/
 * `openai-compatible.ts` both used `{ temperature: 0.3, max_tokens: 4096 }`
 * for judge calls and `{ temperature: 0.4, max_tokens: 4096 }` for respond
 * calls — a deliberately HIGHER temperature for free-form generation than
 * for scoring). Now defined exactly ONCE per mode, here, and only ever used
 * as the LAST-RESORT fallback beneath a `JudgeModelVersion`'s own
 * `samplingDefaults` (which, being a single JSON field shared by both
 * modes — see `prisma/schema.prisma` — applies identically to judge and
 * respond calls once set; this mode split only matters when a version has
 * no `samplingDefaults` of its own at all).
 */
export const JUDGE_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.3, max_tokens: 4096 };
export const RESPOND_DEFAULT_SAMPLING_PARAMS: SamplingParams = { temperature: 0.4, max_tokens: 4096 };

function isPartialSamplingParams(value: unknown): value is Partial<SamplingParams> {
  return typeof value === 'object' && value !== null;
}

/**
 * Effective sampling params = per-call override ?? the `JudgeModelVersion`'s
 * own `samplingDefaults` ?? `registryDefault` (mode-specific — see
 * `JUDGE_DEFAULT_SAMPLING_PARAMS`/`RESPOND_DEFAULT_SAMPLING_PARAMS` above) —
 * per-field, so a version that only pins `temperature` still inherits the
 * registry's `max_tokens`. This is the value recorded as
 * `samplingParamsUsed` on every `JudgmentResult`/`RespondResult` (persisted
 * as `ModelJudgment.samplingParams` — the ACTUAL params a call used, not a
 * re-derivation at persist time).
 */
export function effectiveSamplingParams(
  versionDefaults: unknown,
  overrides?: Partial<SamplingParams>,
  registryDefault: SamplingParams = JUDGE_DEFAULT_SAMPLING_PARAMS
): SamplingParams {
  const versionShape = isPartialSamplingParams(versionDefaults) ? versionDefaults : undefined;
  return {
    temperature: overrides?.temperature ?? versionShape?.temperature ?? registryDefault.temperature,
    max_tokens: overrides?.max_tokens ?? versionShape?.max_tokens ?? registryDefault.max_tokens,
  };
}
```

- [ ] **Step 4: Point registry.ts at the leaf module**

(a) In `src/lib/llm/registry.ts`, after line 93 —

```ts
import { PAIRWISE_JUDGMENT_JSON_SCHEMA, tryParsePairwiseJudgment } from './judgment-schema';
```

— add:

```ts
import { effectiveSamplingParams, RESPOND_DEFAULT_SAMPLING_PARAMS, type SamplingParams } from './sampling';
```

(Only the respond default is imported as a value: `JUDGE_DEFAULT_SAMPLING_PARAMS` was used in registry.ts solely as `effectiveSamplingParams`'s default parameter, which now lives in sampling.ts; importing it here would be an unused import and fail `npm run lint`.)

(b) Replace lines 412-459 in HEAD — **:413-460 after (a) added one import line** — everything from the line

```ts
// ─── Sampling params ─────────────────────────────────────────────────────────
```

through the closing `}` of `effectiveSamplingParams` (the line before the blank line preceding `// ─── execute(): the low-level, single-attempt call primitive`) — with exactly:

```ts
// ─── Sampling params ─────────────────────────────────────────────────────────
// `SamplingParams`, the two registry defaults and `effectiveSamplingParams`
// live in `./sampling` — a LEAF module — so that
// `src/lib/calibration/launch.ts` can resolve a version's effective params
// (the v2k CalibrationRun snapshot) without value-importing this file, which
// would drag every provider SDK and the redis client into the esbuild CLI
// bundle (Dockerfile, `scripts/calibration/run.ts`). Re-exported here so every
// pre-existing importer of registry.ts — and the `@/lib/llm` barrel, which
// re-exports from here — is unchanged.
export type { SamplingParams } from './sampling';
export { effectiveSamplingParams } from './sampling';
```

Nothing else in registry.ts changes: :1107 and :1323-1327 keep calling `effectiveSamplingParams(...)` / `RESPOND_DEFAULT_SAMPLING_PARAMS` through the new import, and every `SamplingParams` type reference (:469, :918, :936, :1042, :1217, :1279, :1291, :1303) resolves through the inline `type` import. `src/lib/llm/index.ts`'s re-export block (:193-202 on HEAD 5e48187 — `effectiveSamplingParams` at :197, `type SamplingParams` at :202) is untouched.

Line-number consequence (for the plans that land after this one): the 48-line section became 11 lines and one import line was added, so every old registry.ts line N ≥ 460 is now at N − 36 and old :94-411 at N + 1. Confirm before moving on:

```bash
grep -n -a 'raise samplingDefaults.max_tokens\|const samplingParamsUsed = effectiveSamplingParams' /root/judge-arena/src/lib/llm/registry.ts
```
Expected: `637:` (the truncation advice, old :673), `1071:` (prepareJudgmentCall, old :1107) and `1287:` (prepareRespondCall, old :1323).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /root/judge-arena && npx vitest run tests/lib/sampling.test.ts tests/lib/registry.test.ts tests/lib/llm-index.test.ts`
Expected: PASS — 46 tests (2 + 31 + 13), 3 files (verified on HEAD 5e48187: `registry.test.ts` 31 + `llm-index.test.ts` 13 = 44 today). llm-index matters because it mocks `@/lib/llm/registry` with `importOriginal` (tests/lib/llm-index.test.ts:31-34); the re-exports must survive that spread.

- [ ] **Step 6: Injection — all three properties must be able to fail**

Injection A (the leaf property): at the top of `src/lib/llm/sampling.ts` add exactly these three lines — the MULTI-LINE re-export form, deliberately, because that is the form a per-line regex misses and the whole-file assertion exists to catch:

```ts
export {
  logger,
} from '@/lib/logger';
```

(`@/lib/logger`, not `./registry`: registry.ts value-imports `./sampling` after Step 4(a), so injecting an import of `./registry` here would make sampling ⇄ registry a module cycle. It would probably still redden the same assertion — registry.ts touches nothing from sampling.ts at module-evaluation time — but a cycle that misbehaved under vite-node would surface as a module-load error, and a failure message that does not describe the defect is not evidence (CONTRIBUTING.md:210-234). `logger` imports nothing from `src/lib/llm`, so there is no cycle, and it is bundled exactly like any other value import.)

Run: `npx vitest run tests/lib/sampling.test.ts`
Expected: FAIL — `has NO value import or re-export at all` with the message `src/lib/llm/sampling.ts must stay a LEAF: no value import, no \`export … from\`, no dynamic import` and `AssertionError: expected [ Array(1) ] to deeply equal []` (vitest 3.2.4 abbreviates the array in the summary line; the diff body below shows the single offending specifier `from '@/lib/logger'`).
Restore (delete the three added lines). (The single-line form `import { logger } from '@/lib/logger';` reddens the same test the same way; not required to run.)

Injection B (the behaviour still routes through the moved code): in `src/lib/llm/sampling.ts` change

```ts
    max_tokens: overrides?.max_tokens ?? versionShape?.max_tokens ?? registryDefault.max_tokens,
```

to

```ts
    max_tokens: overrides?.max_tokens ?? registryDefault.max_tokens,
```

Run: `npx vitest run tests/lib/registry.test.ts`
Expected: FAIL — `a per-call override wins over both the version default and the registry default` with `expected { temperature: 0.9, max_tokens: 4096 } to deeply equal { temperature: 0.9, max_tokens: 2048 }`. (Injection B reddens ONLY registry.test.ts: `tests/lib/sampling.test.ts`'s two calls are `effectiveSamplingParams(null)` and `effectiveSamplingParams(null, undefined, RESPOND_DEFAULT_SAMPLING_PARAMS)`, both of which take the `registryDefault` arm and still return `{0.3,4096}`/`{0.4,4096}` under this breakage — which is why Injection C exists.)
Restore.

Injection C (one resolver, not a copy — the `toBe` identity): this is the shape the tree takes under the most likely mis-execution of Step 3, where the section is COPIED into sampling.ts and registry.ts keeps its own definitions. In `src/lib/llm/registry.ts` alias the Step 4(a) import —

```ts
import { effectiveSamplingParams as resolveSampling, RESPOND_DEFAULT_SAMPLING_PARAMS, type SamplingParams } from './sampling';
```

— and replace the re-export line `export { effectiveSamplingParams } from './sampling';` with a local wrapper:

```ts
export function effectiveSamplingParams(...args: Parameters<typeof resolveSampling>): SamplingParams {
  return resolveSampling(...args);
}
```

(The alias is required: leaving the import unaliased and adding a same-named local declaration is a duplicate binding that esbuild refuses to transform, so the file would not load at all and the failure would not describe the defect.)
Run: `npx vitest run tests/lib/sampling.test.ts tests/lib/registry.test.ts`
Expected: FAIL — exactly 1 test, `is what registry.ts hands out — one resolver, not a copy`, on its FIRST line: `expected [Function effectiveSamplingParams] to be [Function effectiveSamplingParams]` (two distinct function objects that print the same name). Every other assertion in that test and all 31 in `tests/lib/registry.test.ts` stay green — behaviour is identical, which is precisely why the identity assertion has to exist: without it, two divergent copies of the resolver (launch.ts on one, the worker on the other) would land green, and that divergence is the drift the v2k column exists to detect.
Restore both lines.

- [ ] **Step 7: Bundle-weight check (the reason for the task) and gates**

```bash
cd /root/judge-arena && npx esbuild scripts/calibration/run.ts --bundle --platform=node --target=node22 \
  --outfile=/tmp/ja-calibration-run.js --external:@prisma/client --tsconfig=tsconfig.json --log-level=warning \
  && echo "sdk+redis hits: $(grep -c '@anthropic-ai/sdk\|llm/breaker-redis' /tmp/ja-calibration-run.js)  bytes: $(stat -c%s /tmp/ja-calibration-run.js)"
```
Expected: `sdk+redis hits: 0`, bytes ≈ 320 548 (baseline on HEAD, measured; treat anything over 400 000 as a regression to explain, not to wave through). Both markers are checked because the docblock and the commit message name TWO things being kept out: a barrel import would drag in `./breaker-redis` (the redis client) as well as the SDK, and grepping only for the SDK would miss a direct `@/lib/llm/breaker-redis` import. `llm/breaker-redis` rather than plain `breaker-redis` on purpose: `src/lib/llm/resilience.ts:11` mentions `` `./breaker-redis.ts` `` in a doc comment, which is not an inclusion. If the count is non-zero, run `grep -n '@anthropic-ai/sdk\|llm/breaker-redis' /tmp/ja-calibration-run.js | head` — an esbuild module-path marker (`// src/lib/llm/…`) is a real inclusion; a mention inside a comment is not.

Then the gates, in order (the `src/lib/llm/**` floor 91/94/83/91 must hold — sampling.ts is fully covered by the two test files above):

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
grep DATABASE_URL /root/judge-arena/.env.test   # must show localhost:5432/judge_arena_test
pgrep -af "[v]itest"                            # must print NOTHING — a concurrent suite on the shared test DB deadlocks this one (facts table)
npm run test:db:coverage && npm run test:integration && npm run build
```
Expected: lint 0 warnings; tsc 0; unit 879 tests / 56 files, coverage thresholds met; db 670; integration 82; build OK.

- [ ] **Step 8: Commit (a)**

```bash
git -C /root/judge-arena add src/lib/llm/sampling.ts src/lib/llm/registry.ts tests/lib/sampling.test.ts
git -C /root/judge-arena commit -F - <<'EOF'
refactor(llm): extract the sampling resolver into a leaf module

`SamplingParams`, the two registry defaults, `isPartialSamplingParams` and
`effectiveSamplingParams` move verbatim from src/lib/llm/registry.ts
(its "Sampling params" section) into src/lib/llm/sampling.ts. registry.ts
re-exports the two public names and imports the respond default for
`prepareRespondCall`; the `@/lib/llm` barrel is unchanged, so every
existing importer is unchanged.

Why: the v2k calibration snapshot (next commit) needs
`effectiveSamplingParams` inside src/lib/calibration/launch.ts, which
esbuild bundles into the image's calibration-run.js with only
@prisma/client external (Dockerfile). Reaching it through registry.ts
would ship @anthropic-ai/sdk and every backend module — and through the
barrel, the redis client on top — into a CLI that never calls a
provider — all import-safe,
but pure weight, and it would falsify .dockerignore's "pulls in
src/lib/calibration/** and @/lib/db only". A leaf module costs nothing:
the bundle still contains zero occurrences of @anthropic-ai/sdk.

tests/lib/sampling.test.ts pins the leaf property (no value import or
re-export in the file) and that registry.ts hands out the same function
object; the
resolver's behaviour stays pinned by tests/lib/registry.test.ts through
the re-export. Verified by injection: a multi-line `export { logger } from
'@/lib/logger';` in sampling.ts turns the leaf test red (the assertion is
whole-file, not per-line, because a multi-line re-export carries no `from`
on its first line and esbuild bundles it exactly like an import); dropping
the version's max_tokens from the merge turns registry.test.ts's override
case red; and replacing the re-export with a local wrapper — the shape a
COPY instead of a MOVE would leave — turns the `toBe` identity red while
every behaviour test stays green.

This lands first in the wave because it moves every registry.ts line
after :412 (old N >= 460 is now N - 36; old :94-411 is N + 1); the
loop-detector and capture-field plans must re-verify their cites.

Gates: lint 0, tsc 0, 879 unit / 670 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
```

(Substitute the actual counts printed by the gates if they differ.)

---

### Task 2: v2k column, launch-time snapshot, DB tests

**Files:**
- Modify: `prisma/schema.prisma:915-921` (insert the column after the `rubric` relation line 920)
- Create: `prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot/migration.sql`
- Modify: `src/lib/calibration/launch.ts:39` (import), `:43` (add import after it), `:81-96` (result type), `:316-331` (transaction), `:333-338` (logger), `:414-419` (return)
- Test: `tests/db/calibration-link.test.ts` (imports :1-8, fixtures :114-147, new `(4)` block appended at the END of the top-level describe — after the last test, before the file's final `});` at :502 — so the section markers stay in order)

**Interfaces:**
- Consumes: `effectiveSamplingParams`, `type SamplingParams` from `'@/lib/llm/sampling'` (Task 1).
- Produces:
  - Prisma: `CalibrationRun.samplingParams: Json?` (client type `Prisma.JsonValue | null`).
  - `CalibrationLaunchResult.samplingParams: SamplingParams` (new required field on the return of `launchCalibrationRun`), used by Task 3.
  - DB fixture `mkWorld(opts: { items?: number; protocol?: 'pairwise' | 'pointwise'; samplingDefaults?: Prisma.InputJsonValue })`.

- [ ] **Step 1: Write the failing tests**

**Every line number quoted in this step is a HEAD number, and each substep shifts the ones below it** — (a0) inserts 11 lines at :31, (a) adds 1 line to the import block, (b) and (c) grow the fixtures. Anchor on the quoted TEXT, which is unique in every case; the numbers are only for finding it. (Applying (a0) LAST avoids the +11 on (b)-(d) entirely.)

(a0) The file's own header must stop being wrong before a third concern is added under it (CONTRIBUTING.md:1653-1656). `tests/db/calibration-link.test.ts:10-12` opens `─── The calibration ⇄ golden-item link (A2.1, v2i) ───` / `Two things are pinned here and they are pinned together on purpose:` and then enumerates exactly (1) the v2i index semantics and (2) the launch path; the top-level `describe` at :164 is named `v2i calibration ⇄ golden item link (DB)`. Three text-anchored edits:

- Line 12: `// Two things are pinned here and they are pinned together on purpose:` → `// Three things are pinned here and they are pinned together on purpose:`.
- After the `(2)` bullet's last line (`//       long batch as \`'reaper: abandoned'\`.`, :29) and its trailing `//` (:30) — i.e. immediately before the paragraph beginning `` // `launchCalibrationRun` goes through the `prisma` singleton `` (:31) — insert:

```ts
//   (3) THE LAUNCH-TIME SAMPLING SNAPSHOT (v2k) —
//       `CalibrationRun.samplingParams`, the RESOLVED
//       `effectiveSamplingParams(JudgeModelVersion.samplingDefaults)` written
//       inside the SAME launch transaction as the header. It lives in this
//       file for the same reason (2) does: `tests/db` is the only suite that
//       executes `launchCalibrationRun`, so it is the only place that can
//       prove launch.ts CALLS the resolver rather than storing the raw,
//       mutable `samplingDefaults` — and the only place that can show the
//       obvious join through the version reporting today's config for a
//       historical run.
//
```

- Line 164: `describe('v2i calibration ⇄ golden item link (DB)', () => {` → `describe('v2i calibration ⇄ golden item link + v2k sampling snapshot (DB)', () => {`.

(a) In `tests/db/calibration-link.test.ts`, replace the import block at lines 1-8 —

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import { prisma } from '@/lib/db';
import { isGoldenSetFrozen } from '@/lib/golden-sets';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
import { launchCalibrationRun, MAX_CALIBRATION_ITEMS } from '@/lib/calibration/launch';
import { DEADLINE_SLACK_MS } from '@/lib/run-launch';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';
```

— with:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, truncateAll, mkUser, mkRubric } from './helpers';
import { prisma } from '@/lib/db';
import { isGoldenSetFrozen } from '@/lib/golden-sets';
import { effectiveSamplingParams } from '@/lib/llm/sampling';
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
import { launchCalibrationRun, MAX_CALIBRATION_ITEMS } from '@/lib/calibration/launch';
import { DEADLINE_SLACK_MS } from '@/lib/run-launch';
import { seedPromptTemplates } from '../../prisma/seed-prompt-templates';
```

(b) Replace the fixture `mkJudgeVersionWithEndpoint` (lines 114-131) —

```ts
async function mkJudgeVersionWithEndpoint(userId: string) {
  const name = uniq('fixture-judge');
  const judgeModel = await db.judgeModel.create({
    data: { name, slug: name, judgeClass: 'prompted_api', scoringMechanism: 'critique_generative' },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pairwise: ['preference'] },
    },
  });
  await db.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });
  return version;
}
```

— with:

```ts
async function mkJudgeVersionWithEndpoint(
  userId: string,
  opts: { samplingDefaults?: Prisma.InputJsonValue } = {}
) {
  const name = uniq('fixture-judge');
  const judgeModel = await db.judgeModel.create({
    data: { name, slug: name, judgeClass: 'prompted_api', scoringMechanism: 'critique_generative' },
  });
  const version = await db.judgeModelVersion.create({
    data: {
      judgeModelId: judgeModel.id,
      ordinal: 1,
      servingBackend: 'openai',
      protocolSupport: { pairwise: ['preference'] },
      // UNSET by default (not null): every pre-v2k test below stays exactly
      // what it was, and block (4) exercises the resolver's "no defaults" arm.
      ...(opts.samplingDefaults !== undefined ? { samplingDefaults: opts.samplingDefaults } : {}),
    },
  });
  await db.modelEndpoint.create({
    data: { userId, judgeModelVersionId: version.id, isActive: true, verifiedAt: new Date() },
  });
  return version;
}
```

(c) Replace the `mkWorld` signature and its `version` line (lines 134 and 145) —

```ts
async function mkWorld(opts: { items?: number; protocol?: 'pairwise' | 'pointwise' } = {}) {
```
```ts
  const version = await mkJudgeVersionWithEndpoint(user.id);
```

— with:

```ts
async function mkWorld(
  opts: { items?: number; protocol?: 'pairwise' | 'pointwise'; samplingDefaults?: Prisma.InputJsonValue } = {}
) {
```
```ts
  const version = await mkJudgeVersionWithEndpoint(user.id, { samplingDefaults: opts.samplingDefaults });
```

(d) Insert a new block at the END of the top-level `describe`, so the section markers stay monotonic — (1) :172, (2) :251, (3) :428, and now (4). Anchor: after the closing `});` of the LAST test in the file (`refuses a golden set with no live items — an empty calibration would freeze a set and measure nothing`, whose body ends `expect(await db.$transaction((tx) => isGoldenSetFrozen(tx, world.goldenSet.id))).toBe(false);`) and BEFORE the file's final `});` (line 502 today, closing the describe). Do NOT insert after :426 — that would put a "(4)" block above the "(3)" one.

```ts
  // ── (4) The sampling snapshot (v2k) ──────────────────────────────────────
  //
  // `JudgeModelVersion.samplingDefaults` is MUTABLE — no history, no
  // updatedAt, three in-tree writers — so a join from a historical run through
  // its version reports TODAY's config (scoreboard spec §4.1: raising
  // granite4.2 from 4096 to 12288 for run #9 silently rewrote what that join
  // says about run #7). prisma/seed-core.ts:223-229 already declares a version
  // immutable under a judgment; nothing enforces it. The header therefore
  // snapshots the RESOLVED params at launch, with the same
  // `effectiveSamplingParams` the worker's pairwise seam resolves per call
  // (registry.ts prepareJudgmentCall; judgment-consumer.ts's pairwise seam
  // passes no overrides), so header == every ModelJudgment.samplingParams of
  // the run unless the row moved mid-run — and header ≠ judgment is the tell.

  it('snapshots the EFFECTIVE sampling params on the header at launch — the resolver the worker uses, not the raw JSON', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.2, max_tokens: 12288 } });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    expect(header.samplingParams).toEqual({ temperature: 0.2, max_tokens: 12288 });
    // One resolver, not two: what the header says equals what the worker will
    // persist on each judgment of this run.
    expect(header.samplingParams).toEqual(effectiveSamplingParams(world.version.samplingDefaults));
    // Returned to the caller too, so the CLI prints the snapshot without a re-read.
    expect(result.samplingParams).toEqual({ temperature: 0.2, max_tokens: 12288 });
  });

  it('editing samplingDefaults AFTER the launch does not move the header — and the join through the version now lies', async () => {
    const world = await mkWorld({ items: 1, samplingDefaults: { temperature: 0.3, max_tokens: 4096 } });
    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    // The production edit, in shape: a raw update of the version row
    // (spec §4.1, 4096 -> 12288 for a re-run).
    await db.judgeModelVersion.update({
      where: { id: world.version.id },
      data: { samplingDefaults: { temperature: 0.3, max_tokens: 12288 } },
    });

    const header = await db.calibrationRun.findUniqueOrThrow({
      where: { id: result.calibrationRunId },
      include: { judgeModelVersion: { select: { samplingDefaults: true } } },
    });
    // The snapshot is what ran.
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 4096 });
    // LOAD-BEARING: the obvious join really does report today's config for
    // the historical run. Without this the assertion above is a shape test
    // of a column, not a behaviour test of the hazard the column exists for.
    expect(header.judgeModelVersion.samplingDefaults).toEqual({ temperature: 0.3, max_tokens: 12288 });
  });

  it('a version with NO samplingDefaults snapshots the registry default — NULL means "launched before v2k" and nothing else', async () => {
    const world = await mkWorld({ items: 1 }); // samplingDefaults unset

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    expect(header.samplingParams).not.toBeNull();
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });

  it('a PARTIAL samplingDefaults is resolved field-by-field before it is stored — the header is never a copy of the raw JSON', async () => {
    // The production shape (spec §4.1): granite4.2's max_tokens was raised
    // 4096 -> 12288 and `temperature` was never set. This is the ONLY test
    // here that distinguishes the resolver from the obvious shortcut
    // `version.samplingDefaults ?? JUDGE_DEFAULT_SAMPLING_PARAMS` — under that
    // implementation the three tests above all still pass (their fixtures are
    // full pairs or unset), and this one stores `{ max_tokens: 12288 }` with
    // no temperature, breaking the schema comment's "never the raw, nullable,
    // possibly partial samplingDefaults" and the field-for-field comparison
    // with ModelJudgment.samplingParams that the drift detector rests on.
    const world = await mkWorld({ items: 1, samplingDefaults: { max_tokens: 12288 } });

    const result = await launchCalibrationRun(launchParamsFrom(world), { publish: noopPublish });

    const header = await db.calibrationRun.findUniqueOrThrow({ where: { id: result.calibrationRunId } });
    // Full pair on the header; the version's own field is still partial.
    expect(header.samplingParams).toEqual({ temperature: 0.3, max_tokens: 12288 });
    expect(world.version.samplingDefaults).toEqual({ max_tokens: 12288 });
  });
```

(The per-field merge IS proved here, and deliberately so: `tests/lib/registry.test.ts:152-154` pins the resolver in isolation, but nothing else in any suite proves that `launch.ts` CALLS it rather than storing the raw field — `tests/db` is the only suite that executes `launchCalibrationRun`.)

- [ ] **Step 2: Run the DB test file to verify the four new tests fail**

Preconditions: (handoff trap 1) `grep DATABASE_URL /root/judge-arena/.env.test` shows `localhost:5432/judge_arena_test`; and `pgrep -af "[v]itest"` prints nothing — another suite on the shared test DB turns this file into `40P01 deadlock detected` / `Unique constraint failed on (slug)` failures that have nothing to do with the change (facts table).

Run (single file, no reset — the test DB is already at v2j):
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```
Expected: 4 FAIL / 13 pass (17 total). First failure: `snapshots the EFFECTIVE sampling params…` with `expected undefined to deeply equal { temperature: 0.2, max_tokens: 12288 }` (the column does not exist, so the client returns no such property). The other three fail the same way (`expected undefined to deeply equal …`; in the no-defaults test `expected undefined not to be null` passes and the next line fails).

- [ ] **Step 3: Add the column to the schema**

In `prisma/schema.prisma`, after line 920 —

```prisma
  rubricId            String?
  rubric              Rubric?           @relation(fields: [rubricId], references: [id], onDelete: Restrict)
```

— and before `  evaluationRuns      EvaluationRun[]` (line 921), insert:

```prisma
  /// The EFFECTIVE sampling params this calibration was LAUNCHED under:
  /// `effectiveSamplingParams(JudgeModelVersion.samplingDefaults)` resolved
  /// inside the launch transaction (src/lib/calibration/launch.ts) — a fully
  /// populated `{ temperature, max_tokens }`, never the raw, nullable, possibly
  /// partial `samplingDefaults`. Same shape and meaning as
  /// `ModelJudgment.samplingParams`, which every judgment of this run should
  /// equal; a judgment that differs means the version row was edited mid-run
  /// (scoreboard spec §4.1; runbook §8.8). Pinned for the same reason
  /// `rubricId` is: `samplingDefaults` is MUTABLE — three writers
  /// (scripts/admin/add-judge.ts, scripts/importer/judges.ts,
  /// prisma/seed-core.ts), no history — so a join through the version reports
  /// TODAY's config for a historical run, even though prisma/seed-core.ts:223-229
  /// declares a version immutable under a judgment ("a version that needs
  /// different values is a new ordinal"). The production 4096 -> 12288 edits
  /// broke that invariant; this column is the defence. NULL means exactly one
  /// thing: launched before v2k (9 production rows; no backfill).
  samplingParams      Json?
```

- [ ] **Step 4: Generate the migration SQL — zero hand edits**

The dev DB `judge_arena` is at v2h (two migrations behind), so CONTRIBUTING.md:694-697's `--from-url` dev form would emit v2i and v2j statements as well. Diff against the TEST database instead, which the last `npm run test:db` left at v2j — and do it BEFORE this task's first `npm run test:db`, which will move it to v2k:

```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script' | tee /tmp/v2k-diff.sql
```
Expected output, exactly (trailing newlines aside):
```
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "samplingParams" JSONB;
```
If anything else appears, the test DB is not at v2j: reset it alone (the same command `npm run test:db` runs first, package.json:18, without the suite), then re-run the diff:
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=approved-plan-2026-07-24-1a-testdb-only npx prisma migrate reset --force --skip-seed'
```

Create the migration from the header plus the diff verbatim:

```bash
cd /root/judge-arena && mkdir -p prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot && cat > prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot/migration.sql <<'EOF'
-- v2k — CalibrationRun snapshots the sampling config it ran under
--
-- CalibrationRun pinned WHICH judge version ran (judgeModelVersionId) and which
-- rubric (rubricId, v2i) — but not what sampling config the version carried at
-- the time. JudgeModelVersion.samplingDefaults is a plain JSONB with no history
-- and three in-tree writers, so the obvious join (run -> version ->
-- samplingDefaults) reports TODAY's config for a historical run: raising
-- granite4.2 from 4096 to 12288 for calibration run #9 silently rewrote what
-- that join says about run #7, with nothing updated and nothing logged.
-- prisma/seed-core.ts already declares a version immutable under a judgment
-- ("a version that needs different values is a new ordinal"); the production
-- edits violated that invariant and nothing noticed. This column is the
-- defence: the truth used to survive only one level deeper, on
-- ModelJudgment.samplingParams, and readers do not reliably go one level deeper.
--
-- THE EFFECTIVE PARAMS, NOT THE RAW JSON. The column holds
-- effectiveSamplingParams(samplingDefaults) resolved at launch, inside the
-- launch transaction — a full { temperature, max_tokens } — so it is
-- comparable field-for-field with ModelJudgment.samplingParams (the per-call
-- truth), and a judgment that differs from its header is the mid-run-edit tell.
-- Snapshotting the raw field would store NULL for every version without
-- defaults and could not be compared to anything.
--
-- ENTIRELY ADDITIVE, ZERO HAND EDITS: one nullable JSONB column, exactly what
-- `prisma migrate diff` emitted; CONTRIBUTING's pseudo-drift table stays at
-- EIGHT rows. NO BACKFILL: production holds 9 CalibrationRun rows and they stay
-- NULL. NULL means "launched before v2k — derive from ModelJudgment.samplingParams"
-- and nothing else; a backfill would present an after-the-fact derivation as a
-- launch-time snapshot, and every reader must render NULL as pre-v2k, never as
-- a config.

EOF
cat /tmp/v2k-diff.sql >> prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot/migration.sql
diff <(grep -v '^--' prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot/migration.sql | sed '/^$/d') <(grep -v '^--' /tmp/v2k-diff.sql | sed '/^$/d') && echo "SQL identical to migrate diff"
npx prisma generate
```
Expected: `SQL identical to migrate diff`; `prisma generate` succeeds.

- [ ] **Step 5: Write the snapshot in the launch transaction**

In `src/lib/calibration/launch.ts`:

(a) Replace line 39 —
```ts
import type { GoldenCandidate } from '@prisma/client';
```
— with:
```ts
import type { GoldenCandidate, Prisma } from '@prisma/client';
```

(b) After line 43 —
```ts
import { resolveTimeoutBudgets } from '@/lib/llm/timeout-policy';
```
— add:
```ts
// The LEAF module, deliberately — not registry.ts and not the `@/lib/llm`
// barrel. This file is bundled into the image's calibration-run.js by esbuild
// (Dockerfile, only @prisma/client external); importing registry.ts would
// ship every provider SDK, and the barrel would add the redis client on top,
// into a CLI that never calls a provider. tests/lib/sampling.test.ts keeps
// sampling.ts a leaf.
import { effectiveSamplingParams, type SamplingParams } from '@/lib/llm/sampling';
```

(c) In `CalibrationLaunchResult` (lines 81-96), after the `frozeGoldenSet: boolean;` line and before the closing `}`, add:
```ts
  /**
   * The EFFECTIVE `{ temperature, max_tokens }` snapshotted on the header
   * (`CalibrationRun.samplingParams`, v2k) — resolved, never the version's raw
   * `samplingDefaults`. Returned so a caller can print what the run was
   * launched under without re-reading the row.
   */
  samplingParams: SamplingParams;
```

(d) Replace the transaction — lines 316-331 in HEAD, **:330-345 after (b) added 7 lines and (c) added 7**; anchor on the quoted text, which is unique —
```ts
  const { calibrationRun, wasAlreadyFrozen } = await prisma.$transaction(async (tx) => {
    const alreadyFrozen = await isGoldenSetFrozen(tx, goldenSetId);
    const created = await tx.calibrationRun.create({
      data: {
        goldenSetId,
        judgeModelVersionId,
        // The pairwise SYSTEM prompt renders this rubric's criteria, so a
        // kappa produced under rubric X is not comparable to one under
        // rubric Y. Recorded on the header so the number is interpretable
        // without joining through a run.
        rubricId,
      },
      select: { id: true },
    });
    return { calibrationRun: created, wasAlreadyFrozen: alreadyFrozen };
  });
```
— with:
```ts
  const { calibrationRun, wasAlreadyFrozen, samplingParams } = await prisma.$transaction(async (tx) => {
    const alreadyFrozen = await isGoldenSetFrozen(tx, goldenSetId);
    // Read in the SAME transaction as the header write so the snapshot and
    // the irreversible header commit together. `requireOwnedActiveEndpoints`
    // above already refused (400) any version the caller cannot reach, so
    // this null arm guards against a concurrent delete; it is not a refusal
    // an operator will see.
    const version = await tx.judgeModelVersion.findUnique({
      where: { id: judgeModelVersionId },
      select: { samplingDefaults: true },
    });
    if (!version) throw new RunLaunchError(404, 'Judge model version not found');
    // RESOLVED, NOT RAW: the same `effectiveSamplingParams` the worker's
    // pairwise seam resolves per call (registry.ts prepareJudgmentCall; the
    // consumer's pairwise seam passes no overrides), so this equals every
    // ModelJudgment.samplingParams of the run unless the version row moves
    // mid-run — header ≠ judgment is the detector. (One latent third case:
    // judgment-consumer.ts's `result.samplingParamsUsed ?? version
    // .samplingDefaults` fallback persists the RAW field, which can never
    // equal a resolved header. It exists for pre-Task-10 fixtures and no
    // in-tree caller reaches it.) The raw field would store NULL for a
    // version without defaults, and NULL must mean only "pre-v2k".
    const resolved = effectiveSamplingParams(version.samplingDefaults);
    const created = await tx.calibrationRun.create({
      data: {
        goldenSetId,
        judgeModelVersionId,
        // The pairwise SYSTEM prompt renders this rubric's criteria, so a
        // kappa produced under rubric X is not comparable to one under
        // rubric Y. Recorded on the header so the number is interpretable
        // without joining through a run.
        rubricId,
        // Pinned for the same reason as rubricId: `samplingDefaults` is
        // mutable, and a join through the version reports today's config for
        // a historical run (scoreboard spec §4.1; seed-core.ts:223-229 states
        // the invariant the production SQL edits broke).
        samplingParams: resolved as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return { calibrationRun: created, wasAlreadyFrozen: alreadyFrozen, samplingParams: resolved };
  });
```
(The double cast is required: `SamplingParams` is an interface without an index signature, so it is not directly assignable to `Prisma.InputJsonValue`; `judgment-consumer.ts:753` gets away with one cast because it casts a union that already includes `JsonValue`.)

(e) Replace the logger call (lines 333-338 in HEAD; now shifted) —
```ts
  logger.info('launchCalibrationRun: golden set is now frozen (irreversible)', {
    goldenSetId,
    calibrationRunId: calibrationRun.id,
    items: items.length,
    frozeGoldenSet: !wasAlreadyFrozen,
  });
```
— with:
```ts
  logger.info('launchCalibrationRun: golden set is now frozen (irreversible)', {
    goldenSetId,
    calibrationRunId: calibrationRun.id,
    items: items.length,
    frozeGoldenSet: !wasAlreadyFrozen,
    samplingParams,
  });
```

(f) Replace the return (lines 414-419 in HEAD; now shifted) —
```ts
  return {
    calibrationRunId: calibrationRun.id,
    accepted,
    failed,
    frozeGoldenSet: !wasAlreadyFrozen,
  };
```
— with:
```ts
  return {
    calibrationRunId: calibrationRun.id,
    accepted,
    failed,
    frozeGoldenSet: !wasAlreadyFrozen,
    samplingParams,
  };
```

- [ ] **Step 6: Run the full DB suite — this replays the migration chain including v2k (the real test of the migration file, CONTRIBUTING.md:726-730)**

```bash
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test — NOT judge-arena-pg-1
pgrep -af "[v]itest"                              # must print NOTHING (shared test DB; see facts table)
cd /root/judge-arena && npm run test:db
```
Expected: `prisma migrate reset` applies 21 migrations ending in `20260901180000_v2k_calibration_sampling_snapshot`; 674 tests pass (670 + 4), including all 17 in `tests/db/calibration-link.test.ts`. Every pre-existing direct `db.calibrationRun.create` seed (golden-set-freeze, meta-eval, golden-sets, config-golden-sets, account-deletion) stays green — the column is nullable and none asserts a whole row.

- [ ] **Step 7: Injection — two breakages, each must go red for the stated reason**

From here on run only the file (the DB is now at v2k, no reset needed):
```bash
cd /root/judge-arena && sh -c 'set -a; . ./.env.test; set +a; npx vitest run --config vitest.db.config.ts tests/db/calibration-link.test.ts'
```

Injection A — delete the write. In launch.ts remove the single line
```ts
        samplingParams: resolved as unknown as Prisma.InputJsonValue,
```
Expected: 4 FAIL — every block-(4) test, each on its FIRST assertion. Tests 1, 2 and 4 report `expected null to deeply equal { … }`; test 3 (`a version with NO samplingDefaults…`) reports `expected null not to be null`, because `.not.toBeNull()` is its first assertion and its `toEqual` line is never reached. Restore.

Injection B — snapshot the RAW field instead of the resolved one. Change
```ts
    const resolved = effectiveSamplingParams(version.samplingDefaults);
```
to
```ts
    const resolved = (version.samplingDefaults ?? {}) as unknown as SamplingParams;
```
Expected: 2 FAIL. `a version with NO samplingDefaults snapshots the registry default…` with `expected {} to deeply equal { temperature: 0.3, max_tokens: 4096 }`, and `a PARTIAL samplingDefaults is resolved field-by-field…` with `expected { max_tokens: 12288 } to deeply equal { temperature: 0.3, max_tokens: 12288 }`. The other two stay green — correct, both of those fixtures carry a FULL pair, so raw and resolved coincide; the two reds are exactly the tests that discriminate raw from resolved. (The DOUBLE cast mirrors Step 5(d)'s and is required in this direction too: `Prisma.JsonValue` and the `SamplingParams` interface are mutually non-assignable, and `?? {}` does not rescue it — TS subtype-reduces the union away, so a single `as SamplingParams` is TS2352 `neither type sufficiently overlaps` and an executor who runs `npx tsc --noEmit` mid-injection would see a compile error instead of the two assertion failures above. Verified with tsc 2026-09-02.) Restore.

- [ ] **Step 8: Bundle-weight check and the cheap gates (no commit yet — see Step 9)**

The heavy gates are DELIBERATELY NOT re-run here. Step 6 already did the load-bearing one — `npm run test:db`, a full `prisma migrate reset` that replays the chain including v2k, which is the real test of the migration file (CONTRIBUTING.md:726-730). Re-running it as `test:db:coverage` in this step would reset the database and replay the same 674 tests a second time only to print coverage numbers, and Task 4 Step 6 — the single commit point for Tasks 2-4 — runs `test:db:coverage`, `test:integration` and `build` anyway. Nothing between here and there can move the integration suite or the build beyond what `tsc` proves. Run:

```bash
cd /root/judge-arena && npx esbuild scripts/calibration/run.ts --bundle --platform=node --target=node22 \
  --outfile=/tmp/ja-calibration-run.js --external:@prisma/client --tsconfig=tsconfig.json --log-level=warning \
  && echo "sdk+redis hits: $(grep -c '@anthropic-ai/sdk\|llm/breaker-redis' /tmp/ja-calibration-run.js)  bytes: $(stat -c%s /tmp/ja-calibration-run.js)"
npm run lint && npx tsc --noEmit && npm run test:coverage
```
Expected: `sdk+redis hits: 0`, bytes still ≈ 320 KB (launch.ts now imports the leaf `@/lib/llm/sampling`; if this moved, the leaf property broke — see Task 1 Step 7 for how to read a non-zero count); lint 0; tsc 0; unit 879, unit coverage floors met. The db/integration/build gates are deferred to Task 4 Step 6. (For when they run: launch.ts gains covered lines and `src/lib/calibration/sampling-drift.ts` does not exist yet, so the db aggregate moves UP at this point in the tree; do not touch any floor — see Task 4 Step 6 for the direction once Task 3 has landed.)

- [ ] **Step 9: Stage only**

Binding decision for this item: ONE feature commit carries the column, the launch write, the DB tests, the CLI and the docs (they are one concern — "the run records what it ran under"). Stage now; the commit is Task 4 Step 6.

```bash
git -C /root/judge-arena add prisma/schema.prisma prisma/migrations/20260901180000_v2k_calibration_sampling_snapshot/migration.sql src/lib/calibration/launch.ts tests/db/calibration-link.test.ts
git -C /root/judge-arena status --short
```
Expected: the four paths staged (`A` for the migration, `M` for the rest), nothing else modified.

---

### Task 3: Sampling-drift detector and the CLI read sites

**Files:**
- Create: `src/lib/calibration/sampling-drift.ts`
- Create: `tests/lib/calibration-sampling-drift.test.ts`
- Modify: `scripts/calibration/run.ts:42-53` (imports), `:156-161` (`--score-only` branch — the quoted block is six lines, `let calibrationRunId;` through `} else {`), `:199` (pre-launch print), `:213` (after it), `:276-286` (judgments select), and a new block after the judgments fetch (`:288`) — all HEAD numbers; Step 6 carries the running offset for each substep

**Interfaces:**
- Consumes: `CalibrationLaunchResult.samplingParams: SamplingParams` (Task 2); `CalibrationRun.samplingParams` (Task 2).
- Produces (from `'@/lib/calibration/sampling-drift'`):
  - `export function canonicalJson(value: unknown): string`
  - `export type SamplingDrift = { kind: 'consistent'; executedUnder: string | null } | { kind: 'moved_mid_run'; executedUnder: string[] } | { kind: 'differs_from_header'; header: string; executedUnder: string }`
  - `export function detectSamplingDrift(header: unknown, judgments: ReadonlyArray<{ status: string; samplingParams: unknown }>): SamplingDrift`
  - `export function describeSamplingSnapshot(snapshot: unknown): string` (NULL/undefined → the pre-v2k sentence, never a config; otherwise `canonicalJson`)

Why a `src/lib` module and not ten lines in the script: the comparison contains a rule that is silently wrong if done naively — JSONB returns keys shortest-first (`max_tokens` before `temperature`), so `JSON.stringify(header) !== JSON.stringify(judgment.samplingParams)` on EVERY run — and CONTRIBUTING.md:247 says rules that can be silently wrong go under `src/lib/**` where they can be unit-tested. The NULL renderer lives here for the same reason: a `snapshot ?? JUDGE_DEFAULT_SAMPLING_PARAMS` regression would silently re-introduce the exact lie the column exists to end, and the Goal makes "NULL renders as pre-v2k, never as a config" a requirement. `scripts/calibration/run.ts` itself has no harness and stays print-only.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/calibration-sampling-drift.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';

// ─── header (launch-time snapshot) vs judgments (execution-time truth) ─────
//
// CalibrationRun.samplingParams (v2k) is written from the same resolver the
// worker uses per judgment, so the two agree unless the version row was edited
// mid-run (runbook §8.8). The trap in comparing them is JSONB: Postgres stores
// object keys shortest-first, so the header written as { temperature,
// max_tokens } reads back from a judgment row as { max_tokens, temperature }.
// A naive JSON.stringify comparison would report drift on EVERY run.

const LAUNCHED = { temperature: 0.3, max_tokens: 4096 }; // in-process key order
const FROM_JSONB = { max_tokens: 4096, temperature: 0.3 }; // what Postgres hands back
const RAISED = { max_tokens: 12288, temperature: 0.3 };

describe('calibration/sampling-drift: canonicalJson', () => {
  it('sorts keys so a JSONB round-trip compares equal to what was written', () => {
    expect(canonicalJson(LAUNCHED)).toBe(canonicalJson(FROM_JSONB));
    expect(canonicalJson(LAUNCHED)).toBe('{"max_tokens":4096,"temperature":0.3}');
  });

  it('is total over the values a Json? column can hold', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('undefined');
    expect(canonicalJson('4096')).toBe('"4096"');
  });
});

describe('calibration/sampling-drift: describeSamplingSnapshot', () => {
  it('a NULL header is rendered as pre-v2k, never as a config', () => {
    // NULL means exactly one thing — launched before v2k. Falling through to a
    // default here would present a guess as a launch-time snapshot.
    expect(describeSamplingSnapshot(null)).toMatch(/launched before v2k/);
    expect(describeSamplingSnapshot(undefined)).toMatch(/launched before v2k/);
    // A real snapshot renders canonically (same function as the drift check).
    expect(describeSamplingSnapshot(FROM_JSONB)).toBe(canonicalJson(FROM_JSONB));
  });
});

describe('calibration/sampling-drift: detectSamplingDrift', () => {
  it('JSONB key order is NOT drift', () => {
    expect(
      detectSamplingDrift(LAUNCHED, [
        { status: 'completed', samplingParams: FROM_JSONB },
        { status: 'completed', samplingParams: FROM_JSONB },
      ])
    ).toEqual({ kind: 'consistent', executedUnder: canonicalJson(LAUNCHED) });
  });

  it('two distinct configs among COMPLETED judgments is a run that moved mid-run', () => {
    const drift = detectSamplingDrift(LAUNCHED, [
      { status: 'completed', samplingParams: FROM_JSONB },
      { status: 'completed', samplingParams: RAISED },
    ]);
    expect(drift.kind).toBe('moved_mid_run');
    expect(drift.kind === 'moved_mid_run' && drift.executedUnder).toEqual([
      canonicalJson(FROM_JSONB),
      canonicalJson(RAISED),
    ]);
  });

  it('a pending/error judgment with NULL samplingParams does not collapse the comparison (spec §4.1 caveat)', () => {
    expect(
      detectSamplingDrift(LAUNCHED, [
        { status: 'completed', samplingParams: FROM_JSONB },
        { status: 'error', samplingParams: null },
        { status: 'pending', samplingParams: null },
      ])
    ).toEqual({ kind: 'consistent', executedUnder: canonicalJson(LAUNCHED) });
  });

  it('every judgment agreeing with each other but not with the header is a row edited between launch and execution', () => {
    expect(detectSamplingDrift(LAUNCHED, [{ status: 'completed', samplingParams: RAISED }])).toEqual({
      kind: 'differs_from_header',
      header: canonicalJson(LAUNCHED),
      executedUnder: canonicalJson(RAISED),
    });
  });

  it('a pre-v2k header (null) is never reported as drift — there is nothing to compare against', () => {
    expect(detectSamplingDrift(null, [{ status: 'completed', samplingParams: FROM_JSONB }])).toEqual({
      kind: 'consistent',
      executedUnder: canonicalJson(FROM_JSONB),
    });
    expect(detectSamplingDrift(null, [])).toEqual({ kind: 'consistent', executedUnder: null });
  });

  it('a header with nothing completed yet is not drift — the poll can time out with every judgment still pending', () => {
    // The state scripts/calibration/run.ts hands the detector when the poll
    // loop times out with everything still pending: a REAL header (v2k wrote
    // it at launch) and zero completed judgments. It is the only case that
    // exercises the `only !== null` arm — every other test here either has a
    // completed judgment or a null header, where `header != null`
    // short-circuits first.
    expect(detectSamplingDrift(LAUNCHED, [{ status: 'pending', samplingParams: null }])).toEqual({
      kind: 'consistent',
      executedUnder: null,
    });
    expect(detectSamplingDrift(LAUNCHED, [])).toEqual({ kind: 'consistent', executedUnder: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-sampling-drift.test.ts`
Expected: FAIL with `Failed to resolve import "@/lib/calibration/sampling-drift"`.

- [ ] **Step 3: Write the module**

Create `src/lib/calibration/sampling-drift.ts`:

```ts
/**
 * ─── Sampling drift: launch-time snapshot vs execution-time truth (v2k) ────
 *
 * `CalibrationRun.samplingParams` is what a calibration was LAUNCHED under —
 * `effectiveSamplingParams(version.samplingDefaults)` resolved inside the
 * launch transaction (src/lib/calibration/launch.ts). Each
 * `ModelJudgment.samplingParams` is what that judgment was EXECUTED under —
 * the same resolver, run by the worker per call against the version row AS
 * OF THAT CALL (src/worker/judgment-consumer.ts loads the version per
 * judgment). The two agree by construction, unless the version row was edited
 * while the run was draining — runbook §8.8's "mixture of two experiments",
 * which the scoreboard spec §4.1 detects by `SELECT DISTINCT` returning two
 * rows. This module makes that tell mechanical for scripts/calibration/run.ts.
 *
 * WHY IT IS NOT TEN LINES IN THE SCRIPT: JSONB stores object keys
 * shortest-first, so `{ temperature, max_tokens }` written by Prisma comes
 * back as `{ max_tokens, temperature }`. A naive `JSON.stringify` comparison
 * between the in-process header and a DB-loaded judgment reports drift on
 * EVERY run — a rule that is silently wrong, which CONTRIBUTING.md:247 says
 * belongs under src/lib/** where tests/lib/calibration-sampling-drift.test.ts
 * can pin it.
 */

export type SamplingDrift =
  /** Every completed judgment ran under one config, and it matches the
   * header when there is one. `executedUnder` is null when nothing has
   * completed yet. */
  | { kind: 'consistent'; executedUnder: string | null }
  /** Completed judgments ran under more than one config: the version row was
   * edited mid-run. The run is not internally comparable. */
  | { kind: 'moved_mid_run'; executedUnder: string[] }
  /** Judgments agree with each other but not with the header: the row was
   * edited between launch and the first execution. */
  | { kind: 'differs_from_header'; header: string; executedUnder: string };

/**
 * JSON with object keys sorted — flat objects only, which is all a
 * `SamplingParams` is. Total over `Json?` column values (`null`), and over
 * `undefined` for callers holding an unset field.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'undefined';
  const record = value as Record<string, unknown>;
  return JSON.stringify(record, Object.keys(record).sort());
}

/**
 * How a `CalibrationRun.samplingParams` value is shown to an operator. A NULL
 * (or unset) snapshot is a run launched before v2k and is rendered as exactly
 * that — never as a config, and never falling through to a registry default,
 * because either would reintroduce the lie the column was added to end.
 */
export function describeSamplingSnapshot(snapshot: unknown): string {
  return snapshot == null
    ? '(no snapshot — launched before v2k; derive from ModelJudgment.samplingParams)'
    : canonicalJson(snapshot);
}

export function detectSamplingDrift(
  header: unknown,
  judgments: ReadonlyArray<{ status: string; samplingParams: unknown }>
): SamplingDrift {
  // Only COMPLETED judgments carry a config that ran; pending/error rows have
  // NULL samplingParams and must not collapse the comparison (spec §4.1).
  const executedUnder = [
    ...new Set(judgments.filter((j) => j.status === 'completed').map((j) => canonicalJson(j.samplingParams))),
  ];
  if (executedUnder.length > 1) return { kind: 'moved_mid_run', executedUnder };
  const only = executedUnder[0] ?? null;
  // A null header is a run launched before v2k — nothing to compare against,
  // and never something to warn about.
  if (header != null && only !== null && only !== canonicalJson(header)) {
    return { kind: 'differs_from_header', header: canonicalJson(header), executedUnder: only };
  }
  return { kind: 'consistent', executedUnder: only };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/judge-arena && npx vitest run tests/lib/calibration-sampling-drift.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Injection — the five rules that could be silently wrong**

Injection A (key order): in `canonicalJson` change `return JSON.stringify(record, Object.keys(record).sort());` to `return JSON.stringify(record);`.
Run: `npx vitest run tests/lib/calibration-sampling-drift.test.ts`
Expected: FAIL — 3 tests (the header `LAUNCHED` now canonicalises to `{"temperature":0.3,"max_tokens":4096}` while every `FROM_JSONB` judgment canonicalises to `{"max_tokens":4096,"temperature":0.3}`): `sorts keys so a JSONB round-trip compares equal…` (`expected '{"temperature":0.3,"max_tokens":4096}' to be '{"max_tokens":4096,"temperature":0.3}'`), `JSONB key order is NOT drift` and `a pending/error judgment with NULL samplingParams does not collapse the comparison` (both `expected { kind: 'differs_from_header', …(2) } to deeply equal { kind: 'consistent', …(1) }`). The other 6 stay green — `describeSamplingSnapshot`, the `moved_mid_run`/`differs_from_header`/pre-v2k cases (which compare outputs of the same broken function against each other) and the nothing-completed case (no judgment to canonicalise). Restore.

Injection B (status filter): in `detectSamplingDrift` change `.filter((j) => j.status === 'completed')` to `.filter(() => true)`.
Run: same command.
Expected: FAIL — 1 test: `a pending/error judgment with NULL samplingParams does not collapse the comparison` with `kind: 'moved_mid_run'` (`'null'` joins the Set). Restore.

Injection C (NULL is pre-v2k, never a config): in `describeSamplingSnapshot` change `snapshot == null` to `snapshot === undefined`.
Run: same command.
Expected: FAIL — 1 test: `a NULL header is rendered as pre-v2k, never as a config` with `expected 'null' to match /launched before v2k/`. Restore.

Injection D (the `only !== null` guard — a launched run with nothing completed yet): in `detectSamplingDrift` change

```ts
  if (header != null && only !== null && only !== canonicalJson(header)) {
```
to
```ts
  if (header != null && only !== canonicalJson(header)) {
```

Run: same command.
Expected: FAIL — 1 test: `a header with nothing completed yet is not drift — the poll can time out with every judgment still pending`, with `expected { kind: 'differs_from_header', …(2) } to deeply equal { kind: 'consistent', …(1) }` (`only` is `null`, which never equals a canonicalised header, so a run that has simply not finished anything is reported as an edited version row). Every other test stays green — which is the point: without this test the guard could be deleted and the suite would not notice. Restore.

Injection E (the `moved_mid_run` threshold — the runbook §8.8 contamination case): in `detectSamplingDrift` change `if (executedUnder.length > 1)` to `if (executedUnder.length > 2)`.
Run: same command.
Expected: FAIL — 1 test: `two distinct configs among COMPLETED judgments is a run that moved mid-run` with `expected 'consistent' to be 'moved_mid_run'` on the `drift.kind` assertion. (`consistent`, not `differs_from_header`: with the early return gone, `only` becomes `executedUnder[0]` = `canonicalJson(FROM_JSONB)`, which IS `canonicalJson(LAUNCHED)`, so the header comparison passes and the second config is silently dropped — a strictly worse failure than a mismatch, and exactly why this injection is worth running.) Restore.

- [ ] **Step 6: Wire the CLI**

In `scripts/calibration/run.ts`:

(a) After line 53 —
```ts
import { scoreCalibrationRun } from '@/lib/calibration/score';
```
— add:
```ts
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';
```

(b) No local helper is defined in run.ts: the NULL-as-pre-v2k renderer is `describeSamplingSnapshot` from the module above (Step 3), where `tests/lib/calibration-sampling-drift.test.ts` pins it. The `cap` helper at lines 72-74 is untouched.

(c) Replace lines 156-161 (six lines: `let calibrationRunId: string;` through `} else {` — a 156-160 range would drop the `} else {` and leave the file unparseable) —
```ts
  let calibrationRunId: string;

  if (scoreOnly) {
    calibrationRunId = scoreOnly;
    console.log(`Scoring existing calibration run ${calibrationRunId} (no launch).`);
  } else {
```
— with:
```ts
  let calibrationRunId: string;
  // The header's launch-time snapshot (v2k, CalibrationRun.samplingParams).
  // `null` means launched before the column existed — see describeSamplingSnapshot.
  let headerSampling: unknown;

  if (scoreOnly) {
    calibrationRunId = scoreOnly;
    console.log(`Scoring existing calibration run ${calibrationRunId} (no launch).`);
    const header = await prisma.calibrationRun.findUnique({
      where: { id: calibrationRunId },
      select: { samplingParams: true },
    });
    if (!header) throw new Error(`No CalibrationRun ${calibrationRunId}.`);
    headerSampling = header.samplingParams;
    console.log(`  sampling  ${describeSamplingSnapshot(headerSampling)}`);
  } else {
```

(d) Replace the pre-launch sampling print — line 199 in HEAD, **:210 after (a) and (c) above**; (a) adds +1 and (c) adds +10, so every anchor below is HEAD + 11 plus the lines this step's own earlier substeps add. Anchor on the quoted text, which is unique —
```ts
    console.log(`  sampling  ${JSON.stringify(version.samplingDefaults)}`);
```
— with:
```ts
    console.log(
      `  sampling  ${JSON.stringify(version.samplingDefaults)}  ` +
        '(version.samplingDefaults — RAW and MUTABLE; the run\'s resolved snapshot is printed after launch)'
    );
```

(e) After the `calibrationRunId` print — line 213 in HEAD, **:227 after (a)/(c)/(d)** —
```ts
    console.log(`  calibrationRunId ${calibrationRunId}`);
```
— add:
```ts
    headerSampling = launched.samplingParams;
    console.log(`  sampling  ${canonicalJson(launched.samplingParams)}  (snapshot on CalibrationRun.samplingParams — resolved, immutable)`);
```

(f) In the judgments select — lines 276-286 in HEAD, **:292-302 after (a)/(c)/(d)/(e)** — after the line (`inputTokens: …`, HEAD :280, now **:296**)
```ts
      inputTokens: true, outputTokens: true, latencyMs: true, servedModelId: true, finishReason: true, parseMode: true,
```
add:
```ts
      // What each judgment was EXECUTED under — compared against the header
      // snapshot below (v2k).
      samplingParams: true,
```

(g) After the judgments fetch's closing `});` — line 288 in HEAD, **:307 after (a)/(c)/(d)/(e)/(f)** — and before `console.log(\`\n── Capture completeness …` (HEAD :290, now :309 — do NOT insert inside the `fields` array below it), add:
```ts
  // ── Sampling drift (v2k) ─────────────────────────────────────────────────
  // Header = what the run was LAUNCHED under; each completed judgment = what
  // it was EXECUTED under. Equal by construction unless the version row was
  // edited while the run drained — runbook §8.8's "mixture of two
  // experiments". The comparison lives in src/lib (JSONB reorders keys).
  const drift = detectSamplingDrift(headerSampling, judgments);
  if (drift.kind === 'moved_mid_run') {
    console.log(`\n  ⚠ sampling config MOVED MID-RUN — completed judgments ran under ${drift.executedUnder.join('  and  ')}.`);
    console.log('    This run is a mixture of two experiments (runbook §8.8): void it and re-run whole under a NEW version ordinal.');
  } else if (drift.kind === 'differs_from_header') {
    console.log(`\n  ⚠ sampling config differs from the launch snapshot — header ${drift.header}, judgments ${drift.executedUnder}.`);
    console.log('    The version row was edited between launch and execution; the header is what was intended, the judgments are what ran.');
  }
```

- [ ] **Step 7: Verify the script (no harness exists — map testStrategy "NOT TESTED"; this is the honest substitute)**

Type-check and lint the script, then execute the new `--score-only` branch against the local test DB (reads only; the id does not exist, so the branch runs its query and takes its refusal):

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit
pgrep -af "[v]itest"   # must print NOTHING — shared test DB (facts table); a concurrent `prisma migrate reset` can drop CalibrationRun mid-query and turn the expected refusal into a Prisma P2021
sh -c 'set -a; . ./.env.test; set +a; npx tsx scripts/calibration/run.ts --score-only=does-not-exist'; echo "exit=$?"
```
Expected: tsc 0; lint 0; the script prints `Scoring existing calibration run does-not-exist (no launch).` then `Error: No CalibrationRun does-not-exist.` (with a stack) and `exit=1`.

Also confirm the bundle is still SDK-free (the script now imports `src/lib/calibration/sampling-drift.ts`, a leaf):
```bash
npx esbuild scripts/calibration/run.ts --bundle --platform=node --target=node22 --outfile=/tmp/ja-calibration-run.js --external:@prisma/client --tsconfig=tsconfig.json --log-level=warning && echo "sdk+redis hits: $(grep -c '@anthropic-ai/sdk\|llm/breaker-redis' /tmp/ja-calibration-run.js)  bytes: $(stat -c%s /tmp/ja-calibration-run.js)"
```
Expected: `sdk+redis hits: 0`, bytes still ≈ 320 KB. (This check is manual and in no gate — see the note in Task 1 Step 7 on reading a non-zero count. Wiring it into `scripts/ci-local.sh` would be a second concern in this commit and is deliberately not done here.)

- [ ] **Step 8: Gates, then stage (no commit yet — commit is Task 4 Step 6)**

```bash
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage
```
Expected: unit 888 tests / 57 files (879 + 9); aggregate floors 43/63/87/43 hold (the new module is 100% covered in the unit run; `src/lib/calibration/**` has no per-glob floor). Note for the db run (Task 4 Step 6): `vitest.db.config.ts:35` uses the same `include: ['src/lib/**/*.ts', …]` and neither config sets `coverage.all`, so Vitest's default counts files no db test imports — `sampling-drift.ts` lands in the db denominator at 0%. Its ~14 statements against a floor of 47 vs ~49 actual leave ample margin, but expect the db aggregate to move DOWN by a fraction of a point rather than up; never lower a floor to accommodate it.

```bash
git -C /root/judge-arena add src/lib/calibration/sampling-drift.ts tests/lib/calibration-sampling-drift.test.ts scripts/calibration/run.ts
git -C /root/judge-arena status --short
```
Expected: seven paths staged in total (Task 2's four + these three).

---

### Task 4: Documentation CORRECTION notes and the feature commit

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md:326-330` (§7 #1 — §7 heading is now :318, "### Blocks a trustworthy leaderboard" :324; was :296-300 before Wave 1's CI commits) and `:379-389` (§8 step 3 SQL; was :342-352)
- Modify: `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md:232-236` (§4.1 "Open follow-up" — kept verbatim; a note is inserted after :236)
- Modify: `docs/superpowers/plans/2026-08-30-state-and-next-steps.md:416-423` (§5.6 #6)
- Modify: `docs/runbooks/scoring-a-judge-against-a-golden-set.md:543-546` (§8.8 — heading at :532; was :534-537 before Wave 1's U3 §8.7 note)

**EVERY doc line number in this task shifted in Wave 1 except the spec's and the register's.** Verified on HEAD 5e48187; each step also names a unique text anchor. Anchor on the TEXT, and re-check the number first with e.g. `grep -n -a 'already pinned for exactly this reason' docs/superpowers/plans/2026-09-01-scoreboard-handoff.md`.

**Interfaces:** none (docs). Every claim below is made true by Tasks 2-3 in the same commit.

**No injection step:** this task changes only prose. Every factual claim it writes is made true by Tasks 2-3, whose injections (2.7 A/B, 3.5 A/B/C) are the evidence for it; there is no behaviour here to break.

What is being corrected, so it is stated rather than overwritten (CONTRIBUTING.md:1653-1656): three documents say `passThreshold` is "already pinned" on the run. It is not — `CalibrationRun.passed` and `CalibrationRun.passThreshold` are declared in `prisma/schema.prisma` (`passed` then `passThreshold`; :923 and :926 on HEAD, but Task 2 Step 3 inserts 17 lines above them in the SAME commit, moving them to :940 and :943 — which is why the notes below cite the field names and not line numbers) and nothing in `src/` or `scripts/` writes them (`grep -rn -a passThreshold src scripts` → none; `score.ts:285-310` writes rawAgreement/kappa/verdictCount/kappaVariant/kappaWeighting/thresholdMetric/finishedAt). What IS pinned: `rubricId` at launch, `kappaVariant`/`kappaWeighting`/`thresholdMetric` at score time. NOT changed here, by the brief: `src/lib/llm/registry.ts:673` and runbook §8.2 (:389, :400) still tell operators to "raise samplingDefaults.max_tokens" in place — that contradicts `prisma/seed-core.ts:223-229` and belongs to the loop-detector plan (registry.ts is its file). New text written here says "new ordinal (or at minimum never mid-run)".

- [ ] **Step 1: Handoff §7 #1 — CORRECTION note**

In `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md`, after line **330** (was :300 before Wave 1's CI commits; re-verify with `grep -n -a 'already pinned for exactly this reason' docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` and anchor on the quoted text, which is unique) —
```markdown
   level deeper on `ModelJudgment.samplingParams`. `rubricId`, `kappaVariant` and `passThreshold` are
   already pinned for exactly this reason; this was missed. **Additive, one column.**
```
— insert:
```markdown

   > **CORRECTION (2026-09-01, v2k).** Landed as `CalibrationRun.samplingParams` — the RESOLVED
   > `{ temperature, max_tokens }` (`effectiveSamplingParams(samplingDefaults)`, never the raw JSON)
   > written inside the launch transaction in `src/lib/calibration/launch.ts`; NULL only on the 9
   > runs launched before v2k, deliberately not backfilled. The sentence above also said
   > `passThreshold` is "already pinned". **It is not**: `CalibrationRun.passed` and
   > `CalibrationRun.passThreshold` are declared in `prisma/schema.prisma` and NOTHING in `src/` or
   > `scripts/` writes them. What is
   > actually pinned is `rubricId` at launch and `kappaVariant`/`kappaWeighting`/`thresholdMetric` at
   > score time (`score.ts`). The same wrong sentence appeared in the scoreboard spec §4.1 and the
   > register §5.6 #6 and is corrected in both. `scripts/calibration/run.ts` now prints the snapshot
   > and warns when a run's judgments disagree with its header or with each other.
```

- [ ] **Step 2: Handoff §8 step 3 — read the header first**

Replace lines **379-389** (was :342-352 before Wave 1; §8's heading is now :369 and a CI CORRECTION sits at :392. Anchor on the first quoted line, `# 3. The scoreboard as the database holds it — never from a doc, and never`; all 11 lines match the tree byte-for-byte) —
```sh
# 3. The scoreboard as the database holds it — never from a doc, and never
#    joining to JudgeModelVersion.samplingDefaults for the config. (open #1)
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.kappa, cr.\"verdictCount\",
         (SELECT DISTINCT mj.\"samplingParams\"->>'max_tokens'
            FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\"
           WHERE er.\"calibrationRunId\" = cr.id AND mj.\"samplingParams\" IS NOT NULL) AS maxtok
    FROM \"CalibrationRun\" cr
    JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\"
    JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\"
   ORDER BY cr.\"startedAt\" DESC;"
```
— with:
```sh
# 3. The scoreboard as the database holds it — never from a doc, and never
#    joining to JudgeModelVersion.samplingDefaults for the config. (open #1,
#    landed as v2k: cr."samplingParams" is the launch-time snapshot. The
#    nested DISTINCT is only the fallback for the 9 rows launched before v2k,
#    which are NULL by design — and it ERRORS with "more than one row" on a
#    run whose config moved mid-run, which is the right outcome.)
kubectl -n tenant-public exec judge-arena-pg-1 -c postgres -- psql -U postgres -d judge_arena -c "
  SELECT jm.name, cr.\"rawAgreement\" AS acc, cr.kappa, cr.\"verdictCount\",
         COALESCE(cr.\"samplingParams\"->>'max_tokens',
           (SELECT DISTINCT mj.\"samplingParams\"->>'max_tokens'
              FROM \"ModelJudgment\" mj JOIN \"EvaluationRun\" er ON er.id = mj.\"runId\"
             WHERE er.\"calibrationRunId\" = cr.id AND mj.\"samplingParams\" IS NOT NULL)) AS maxtok,
         (cr.\"samplingParams\" IS NULL) AS pre_v2k
    FROM \"CalibrationRun\" cr
    JOIN \"JudgeModelVersion\" jmv ON jmv.id = cr.\"judgeModelVersionId\"
    JOIN \"JudgeModel\" jm ON jm.id = jmv.\"judgeModelId\"
   ORDER BY cr.\"startedAt\" DESC;"
```

- [ ] **Step 3: Spec §4.1 — landed, with the CORRECTION and the right-hand query**

In `docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md`, keep lines 232-236 verbatim (the same insert-after pattern as Steps 1 and 4 — the original stays, the note beneath says what was wrong) —
```markdown
> **Open follow-up.** `CalibrationRun` should snapshot the resolved sampling config at launch, the
> way it already snapshots `rubricId`, `kappaVariant` and `passThreshold`. Those three were pinned
> because a report you cannot reconstruct is not a report; `samplingDefaults` is the same argument
> and was missed. Until then, every reader must know to go one level deeper, and readers do not
> reliably know things.
```
— and insert after line 236 (one blank line between the two blockquotes, so markdown does not merge them):
```markdown

> **Landed (v2k, 2026-09-01) — with a CORRECTION.** `CalibrationRun.samplingParams` now snapshots
> the RESOLVED config at launch (`effectiveSamplingParams(samplingDefaults)`, a full
> `{ temperature, max_tokens }`, never the raw JSON), so the header itself is now the right answer:
>
> ```sql
> -- RIGHT, since v2k. NULL only on the 9 runs launched before the column existed —
> -- for those, and only those, fall through to the per-judgment query above.
> SELECT cr.id, cr."samplingParams"->>'max_tokens' AS max_tokens, cr."samplingParams" IS NULL AS pre_v2k
> FROM "CalibrationRun" cr;
> ```
>
> The note above says the run "already snapshots `rubricId`, `kappaVariant` and
> `passThreshold`". **That is wrong about `passThreshold`**: `CalibrationRun.passed` and
> `CalibrationRun.passThreshold` are declared in `prisma/schema.prisma` and nothing writes them.
> `rubricId` is pinned at launch;
> `kappaVariant`/`kappaWeighting`/`thresholdMetric` at score time. The header is a snapshot, not a
> lock — the worker still reads the version row per judgment — so a judge whose config must change
> gets a **new version ordinal** (`prisma/seed-core.ts:223-229` states the invariant) or, at the very
> minimum, is never edited mid-run; `scripts/calibration/run.ts` prints a ⚠ when a run's judgments
> disagree with the header or with each other, comparing with keys canonicalised (JSONB reorders them).
```

- [ ] **Step 4: Register §5.6 #6 — done, with the CORRECTION**

In `docs/superpowers/plans/2026-08-30-state-and-next-steps.md`, after line 423 —
```markdown
   the run for precisely this reason; `samplingDefaults` was missed. Additive, one column.
```
— insert:
```markdown

   > **DONE / CORRECTION (v2k, 2026-09-01).** Landed as `CalibrationRun.samplingParams` — resolved
   > at launch inside the launch transaction, NULL only on the 9 pre-v2k rows (no backfill), printed
   > and drift-checked by `scripts/calibration/run.ts`. And "`passThreshold` … already pinned" above
   > was wrong: `passThreshold`/`passed` have no writer anywhere in `src/` or `scripts/`; only
   > `rubricId` (launch) and `kappaVariant`/`kappaWeighting`/`thresholdMetric` (score) are pinned.
```

- [ ] **Step 5: Runbook §8.8 — the header is the second tell**

In `docs/runbooks/scoring-a-judge-against-a-golden-set.md`, replace lines **543-546** (was :534-537 before Wave 1's U3 §8.7 note; §8.8's heading is at :532. Anchor on ``Run `cmtircx0x` is the worked example`` — the four quoted lines are byte-exact) —
```markdown
Run `cmtircx0x` is the worked example: 11 items completed under the flat 300 s wall, the remaining 19
under the escalating policy, and the run is internally comparable because the model's own
configuration never moved. The tell that a run *is* contaminated is §4.1 of the scoreboard spec —
`SELECT DISTINCT mj."samplingParams"->>'max_tokens'` returning more than one row.
```
— with:
```markdown
Run `cmtircx0x` is the worked example: 11 items completed under the flat 300 s wall, the remaining 19
under the escalating policy, and the run is internally comparable because the model's own
configuration never moved. The tell that a run *is* contaminated is §4.1 of the scoreboard spec —
`SELECT DISTINCT mj."samplingParams"->>'max_tokens'` returning more than one row — and, since v2k,
any judgment's `samplingParams` differing from the header's `CalibrationRun."samplingParams"` (the
launch-time snapshot; NULL on runs launched before v2k). `scripts/calibration/run.ts` checks both in
its Result block and prints a ⚠ naming the configs. A judge that needs a different `max_tokens` is a
**new version ordinal** (`prisma/seed-core.ts:223-229` states the invariant: a version is immutable
under a judgment) — or, at the very minimum, is never edited while a run is draining.
```

- [ ] **Step 6: Full gates, then commit (b)**

```bash
grep DATABASE_URL /root/judge-arena/.env.test     # localhost:5432/judge_arena_test
pgrep -af "[v]itest"                              # must print NOTHING (shared test DB; see facts table)
cd /root/judge-arena && npm run lint && npx tsc --noEmit && npm run test:coverage && npm run test:db:coverage && npm run test:integration && npm run build
git -C /root/judge-arena add docs/superpowers/plans/2026-09-01-scoreboard-handoff.md docs/superpowers/specs/2026-09-01-judge-scoreboard-and-model-envelopes.md docs/superpowers/plans/2026-08-30-state-and-next-steps.md docs/runbooks/scoring-a-judge-against-a-golden-set.md
git -C /root/judge-arena status --short
```
Expected: lint 0; tsc 0; unit 888 / 57 files; db 674 (the db aggregate may tick DOWN a fraction: `vitest.db.config.ts`'s `src/lib/**` include counts `sampling-drift.ts` at 0% because only unit tests import it — floors have margin, do NOT lower one); integration 82; build OK; `status` shows exactly eleven staged paths (Task 2: 4, Task 3: 3, Task 4: 4) and nothing unstaged.

```bash
git -C /root/judge-arena commit -F - <<'EOF'
feat(calibration): v2k — the run snapshots the sampling config it ran under

CalibrationRun pinned WHICH judge version ran and which rubric, but not
what sampling config the version was carrying. JudgeModelVersion
.samplingDefaults is a plain JSONB with no history and three in-tree
writers (add-judge.ts update, importer/judges.ts create, seed-core.ts
upsert-create), so the obvious join reported TODAY's config for every
historical run: raising granite4.2 from 4096 to 12288 for run #9
silently rewrote what that join says about run #7, with nothing logged.
prisma/seed-core.ts:223-229 already declares a version immutable under a
judgment ("a version that needs different values is a new ordinal"); the
production SQL edits broke that invariant and nothing noticed.

The column holds the RESOLVED params — effectiveSamplingParams
(samplingDefaults), a full { temperature, max_tokens } — read and written
inside the launch transaction, so it is field-for-field comparable with
ModelJudgment.samplingParams (the per-call truth, same resolver, no
overrides on the pairwise seam). Header ≠ judgment is therefore the
mid-run-edit tell — with one latent exception, judgment-consumer.ts's
`samplingParamsUsed ?? version.samplingDefaults` fallback, which persists
the raw field and which no in-tree caller reaches today. The header is a
snapshot, not a lock. The raw field
would have stored NULL for any version without defaults and been
comparable to nothing. NULL now means exactly one thing: launched before
v2k — the 9 production rows are deliberately not backfilled, and the CLI
renders NULL as "pre-v2k", never as a config.

Migration 20260901180000_v2k_calibration_sampling_snapshot is one
nullable JSONB column, byte-identical to what `prisma migrate diff`
emitted (diffed against the test database, which was at v2j; the dev
database is at v2h and would have emitted v2i/v2j too). Pseudo-drift
table stays at eight rows.

scripts/calibration/run.ts labels the pre-launch print as the raw,
mutable field, prints the resolved snapshot after launch and in
--score-only, and warns when completed judgments disagree with the
header or with each other. That comparison lives in
src/lib/calibration/sampling-drift.ts because JSONB reorders keys
(max_tokens before temperature) and a naive stringify would report drift
on every run; tests/lib/calibration-sampling-drift.test.ts pins the key
order, the status filter (pending/error rows have NULL samplingParams
and must not collapse the DISTINCT — spec §4.1's caveat) and that a NULL
header renders as "launched before v2k", never as a config.

tests/db/calibration-link.test.ts drives the real launchCalibrationRun:
the header equals the resolver's output; editing samplingDefaults after
launch leaves the header alone WHILE the join through the version now
reports the new value (both asserted — the second is what makes it a
test of the hazard); a version with no defaults snapshots {0.3, 4096},
never NULL; and a version with a PARTIAL {max_tokens: 12288} — the
production shape — snapshots the full {0.3, 12288}, which is the case
that separates the resolver from storing the raw field. Verified by
injection: deleting the write turns all four red; snapshotting the raw
field instead of the resolved one turns the no-defaults case ({}) and
the partial case ({max_tokens: 12288}) red.

Docs: the handoff §7 #1, spec §4.1 and register §5.6 #6 all said
passThreshold was "already pinned". It is not — passThreshold/passed are
declared and nothing writes them; only rubricId (launch) and
kappaVariant/kappaWeighting/thresholdMetric (score) are. CORRECTION notes
in all three; handoff §8 step 3 now reads cr."samplingParams" first;
runbook §8.8 names the header as the second tell and says "new ordinal,
or at minimum never mid-run". registry.ts:673's "raise
samplingDefaults.max_tokens" advice is unchanged here — it belongs to
the loop-detector change.

Gates: lint 0, tsc 0, 888 unit / 674 db / 82 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_018ACKb44as67Hz9R3sxexc7
EOF
git -C /root/judge-arena log --oneline -3
```
Expected: two new commits atop 5e48187 — `refactor(llm): extract the sampling resolver into a leaf module` then `feat(calibration): v2k — the run snapshots the sampling config it ran under`. Do NOT push. (Substitute the actual counts printed by the gates if they differ.)

---

## Self-review

**Spec coverage** — item #1 scope and binding decisions:
| requirement | task |
|---|---|
| (1) extract registry.ts:412-459 into leaf `sampling.ts`; registry re-exports; index.ts unchanged; registry.test.ts:146-165 green; llm glob floor holds | Task 1 |
| (2) migration `20260901180000_v2k_calibration_sampling_snapshot`, `ALTER TABLE "CalibrationRun" ADD COLUMN "samplingParams" JSONB;`, narrative header, schema comment citing seed-core.ts:223-229, resolved-not-raw, NULL = pre-v2k, no backfill | Task 2 Steps 3-4 |
| (3) launch.ts: read version in-tx, resolve via `@/lib/llm/sampling`, write with the double cast, `samplingParams: SamplingParams` on the result, logger payload, return; line 39 widened; null guard kept, untested, not described as 404-to-operator | Task 2 Step 5 |
| (4) run.ts: :199 labelled raw/mutable; snapshot printed after :213; `--score-only` prints header or the pre-v2k sentence (`describeSamplingSnapshot`, unit-tested in the module, never a default); `samplingParams` in the judgments select; warn on judgment≠judgment and judgment≠header | Task 3 Steps 3, 6 |
| (5) DB tests: fixtures accept `samplingDefaults`; header == effectiveSamplingParams(defaults); post-launch edit leaves header AND the join now differs (both asserted); no defaults → {0.3, 4096} never NULL; PARTIAL defaults → full pair (the only test that separates the resolver from storing the raw field) | Task 2 Step 1 |
| (6) CORRECTION notes: handoff :329 (insert after :330), spec :232-233 (original kept, note inserted after :236), register :422-423 (passThreshold); handoff §8 SQL (:379-389) reads cr."samplingParams" first; spec §4.1 gets the right-since-v2k query beside the labelled WRONG join; runbook §8.8 (:543-546); "new ordinal (or at minimum never mid-run)" wording; registry.ts:673 untouched | Task 4 |
| Two commits: (a) refactor(llm), (b) feat(calibration) | Task 1 Step 8; Task 4 Step 6 |
| Every task carries an injection, one per BEHAVIOUR | 1.6 (A leaf — multi-line re-export, B behaviour, C one-resolver-not-a-copy), 2.7 (A write, B raw-vs-resolved), 3.5 (A key order, B status filter, C NULL-as-pre-v2k, D the `only !== null` guard, E the `moved_mid_run` threshold) (Task 4 is docs; its claims are made true by 2-3) |

**Placeholder scan** — no TBD/TODO/"similar to"/"handle edge cases"; every code step shows the code; every referenced symbol exists in the tree at a cited line or is defined in a task (`canonicalJson`, `detectSamplingDrift`, `describeSamplingSnapshot`, `SamplingDrift`, `headerSampling`, `JUDGE_DEFAULT_SAMPLING_PARAMS`, `RESPOND_DEFAULT_SAMPLING_PARAMS`). No `describeSnapshot` remains anywhere (renamed and moved into the module in this revision). Vitest 3.2.4 summary-line quirks are stated where they matter: arrays are abbreviated (`[ Array(1) ]`, Task 1 Step 6), two-key objects are printed in full (`{ temperature: 0.2, max_tokens: 12288 }`, Task 2 Steps 2/7 — verified by running the assertion), nested objects are elided (`{ kind: 'differs_from_header', …(2) }`, Task 3 Step 5).

**Type consistency** — `SamplingParams`/`effectiveSamplingParams` imported from `'@/lib/llm/sampling'` in launch.ts and the DB test, from `'@/lib/llm/registry'` in the unit test (re-export, asserted `toBe`); `CalibrationLaunchResult.samplingParams: SamplingParams` produced in Task 2 and consumed in Task 3 as `launched.samplingParams`; `detectSamplingDrift(header: unknown, judgments: ReadonlyArray<{ status: string; samplingParams: unknown }>)` accepts the Prisma select's `{ status: JudgmentStatus; samplingParams: Prisma.JsonValue | null; … }` rows; `headerSampling: unknown` in run.ts matches both `Prisma.JsonValue | null` (score-only) and `SamplingParams` (launch); `describeSamplingSnapshot(snapshot: unknown): string` is imported by run.ts from `'@/lib/calibration/sampling-drift'` alongside `canonicalJson`/`detectSamplingDrift` (one import line, Task 3 Step 6(a)) and consumed with `headerSampling`.

**Count arithmetic** (baseline re-measured on HEAD 5e48187, not fc9e936) — unit: 877 + 2 (sampling) + 9 (drift: 2 canonicalJson + 1 describeSamplingSnapshot + 6 detectSamplingDrift) = 888 across 55 + 2 = 57 files; db: 670 + 4 = 674 (`tests/db/calibration-link.test.ts` 13 → 17); integration unchanged at 82 / 11 files. Executors substitute the printed actuals.
