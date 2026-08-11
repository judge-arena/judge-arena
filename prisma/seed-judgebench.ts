import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PrismaClient } from '@prisma/client';

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
    // once. Visibility and sampleCount ARE re-asserted, so a row that predates
    // those fields (or was flipped private by hand) is corrected.
    update: {
      visibility: 'public',
      sampleCount: rows.length,
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

  console.log(
    `  ✓ Created dataset: ${dataset.name} (${created.count} new samples, ${rows.length} total)`
  );
  return dataset;
}
