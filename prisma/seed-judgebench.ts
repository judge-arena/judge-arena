import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';

// Relative, not `@/lib/tombstones`: this module is bundled by esbuild for the
// runner image and run by `tsx` for `npm run db:seed`, and only the former is
// given a `--tsconfig` to resolve `paths` from. `scripts/admin/create-user.ts`
// reaches into src/ the same way and for the same reason.
import { liveDatasetsOnly, liveSamplesOnly } from '../src/lib/tombstones';

/**
 * JudgeBench — a public, read-only benchmark dataset seeded for every user.
 *
 * Source: https://huggingface.co/datasets/ScalerLab/JudgeBench (MIT licence)
 * Paper:  https://arxiv.org/abs/2410.12784
 *
 * The rows are VENDORED at prisma/data/judgebench.json rather than fetched at
 * seed time. Regenerate with `node scripts/datasets/fetch-judgebench.mjs`.
 * Vendoring is deliberate: seeding must be deterministic and must not depend
 * on outbound internet, because rebaseline T4 removes tenant-public's blanket
 * world egress and a seeder that phoned out to huggingface.co would begin
 * failing that day as a silent packet drop rather than a clear error.
 *
 * ── WHAT THIS DATA IS, AND WHAT THE RUNTIME CAN DO WITH IT TODAY ───────────
 * Each row is a PAIRWISE item: one question, two candidate responses, and a
 * ground-truth label saying which response is objectively correct. That shape
 * is why it is worth seeding — it is the substrate Roadmap A's golden sets
 * need, and A0 imports golden items from an existing Dataset.
 *
 * BE CLEAR ABOUT THE LIMIT: the only seeded PromptTemplate is `v1-legacy`,
 * `protocol: 'pointwise'` — it scores ONE submission against a rubric and
 * returns an overallScore. There is no pairwise judging path yet. So a run
 * launched against this dataset today judges `input` (the question) alone,
 * which is not what the benchmark measures. The pair lives in `metadata`,
 * losslessly, waiting for the pairwise protocol A1/A2 introduces. This is
 * seeded as REFERENCE DATA, not as a runnable evaluation.
 */

/** Stable id so re-seeding upserts rather than duplicating. */
export const JUDGEBENCH_DATASET_ID = 'judgebench-v1';

interface JudgeBenchRow {
  pair_id: string;
  original_id: number;
  source: string;
  question: string;
  response_model: string;
  response_A: string;
  response_B: string;
  label: string;
}

interface JudgeBenchFile {
  dataset: string;
  license: string;
  splits: Record<string, JudgeBenchRow[]>;
}

/**
 * Read the vendored rows at RUNTIME rather than `import`ing the JSON.
 *
 * This is a measured decision, not a style preference. With
 * `resolveJsonModule` on, `import data from './data/judgebench.json'` makes
 * TypeScript infer a type for all 620 literals, and that one line cost:
 *
 *     tsc --noEmit   504 MB / 1.5 s   ->   918 MB / 5.9 s
 *
 * — nearly doubling the typecheck's memory, permanently, on every CI run and
 * every developer machine, for types nobody consumes. Heap on the CI runner
 * is a live constraint: a 1 GiB container limit gave V8 ~512 MiB and OOM'd
 * this exact command (divergence entry 62). Reading the file at runtime keeps
 * tsc at its baseline and keeps the esbuild bundle small.
 *
 * The file ships with no Dockerfile change: the runner stage already does
 * `COPY --from=builder /app/prisma ./prisma`, and the standalone output is
 * copied to `/app`, so the bundle at /app/seed.js finds /app/prisma/data/.
 */
function loadJudgeBench(): JudgeBenchFile {
  const candidates = [
    // Bundled: seed.js sits at /app, prisma/ was copied to /app/prisma.
    join(__dirname, 'prisma', 'data', 'judgebench.json'),
    // Source tree: this module lives in prisma/, data/ is beside it.
    join(__dirname, 'data', 'judgebench.json'),
    // Invoked from the repo root (tsx, vitest).
    join(process.cwd(), 'prisma', 'data', 'judgebench.json'),
  ];

  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as JudgeBenchFile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // A malformed file is a real failure — do not fall through and end up
      // reporting "not found" for a file that was found and was broken.
      throw new Error(`JudgeBench data at ${path} could not be parsed: ${String(err)}`);
    }
  }

  throw new Error(
    `JudgeBench data not found. Tried:\n  ${candidates.join('\n  ')}\n` +
      'Regenerate it with: node scripts/datasets/fetch-judgebench.mjs'
  );
}

/**
 * Flatten the splits into one ordered list. Split order is fixed (`gpt` then
 * `claude`) and indices are assigned across the whole set, so `index` is
 * stable across re-seeds — which is what makes the `@@unique([datasetId,
 * index])` skipDuplicates below safe rather than merely convenient.
 */
export function flattenJudgeBench(): Array<JudgeBenchRow & { split: string }> {
  const data = loadJudgeBench();
  const out: Array<JudgeBenchRow & { split: string }> = [];
  for (const split of ['gpt', 'claude']) {
    for (const row of data.splits[split] ?? []) out.push({ ...row, split });
  }
  return out;
}

export async function seedJudgeBench(
  client: PrismaClient,
  opts: { ownerId: string; projectId: string }
) {
  const rows = flattenJudgeBench();

  // A1 / DECISION 15 — A HIDDEN DATASET IS CLOSED TO WRITES, and this seeder
  // is a write path onto a fixed id. It was the last one Decision 15 did not
  // reach: all four HTTP verbs and the config importer already refuse, and
  // without this the `update` arm below rewrote `visibility` and
  // `sampleCount` on a deleted corpus, left `isTombstone: true` in place,
  // printed a success line and exited 0.
  //
  // TWO READS, not one, because "absent" and "hidden" need different answers:
  // absent is the ordinary first-run case and must create, hidden must
  // refuse. The liveness half spreads `liveDatasetsOnly()` rather than
  // spelling the tombstone predicate here — src/lib/tombstones.ts is the
  // single definition of hidden, and a seeder with its own copy of it is
  // exactly how the two drift apart.
  //
  // IT THROWS rather than warning and continuing, unlike the config
  // importer's skip. The importer processes a document of independent
  // entities and has a per-item diff report to carry a refusal in; this has
  // neither, and its caller (`seedAll`) prints "✅ Database seeded
  // successfully!" unconditionally afterwards, so a warning would be
  // contradicted two lines later. A non-zero exit is the only refusal a
  // deploy-time Job actually surfaces. The cost is stated plainly: a
  // deployment whose `judgebench-v1` is deleted gets a failing seed step
  // until an operator acts, which is the intended signal and not collateral —
  // this call is the LAST thing `seedAll` does, so everything before it has
  // already committed idempotently and a re-run after the repair is a no-op.
  const existing = await client.dataset.findUnique({
    where: { id: JUDGEBENCH_DATASET_ID },
    select: { id: true },
  });
  if (existing) {
    const live = await client.dataset.findFirst({
      where: { id: JUDGEBENCH_DATASET_ID, ...liveDatasetsOnly() },
      select: { id: true },
    });
    if (!live) {
      throw new Error(
        `JudgeBench (${JUDGEBENCH_DATASET_ID}) is DELETED on this instance and is closed to writes ` +
          '(A1 tombstone overlay, decision 15). Nothing was seeded for it — not the samples, and not ' +
          'visibility or sampleCount. Re-seeding cannot un-delete a dataset, deliberately: there is no ' +
          'restore verb in the product yet, and a seeder that silently resurrected a corpus an admin ' +
          'deleted would be a worse defect than this refusal. To repair, remove the hiding row and ' +
          `re-run: DELETE FROM "Tombstone" WHERE "datasetId" = '${JUDGEBENCH_DATASET_ID}';`
      );
    }
  }

  const dataset = await client.dataset.upsert({
    where: { id: JUDGEBENCH_DATASET_ID },
    // `update` re-asserts the public fields on every seed so a deployment
    // whose row predates this (or was flipped private by hand) is corrected,
    // matching the Leaderboard project's reasoning. Ownership is NOT
    // re-asserted: account deletion reassigns public datasets to an archive
    // user on purpose, and stomping that every seed would undo it.
    // `publishedAt` is NOT re-asserted here, deliberately: it records when
    // this dataset was first published, and re-stamping it on every seed
    // would walk that date forward forever. The create path below sets it
    // once. Visibility IS re-asserted, so a row that predates that field (or
    // was flipped private by hand) is corrected.
    //
    // `sampleCount` is NOT re-asserted here any more, and that is A1's doing.
    // It used to be `rows.length` — the vendored file's 620 — which made this
    // the one writer in the tree meaning "all rows" while the other seven mean
    // LIVE rows. Deleting one JudgeBench sample and re-seeding then wrote 620
    // over a live count of 619, and `toPublicDataset` reads the stored rung
    // FIRST (`sampleCount ?? sampleTotal ?? _count.samples`), so the golden-set
    // import picker advertised 620 while `POST /api/golden-sets` imported 619 —
    // verbatim the failure `samples/route.ts` says this column exists to
    // prevent. It is written once, below, from a live count, on both arms.
    update: {
      visibility: 'public',
    },
    create: {
      id: JUDGEBENCH_DATASET_ID,
      name: 'JudgeBench',
      slug: 'judgebench',
      description:
        'A benchmark for evaluating LLM-based judges on objective correctness. Each item is a ' +
        'question with two candidate responses and a ground-truth label for which one is ' +
        'correct, drawn from MMLU-Pro, LiveBench and LiveCodeBench. Responses were generated ' +
        'by GPT-4o (gpt split) and Claude 3.5 Sonnet (claude split). Source: ScalerLab/JudgeBench ' +
        '(MIT). Paper: arxiv.org/abs/2410.12784',
      // 'remote' is the honest provenance — the data originates at
      // HuggingFace and huggingFaceId/sourceUrl point back at it. Unlike the
      // LiveCodeBench row, this one ALSO carries its samples inline, so it is
      // usable without a fetch step.
      source: 'remote',
      visibility: 'public',
      publishedAt: new Date(),
      inputType: 'query-response',
      sourceUrl: 'https://huggingface.co/datasets/ScalerLab/JudgeBench',
      huggingFaceId: 'ScalerLab/JudgeBench',
      remoteMetadata: JSON.stringify({
        author: 'ScalerLab',
        cardData: { license: 'mit', task_categories: ['text-classification'] },
        paper: 'https://arxiv.org/abs/2410.12784',
        splits: { gpt: 350, claude: 270 },
        vendoredBy: 'scripts/datasets/fetch-judgebench.mjs',
      }),
      splits: JSON.stringify(['gpt', 'claude']),
      features: JSON.stringify([
        'pair_id',
        'original_id',
        'source',
        'question',
        'response_model',
        'response_A',
        'response_B',
        'label',
      ]),
      tags: JSON.stringify(['llm-as-judge', 'pairwise', 'benchmark', 'judgebench']),
      sampleCount: rows.length,
      projectId: opts.projectId,
      userId: opts.ownerId,
    },
  });

  // skipDuplicates against @@unique([datasetId, index]) rather than a
  // delete-then-insert: DatasetSample rows are referenced by Evaluation, so
  // deleting them on every re-seed would either fail on the FK or orphan real
  // evaluation history. Re-seeding is therefore additive and safe.
  //
  // ADDITIVE NO LONGER MEANS RESTORATIVE, post-A1. Before the overlay a
  // deleted sample left the table and this insert re-created it, so a re-seed
  // repaired the corpus. Now the hidden row survives HOLDING ITS ORDINAL,
  // `skipDuplicates` skips the conflict, and nothing is restored. That is the
  // intended outcome and not a gap to close here: `restoreSample`
  // (src/lib/tombstones.ts) has no caller anywhere in the product, and a
  // seeder quietly un-deleting rows an owner withdrew would be the same
  // resurrection the config-export comments call worse than a leak. What
  // changes is that the skip is now REPORTED rather than silent — see the
  // live count and the warning below.
  const created = await client.datasetSample.createMany({
    data: rows.map((row, index) => ({
      datasetId: dataset.id,
      index,
      // `input` is the question alone — see the header note. The two
      // candidate responses are NOT concatenated in here, because doing so
      // would make a pointwise run look meaningful when it is not.
      input: row.question,
      expected: row.label,
      metadata: JSON.stringify({
        split: row.split,
        pair_id: row.pair_id,
        original_id: row.original_id,
        source: row.source,
        response_model: row.response_model,
        response_A: row.response_A,
        response_B: row.response_B,
      }),
    })),
    skipDuplicates: true,
  });

  // `sampleCount` MEANS LIVE ROWS here, exactly as it does at the other seven
  // writers (datasets/route.ts's POST, dataset-versions.ts, refresh/route.ts,
  // the three samples verbs, config/import). `rows.length` is the vendored
  // file's length, which is the row count on disk and not the live count the
  // moment anything is hidden.
  //
  // Written after `createMany`, not in the `upsert` arms, because that is the
  // only point at which the live count is knowable: the insert is what decides
  // how many of the 620 ordinals exist, and the tombstones are what decide how
  // many of those are visible.
  //
  // Conditional so an unchanged re-seed writes nothing at all — an
  // unconditional `update` would bump `updatedAt` on every seed and reshuffle
  // every `orderBy: { updatedAt: 'desc' }` dataset list for no reason.
  const live = await client.datasetSample.count({
    where: { datasetId: dataset.id, ...liveSamplesOnly() },
  });
  const onDisk = await client.datasetSample.count({ where: { datasetId: dataset.id } });

  if (dataset.sampleCount !== live) {
    await client.dataset.update({
      where: { id: dataset.id },
      data: { sampleCount: live },
    });
  }

  console.log(
    `  ✓ Created dataset: ${dataset.name} (${created.count} new samples, ${live} live of ${onDisk} on disk)`
  );

  if (onDisk > live) {
    console.warn(
      `  ⚠ ${onDisk - live} JudgeBench sample(s) are deleted on this instance and were NOT restored ` +
        'by this re-seed — a hidden row keeps its ordinal, so the insert above skipped it as a ' +
        `duplicate. sampleCount was written as ${live}, the live count. To restore them, clear their ` +
        'rows in "Tombstone" and re-run.'
    );
  }

  return dataset;
}
