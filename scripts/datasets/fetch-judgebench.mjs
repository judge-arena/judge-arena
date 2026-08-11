#!/usr/bin/env node
/**
 * Regenerates prisma/data/judgebench.json from the upstream HuggingFace dataset.
 *
 * The seeder does NOT run this. The dataset is vendored into the repo on
 * purpose so that seeding is deterministic, reproducible, and works with no
 * outbound internet — rebaseline T4 adds a Cilium egressDeny that removes
 * tenant-public's blanket world egress, and a seeder that phones out to
 * huggingface.co would start failing as a silent packet drop on that day.
 * This script exists so the vendored file has a provenance you can re-run,
 * not so it runs at deploy time.
 *
 * Source: https://huggingface.co/datasets/ScalerLab/JudgeBench  (MIT licence)
 * Paper:  https://arxiv.org/abs/2410.12784
 *
 * Usage:  node scripts/datasets/fetch-judgebench.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../../prisma/data/judgebench.json');

const DATASET = 'ScalerLab/JudgeBench';
const CONFIG = 'default';
const SPLITS = ['gpt', 'claude'];
// The rows endpoint caps `length` at 100.
const PAGE = 100;

async function fetchSplit(split) {
  const rows = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url =
      `https://datasets-server.huggingface.co/rows` +
      `?dataset=${encodeURIComponent(DATASET)}` +
      `&config=${encodeURIComponent(CONFIG)}` +
      `&split=${encodeURIComponent(split)}` +
      `&offset=${offset}&length=${PAGE}`;

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`${split} offset=${offset}: HTTP ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    total = body.num_rows_total;
    for (const r of body.rows) rows.push(r.row);
    offset += PAGE;
    process.stderr.write(`  ${split}: ${Math.min(offset, total)}/${total}\n`);
  }

  if (rows.length !== total) {
    throw new Error(`${split}: expected ${total} rows, collected ${rows.length}`);
  }
  return rows;
}

const out = { dataset: DATASET, license: 'mit', splits: {} };

for (const split of SPLITS) {
  const rows = await fetchSplit(split);
  // Keep every upstream field. They are all load-bearing: `source` records
  // which benchmark the question came from (mmlu-pro-*, livecodebench, ...),
  // `response_model` records who authored the pair, and `pair_id` is the
  // upstream identity used to de-duplicate against a future re-fetch.
  out.splits[split] = rows.map((r) => ({
    pair_id: r.pair_id,
    original_id: r.original_id,
    source: r.source,
    question: r.question,
    response_model: r.response_model,
    response_A: r.response_A,
    response_B: r.response_B,
    label: r.label,
  }));
}

mkdirSync(dirname(OUT), { recursive: true });
// Stable key order + trailing newline so a re-fetch produces a reviewable
// diff rather than a whole-file churn.
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

const counts = Object.entries(out.splits).map(([s, r]) => `${s}=${r.length}`);
process.stderr.write(`wrote ${OUT} (${counts.join(', ')})\n`);
