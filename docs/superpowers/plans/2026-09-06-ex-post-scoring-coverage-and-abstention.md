# Ex-Post Scoring: Version Stamp, Coverage, Selective Accuracy and Abstention Calibration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The golden key `cmt057h5d00097y01ymubpre5` is FORCED CHOICE — 336 `A>B` / 284 `B>A`, **zero ties** (verified below). A `tie` can therefore never be correct, and `rawAgreement` scores it as a miss, silently multiplying two independent quantities: how often a judge COMMITS, and how often it is RIGHT when it does. Measured on that set, lfm2.5:8b and lfm2.5-thinking:1.2b differ **5.3×** on raw accuracy (0.0929 vs 0.4887) — reading as "broken vs mediocre" — while their selective accuracy is 0.5437 vs 0.5363, statistically indistinguishable. Same discriminative ability; they differ only in how they express uncertainty, and the current metric hides that entirely. This plan adds `coverage`, `selectiveAccuracy` **with its own floor over the committed subset**, a labelled set of forced-choice projections, and a cross-judge abstention-calibration contrast — all of them derived from rows already on disk, with **no judge re-run**. It also adds the structural prerequisite for any of it: a **scoring-version stamp**, because if the rules can improve ex post then a stored number is meaningless without knowing which rules produced it. **`rawAgreement` and `kappa` do not change.**

**Architecture:** Scoring is a PURE FUNCTION over stored artefacts. `--score-only=<runId>` (`scripts/calibration/run.ts:163`) is the existing ex-post seam and every deliverable here rides it. Two new leaf modules under `src/lib/calibration/` — `scoring-version.ts` (the rule-generation constant, its changelog and its renderer; **zero imports**) and `forced-choice.ts` (the projections; imports only `PREFERENCES`/`Preference` from `readings.ts`, whose sole import is type-only) — plus one cross-run module `abstention.ts` (same import profile) that deliberately does **not** live in `scoreCalibrationRun`, because the contrast it computes needs judgments from OTHER runs and `scoreCalibrationRun` is defined over exactly one. `src/lib/calibration/score.ts` gains six accumulators and eight result fields inside its existing single pass; `src/lib/calibration/baseline.ts` gains one more formatter beside `formatConstantBaselineLines`; `scripts/calibration/run.ts` gains three `for … console.log` blocks and one import line per task. Two migrations, **v2m** (`scoringVersion`) and **v2n** (`committedCount`, `selectiveAccuracy`, `selectiveBaselineAccuracy`), with one `tests/db` round-trip beside them. One new CLI, `scripts/calibration/abstention.ts`, plus the one `Dockerfile` esbuild block that gives it somewhere to run — the runner ships no TypeScript toolchain and production is the only database holding these rows. Every rendered string lives in `src/lib/**` and is unit-tested there, per CONTRIBUTING.md:247-250 — `scripts/**` is outside every coverage `include` (`vitest.config.ts:37`) and has no harness.

**Tech Stack:** TypeScript, Prisma on Postgres (`Int?` → `INTEGER`, `Float?` → `DOUBLE PRECISION`), vitest 3.2.4 (unit only — this plan reaches **no** `tests/db/**` file and **no** `tests/integration/**` file), Node's `readFileSync` for the three call-site guards (precedent: `tests/lib/sampling.test.ts:22`, `tests/lib/calibration-token-accounting.test.ts:402`).

**Spec:**
- The architectural premise: scoring is EX POST, the prompt is the controlled variable (`COUNT(DISTINCT userPromptSha256) = 1` per golden item across judges), and provenance is complete (`samplingParams` per call, `CalibrationRun.samplingParams` per run header (v2k), `promptTemplateId`, `rubricId`). Consequences: every metric here is BACKFILLABLE; scoring must be VERSIONED; the final verdict is not the only signal.
- `docs/superpowers/plans/2026-09-01-scoreboard-handoff.md` §5.3 (`:271-292`) — the cross-judge difficulty method: do not infer difficulty from the mechanism, check it against judges that answered. §6 traps 1-9 (`:293-352`).
- `/tmp/ja-review-failure-modes.md` — 19 real defects that all passed every gate. Every verification step below names the wrong implementation it discriminates against.
- `CONTRIBUTING.md:205-266` (TDD + the injection rule), `:1488-1577` (the three coverage gates).
- The null-not-zero contract already followed by `judgeLatencyBaseline`, `summarizeReasoningLength` and `constantVerdictBaseline`.

**Priority / wave:** Wave 3 / new. Blocks nothing; blocked by nothing unlanded.

**Depends on:** Nothing unlanded. HEAD is `2e7e142` (`feat(calibration): raise MAX_CALIBRATION_ITEMS to 1000, gated on the deadline-at-first-dequeue fix`), which is the SHA production runs (`sha-2e7e142c2d7c`). Working tree clean, index empty, branch `main`. 22 migrations applied, newest `20260901190000_v2l_calibration_constant_baseline`; **the next free letters are `v2m` and `v2n`, both claimed by this plan.** No name in this plan collides with anything in the tree: `grep -ran "scoringVersion\|selectiveAccuracy\|committedCount\|abstain\|forced-choice\|forcedChoice" src/ scripts/ tests/ prisma/` returns **nothing** (`-a` per the NUL-byte trap).

**Owner decisions needed:** **One, and it is a timing decision, not a design one.** Calibration run `cmtluplg500012l0sj315kyar` (qwen3.5:9b, golden set `cmt057h5d00097y01ymubpre5`) is **IN FLIGHT** — 263 of 620 judgments completed as of 2026-09-06, `finishedAt` NULL, roughly 28 h from done. `scoreCalibrationRun` is a FULL OVERWRITE. Backfilling it mid-flight is not destructive (a later re-score fixes it) but it stamps `scoringVersion = 2` and a `selectiveAccuracy` over a **non-random 42% subset** — the items that dequeued first — and a stamped partial row is indistinguishable on the scoreboard from a finished one. **Task 5 states where in the sequence that run is safe to score; the operator decides when.** Everything else is decided and argued in-plan: **(a)** the version stamp is a nullable `Int`, not an enum and not a timestamp (Task 1 Step 1); **(b)** coverage is **not** stored, because it is exactly `committedCount / verdictCount` over two stored columns and a redundant stored copy drifts (Task 3 Step 1); **(c)** the forced-choice projections get **no columns at all** — they are projections, and a projection in the scoreboard header is how a projected figure gets quoted as a measured one (Task 4 Step 1); **(d)** the textual uncertainty signal is **SCOPED OUT with measured evidence**, not shipped (Task 6, and the Measurements section below). **No push, no promote, no cluster mutation anywhere in this plan** — those are the operator's.

---

## Verified corrections to this plan's own brief

Each item was checked against the tree or against production `judge-arena-pg-1` by read-only `psql` on 2026-09-06. Failure mode 19 cuts both ways — *open the cited location before applying a finding* — so each correction states what was checked and how.

1. **The run id in the brief does not exist.** The brief attributes the 619-judgment Qwen3.6 run to `cmtonq36mtpord2v2000001`. `SELECT id FROM "CalibrationRun"` returns 20 rows and that is not one of them. The run described — Qwen3.6-35B-A3B, golden set `cmt057h5d00097y01ymubpre5`, `verdictCount 619`, `rawAgreement 0.8869143780290791` — is **`cmtozu76f00012l5w4llb4pae`** (started 2026-09-05 23:08:01, finished 2026-09-06 07:41:31). Every figure the brief attributes to it reproduces exactly on that row. Use the real id; `cmtonq36…` appears nowhere below.

2. **`selectiveAccuracy` is NOT an upper bound on a forced judge, and the brief's framing that "any REAL forcing strategy lies between the bounds" is false on this corpus.** Measured on `cmtondblm00012lzcx1m2cyql` (lfm2.5:8b, 603 verdicts): of the 500 items it abstained on, **275 are keyed `A>B`**. A judge that stamps the key's plurality class on every abstention therefore scores `(56 + 275)/603 = 0.5489` — **above** its selective accuracy of `56/103 = 0.5437`. The same happens on lfm2.5-thinking: stamp `0.5484` vs selective `0.5363`. The reason is simple and worth stating once: selective accuracy assumes the judge would be as accurate on its abstentions as on its commitments, and a *stamp* does not use the judge at all — it uses a property of the key. Task 4 therefore reports **named strategies**, not an interval, and prints an explicit `ⓘ` line when a stamp beats selective accuracy. That line fires on two of the three completed runs on this set.

3. **There is a second, algebraic reason not to invent a "judge is as good on ties" projection: it already exists.** `(correct + selective × abstained) / verdictCount` = `selective × (committed + abstained) / verdictCount` = `selective`. The projection IS selective accuracy, exactly, for every input. Task 4 pins that identity with a test rather than shipping a duplicate field under a different name.

4. **The brief's qwen3.5:9b row is stale and will keep moving.** It quotes coverage 1.0000 / selective 0.8168 / raw 0.8168 "(partial)". Re-measured 2026-09-06: `215/263 = 0.8175`. The run is the one still draining (`cmtluplg500012l0sj315kyar`, 263 of 620 completed), so **any figure for it is a snapshot, not a measurement of that judge.** It appears below with its `n` and an explicit warning, and no test in this plan uses it as a fixture.

5. **The brief's reasoning-length figures are close but not current.** It quotes 26,127 chars mean on lfm2.5:8b and 9,437 on lfm2.5-thinking. Re-measured over completed judgments with a non-null `reasoningContent` on the 620-item set: lfm2.5:8b `cmtondblm…` **n=603, mean 27,988** (min 2,464, max 136,850); lfm2.5-thinking `cmtp3jwrf…` **n=620, mean 9,441**; Qwen3.6 `cmtozu76f…` **n=619, mean 9,713**. The brief's "present on 619/619 Qwen3.6 judgments" is exact. Nothing in this plan depends on the mean; the figures are recorded because Task 6's negative result is computed over these same populations.

6. **There are 20 `CalibrationRun` rows in production, not 12.** 17 carry a non-null `rawAgreement`; 19 carry a `finishedAt`; one (`cmtluplg5…`) is in flight. Two carry the v2l `constantBaselineAccuracy` on the 620 set and three on the 30-item set — the rest predate v2l and are NULL. **All 20 will read `scoringVersion IS NULL` the moment v2m applies.** Task 5's backfill list is 19 rows, not 12.

7. **One production row is scored but empty, and backfilling it produces a real 0.** `cmton7ip500012lyjubiqohy8` (lfm2.5:8b, 620 set) has `verdictCount 0` and `rawAgreement` NULL in its header, but **16 completed judgments on disk** — it was scored at launch and never re-scored after the first items landed. Re-scoring it yields `verdictCount 16`, `committedCount 1`, `coverage 0.0625`, `correctCount 0`, and `selectiveAccuracy 0.0000` over a denominator of **one**. That is a correct measurement of an aborted run and not a bug. **NOTHING in this plan gates `selectiveAccuracy` by its denominator** — `MIN_CONTRAST_N` gates only the abstention contrast's two arms, and no other rule exists — which is exactly why the scoreboard query in Task 1 Step 1 filters on `committedCount` rather than trusting the column. Named explicitly in the backfill order so nobody reads it as a regression.

---

## Measurements — read-only `psql` against `judge-arena-pg-1`, 2026-09-06

Every number below was produced by the queries in this section, run against production while a calibration was draining. **Nothing here writes.** Re-run them at execution time; the two rows marked *live* move.

### M1. The key is forced choice

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
select gs.id, gs.name, count(gi.id) items,
       sum(case when gi.expected='A>B' then 1 else 0 end) ab,
       sum(case when gi.expected='B>A' then 1 else 0 end) ba,
       sum(case when gi.expected='tie' then 1 else 0 end) tie
from \"GoldenSet\" gs left join \"GoldenItem\" gi on gi.\"goldenSetId\"=gs.id
group by 1,2 order by 3 desc;"
```

```
cmt057h5d00097y01ymubpre5|JudgeBench pairwise — full|620|336|284|0
cmt057hd001g17y01lhjzgfuj|JudgeBenchSample — 30 random|30|17|13|0
```

**336/620 = 0.5419355** — the key marginal the brief quotes. `SELECT DISTINCT "pairOrder" FROM "ModelJudgment"` returns exactly `AB`, so `preferenceFromVerdict` is the identity on this corpus and every derived preference below equals the raw letter's obvious reading. That is *not* assumed by any code in this plan; it is stated so the hand arithmetic can be checked.

### M2. Coverage, selective accuracy, and the two floors

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
with j as (
  select cr.id crid, jm.name judge, gi.expected, mj.verdict,
    case when mj.verdict='tie' then 'tie' when mj.verdict='A' then 'A>B' when mj.verdict='B' then 'B>A' end pref
  from \"CalibrationRun\" cr
  join \"JudgeModelVersion\" jv on jv.id=cr.\"judgeModelVersionId\"
  join \"JudgeModel\" jm on jm.id=jv.\"judgeModelId\"
  join \"EvaluationRun\" er on er.\"calibrationRunId\"=cr.id
  join \"GoldenItem\" gi on gi.id=er.\"goldenItemId\"
  join \"ModelJudgment\" mj on mj.\"runId\"=er.id and mj.status='completed'
  where cr.\"goldenSetId\"='cmt057h5d00097y01ymubpre5' and mj.verdict is not null)
select crid, judge, count(*) n,
  sum(case when verdict<>'tie' then 1 else 0 end) nc,
  sum(case when pref=expected then 1 else 0 end) corr,
  round(sum(case when verdict<>'tie' then 1 else 0 end)::numeric/count(*),4) coverage,
  round(sum(case when pref=expected then 1 else 0 end)::numeric/nullif(sum(case when verdict<>'tie' then 1 else 0 end),0),4) selective,
  round(sum(case when pref=expected then 1 else 0 end)::numeric/count(*),4) raw,
  round(greatest(sum(case when verdict<>'tie' and expected='A>B' then 1 else 0 end),
                 sum(case when verdict<>'tie' and expected='B>A' then 1 else 0 end))::numeric
        /nullif(sum(case when verdict<>'tie' then 1 else 0 end),0),4) floor_committed,
  round(greatest(sum(case when expected='A>B' then 1 else 0 end),
                 sum(case when expected='B>A' then 1 else 0 end))::numeric/count(*),4) floor_all
from j group by 1,2 order by 2;"
```

| calibrationRunId | judge | n | committed | correct | coverage | selective | raw | floor over COMMITTED | floor over ALL scored |
|---|---|---|---|---|---|---|---|---|---|
| `cmtozu76f00012l5w4llb4pae` | Qwen3.6-35B-A3B | 619 | 610 | 549 | **0.9855** | **0.9000** | 0.8869 | **0.5410** (330/610) | 0.5428 (336/619) |
| `cmtp3jwrf00012laoe6kmxgod` | lfm2.5-thinking:1.2b | 620 | 565 | 303 | **0.9113** | **0.5363** | 0.4887 | **0.5292** (299/565) | 0.5419 (336/620) |
| `cmtondblm00012lzcx1m2cyql` | lfm2.5:8b | 603 | 103 | 56 | **0.1708** | **0.5437** | 0.0929 | **0.5243** (54/103) | 0.5456 (329/603) |
| `cmton7ip500012lyjubiqohy8` | lfm2.5:8b (aborted) | 16 | 1 | 0 | 0.0625 | 0.0000 | 0.0000 | 1.0000 (1/1) | 0.6875 (11/16) |
| `cmtluplg500012l0sj315kyar` | qwen3.5:9b *live, 263/620* | 263 | 263 | 215 | 1.0000 | 0.8175 | 0.8175 | 0.5323 (140/263) | 0.5323 |

**The brief's table reproduces on all four completed rows.** `raw = coverage × selective` holds to floating point on every one (`0.9855 × 0.9000 = 0.8869`; `0.1708 × 0.5437 = 0.0929`).

**THE LOAD-BEARING COLUMN IS THE SECOND-TO-LAST, AND IT FLIPS SIGNS.** Comparing selective accuracy against the FULL-subset floor — the error v2l exists to prevent, one level down — reverses the verdict on two of the four judges:

| judge | selective | margin over **committed** floor | margin over **all-scored** floor |
|---|---|---|---|
| Qwen3.6 | 0.9000 | **+0.3590** | +0.3572 |
| lfm2.5-thinking | 0.5363 | **+0.0071** | **−0.0056** |
| lfm2.5:8b | 0.5437 | **+0.0194** | **−0.0019** |

Both weak judges read as *above* a stamp against their own committed denominator and *below* a stamp against the full one. **Neither reading is a strong claim** — +0.0071 over n=565 is noise — but the SIGN is what a reader takes away, and it is determined entirely by which floor is quoted. Every comparison in this plan uses the committed floor, and Task 3's test pins the two apart on exactly this fixture.

### M3. The forced-choice projections, per strategy

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
with j as (
  select cr.id crid, gi.expected, mj.verdict,
    case when mj.verdict='tie' then 'tie' when mj.verdict='A' then 'A>B' when mj.verdict='B' then 'B>A' end pref
  from \"CalibrationRun\" cr
  join \"EvaluationRun\" er on er.\"calibrationRunId\"=cr.id
  join \"GoldenItem\" gi on gi.id=er.\"goldenItemId\"
  join \"ModelJudgment\" mj on mj.\"runId\"=er.id and mj.status='completed'
  where mj.verdict is not null)
select crid,
  sum(case when expected='A>B' then 1 else 0 end) k_ab, sum(case when expected='B>A' then 1 else 0 end) k_ba,
  sum(case when verdict='tie' and expected='A>B' then 1 else 0 end) a_ab,
  sum(case when verdict='tie' and expected='B>A' then 1 else 0 end) a_ba,
  sum(case when verdict<>'tie' and expected='A>B' then 1 else 0 end) c_ab,
  sum(case when verdict<>'tie' and expected='B>A' then 1 else 0 end) c_ba,
  count(*) n
from j where crid in ('cmtondblm00012lzcx1m2cyql','cmtozu76f00012l5w4llb4pae','cmtp3jwrf00012laoe6kmxgod')
group by 1;"
```

```
cmtondblm00012lzcx1m2cyql|329|274|275|225|54|49|603
cmtozu76f00012l5w4llb4pae|336|283|6|3|330|280|619
cmtp3jwrf00012laoe6kmxgod|336|284|37|18|299|266|620
```

Derived by hand from those counts, and reproduced exactly by `forcedChoiceBounds` in Task 4's tests:

| judge | abstained | all-wrong (= raw) | unbiased coin | stamp `A>B` | all-right (oracle) | selective |
|---|---|---|---|---|---|---|
| Qwen3.6 | 9 | 0.8869 (549/619) | 0.8942 | **0.8966** (6 of 9 keyed `A>B`) | 0.9015 | 0.9000 |
| lfm2.5-thinking | 55 | 0.4887 (303/620) | 0.5331 | **0.5484** (37 of 55) | 0.5774 | 0.5363 |
| lfm2.5:8b | 500 | 0.0929 (56/603) | 0.5075 | **0.5489** (275 of 500) | 0.9221 | 0.5437 |

The bolded stamp column exceeds selective accuracy on the two lower rows — correction 2 above, in numbers.

### M4. The cross-judge abstention contrast (scope item 5a)

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
with j as (
  select cr.id crid, er.\"goldenItemId\" item, gi.expected, mj.verdict,
    case when mj.verdict='tie' then 'tie' when mj.verdict='A' then 'A>B' when mj.verdict='B' then 'B>A' end pref
  from \"CalibrationRun\" cr
  join \"EvaluationRun\" er on er.\"calibrationRunId\"=cr.id
  join \"GoldenItem\" gi on gi.id=er.\"goldenItemId\"
  join \"ModelJudgment\" mj on mj.\"runId\"=er.id and mj.status='completed'
  where cr.\"goldenSetId\"='cmt057h5d00097y01ymubpre5' and mj.verdict is not null)
select s.crid subject, c.crid cohort, case when s.verdict='tie' then 'abstained' else 'committed' end bucket,
  sum(case when c.verdict<>'tie' then 1 else 0 end) n,
  sum(case when c.verdict<>'tie' and c.pref=c.expected then 1 else 0 end) corr
from j s join j c on c.item=s.item and c.crid<>s.crid
where s.crid in ('cmtondblm00012lzcx1m2cyql','cmtp3jwrf00012laoe6kmxgod')
  and c.crid='cmtozu76f00012l5w4llb4pae'
group by 1,2,3 order by 1,3;"
```

```
cmtondblm00012lzcx1m2cyql|cmtozu76f00012l5w4llb4pae|abstained|493|441
cmtondblm00012lzcx1m2cyql|cmtozu76f00012l5w4llb4pae|committed|100|93
cmtp3jwrf00012laoe6kmxgod|cmtozu76f00012l5w4llb4pae|abstained|52|51
cmtp3jwrf00012laoe6kmxgod|cmtozu76f00012l5w4llb4pae|committed|558|498
```

| subject | cohort accuracy on subject's ABSTAINED items | on subject's COMMITTED items | contrast |
|---|---|---|---|
| lfm2.5:8b (`cmtondblm…`) | 0.8945 (441/493) | 0.9300 (93/100) | **−0.0355** |
| lfm2.5-thinking (`cmtp3jwrf…`) | **0.9808 (51/52)** | 0.8925 (498/558) | **+0.0883** |
| Qwen3.6 (`cmtozu76f…`), cohort qwen3.5:9b | — (**n = 0**) | 0.8175 (215/263) | **null** |

Three findings, and the middle one is the reason this measure is worth building:

- **lfm2.5:8b abstains on items that are *slightly* harder.** The cohort does 3.6 pp worse there. With `n = 493` and `n = 100`, one standard error on the difference is ≈ 0.029, so this is ≈ 1.2 se — **directionally consistent with calibrated abstention, and not distinguishable from noise.** Reported with both `n`s and no p-value.
- **lfm2.5-thinking abstains on items a competent judge finds EASIER.** 51 of 52. Its abstention is anti-correlated with difficulty — it is not withholding judgment on hard items, it is emitting `tie` as noise. Two judges with statistically identical selective accuracy (0.5437 / 0.5363), and this separates them cleanly where every existing metric does not.
- **Qwen3.6's 9 abstentions overlap the qwen3.5:9b partial run on ZERO items** (verified: the join returns no `abstained` row at all). The contrast is `null`, not `0`. This is the case the null-not-zero contract and `MIN_CONTRAST_N` exist for.

**Cohort admission, and why lfm2.5-thinking is not in lfm2.5:8b's cohort.** The brief names the confound directly: the two LFM judges have near-identical selective accuracy and may share a failure mode. Measured as a cohort for lfm2.5:8b, lfm2.5-thinking gives 0.5320 (abstained) vs 0.5579 (committed) — a contrast built entirely out of a judge that is itself at its own constant floor (+0.0071 margin). **The rule that excludes it is quantitative and lands first: a cohort member needs `selectiveMarginOverConstant > 0.05`.** On this corpus that admits Qwen3.6 (+0.3590) and qwen3.5:9b (+0.2852) and rejects lfm2.5-thinking (+0.0071) and lfm2.5:8b (+0.0194). The family rule (Task 5) is a second, independent gate that is **not load-bearing today** — the margin gate already excludes every LFM pairing — and it is stated as a policy rather than a measurement for exactly that reason.

**One known bias, measured rather than assumed.** Cohort accuracy is computed over the cohort's COMMITTED judgments only; a cohort member's own abstention is not evidence about an item's difficulty. If the cohort *also* abstained preferentially on the hard items, dropping those inflates the abstained arm and biases the contrast toward zero — i.e. **conservative**, it makes calibrated abstention harder to detect, not easier. Measured here it is negligible: Qwen3.6 abstained on 7 of 500 (1.4%) of lfm2.5:8b's abstained items and 2 of 102 (2.0%) of its committed ones.

### M5. Textual uncertainty in `reasoningContent` — the rule, and why it does not survive contact with the corpus

Scope item 5b requires a proposed rule to be **tested against real stored reasoning and reported with its actual hit rate and false positives**. It was. The rule tested is the strongest cheap one available — a case-insensitive substring match over `reasoningContent` for ten terminal-hedge markers:

```
not sure · unsure · not certain · hard to say · too close to call
toss-up · coin flip · difficult to decide · hard to decide · no clear winner
```

```sh
kubectl exec -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -tAF'|' -c "
with j as (
  select cr.id crid, jm.name judge, mj.verdict, gi.expected,
    case when mj.verdict='tie' then 'tie' when mj.verdict='A' then 'A>B' when mj.verdict='B' then 'B>A' end pref,
    lower(mj.\"reasoningContent\") rc
  from \"CalibrationRun\" cr
  join \"JudgeModelVersion\" jv on jv.id=cr.\"judgeModelVersionId\"
  join \"JudgeModel\" jm on jm.id=jv.\"judgeModelId\"
  join \"EvaluationRun\" er on er.\"calibrationRunId\"=cr.id
  join \"GoldenItem\" gi on gi.id=er.\"goldenItemId\"
  join \"ModelJudgment\" mj on mj.\"runId\"=er.id and mj.status='completed'
  where cr.id in ('cmtozu76f00012l5w4llb4pae','cmtp3jwrf00012laoe6kmxgod','cmtondblm00012lzcx1m2cyql')
    and mj.\"reasoningContent\" is not null),
m as (select judge, verdict, pref, expected,
  (rc like '%not sure%' or rc like '%unsure%' or rc like '%not certain%' or rc like '%hard to say%'
   or rc like '%too close to call%' or rc like '%toss-up%' or rc like '%coin flip%'
   or rc like '%difficult to decide%' or rc like '%hard to decide%' or rc like '%no clear winner%') hit
  from j)
select judge, case when verdict='tie' then 'abstained' else 'committed' end bucket,
  count(*) n, sum(case when hit then 1 else 0 end) hits,
  round(sum(case when hit then 1 else 0 end)::numeric/count(*),4) rate
from m group by 1,2 order by 1,2;"
```

**Result 1 — the marker does not track the verdict channel's abstention at all.**

| judge | rate on ABSTAINED (`tie`) | rate on COMMITTED |
|---|---|---|
| Qwen3.6 | **0.0000** (0/9) | 0.0639 (39/610) |
| lfm2.5-thinking | 0.4182 (23/55) | 0.3558 (201/565) |
| lfm2.5:8b | 0.3560 (178/500) | 0.3495 (36/103) |

On the one judge with real discriminative ability the marker fires **more often when it commits than when it abstains**. On the other two it is flat to within a few points of a base rate of ~0.35 — i.e. it is a stylistic tic of the model, not a signal about the item.

**Result 2 — within the committed set, the sign of the effect is not stable across judges.** Same query restricted to `verdict <> 'tie'`, grouped by the marker:

| judge | selective accuracy, marker ABSENT | marker PRESENT | direction |
|---|---|---|---|
| Qwen3.6 | 0.9177 (524/571) | **0.6410** (25/39) | correct — hedging predicts being wrong |
| lfm2.5-thinking | 0.5082 (185/364) | **0.5871** (118/201) | **inverted** |
| lfm2.5:8b | 0.5373 (36/67) | **0.5556** (20/36) | **inverted** |

The lfm2.5-thinking swing is +0.079 on `n = 364 / 201`, about 1.8 se — not significant, and **not in the predicted direction**. A quantity whose sign depends on which judge produced it cannot be put on a scoreboard beside accuracy.

**Result 3 — the false-positive mode, quoted verbatim from the corpus.** Four sampled `not sure` contexts from `cmtp3jwrf00012laoe6kmxgod`:

```
… which would correspond to a tie? Not sure. Alternatively, perhaps since I have to pick based on
the criteria, maybe Response A is more accurate and Respo…

… since they mentioned Response B's analysis leading to J being 8? Not sure. Alternatively, given
that in their own example, they concluded A was correct…

… and based on prior example where answer was C leading to tie? Not sure. Alternatively, given that
in their sample they had a case where the answer was C…
```

Every one is a **mid-stream rhetorical hedge inside a rambling chain that then resolves to a confident verdict**. The marker cannot tell a transient hedge from a terminal one, and the models that hedge most are the models that ramble most (lfm2.5:8b: mean 27,988 chars) — so the rule measures **verbosity**, and it reports it under a label that says "uncertainty".

**CONCLUSION, and it is the deliverable for scope item 5b: no honest cheap textual signal exists on this corpus, and none is shipped.** No module, no field, no CLI line, no column. The three results above are written into the runbook by Task 6 so the next person starts from the measurement rather than the intuition. An LLM-judge-of-the-judge is explicitly not proposed as the alternative; that is a separate research question with its own validity problems. What *does* work is M4 — the behavioural channel, which needs no text at all.

### M6. The FINAL-ANSWER channel — the same rule, re-tested where M5 did not look, and the denominator defect it exposed

**Why this section exists.** M5 tested hedge markers over `reasoningContent`, the rambling thinking channel. It did not test the model's *terminal answer*. The operator proposed, on 2026-09-06, a deterministic rule labelling an explicit refusal ("I decline to answer", "too hard to tell", "not enough evidence") as a distinct `noAnswer` bucket, with `pctNoAnswer`, `pctTie`, and a deflated accuracy of `correct / (total − tie − noAnswer)`. That is a *different channel* from M5's and deserved its own measurement rather than an appeal to M5. It got one: 45 agents, read-only `psql`, every numeric claim independently re-derived by a second agent. **The rule is rejected, on three independent grounds, and none of them is M5's.**

**Result 1 — the schema forecloses the third bucket.** Pairwise judging runs under guided decoding with a closed enum, and all three sites that describe it are byte-identical:

```
src/lib/llm/judgment-schema.ts:100   enum: ['A', 'B', 'tie'],
src/lib/llm/judgment-schema.ts:102   '... or "tie" if neither is clearly better.'
prisma/seed-prompt-templates.ts:81   '... or "tie" if neither is clearly better.'
src/lib/llm/render.ts:618            '... or "tie" if neither is clearly better.'
```

"Neither is clearly better" is an **undecidability clause, not an equal-quality clause**. The production `PromptTemplate` row (`cmsyqlrvs00017y663xe2vqf2`, `v1-pairwise`, 1351 chars, md5 `9ba4f9b69f5ca06440ee347a6f1e251f`) is byte-identical to the repo seed and is the template on **3,550 / 3,550** pairwise judgments. There is no wording anywhere restricting `tie` to equal quality. **`tie` ALREADY IS the sanctioned no-answer channel**, and a refusal has no other channel to be expressed in. Out-of-enum values (`neither`, `both`, `equal`, `C`, `draw`) are rejected to a `non_retryable` error with `verdict` left NULL — and that rejection **has never once fired**. The production verdict domain is exactly `{A, B, tie, NULL}`.

**Result 2 — the marker's sign inverts across judges, exactly as in M5.** Union of a refusal marker set and a no-input-hallucination marker set over `reasoning`, tie-arm vs committed-arm:

| judge | fires on ties | fires on committed | direction |
|---|---|---|---|
| Qwen3.6-35B-A3B | 0/11 | 4/753 | **inverted** — fires only when it COMMITS |
| lfm2.5-thinking:1.2b | 13/57 | 0/593 | correct |
| lfm2.5:8b | 5/540 | 0/109 | correct |
| granite4.1:3b / granite4.2:3b | 0/23, 0/3 | 0/67, 0/37 | no signal |

**Result 3 — committed-side precision is ZERO, and the failure mode is new.** All Qwen3.6 hits are *mention-not-use*: the judge describing the CANDIDATE's refusal, quoted verbatim from the corpus:

```
Response B fails to follow the logical chain, incorrectly claims there is insufficient
information, and provides an incorrect guess.

Response B correctly traces the logic up to the bowling alley and park but then incorrectly
claims insufficient information for the museum and school.

Response B fails to confidently derive the solution, expresses unnecessary uncertainty, and
explicitly refuses to provide the answer in the specified format.
```

All are **correct** committed verdicts. M5 never named this mode — it is not a hedge, it is a criticism of a hedger.

**Result 4 — the proposed formula is arithmetically unsound, and inert where it is not harmful.** `noAnswer` is not disjoint from `committed`, so the formula removes rows from the denominator while leaving their correct answers in the numerator. On Qwen3.6: `549/610 = 0.900000` becomes `549/606 = 0.905941` — **+0.59 pp of pure artifact that rewards a judge for criticising a hedging candidate.** Where the hits land on ties instead, the row is already outside both operands, so deflated accuracy equals `selectiveAccuracy` to 6 decimal places on all three judges. A term that is either inert or wrong is not a term.

**A partial rescue was attempted and does not change the verdict.** The mention-not-use false positive *is* partly separable syntactically — it places the marker in the same clause as a `Response A|B` referent, and 8/8 committed false positives match `response [ab]`. But the entire marked population is **18 rows out of 1,860**, and a perfect filter still leaves Result 1 and Result 2 standing. Not a field.

**Result 5 — a non-reasoning judge has no thinking channel at all.** mistrallite:7b (run `cmtpv1n5s00012ll8f3wrmijs`, 30-item set, `rawAgreement` 0.3667) reports `reasoningContent` NULL and `accounting=no_reasoning_channel` on **30/30** judgments. Any classifier reading a thinking channel is undefined for an entire class of judge — and 13 of that run's 19 disagreements are ties, so it is precisely the judge coverage exists to describe.

**Result 6 — THE FINDING WORTH KEEPING: `rawAgreement`'s denominator silently varies per judge.** The "no answer" population the operator was reaching for does exist — it is just not textual, and not the judge's:

| judge | items asked | verdicts | ties | committed | correct | no verdict |
|---|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | 620 | 619 | 9 | 610 | 549 | **1** |
| lfm2.5-thinking:1.2b | 620 | 620 | 55 | 565 | 303 | **0** |
| lfm2.5:8b | 620 | **603** | 500 | 103 | 56 | **17** |

lfm2.5:8b is scored over 603 items and its peers over 619 and 620. Across the four completed runs on this set (n = 2,480 item-rows): judge-behaviour refusals **0**, prose-not-JSON **0**, token-budget truncations **18**, infrastructure **0** (all 330 infrastructure errors are confined to the single live qwen3.5:9b run). Every no-verdict row is a `finishReason='length'` truncation or a dead request — a property of the FLEET, never of the judge, and it must never be attributed to one.

**CONCLUSION.** The textual no-answer classifier is **not shipped** — no module, no field, no CLI line, no column — for the three reasons above, of which only Result 2 is shared with M5. What IS shipped, as an amendment to Task 3, is **`noVerdictRate`**: `missingVerdicts / dispatchedItemCount`, deterministic, no text rule, printed beside coverage and labelled as a fleet property. `registry.ts:1284`'s "did not contain a usable {verdict, reasoning} object" error is worth one line of correction for the next reader: **it has never fired**, because `assertUsableContent()` throws inside `execute()` before `tryParsePairwiseJudgment()` is reached, so a rambling or refusing generation is recorded as a token-budget error and never as a parse failure.

---

## Global Constraints

- Repo: `/root/judge-arena` (Next.js 15.5.22, TypeScript, Prisma on Postgres — `Json` maps to JSONB —, amqplib 2.0.1, vitest 3.2.4). Node >= 22. **Always use `git -C /root/judge-arena`. Never `cd` into the repo** (handoff §6 trap 2: a stale `cd` once hard-reset the wrong repo to a four-month-old commit; failure mode 12).
- Gates, in this order, all clean before every commit: `npm run lint` (0 warnings) → `npx tsc --noEmit` → `npm run test:coverage` (unit; per-glob floors in `vitest.config.ts:187-220` — **NEVER lower a floor**) → `npm run test:db:coverage` → `npm run test:integration` → `npm run build` (CONTRIBUTING.md:1640-1645). **Documented carve-out for this plan:** Tasks 1, 3, 4, 5 and 6 stop after `test:coverage`; **Task 2 (the schema/migration task) runs the full chain ONCE for the branch**, because it is the only task that touches `prisma/schema.prisma`. Every extra `npm run test:db:coverage` is another `prisma migrate reset --force` of the single shared `judge_arena_test`, whose suite is **not** concurrency-safe (failure mode 11) — never run two at once, and re-run a failing db file **alone** before calling anything a regression.
- **Before the first `npm run test:db:coverage`, confirm what it will reset:** `grep DATABASE_URL /root/judge-arena/.env.test`. It must be `localhost:5432` (the local podman `judge-arena-pg`). `judge-arena-pg` (podman, local) and `judge-arena-pg-1` (k8s, **PRODUCTION**) differ by one character (handoff §6 trap 1). **A calibration IS draining in production right now** (`cmtluplg500012l0sj315kyar`, 263/620). **Every production access in this plan is a read-only `psql SELECT` and nothing else.**
- Baseline, stated by the brief and re-confirmed as the starting tree state at `2e7e142`: **lint 0, `npx tsc --noEmit` 0, 1007 unit / 61 files, 680 db / 46 files, 93 integration / 11 files, `npm run build` clean.** **Every predicted count below is arithmetic on the baseline you MEASURE in Task 1 Step 0 — never itself a measurement** (failure mode 15). If `test:coverage` prints something else, **the printed number is the truth** — put IT in the `Gates:` line, and treat an unexplained delta as a finding to diagnose, not a number to overwrite.
- **Before EVERY commit, prove the index is empty first.** Other agents execute sibling plans in this checkout.

  ```bash
  git -C /root/judge-arena diff --cached --name-only
  ```
  Expected: **empty**. If it prints anything, another agent has work staged — **stop, and do NOT `git reset` it** (that is their work); hand it back to the operator, or take a `git worktree`. `git add <paths> && git commit` (no `--only`) commits the **whole index**, not the paths just added, so a pre-staged file lands silently under this plan's subject line and breaks one-concern-per-commit with every gate green. **Every commit below therefore does `git add <paths>` and then `git commit --only <paths>`** — `--only` restricts the commit to those paths and cannot pull the rest of the index in, but it does NOT imply the add (`git commit --only <untracked path>` fails with `error: pathspec … did not match any file(s) known to git`), so the `git add` step is required. Verify afterwards with `git show --stat --oneline HEAD` and check the file count.
- **Name paths explicitly. Never `git add -A` / `git add .`** — sibling plan files are untracked in `docs/superpowers/plans/` and belong to other concerns. **Do not assert how many there are**; that count changes every time a sibling lands. The empty index and the explicit path list are the check.
- TDD with an INJECTION step (CONTRIBUTING.md:210-234): every behaviour test must be shown to go RED by a deliberate breakage and GREEN again after. **An injection that leaves the suite green is a FINDING, not a formality.** A failure message that does not describe the defect is not evidence (CONTRIBUTING.md:230-234) — if an injection fails for an incidental reason, write a cleaner one.
- **Every verification step must name the wrong implementation it discriminates against.** Where a step cannot discriminate, this plan says so out loud rather than implying coverage it does not have (`/tmp/ja-review-failure-modes.md` §A; failure mode 5 — *an assertion with no injection behind it is unguarded*).
- One concern per commit/PR (CONTRIBUTING.md:1639). Wrong statements in docs get an explicit `CORRECTION` note that **quotes what the document used to say**, never a silent overwrite (CONTRIBUTING.md:1653-1656).
- Commit subject: `type(scope): lowercase summary` (feat/fix/docs/ci; scopes in use: worker, llm, queue, calibration, ci, docker). Body: narrative, then a `Gates: lint 0, tsc 0, <n> unit / <n> db / <n> integration, coverage 0.` line — EVERY slot present; a slot deliberately not measured reads `n-a` with the reason in the parenthetical that follows — then EXACTLY these trailers, on their own lines, in this order:

  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
  ```
- Commit **LOCALLY only. NEVER push, NEVER promote, NEVER mutate the cluster.** Those are the operator's. Pushing to main fires CI and builds an image; promotion is a separate homelab-setup PR. **Do not run `npm run test:db`, `prisma migrate`, or any file under `tests/db/`** except where Task 2's full-chain gate explicitly calls for it, and never against anything but `localhost:5432`.
- **Migration naming:** `prisma/migrations/<YYYYMMDDHHMMSS>_v2<letter>_<snake>/migration.sql`. `20260901190000_v2l_…` is on disk and applied, so any timestamp `<= 20260901190000` collides. This plan takes **`v2m` at `20260906120000`** and **`v2n` at `20260906130000`**. Narrative `-- v2x — …` header in the v2k/v2l style, then **content exactly what `prisma migrate diff` emits, with ZERO hand edits below the header**, then `npx prisma generate`. Both migrations are ENTIRELY ADDITIVE: nullable columns, no `DROP`, no `DELETE`, no default, no backfill inside the migration.
- **GREP TRAP, live in HEAD:** `/root/judge-arena/src/lib/calibration/readings.ts` and `/root/judge-arena/scripts/importer/reconcile.ts` contain a deliberate NUL byte; plain `grep` silently returns nothing for those two files. **Use `grep -a`. NEVER remove the NUL.**
- `scripts/calibration/**` is outside every coverage `include` (`vitest.config.ts:37`) and no test imports it. It IS lint-gated (`npm run lint` = `eslint src/ prisma/ scripts/ tests/`) and tsc-gated. **Every string this plan prints is built in `src/lib/**` and unit-tested there**; the scripts only loop over the returned arrays. The Docker image bundles `scripts/calibration/run.ts` with esbuild (`Dockerfile:150`), Task 5 adds a second block for `scripts/calibration/abstention.ts`, and `.dockerignore:72` promises the directory "pulls in `src/lib/calibration/**` and `@/lib/db` only" — `scoring-version.ts` imports **nothing**, `forced-choice.ts` and `abstention.ts` import only type-and-constant symbols from `readings.ts`, so that promise stays true.
- `src/lib/**/*.ts` is inside the unit coverage `include`. Three new, heavily-unit-tested leaf modules **are expected to raise `lines`/`statements`/`functions`, and the aggregate `branches` floor (87, `vitest.config.ts:190` — the tightest gate in the file) is the one that can move DOWN if their own branch rate is below it.** They are not fully branch-covered by construction: `baseline.ts`'s unreachable `coverage === null` arm, `forced-choice.ts`'s `best > 0` false arm and its `unbiasedCoinTiebreak === null` render, and in `abstention.ts` the `selectiveMarginOverConstant === null` reason, `arm(null)`, the both-arms-null early return and the `contrast === null` line. **Read the printed `% Branch` row for `src/lib/calibration/` rather than assuming.** **`vitest.config.ts` is not edited by this plan. If `test:coverage` reports a threshold failure, do not touch it — add a fixture for the uncovered branch** — a floor never goes down.
- **`rawAgreement` and `kappa` MUST NOT CHANGE.** Every historical number and every document quoting one depends on them. This plan only ADDS fields. Task 3 Step 2's `three ties` test pins `rawAgreement` on the only fixture where it and selective accuracy differ, and Step 13's INJECTION F reddens it; Cohen's kappa already treats `tie` as a third category and already scores stampers correctly (lfm2.5:8b kappa ≈ 0), and **nothing here touches `src/lib/agreement.ts` or `groundTruthReadings`.**

---

## Commit shape (binding)

Exactly **six** commits land from this plan, one per task, one concern each:

| commit | task | subject |
|---|---|---|
| A | 1 | `feat(calibration): stamp which generation of the scoring rules produced a stored number` |
| B | 2 | `feat(calibration): v2m/v2n — CalibrationRun records its scoring version and its coverage` |
| C | 3 | `feat(calibration): coverage and selective accuracy, with the floor over the COMMITTED subset` |
| D | 4 | `feat(calibration): report the forced-choice projections by strategy, never as one number` |
| E | 5 | `feat(calibration): contrast a judge's abstentions against the cohort that answered them` |
| F | 6 | `docs(calibration): backfill order, the new report block, and a negative result on textual hedging` |

**Why the migration is its own commit (B) and not folded into A or C.** A carries the pure module and the constant; C carries the computation. B carries only `prisma/schema.prisma` + two `migration.sql` files + the regenerated client + the one `tests/db` assertion that the migrated columns and the generated client agree, and it is the ONLY commit in this plan that runs the full six-gate chain. Splitting it this way means the schema change can be reviewed as a schema change, and it is the one commit whose blast radius reaches a database.

**Why the version BUMP (1 → 2) lands in commit C and not B.** The bump *is* the rule change's identity. Landing it separately would create a window in which the scoring rules had changed and the stamp had not — which is the exact defect the stamp exists to prevent.

---

### Task 1: the scoring-version stamp — a pure module and its changelog

**Files:**
- Create: `/root/judge-arena/src/lib/calibration/scoring-version.ts`
- Create (Test): `/root/judge-arena/tests/lib/calibration-scoring-version.test.ts`
- Create: this plan file, committed here — named explicitly in Step 8's `git commit --only`.
- Modify: nothing else. No schema, no migration, no script, no worker file, no change to `score.ts` (that is Task 2's commit, which needs the column to exist first).

**Interfaces:**
- Consumes: **nothing. The module has zero imports** — a property `npm run lint`, `npx tsc --noEmit` and the `.dockerignore:72` bundle promise all depend on, and Step 3's first test asserts.
- Produces:
  - `export const SCORING_RULES_VERSION = 1;`
  - `export type ScoringRulesGeneration = { version: number; migration: string; rules: string };`
  - `export const SCORING_RULES_CHANGELOG: readonly ScoringRulesGeneration[];`
  - `export function describeScoringVersion(version: number | null): string;`

- [ ] **Step 0: Establish the starting state and MEASURE the baseline**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena diff --cached --name-only && git -C /root/judge-arena status --porcelain
```

`git log` must print `2e7e142 feat(calibration): raise MAX_CALIBRATION_ITEMS to 1000, gated on the deadline-at-first-dequeue fix`. `git diff --cached --name-only` must print **nothing**. `git status --porcelain` must show only `?? docs/superpowers/plans/` lines. **If any line begins with `A `, `M `, ` M`, `D ` or ` D`, STOP** — another agent is executing a sibling plan in this checkout. Do not `git stash`, do not `git reset`, do not commit around it: hand it back to the operator, or take a `git worktree`.

Then measure, because every count in this plan is arithmetic on this number and nothing else:

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npx vitest run --root /root/judge-arena 2>&1 | tail -5
```

Expected on `2e7e142`: lint 0, tsc silent, `Test Files  61 passed (61)` / `Tests  1007 passed (1007)`. **Write down whatever it prints — call it `B` (tests) and `F` (files).** The per-task deltas are stated in each task's Gates step and are `it(` block counts, not guesses.

- [ ] **Step 1: Record the column decision (read it — Task 2 materialises it and the rest of the plan assumes it)**

No code in this step. **The stamp is a nullable `Int` column, `CalibrationRun.scoringVersion`.** The alternatives and why they lose:

*An enum.* Prisma enums are a schema type; every new generation is a `CREATE TYPE`/`ALTER TYPE` migration on a column that only ever needs to be compared and ordered. An enum also cannot express "a NEWER image scored this row" — the value would not parse, where an `Int` renders honestly (`describeScoringVersion(99)` below). Rejected.

*A timestamp, or reusing `finishedAt`.* Time is not a rule identity. Two runs scored eight minutes apart can straddle a deploy, and a timestamp cannot be compared against a constant in code — the check would become "is this after the day v2n landed", written down nowhere and wrong the first time a rollback happens. `finishedAt` is additionally already overwritten by every `--score-only`, which is a separate hazard Task 6 documents. Rejected.

*A string like `'v2n'`.* Not orderable, and it invites free text. Rejected.

*Nothing at all — derive the generation from which columns are non-NULL.* This is the seductive one, and it is wrong for a specific reason: `selectiveAccuracy` is legitimately NULL at zero coverage (a judge that abstained on everything), so "NULL means not scored under v2" and "NULL means the judge committed to nothing" would be the same observation. That is the null-not-zero failure with an extra step. **A generation must be stated, not inferred.** Rejected.

*What NULL means, precisely, and it means exactly one thing:* **"scored before v2m; the rule generation was not recorded."** All 20 production rows read NULL the moment the migration applies, and they stay NULL until each is re-scored (Task 6's backfill). **NULL is NOT `0` and is NOT "version 1"** — the pre-v2m rules happen to be what this plan calls version 1, but a row that was never stamped cannot prove it was scored under them, and treating NULL as 1 would silently certify 20 rows nobody checked.

*How a scoreboard query avoids comparing across generations* — the canonical guard, which Task 6 writes into the runbook:

```sql
-- ALWAYS run this first. If it returns more than one row, the table holds
-- more than one rule generation and NO cross-row comparison below is valid.
SELECT COALESCE("scoringVersion"::text, 'NULL (pre-v2m)') AS generation, count(*)
FROM "CalibrationRun" WHERE "rawAgreement" IS NOT NULL GROUP BY 1 ORDER BY 1;

-- Only then, and always with the filter, never without it:
SELECT jm.name, cr."rawAgreement", cr."constantBaselineAccuracy",
       cr."committedCount"::float / NULLIF(cr."verdictCount",0) AS coverage,
       cr."selectiveAccuracy", cr."selectiveBaselineAccuracy"
FROM "CalibrationRun" cr
JOIN "JudgeModelVersion" jv ON jv.id = cr."judgeModelVersionId"
JOIN "JudgeModel" jm ON jm.id = jv."judgeModelId"
WHERE cr."goldenSetId" = '<one set>' AND cr."scoringVersion" = 2
  -- selectiveAccuracy is MONOTONICALLY IMPROVABLE BY ABSTAINING ON YOUR OWN
  -- ERRORS, so it is never a ranking key on its own and never read without a
  -- coverage guard beside it. The usual mitigation is a risk-coverage curve;
  -- that is not computable here (no per-item confidence ordering — Task 4 Step 1
  -- and follow-up F3), so the guard is all there is.
  AND cr."committedCount" >= 100
  AND cr."committedCount"::float / NULLIF(cr."verdictCount", 0) >= 0.5
ORDER BY cr."rawAgreement" DESC NULLS LAST, cr."selectiveAccuracy" DESC NULLS LAST;
```

**The judge that games this, concretely, using a row that exists.** `cmtondblm00012lzcx1m2cyql`
(lfm2.5:8b) committed on 103 items and got 56 of them right — selective accuracy 0.5437 over a
committed floor of 0.5243. Have it abstain on the 47 committed items it got *wrong* and nothing else
changes: `committedCount` 56, `committedCorrectCount` 56, **`selectiveAccuracy` 1.0000** over a
committed floor of roughly 0.54, **no `⚠` fires** (1.0 is not at or below the floor), and unguarded
it sorts **above Qwen3.6's 0.9000**. Coverage falls to 0.0929 and `rawAgreement` does not move at all
— which is exactly why the two guards above are `committedCount` and coverage, and why the sort key
is `rawAgreement` with selective accuracy only as the tiebreak. **Never rank on selective accuracy
alone; read it beside coverage or not at all.**

**What goes wrong without the filter, stated concretely because it is not obvious:** a v1 row has `rawAgreement` populated and `selectiveAccuracy` NULL. Sort by `selectiveAccuracy DESC` without `NULLS LAST` and the unscored rows sort *first*; add a `COALESCE(…, 0)` to "fix" that and every un-backfilled judge reads as "never commits, always wrong" — a fabricated measurement produced by a query, on a column that is correctly NULL. The filter is the fix; the coalesce is the trap.

- [ ] **Step 2: Write the failing test**

Create `/root/judge-arena/tests/lib/calibration-scoring-version.test.ts` with exactly this content:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCORING_RULES_CHANGELOG,
  SCORING_RULES_VERSION,
  describeScoringVersion,
} from '@/lib/calibration/scoring-version';

// ─── Why this module exists, in one paragraph ───────────────────────────────
//
// Scoring is EX POST: a score is a pure function over stored artefacts and
// `--score-only` re-derives it at any time without executing a model. That is
// the property the whole evaluation programme rests on, and it has exactly one
// cost — if the rules can improve without re-running anything, then a stored
// number is uninterpretable unless you know which rules produced it. Two runs
// scored under different generations put on one scoreboard is not a noisy
// comparison, it is a meaningless one.

describe('calibration/scoring-version: the constant and its changelog cannot drift apart', () => {
  it('SCORING_RULES_VERSION IS the newest changelog entry', () => {
    // The failure this catches: bumping the constant for a rule change and
    // forgetting the entry, which leaves `describeScoringVersion` reporting
    // the new version as UNKNOWN to the very build that produced it.
    const newest = SCORING_RULES_CHANGELOG[SCORING_RULES_CHANGELOG.length - 1];
    expect(newest.version).toBe(SCORING_RULES_VERSION);
  });

  it('the changelog is 1..n, ascending, with no gap and no repeat', () => {
    expect(SCORING_RULES_CHANGELOG.map((g) => g.version)).toEqual(
      Array.from({ length: SCORING_RULES_CHANGELOG.length }, (_, i) => i + 1)
    );
  });

  it('every entry names the migration that carried it and what the rules were', () => {
    for (const generation of SCORING_RULES_CHANGELOG) {
      expect(generation.migration).toMatch(/^v2[a-z]$/);
      // A one-word "rules" string is a label, not a record. The threshold is
      // deliberately low and its only job is to fail an empty placeholder.
      expect(generation.rules.length).toBeGreaterThan(40);
    }
  });
});

describe('calibration/scoring-version: describeScoringVersion says what a reader needs', () => {
  it('NULL is reported as pre-v2m and NOT comparable — never as version 1, never as 0', () => {
    const text = describeScoringVersion(null);
    expect(text).toContain('NULL');
    expect(text).toContain('v2m');
    expect(text).toContain('NOT comparable');
  });

  it('a known version renders its migration and its rules', () => {
    const text = describeScoringVersion(1);
    expect(text).toContain('v2l');
    expect(text).toContain('rawAgreement');
  });

  it('a version this build does not know is reported as UNKNOWN, not silently rendered', () => {
    // A newer image scored this run. Rendering it as "1" or as an empty string
    // would let an old build describe numbers it cannot account for. 99 is used
    // rather than SCORING_RULES_VERSION + 1 so this test keeps meaning the same
    // thing after the constant is bumped in Task 3.
    const text = describeScoringVersion(99);
    expect(text).toContain('UNKNOWN');
    expect(text).toContain(`newest known is ${SCORING_RULES_VERSION}`);
  });
});

describe('calibration/scoring-version: a LEAF module', () => {
  // WHOLE FILE, not line-by-line. A per-line regex misses the multi-line form
  // (failure mode 2) — `export {\n  x,\n} from './y';` walks straight through
  // a `/^(?:import|export\s.*\sfrom)/` per-line test.
  const SOURCE = readFileSync(
    new URL('../../src/lib/calibration/scoring-version.ts', import.meta.url),
    'utf8'
  );

  it('has NO import of any kind — the property that keeps it free of the calibration graph', () => {
    // scripts/calibration/run.ts is bundled by esbuild with only @prisma/client
    // external (.dockerignore:72). This module is imported by score.ts AND by
    // that bundle; an import here is a new edge in both graphs.
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\bfrom\s+['"]/);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the reason expected**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-scoring-version.test.ts
```

**Expected FAIL**, before any implementation exists — a resolution error, not an assertion error:

```
Error: Failed to resolve import "@/lib/calibration/scoring-version" from "tests/lib/calibration-scoring-version.test.ts". Does the file exist?
```

If instead you see assertion failures, the module already exists and this plan's `Depends on` is stale — stop and re-check the tree.

- [ ] **Step 4: Minimal implementation**

Create `/root/judge-arena/src/lib/calibration/scoring-version.ts` with exactly this content:

```ts
/**
 * ─── WHICH GENERATION OF THE SCORING RULES PRODUCED A STORED NUMBER ─────────
 *
 * SCORING IS EX POST, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
 *
 * A judge's complete output is on disk — `systemPrompt`, `userPrompt`,
 * `userPromptSha256`, `promptTemplateId`, `rawResponse`, `reasoningContent`,
 * `reasoningSource`, `verdict`, `samplingParams`, `parseMode`, `servedModelId`,
 * all non-null on all 619 judgments of calibration run
 * cmtozu76f00012l5w4llb4pae (measured 2026-09-06). A score is therefore a PURE
 * FUNCTION over stored rows, `--score-only` re-derives it at any time, and the
 * evaluation framework can improve WITHOUT re-executing a single model. Every
 * metric added in this phase — coverage, selective accuracy, the forced-choice
 * projections — was backfilled onto runs that finished days earlier.
 *
 * The cost of that property is this: IF THE RULES CAN CHANGE WITHOUT THE DATA
 * CHANGING, A STORED NUMBER IS MEANINGLESS UNLESS YOU KNOW WHICH RULES MADE IT.
 * Two runs scored under different generations, side by side on one scoreboard,
 * is not a noisy comparison — it is a comparison of two different questions.
 * Nothing else in the header can tell them apart: `finishedAt` moves on every
 * re-score, and "which columns are non-NULL" cannot work because
 * `selectiveAccuracy` is LEGITIMATELY NULL at zero coverage, so "not scored
 * under v2" and "the judge committed to nothing" would be one observation.
 *
 * WHAT NULL MEANS ON THE COLUMN, AND IT MEANS EXACTLY ONE THING: "scored before
 * v2m; the rule generation was not recorded." All 20 production CalibrationRun
 * rows read NULL the moment the migration applies. NULL IS NOT 0 AND IS NOT
 * VERSION 1 — the pre-v2m rules happen to be what this file calls generation 1,
 * but a row that was never stamped cannot prove it was scored under them, and
 * treating NULL as 1 would certify 20 rows nobody checked. A scoreboard query
 * filters on an explicit version and NEVER coalesces this column.
 *
 * PURE AND IMPORT-FREE BY DESIGN. Not one import: this module is pulled into
 * both `src/lib/calibration/score.ts` and the esbuild bundle behind
 * `scripts/calibration/run.ts` (.dockerignore:72 promises that bundle reaches
 * `src/lib/calibration/**` and `@/lib/db` only), so an edge added here is an
 * edge added in two graphs. `tests/lib/calibration-scoring-version.test.ts`
 * asserts the whole file against `/^\s*import\s/m`, not line by line.
 */

/**
 * The generation of scoring rules THIS BUILD implements. Stamped onto
 * `CalibrationRun.scoringVersion` by `scoreCalibrationRun` in the same full
 * overwrite as `rawAgreement`, so re-scoring moves the numbers and the stamp
 * together and cannot move one without the other.
 *
 * BUMP THIS WHENEVER A STORED FIELD'S DEFINITION CHANGES — not when a bug is
 * fixed in something that was already right, and not when a field is added that
 * no previous generation could have written (an all-NULL column is already
 * self-describing). Add the changelog entry in the SAME commit; the test pins
 * the two together precisely because bumping one and forgetting the other
 * leaves this build calling its own output UNKNOWN.
 */
export const SCORING_RULES_VERSION = 1;

export type ScoringRulesGeneration = {
  /** Monotone, contiguous from 1. Ordered, so "newer than" is decidable. */
  version: number;
  /** The migration whose landing defines the generation, e.g. 'v2l'. */
  migration: string;
  /** What the stored fields MEAN under this generation, in enough detail that
   *  a reader a year from now can tell whether a number is comparable to one
   *  produced today. A label is not a record. */
  rules: string;
};

export const SCORING_RULES_CHANGELOG: readonly ScoringRulesGeneration[] = [
  {
    version: 1,
    migration: 'v2l',
    rules:
      "rawAgreement = correctCount/verdictCount with a 'tie' counted as a miss; " +
      'Cohen kappa over the three preference categories; constantBaselineAccuracy = ' +
      'max(key class)/verdictCount over the SCORED subset',
  },
];

/**
 * One line describing a stored version, for the CLI report and for anything
 * that has to explain a row to a human.
 *
 * Three branches, and each one is a different kind of honesty:
 *   null      → the row predates the column. Say so, and say it is not
 *               comparable, rather than substituting a plausible generation.
 *   known     → render the migration and the rules, not just the integer.
 *   unknown   → a NEWER image scored this row. Say that this build cannot
 *               account for the numbers, rather than rendering an integer as
 *               though it had been understood.
 */
export function describeScoringVersion(version: number | null): string {
  if (version === null) {
    return (
      'NULL — scored before v2m, so the rule generation was not recorded; ' +
      'this row is NOT comparable to a stamped one until it is re-scored'
    );
  }
  const known = SCORING_RULES_CHANGELOG.find((generation) => generation.version === version);
  if (known === undefined) {
    return (
      `${version} — UNKNOWN to this build (newest known is ${SCORING_RULES_VERSION}); ` +
      'a NEWER image scored this run and this build cannot say what its numbers mean'
    );
  }
  return `${known.version} (${known.migration}) — ${known.rules}`;
}
```

- [ ] **Step 5: Run it to pass**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-scoring-version.test.ts
```

Expected: `Tests  7 passed (7)`, `Test Files  1 passed (1)`.

- [ ] **Step 6: INJECTION A — the constant and the changelog are pinned together**

Edit `/root/judge-arena/src/lib/calibration/scoring-version.ts`.

old_string:
```
export const SCORING_RULES_VERSION = 1;
```
new_string:
```
export const SCORING_RULES_VERSION = 2;
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-scoring-version.test.ts
```

**Expected RED, exactly two tests:**
- `SCORING_RULES_VERSION IS the newest changelog entry` → `expected 1 to be 2`
- `a version this build does not know is reported as UNKNOWN, not silently rendered` → `expected '99 — UNKNOWN to this build (newest known is 2); …' to contain 'newest known is 2'` — **no.** Read this one carefully: that assertion interpolates `SCORING_RULES_VERSION`, so it stays GREEN under this injection. **Only ONE test reddens.** If you see two, the second assertion has been written against a literal and that is a finding.

*What wrong implementation would still pass this?* One that bumped the constant AND added a changelog entry — which is the correct action, not a defect. This injection discriminates "bumped and forgot" only. **Restore the `1` and re-run to green.**

- [ ] **Step 7: INJECTION B — NULL must not be rendered as a generation**

Edit `/root/judge-arena/src/lib/calibration/scoring-version.ts`.

old_string:
```
  if (version === null) {
    return (
      'NULL — scored before v2m, so the rule generation was not recorded; ' +
      'this row is NOT comparable to a stamped one until it is re-scored'
    );
  }
```
new_string:
```
  if (version === null) {
    return describeScoringVersion(1);
  }
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-scoring-version.test.ts
```

**Expected RED, exactly one test:**
- `NULL is reported as pre-v2m and NOT comparable — never as version 1, never as 0` → `expected '1 (v2l) — rawAgreement = correctCount/verdictCount…' to contain "NULL"`

This is the single most likely wrong implementation in the whole module — "the old rows were scored under the old rules, so call them 1" is a reasonable-sounding sentence and it certifies 20 unchecked rows. **Restore and re-run to green.**

- [ ] **Step 8: Gates and commit**

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -30
```

Expected: lint 0 warnings; tsc silent; **`B + 7` tests over `F + 1` files** — on a 1007/61 baseline that is `Tests  1014 passed (1014)` over `Test Files  62 passed (62)`. **This is arithmetic on Step 0's measurement, not itself a measurement** (failure mode 15). Use whatever `test:coverage` actually prints; if the delta is not exactly `+7`, count the `it(` blocks in the new file (there are 7) and diagnose before committing. No coverage floor is expected to move: `scoring-version.ts` has one branch (`describeScoringVersion`'s unknown-version arm) and the test file covers both sides of it, so this module really is fully covered — **read the printed `% Branch` row rather than banking that; the aggregate floor of 87 (`vitest.config.ts:190`) is the one that can fall, and later tasks add modules that are NOT fully branch-covered.**

`npm run test:db:coverage`, `npm run test:integration` and `npm run build` are deliberately **not** run: this commit creates one leaf module and one unit test, touches no Prisma schema and no Next surface. Task 2 runs the full chain once for the branch.

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/scoring-version.ts \
  tests/lib/calibration-scoring-version.test.ts \
  docs/superpowers/plans/2026-09-06-ex-post-scoring-coverage-and-abstention.md
git -C /root/judge-arena status --short
```
Expected: exactly those three paths, each prefixed `A `. Then:

```bash
git -C /root/judge-arena commit --only \
  src/lib/calibration/scoring-version.ts \
  tests/lib/calibration-scoring-version.test.ts \
  docs/superpowers/plans/2026-09-06-ex-post-scoring-coverage-and-abstention.md \
  -F - <<'EOF'
feat(calibration): stamp which generation of the scoring rules produced a stored number

Scoring is ex post. Every judgment's complete artefact is on disk — prompts,
userPromptSha256, promptTemplateId, rawResponse, reasoningContent, verdict,
samplingParams, parseMode, servedModelId are non-null on all 619 judgments of
cmtozu76f00012l5w4llb4pae — so a score is a pure function over stored rows and
--score-only re-derives it without executing a model. That is the property this
programme rests on, and it has exactly one cost: if the rules can improve
without the data changing, a stored number is meaningless unless you know which
rules produced it.

SCORING_RULES_VERSION plus a changelog, pinned to each other by test: bumping
the constant without adding the entry leaves this build reporting its own output
as UNKNOWN, which is the failure that actually happens.

Nothing else in the header can carry this. finishedAt moves on every re-score,
so it dates the scoring pass and not the rule generation. "Which columns are
non-NULL" cannot work either: selectiveAccuracy is legitimately NULL at zero
coverage, so "not scored under the new rules" and "the judge committed to
nothing" would be the same observation.

describeScoringVersion has three branches and each is a refusal to guess. NULL
means "scored before v2m, generation unrecorded, NOT comparable" — never 0 and
never version 1, because a row that was never stamped cannot prove which rules
made it. An unrecognised version means a NEWER image scored the row and this
build cannot account for its numbers, which is said out loud rather than
rendered as an integer.

No imports, no column yet, no caller yet: v2m and score.ts's write land in the
next two commits, in that order, so the column exists before anything stamps it.

Gates: lint 0, tsc 0, <B+7> unit / n-a db (no tests/db file, no schema change) / n-a integration (no tests/integration file), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
```

Replace `<B+7>` with whatever `test:coverage` printed. Then verify:

```bash
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **3 files changed**. Any fourth file is a leaked index — that commit belongs to two concerns and must be reported, not amended around.

---

### Task 2: v2m and v2n — the two additive column sets, and the ONLY commit that reaches a database

**Files:**
- Modify: `/root/judge-arena/prisma/schema.prisma:955` — four fields inserted immediately after `constantBaselineAccuracy Float?`, inside `model CalibrationRun { … }` (`:937-997`)
- Create: `/root/judge-arena/prisma/migrations/20260906120000_v2m_calibration_scoring_version/migration.sql`
- Create: `/root/judge-arena/prisma/migrations/20260906130000_v2n_calibration_coverage/migration.sql`
- Modify (generated, not hand-edited): the Prisma client, via `npx prisma generate`
- Modify (Test): `/root/judge-arena/tests/db/meta-eval.test.ts` — one `it` appended beside the v2l column test at `:275`, following that precedent exactly. **Why this test and not "none":** `prisma migrate reset` proves the SQL *parses*; `tsc` proves the *schema field* exists. Neither proves the migrated COLUMN and the generated client agree, because Prisma's client types come from `schema.prisma` and not from the SQL — so a hand edit below a migration header putting `INTEGER` where `DOUBLE PRECISION` belongs would pass the reset, pass `tsc`, pass every unit test (the scorer is exercised through a fake client) and silently truncate `selectiveAccuracy` in the one place the number matters. Only a real round-trip can see it. Task 2 is also the only commit in this plan that runs `test:db:coverage`, so this is the only place the test can land.

**Interfaces:**
- Consumes: nothing.
- Produces (Prisma model fields on `CalibrationRun`, all nullable, no default):
  - `scoringVersion Int?`
  - `committedCount Int?`
  - `selectiveAccuracy Float?`
  - `selectiveBaselineAccuracy Float?`

- [ ] **Step 0: Confirm the starting state**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena status --porcelain && ls /root/judge-arena/prisma/migrations | tail -4
```

HEAD must be Task 1's commit. `ls` must end with `20260901190000_v2l_calibration_constant_baseline` and `migration_lock.toml`. **If a `20260906*` directory already exists, this task has been partly executed — stop and read it before writing anything.**

- [ ] **Step 1: Record the "no `coverage` column" decision**

No code in this step. **`coverage` is NOT stored. `committedCount` is.**

*For a `coverage` column:* one fewer expression in every scoreboard query.

*Against, and this decides it:* `coverage` is exactly `committedCount / verdictCount`, and **both operands are already stored on the same row**, written in the same overwrite. A stored copy is a derived duplicate, and duplicates drift — the specific way they drift here is that a partial re-score moves `verdictCount` and any code path that updated `coverage` from a stale `committedCount` would leave a row whose three numbers cannot all be true. `verdictCount` is additionally the landmine `score.ts:74-80` already documents (an `Int @default(0)` that an `{ increment }` implementation reads perfectly and returns double on the second pass), so the fewer things derived from it at write time, the better. `committedCount` is a COUNT and is not reconstructible from anything else on the row, so it is stored; `abstainedCount` is `verdictCount − committedCount` and is not.

*Why `selectiveAccuracy` IS stored even though `committedCorrectCount / committedCount` would give it.* Because `committedCorrectCount` is **not** on the row — `CalibrationRun` has no `correctCount` column at all, and adding one purely to re-derive a ratio would be a fifth column for no reader. The precedent is `rawAgreement` itself: the header stores the ratio, not the numerator.

*Why `selectiveBaselineAccuracy` IS stored.* v2l's entire argument, one level down: the scoreboard SQL is the only board that exists (handoff §8 step 3), and without the column that query cannot put the floor beside the number it floors — **which on this corpus changes the SIGN of the margin for two of four judges** (Measurements M2). `src/lib/calibration/baseline.ts` remains the source of truth; this is its stored copy.

- [ ] **Step 2: Edit `prisma/schema.prisma`**

Edit `/root/judge-arena/prisma/schema.prisma`.

old_string:
```
  constantBaselineAccuracy Float?
  testRetest          Float?
```
new_string:
```
  constantBaselineAccuracy Float?
  /// Which generation of the SCORING RULES produced every scored field on this
  /// row (v2m). Scoring is ex post — a score is a pure function over stored
  /// judgments and `--score-only` re-derives it without executing a model — so
  /// the rules can improve while the data does not, and two rows scored under
  /// different generations on one scoreboard compare two different questions.
  /// `src/lib/calibration/scoring-version.ts` is the source of truth
  /// (SCORING_RULES_VERSION + its changelog); score.ts stamps it in the same
  /// full-overwrite update as rawAgreement, so the numbers and the stamp cannot
  /// move independently. NULL means exactly one thing: "scored before v2m, rule
  /// generation unrecorded". It is NOT 0 and NOT version 1 — all 20 production
  /// rows read NULL until each is re-scored. A scoreboard query FILTERS on an
  /// explicit version and never COALESCEs this column.
  scoringVersion      Int?
  /// Items this judge COMMITTED on — a raw verdict other than 'tie' (v2n). The
  /// denominator of `selectiveAccuracy`, and the numerator of coverage, which is
  /// `committedCount::float / verdictCount` and is deliberately NOT stored: both
  /// operands are on this row, and a derived duplicate drifts when a re-score
  /// moves verdictCount. NULL means "not scored since v2n", never "committed to
  /// nothing" — that case is committedCount = 0 with selectiveAccuracy NULL.
  committedCount      Int?
  /// How often the judge was right WHEN IT ANSWERED: correct-among-committed /
  /// committedCount (v2n). The golden key is forced choice (336 'A>B' / 284
  /// 'B>A', no ties), so a 'tie' can never be correct and `rawAgreement`
  /// multiplies two independent quantities — how often the judge commits, and
  /// how often it is right when it does. Measured 2026-09-06: lfm2.5:8b and
  /// lfm2.5-thinking differ 5.3x on rawAgreement (0.0929 vs 0.4887) and are
  /// indistinguishable on this column (0.5437 vs 0.5363). NULL at ZERO coverage
  /// — never 0, never 1, never NaN — because "it was never right when it
  /// answered" is a measurement and "it never answered" is not.
  selectiveAccuracy   Float?
  /// The constant-verdict floor over the COMMITTED SUBSET (v2n) — max(key
  /// class)/committedCount, the floor `selectiveAccuracy` must clear. NOT
  /// `constantBaselineAccuracy`, which is over every scored item: comparing
  /// selective accuracy against THAT is precisely the error v2l exists to
  /// prevent, one level down, and on production data it flips the margin's sign
  /// for two of four judges (lfm2.5-thinking 0.5363 selective is +0.0071 over
  /// its committed floor of 0.5292 and -0.0056 against the full 0.5419).
  /// src/lib/calibration/baseline.ts is the source of truth; this is its stored
  /// copy for readers that never load the module.
  selectiveBaselineAccuracy Float?
  testRetest          Float?
```

- [ ] **Step 3: Generate the migration SQL — do NOT hand-write the statement**

House rule: the content below the narrative header is **exactly** what `prisma migrate diff` emits, with zero hand edits. Generate it offline, against the schema as it was one commit ago — this needs no shadow database, no `DATABASE_URL`, and touches nothing:

```bash
git -C /root/judge-arena show HEAD:prisma/schema.prisma > /tmp/ja-schema-v2l.prisma
npx --prefix /root/judge-arena prisma migrate diff \
  --from-schema-datamodel /tmp/ja-schema-v2l.prisma \
  --to-schema-datamodel /root/judge-arena/prisma/schema.prisma \
  --script
```

**Expected output — all four columns in ONE `AlterTable`, because that is what a single diff produces:**

```sql
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "committedCount" INTEGER,
ADD COLUMN     "scoringVersion" INTEGER,
ADD COLUMN     "selectiveAccuracy" DOUBLE PRECISION,
ADD COLUMN     "selectiveBaselineAccuracy" DOUBLE PRECISION;
```

**That is one statement and this task ships TWO migrations, so the split is deliberate and must be done by re-running the diff twice, not by editing the output.** Do it in two passes:

```bash
# Pass 1 — v2m only: start from the committed schema, add ONLY scoringVersion.
git -C /root/judge-arena show HEAD:prisma/schema.prisma > /tmp/ja-schema-v2l.prisma
python3 - <<'PY'
src = open('/tmp/ja-schema-v2l.prisma').read()
anchor = '  constantBaselineAccuracy Float?\n'
assert src.count(anchor) == 1, 'anchor is not unique — stop and re-read the schema'
open('/tmp/ja-schema-v2m.prisma','w').write(src.replace(anchor, anchor + '  scoringVersion      Int?\n'))
PY
npx --prefix /root/judge-arena prisma migrate diff \
  --from-schema-datamodel /tmp/ja-schema-v2l.prisma \
  --to-schema-datamodel /tmp/ja-schema-v2m.prisma --script

# Pass 2 — v2n only: from the v2m shape to the real, fully-commented schema.
npx --prefix /root/judge-arena prisma migrate diff \
  --from-schema-datamodel /tmp/ja-schema-v2m.prisma \
  --to-schema-datamodel /root/judge-arena/prisma/schema.prisma --script
```

Pass 1 must print exactly:
```sql
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "scoringVersion" INTEGER;
```
Pass 2 must print exactly:
```sql
-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "committedCount" INTEGER,
ADD COLUMN     "selectiveAccuracy" DOUBLE PRECISION,
ADD COLUMN     "selectiveBaselineAccuracy" DOUBLE PRECISION;
```

**If either prints anything else — a `DROP`, a `SET NOT NULL`, a `DEFAULT`, a second table — STOP.** An additive nullable column is the entire change; anything else means the schema edit in Step 2 was not the edit this plan describes. `/// ` doc comments are Prisma-level and emit no SQL, which is why the four blocks of prose above do not appear in either output.

- [ ] **Step 4: Write the two migration files**

Create `/root/judge-arena/prisma/migrations/20260906120000_v2m_calibration_scoring_version/migration.sql`:

```sql
-- v2m — CalibrationRun records WHICH GENERATION OF THE SCORING RULES made its numbers
--
-- SCORING IS EX POST, AND THAT IS WHY THIS COLUMN HAS TO EXIST. A judge's
-- complete output is on disk — systemPrompt, userPrompt, userPromptSha256,
-- promptTemplateId, rawResponse, reasoningContent, reasoningSource, verdict,
-- samplingParams, parseMode and servedModelId are all non-null on all 619
-- judgments of calibration run cmtozu76f00012l5w4llb4pae (measured 2026-09-06)
-- — so a score is a PURE FUNCTION over stored rows, `--score-only` re-derives
-- it at any time, and the evaluation framework can improve WITHOUT re-executing
-- a single model. That property is the point of the whole design. Its one cost
-- is paid here: if the rules can change while the data does not, then a stored
-- number is meaningless unless you know which rules produced it, and two runs
-- scored under different generations on one scoreboard are not a noisy
-- comparison but a comparison of two different questions.
--
-- WHY NOT DERIVE IT. finishedAt is rewritten by every --score-only, so it dates
-- the pass and not the rules. "Which columns are non-NULL" cannot work either:
-- v2n's selectiveAccuracy is LEGITIMATELY NULL at zero coverage, so "not scored
-- under the new rules" and "the judge committed to nothing" would be the same
-- observation — the null-not-zero failure with one more step in it.
--
-- WHY Int AND NOT AN ENUM. A generation only ever needs to be compared and
-- ordered, and an Int renders honestly when a NEWER image has scored a row: the
-- value is out of range for this build and describeScoringVersion says so, where
-- an enum value would simply fail to parse.
--
-- WHAT NULL MEANS, AND IT MEANS EXACTLY ONE THING: "scored before v2m; the rule
-- generation was not recorded." All 20 production CalibrationRun rows read NULL
-- the moment this applies. NULL IS NOT 0 AND IS NOT VERSION 1 — the pre-v2m
-- rules happen to be what src/lib/calibration/scoring-version.ts calls
-- generation 1, but a row that was never stamped cannot prove it was scored
-- under them, and treating NULL as 1 would certify 20 rows nobody checked. A
-- scoreboard query FILTERS on an explicit version; it never COALESCEs this
-- column, because coalescing it to 0 sorts every un-backfilled judge to the top
-- or the bottom of a leaderboard as a fabricated measurement.
--
-- ZERO HAND EDITS: what follows is byte-for-byte what `prisma migrate diff`
-- emitted for this one field. ENTIRELY ADDITIVE: one nullable INTEGER, no DROP,
-- no DELETE, no default, NO BACKFILL. Re-scoring is a deliberate operator action
-- (`--score-only`) and never a migration step, because scoring also rewrites
-- rawAgreement, kappa and finishedAt.

-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "scoringVersion" INTEGER;
```

Create `/root/judge-arena/prisma/migrations/20260906130000_v2n_calibration_coverage/migration.sql`:

```sql
-- v2n — CalibrationRun separates HOW OFTEN A JUDGE COMMITS from HOW OFTEN IT IS RIGHT
--
-- The golden key is FORCED CHOICE. GoldenSet cmt057h5d00097y01ymubpre5 is 620
-- items, 336 'A>B' and 284 'B>A', with ZERO ties (verified 2026-09-06). A 'tie'
-- verdict can therefore never be correct, and rawAgreement — which is accuracy,
-- and counts a tie as a miss — silently multiplies two independent quantities:
-- coverage, and accuracy given coverage.
--
-- WHAT THAT HIDES, measured on that set:
--     judge                  coverage  selective   rawAgreement
--     Qwen3.6-35B-A3B          0.9855     0.9000         0.8869
--     lfm2.5-thinking:1.2b     0.9113     0.5363         0.4887
--     lfm2.5:8b                0.1708     0.5437         0.0929
-- The two lfm rows differ 5.3x on rawAgreement — which reads as "mediocre
-- versus broken" — and are statistically identical on selective accuracy. Same
-- discriminative ability; they differ only in how they express uncertainty, and
-- nothing stored before this migration could say so.
--
-- THE FLOOR MOVES WITH THE DENOMINATOR, AND THIS IS THE SECOND ONE. v2l added
-- constantBaselineAccuracy = max(key class)/verdictCount over the SCORED subset.
-- selectiveAccuracy has a DIFFERENT denominator — the committed subset — and
-- therefore a different floor, which is what selectiveBaselineAccuracy holds.
-- Comparing selective accuracy against v2l's full-subset floor is exactly the
-- error v2l exists to prevent, one level down, and on production data it FLIPS
-- THE SIGN of the margin for two of four judges: lfm2.5-thinking's 0.5363 is
-- +0.0071 over its committed floor of 0.5292 and -0.0056 against the full
-- subset's 0.5419; lfm2.5:8b's 0.5437 is +0.0194 over 0.5243 and -0.0019
-- against 0.5456. Neither margin is a strong claim, but the SIGN is what a
-- reader takes away and it is decided entirely by which floor is quoted.
--
-- WHY NO `coverage` COLUMN. It is exactly committedCount::float / verdictCount
-- and BOTH operands are on this row, written in the same overwrite. A stored
-- copy is a derived duplicate, and a partial re-score moves verdictCount, so a
-- stale copy would leave a row whose three numbers cannot all be true.
-- abstainedCount is omitted for the same reason (verdictCount - committedCount).
-- committedCount IS stored because it is a count and is reconstructible from
-- nothing else here; selectiveAccuracy is stored because its numerator
-- (correct-among-committed) is not on the row at all, exactly as rawAgreement
-- stores a ratio rather than a numerator.
--
-- NULL-NOT-ZERO, on both new Float columns. selectiveAccuracy is NULL at ZERO
-- coverage — never 0, never 1, never NaN — because "it was never right when it
-- answered" is a measurement and "it never answered" is not. That case is real:
-- production row cmton7ip500012lyjubiqohy8 has 16 completed judgments of which
-- the judge committed on ONE.
--
-- rawAgreement AND kappa ARE UNCHANGED. Every historical number and every
-- document quoting one depends on them; this migration only ADDS.
--
-- ZERO HAND EDITS below this header: byte-for-byte what `prisma migrate diff`
-- emitted. ENTIRELY ADDITIVE: three nullable columns, no DROP, no DELETE, no
-- default, NO BACKFILL. NULL means "not scored since v2n" and the 20 production
-- rows stay NULL until an operator re-scores each with --score-only on an image
-- that carries this migration.

-- AlterTable
ALTER TABLE "CalibrationRun" ADD COLUMN     "committedCount" INTEGER,
ADD COLUMN     "selectiveAccuracy" DOUBLE PRECISION,
ADD COLUMN     "selectiveBaselineAccuracy" DOUBLE PRECISION;
```

- [ ] **Step 5: Regenerate the client and prove the four fields exist**

```bash
npx --prefix /root/judge-arena prisma generate
```

Then prove the generated types actually carry the fields — a `prisma generate` that silently used a cached schema is the wrong implementation this discriminates against:

```bash
grep -c 'scoringVersion\|committedCount\|selectiveAccuracy\|selectiveBaselineAccuracy' \
  /root/judge-arena/node_modules/.prisma/client/index.d.ts
```

Expected: a count **well above 4** (the field names appear in the model type, the select, the where, the orderBy and the update input). **`0` means the generate did not see the schema edit.** A `grep -c` on a substring cannot distinguish `committedCount` from `committedCountX` (failure mode 3), which does not matter here because nothing renamed anything — but the next check is the one that has teeth:

```bash
npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json
```

Expected: silent. It is silent both before and after this commit, so **it is not evidence of anything yet** — say so rather than banking it. The compile-time proof arrives in Task 3, where `score.ts` writes all four fields and would fail `tsc` if any were missing.

- [ ] **Step 5b: Pin the columns against a real Postgres**

Append to `/root/judge-arena/tests/db/meta-eval.test.ts`, immediately after the v2l block that ends at `:292`. Edit the file.

old_string:
```
    const scored = await db.calibrationRun.update({
      where: { id: run.id },
      data: { constantBaselineAccuracy: 14 / 25 },
    });
    expect(scored.constantBaselineAccuracy).toBeCloseTo(0.56, 12);
  });
```
new_string:
```
    const scored = await db.calibrationRun.update({
      where: { id: run.id },
      data: { constantBaselineAccuracy: 14 / 25 },
    });
    expect(scored.constantBaselineAccuracy).toBeCloseTo(0.56, 12);
  });

  it('CalibrationRun v2m/v2n columns default to NULL and round-trip their SQL types', async () => {
    // The v2l precedent above, one migration on, and for the same reason. The
    // migration SQL is generated, but a hand edit below the narrative header
    // putting INTEGER where DOUBLE PRECISION belongs passes `prisma migrate
    // reset`, passes `tsc` (the client type comes from schema.prisma, not from
    // the SQL) and passes every unit test, which scores through a fake client.
    // Only a real round-trip can see it: 5/7 stored in an INTEGER column comes
    // back 1. NULL here means "scored before v2m/v2n", never 0.
    const goldenSet = await mkGoldenSet();
    const judgeModelVersion = await mkJudgeModelVersion();
    const run = await db.calibrationRun.create({
      data: { judgeModelVersionId: judgeModelVersion.id, goldenSetId: goldenSet.id },
    });
    expect(run.scoringVersion).toBeNull();
    expect(run.committedCount).toBeNull();
    expect(run.selectiveAccuracy).toBeNull();
    expect(run.selectiveBaselineAccuracy).toBeNull();

    const scored = await db.calibrationRun.update({
      where: { id: run.id },
      data: {
        scoringVersion: 2,
        committedCount: 7,
        selectiveAccuracy: 5 / 7,
        selectiveBaselineAccuracy: 4 / 7,
      },
    });
    expect(scored.scoringVersion).toBe(2);
    expect(scored.committedCount).toBe(7);
    expect(scored.selectiveAccuracy).toBeCloseTo(0.7142857142857143, 12);
    expect(scored.selectiveBaselineAccuracy).toBeCloseTo(0.5714285714285714, 12);
  });
```

`mkJudgeModelVersion` (`tests/db/meta-eval.test.ts:13`) and `mkGoldenSet` (`:58`) are module-scope helpers in that file and are the same ones the v2l test above calls — copy nothing, they are already in scope.

**Do not run this file on its own now.** The db suite is not concurrency-safe (one shared `judge_arena_test`), and `test:db:coverage` in the next step resets the database and applies both new migrations, which is the only run that proves anything here.

- [ ] **Step 6: Gates — the FULL chain, once for the branch**

This is the only commit in the plan that touches `prisma/schema.prisma`, so it is the one that runs everything. **First confirm what `test:db` will reset** (handoff §6 trap 1 — the two database names differ by one character, and one of them is production with a calibration draining in it):

```bash
grep DATABASE_URL /root/judge-arena/.env.test
```

**It MUST read `localhost:5432`.** If it does not, stop; do not run the next command.

```bash
npm --prefix /root/judge-arena run lint \
  && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json \
  && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -20 \
  && npm --prefix /root/judge-arena run test:db:coverage 2>&1 | tail -20 \
  && npm --prefix /root/judge-arena run test:integration 2>&1 | tail -10 \
  && npm --prefix /root/judge-arena run build 2>&1 | tail -10
```

Expected: lint 0; tsc silent; unit **unchanged from Task 1's number** (`B + 7`) over `F + 1` files — this commit adds no UNIT test; db **681 / 46 files** (680 on `2e7e142` plus Step 5b's one, in an existing file so the file count does not move); integration **93 / 11 files**; build clean. `test:db:coverage` runs `prisma migrate reset --force` internally and will apply both new migrations to `judge_arena_test` — **that is the point of running it here**, and it is the only place in this plan where a migration is applied to anything.

**If the db suite reports mass `Test timed out in 5000ms` across unrelated files, that is a stopped podman container, not a regression** (failure mode 10; Postgres alone is not enough — redis and rabbitmq paths hang to the 5 s default). **Never run two `test:db` at once** (failure mode 11), and re-run a failing db file **alone** before calling anything a regression.

- [ ] **Step 7: Commit**

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add \
  prisma/schema.prisma \
  prisma/migrations/20260906120000_v2m_calibration_scoring_version/migration.sql \
  prisma/migrations/20260906130000_v2n_calibration_coverage/migration.sql \
  tests/db/meta-eval.test.ts
git -C /root/judge-arena status --short
```
Expected: exactly those four paths (`M ` on the schema and the test, `A ` on the two migrations). The generated client lives under `node_modules/` and is not tracked; if `git status` shows anything under `node_modules/`, stop.

```bash
git -C /root/judge-arena commit --only \
  prisma/schema.prisma \
  prisma/migrations/20260906120000_v2m_calibration_scoring_version/migration.sql \
  prisma/migrations/20260906130000_v2n_calibration_coverage/migration.sql \
  tests/db/meta-eval.test.ts \
  -F - <<'EOF'
feat(calibration): v2m/v2n — CalibrationRun records its scoring version and its coverage

v2m adds scoringVersion. Scoring is ex post: a score is a pure function over
stored judgments and --score-only re-derives it without executing a model, so
the rules can improve while the data does not. A stored number is then
meaningless unless the row says which rules made it. finishedAt cannot carry
that (every re-score rewrites it) and neither can "which columns are non-NULL",
because v2n's selectiveAccuracy is legitimately NULL at zero coverage — so "not
scored under the new rules" and "the judge committed to nothing" would be one
observation. NULL on this column means one thing only: scored before v2m,
generation unrecorded. Not 0, not version 1; all 20 production rows read NULL
until each is re-scored.

v2n adds committedCount, selectiveAccuracy and selectiveBaselineAccuracy. The
golden key is forced choice — 620 items, 336 A>B / 284 B>A, zero ties — so a
tie can never be correct and rawAgreement multiplies coverage by accuracy-given-
coverage. Measured on that set: lfm2.5:8b and lfm2.5-thinking differ 5.3x on
rawAgreement (0.0929 vs 0.4887) and are indistinguishable on selective accuracy
(0.5437 vs 0.5363). Same discriminative ability, different ways of expressing
uncertainty, and nothing stored could say so.

selectiveBaselineAccuracy is the floor over the COMMITTED subset, not v2l's floor
over every scored item. Quoting the wrong one is the error v2l exists to prevent,
one level down, and it flips the margin's sign for two of four judges:
lfm2.5-thinking is +0.0071 over 0.5292 and -0.0056 against 0.5419.

No coverage column: it is committedCount/verdictCount and both operands are on
the row, so a stored copy is a duplicate that drifts when a re-score moves
verdictCount. rawAgreement and kappa are untouched.

Both files are byte-for-byte what `prisma migrate diff` emitted below their
narrative headers. Entirely additive — four nullable columns, no DROP, no
DEFAULT, no backfill. Backfilling is an operator action with --score-only, never
a migration step, because scoring also rewrites rawAgreement, kappa and
finishedAt.

One tests/db assertion lands with them, following v2l's precedent at
meta-eval.test.ts:275: migrate reset proves the SQL parses and tsc proves the
schema field exists, but neither proves the migrated COLUMN and the generated
client agree about nullability and type. A round-trip does.

Gates: lint 0, tsc 0, <B+7> unit / 681 db / 93 integration, coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **4 files changed** — the schema, the two migrations and `tests/db/meta-eval.test.ts`.

---

### Task 3: coverage and selective accuracy, with the floor over the COMMITTED subset

**Files:**
- Modify: `/root/judge-arena/src/lib/calibration/score.ts` — import (`:93-94`), `CalibrationScore` type (`:154-157`), accumulator declarations (`:258-262`), the row loop (`:279-287`), the computed block (`:299-304`), the result object (`:320-322`), the row update (`:344`)
- Modify: `/root/judge-arena/src/lib/calibration/baseline.ts` — append `formatSelectiveAccuracyLines` after `formatConstantBaselineLines` (`:142-148`)
- Modify: `/root/judge-arena/src/lib/calibration/scoring-version.ts` — bump the constant, add the generation-2 changelog entry
- Modify: `/root/judge-arena/scripts/calibration/run.ts` — one import line at `:60`, one printed block at `:296`, one printed line at `:298`
- Modify (Test): `/root/judge-arena/tests/lib/calibration-score.test.ts` — append one `describe` (8 `it`s)
- Modify (Test): `/root/judge-arena/tests/lib/calibration-baseline.test.ts` — append two `describe`s (6 `it`s + 1 call-site guard)

**Interfaces:**
- Consumes: `constantVerdictBaseline` / `ConstantBaseline` (`@/lib/calibration/baseline`, already imported by `score.ts`), `PREFERENCES` / `Preference` (`@/lib/calibration/readings`), `SCORING_RULES_VERSION` (`@/lib/calibration/scoring-version`, new import).
- Produces, on `CalibrationScore`:
  - `committedCount: number` · `abstainedCount: number` · `committedCorrectCount: number`
  - `coverage: number | null` · `selectiveAccuracy: number | null`
  - `selectiveBaseline: ConstantBaseline | null` · `selectiveMarginOverConstant: number | null`
- Produces, in `baseline.ts`:
  - `export function formatSelectiveAccuracyLines(score: { verdictCount: number; committedCount: number; abstainedCount: number; committedCorrectCount: number; coverage: number | null; selectiveAccuracy: number | null; selectiveBaseline: ConstantBaseline | null; selectiveMarginOverConstant: number | null; constantBaseline: ConstantBaseline | null }): string[]`
- Produces, written onto `CalibrationRun`: `scoringVersion`, `committedCount`, `selectiveAccuracy`, `selectiveBaselineAccuracy`.

- [ ] **Step 0: Confirm the starting state**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena status --porcelain
```
HEAD must be Task 2's commit and the tree must be clean apart from `?? docs/superpowers/plans/` lines.

- [ ] **Step 1: Work the arithmetic BEFORE writing the module (CONTRIBUTING.md:236-241 — a green test can be impossible to fail)**

Every expected value below is hand-computed here so that no test asserts a number the implementation also computed.

**Fixture S1 — the production Qwen3.6 shape** (`cmtozu76f00012l5w4llb4pae`, M2/M3): verdictCount 619, committed 610, abstained 9, correct 549, committed key 330 `A>B` / 280 `B>A`.
`coverage = 610/619 = 0.9854604` → `0.9855`. `selective = 549/610 = 0.9` exactly → `0.9000`. `committed floor = 330/610 = 0.5409836` → `0.5410`. `margin = 0.9 − 0.5409836 = 0.3590164` → `+0.3590`. The FULL-subset floor is `336/619 = 0.5428110` → a different number **and the same top class**, so S1 alone cannot prove the right floor was used. **S3 is the fixture that can.**

**Fixture S2 — three ties on `A>B`-keyed items, over the existing 30-item GROUND_TRUTH** (17 `A>B` / 13 `B>A`): verdictCount 30, abstained 3, committed 27, correct 27, committedCorrect 27.
`accuracy = 27/30 = 0.9` — **unchanged from the existing test at `:222`, which is the point.** `coverage = 27/30 = 0.9`. `selective = 27/27 = 1`. Committed key = 14 `A>B` / 13 `B>A` → `committed floor = 14/27 = 0.5185185`; full-subset floor = `17/30 = 0.5666667`. `selectiveMargin = 1 − 14/27 = 13/27 = 0.4814815`.

**Fixture S3 — the floor's top CLASS differs between the two subsets.** 10 items keyed 6 `A>B` / 4 `B>A`. The judge abstains on three `A>B` items and commits on the other seven, getting 5 right:

| item | key | verdict | derived | committed? | correct? |
|---|---|---|---|---|---|
| 0,1,2 | `A>B` | `tie` | `tie` | no | no |
| 3,4 | `A>B` | `A` | `A>B` | yes | yes |
| 5 | `A>B` | `B` | `B>A` | yes | no |
| 6,7,8 | `B>A` | `B` | `B>A` | yes | yes |
| 9 | `B>A` | `A` | `A>B` | yes | no |

`verdictCount 10`, `correctCount 5`, `accuracy 0.5`, `committedCount 7`, `committedCorrectCount 5`, `coverage 0.7`, `selective = 5/7 = 0.7142857`.
Full-subset key = `{A>B: 6, B>A: 4}` → floor `6/10 = 0.6`, **top class `A>B`**.
Committed key = `{A>B: 3, B>A: 4}` → floor `4/7 = 0.5714286`, **top class `B>A`**.
**The two floors name DIFFERENT preferences.** An implementation that passed `keyCounts` where `committedKeyCounts` belongs fails on the LABEL, not on a fourth decimal — which is the discriminating property this whole task needs and which S1 and S2 do not have.

**Fixture S4 — a tie-KEYED item, where a correct tie must NOT enter the selective numerator.** 4 items: two keyed `tie`, two keyed `A>B`. Verdicts `tie, tie, A, B`.
`correctCount = 3` (both ties are hits against a tie key — `score.ts:54-63` and `constantVerdictBaseline`'s header both say so, and that behaviour is preserved), `committedCount = 2`, `committedCorrectCount = 1`, `selective = 0.5`.
**Without the separate `committedCorrectCount` accumulator this is `3/2 = 1.5` — a "selective accuracy" above 1.** That is not a hypothetical: `PATCH /api/golden-sets/[id]/items` writes `expected` with no vocabulary check on an unfrozen set, and `readings.ts` accepts `'tie'`.

**Fixture S5 — zero coverage.** 3 items, all keyed `A>B`, all answered `tie`. `verdictCount 3`, `committedCount 0`, `correctCount 0`. `coverage = 0/3 = 0` (a real measurement — the judge answered, and committed to nothing). `selectiveAccuracy` **must be `null`**: not `0` ("it was never right when it answered" is a claim about answers that do not exist), not `1`, and not `NaN` from `0/0`. `selectiveBaseline` is `null` because `constantVerdictBaseline` returns `null` at denominator 0.

- [ ] **Step 2: Write the failing tests — `tests/lib/calibration-score.test.ts`**

Append this to the END of `/root/judge-arena/tests/lib/calibration-score.test.ts` (after the final `});`):

```ts

describe('scoreCalibrationRun — coverage and selective accuracy', () => {
  /** Hand-built rows, the same stand-in shape and for the same reason as the
   *  constant-floor block above: `calibration()` cannot express a hand-picked
   *  key balance or a 'tie' KEY, and both are load-bearing here. It ENFORCES
   *  the `calibrationRunId` filter and the nested `status: 'completed'` filter
   *  so a scorer that drops one fails a BEHAVIOUR test. `orderBy` is not
   *  honoured; every fixture below is handed in index order and the ordering
   *  clause is pinned by `fakeClient`'s own test. */
  type CoverageArgs = {
    where?: { calibrationRunId?: string };
    select?: { modelJudgments?: { where?: { status?: string } } };
  };
  type CoverageRow = {
    id: string;
    goldenItem: { id: string; index: number; expected: string };
    modelJudgments: Array<{
      verdict: string | null;
      pairOrder: string;
      judgeModelVersionId: string;
      status: string;
    }>;
  };
  function coverageClient(
    calibrationRunId: string,
    rows: CoverageRow[]
  ): CalibrationScoreClient & { updates: Array<Record<string, unknown>> } {
    const updates: Array<Record<string, unknown>> = [];
    return {
      updates,
      evaluationRun: {
        findMany: async (args: CoverageArgs) => {
          if (args?.where?.calibrationRunId !== calibrationRunId) return [];
          const wanted = args?.select?.modelJudgments?.where?.status;
          return rows.map((r) => ({
            ...r,
            modelJudgments:
              wanted === undefined
                ? r.modelJudgments
                : r.modelJudgments.filter((j) => j.status === wanted),
          }));
        },
      },
      calibrationRun: {
        update: async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        },
      },
    } as unknown as CalibrationScoreClient & { updates: Array<Record<string, unknown>> };
  }
  const row = (index: number, expected: string, verdict: string | null): CoverageRow => ({
    id: `run-${index}`,
    goldenItem: { id: `item-${index}`, index, expected },
    modelJudgments: [{ verdict, pairOrder: 'AB', judgeModelVersionId: 'v1', status: 'completed' }],
  });
  // `coverageClient`/`row` duplicate `rowsClient`/`item` in the constant-floor
  // describe above almost exactly. That is a DELIBERATE choice, not an oversight:
  // hoisting the existing pair to module scope would move ~50 lines of a passing
  // block in the same commit that adds eight tests, and one concern per commit
  // wins. The cost is real and is written down here so the next reader does not
  // have to rediscover it — a change to the query shape has to be made twice, and
  // the copy that is not updated keeps passing. Fold them together in a
  // follow-up commit that touches nothing else.

  it('a judge that never abstains has coverage 1 and selective accuracy EQUAL to accuracy', async () => {
    // The degenerate case, and the one that proves the new fields do not
    // silently redefine the old one: with no ties the two denominators are the
    // same set, so every number must coincide.
    const score = await scoreCalibrationRun(CALIBRATION_ID, fakeClient(calibration(withFlips(3))));

    expect(score.coverage).toBe(1);
    expect(score.committedCount).toBe(30);
    expect(score.abstainedCount).toBe(0);
    expect(score.committedCorrectCount).toBe(score.correctCount);
    expect(score.selectiveAccuracy).toBe(score.accuracy);
    expect(score.selectiveBaseline).toEqual(score.constantBaseline);
  });

  it('three ties: ACCURACY stays 0.9000 and selective accuracy is 1.0 — the split the metric exists for', async () => {
    // Fixture S2. The accuracy assertion is copied from the pre-existing test
    // at :222 deliberately: this is the pin that rawAgreement's MEANING did not
    // move when coverage landed beside it.
    const withTies = [...GROUND_TRUTH] as Preference[];
    withTies[0] = 'tie';
    withTies[1] = 'tie';
    withTies[2] = 'tie';
    const client = fakeClient(calibration(withTies));
    const score = await scoreCalibrationRun(CALIBRATION_ID, client);

    expect(score.accuracy).toBeCloseTo(0.9, 10);
    expect(score.correctCount).toBe(27);
    expect(score.verdictCount).toBe(30);
    expect(score.coverage).toBeCloseTo(0.9, 10);
    expect(score.committedCount).toBe(27);
    expect(score.abstainedCount).toBe(3);
    expect(score.committedCorrectCount).toBe(27);
    expect(score.selectiveAccuracy).toBe(1);
    // Committed key is 14 'A>B' / 13 'B>A' — the three abstentions came off the
    // 'A>B' side, so the floor MOVES from 17/30 to 14/27.
    expect(score.selectiveBaseline?.accuracy).toBeCloseTo(14 / 27, 10);
    expect(score.constantBaseline?.accuracy).toBeCloseTo(17 / 30, 10);
    expect(score.selectiveMarginOverConstant).toBeCloseTo(1 - 14 / 27, 10);

    // rawAgreement MUST NOT CHANGE, pinned HERE because accuracy (0.9) and
    // selective accuracy (1.0) DIFFER on this fixture. Every PRE-EXISTING
    // rawAgreement assertion — :296 (both null), :545, :560 and :594 — runs on a
    // `withFlips(3)` fixture, and `withFlips` (:141-155) only swaps 'A>B'<->'B>A'
    // and emits no 'tie', so on all of them the two numbers are IDENTICALLY equal
    // and none can see "selective accuracy is the better metric, store it in the
    // column that already exists". This assertion and the `cal-s3` row test below
    // are the only two places in the file where that swap is visible.
    expect(score.selectiveAccuracy).not.toBe(score.accuracy);
    expect(client.updates[0].rawAgreement).toBe(score.accuracy);
    expect(client.updates[0].rawAgreement).toBeCloseTo(0.9, 10);
  });

  it('the selective floor is over the COMMITTED subset — and here it names a DIFFERENT class', async () => {
    // Fixture S3, and the only assertion in this file that can catch
    // `constantVerdictBaseline(keyCounts)` written where
    // `constantVerdictBaseline(committedKeyCounts)` belongs. The two floors
    // differ in their TOP CLASS, not just in a decimal: the judge abstained on
    // three 'A>B' items, which flips the plurality of what remains.
    const score = await scoreCalibrationRun(
      'cal-s3',
      coverageClient('cal-s3', [
        row(0, 'A>B', 'tie'),
        row(1, 'A>B', 'tie'),
        row(2, 'A>B', 'tie'),
        row(3, 'A>B', 'A'),
        row(4, 'A>B', 'A'),
        row(5, 'A>B', 'B'),
        row(6, 'B>A', 'B'),
        row(7, 'B>A', 'B'),
        row(8, 'B>A', 'B'),
        row(9, 'B>A', 'A'),
      ])
    );

    expect(score.verdictCount).toBe(10);
    expect(score.correctCount).toBe(5);
    expect(score.accuracy).toBe(0.5);
    expect(score.coverage).toBeCloseTo(0.7, 10);
    expect(score.committedCount).toBe(7);
    expect(score.committedCorrectCount).toBe(5);
    expect(score.selectiveAccuracy).toBeCloseTo(5 / 7, 10);

    expect(score.constantBaseline).toEqual({
      accuracy: 0.6,
      preferences: ['A>B'],
      keyCounts: { 'A>B': 6, 'B>A': 4, tie: 0 },
      denominator: 10,
    });
    expect(score.selectiveBaseline).toEqual({
      accuracy: 4 / 7,
      preferences: ['B>A'],
      keyCounts: { 'A>B': 3, 'B>A': 4, tie: 0 },
      denominator: 7,
    });
    expect(score.selectiveMarginOverConstant).toBeCloseTo(5 / 7 - 4 / 7, 10);
  });

  it('a CORRECT tie against a tie KEY is not a commitment — selective accuracy cannot exceed 1', async () => {
    // Fixture S4. A tie key is reachable (PATCH /api/golden-sets/[id]/items
    // writes `expected` with no vocabulary check on an unfrozen set) and a tie
    // verdict against it is a HIT, which score.ts:54-63 preserves on purpose.
    // Reusing `correctCount` as the selective numerator over a denominator that
    // excluded those hits gives 3/2 = 1.5.
    const score = await scoreCalibrationRun(
      'cal-s4',
      coverageClient('cal-s4', [
        row(0, 'tie', 'tie'),
        row(1, 'tie', 'tie'),
        row(2, 'A>B', 'A'),
        row(3, 'A>B', 'B'),
      ])
    );

    expect(score.correctCount).toBe(3);
    expect(score.committedCount).toBe(2);
    expect(score.committedCorrectCount).toBe(1);
    expect(score.selectiveAccuracy).toBe(0.5);
    expect(score.selectiveAccuracy).toBeLessThanOrEqual(1);
  });

  it('a judge that committed to NOTHING reports selectiveAccuracy null — not 0, not 1, not NaN', async () => {
    // Fixture S5, and a real production shape: cmton7ip500012lyjubiqohy8 has 16
    // completed judgments and committed on ONE.
    const score = await scoreCalibrationRun(
      'cal-s5',
      coverageClient('cal-s5', [row(0, 'A>B', 'tie'), row(1, 'A>B', 'tie'), row(2, 'A>B', 'tie')])
    );

    expect(score.verdictCount).toBe(3);
    expect(score.committedCount).toBe(0);
    expect(score.abstainedCount).toBe(3);
    // Coverage 0 IS a measurement: the judge answered three times and committed
    // to none of them. Selective accuracy is not.
    expect(score.coverage).toBe(0);
    expect(score.selectiveAccuracy).toBeNull();
    expect(score.selectiveBaseline).toBeNull();
    expect(score.selectiveMarginOverConstant).toBeNull();
    expect(Number.isNaN(score.selectiveAccuracy as unknown as number)).toBe(false);
  });

  it('nothing scored at all: coverage is null too, and the counts are 0', async () => {
    const score = await scoreCalibrationRun('cal-empty', coverageClient('cal-empty', []));

    expect(score.verdictCount).toBe(0);
    expect(score.coverage).toBeNull();
    expect(score.selectiveAccuracy).toBeNull();
    expect(score.committedCount).toBe(0);
    expect(score.abstainedCount).toBe(0);
    expect(score.committedCorrectCount).toBe(0);
  });

  it('the row carries committedCount, selectiveAccuracy, its floor AND the scoring version', async () => {
    // One full overwrite: the numbers and the stamp that says which rules made
    // them cannot move independently.
    const client = coverageClient('cal-s3', [
      row(0, 'A>B', 'tie'),
      row(1, 'A>B', 'tie'),
      row(2, 'A>B', 'tie'),
      row(3, 'A>B', 'A'),
      row(4, 'A>B', 'A'),
      row(5, 'A>B', 'B'),
      row(6, 'B>A', 'B'),
      row(7, 'B>A', 'B'),
      row(8, 'B>A', 'B'),
      row(9, 'B>A', 'A'),
    ]);
    await scoreCalibrationRun('cal-s3', client);

    expect(client.updates).toHaveLength(1);
    const data = client.updates[0];
    expect(data.rawAgreement).toBe(0.5);
    expect(data.committedCount).toBe(7);
    expect(data.selectiveAccuracy).toBeCloseTo(5 / 7, 10);
    expect(data.selectiveBaselineAccuracy).toBeCloseTo(4 / 7, 10);
    // Written from the CONSTANT, and asserted against BOTH the constant and the
    // literal 2. The constant alone cannot tell a hardcoded literal from a
    // reference (they are equal today); the literal alone would not fail when
    // the constant is bumped without the write following it.
    expect(data.scoringVersion).toBe(SCORING_RULES_VERSION);
    expect(data.scoringVersion).toBe(2);
    // The floor over ALL scored items is a DIFFERENT column and a different
    // number — 0.6 against 4/7. Two floors on one row, and the wrong one is the
    // one that gets quoted.
    expect(data.constantBaselineAccuracy).toBe(0.6);
  });

  it('re-scoring is idempotent on the new fields too — nothing accumulates', async () => {
    const rows = [row(0, 'A>B', 'tie'), row(1, 'A>B', 'A'), row(2, 'B>A', 'B')];
    const client = coverageClient('cal-idem', rows);
    const first = await scoreCalibrationRun('cal-idem', client);
    const second = await scoreCalibrationRun('cal-idem', client);

    expect(second.committedCount).toBe(first.committedCount);
    expect(second.abstainedCount).toBe(first.abstainedCount);
    expect(second.committedCorrectCount).toBe(first.committedCorrectCount);
    expect(second.coverage).toBe(first.coverage);
    expect(second.selectiveAccuracy).toBe(first.selectiveAccuracy);
    expect(client.updates[1].committedCount).toBe(2);
  });
});
```

**Two imports have to be added at the top of that file** for this block to compile. Edit the import list.

old_string:
```
import {
  scoreCalibrationRun,
  type CalibrationScoreClient,
} from '@/lib/calibration/score';
import type { PairOrder, Preference } from '@/lib/calibration/readings';
```
new_string:
```
import {
  scoreCalibrationRun,
  type CalibrationScoreClient,
} from '@/lib/calibration/score';
import { SCORING_RULES_VERSION } from '@/lib/calibration/scoring-version';
import type { PairOrder, Preference } from '@/lib/calibration/readings';
```

- [ ] **Step 3: Write the failing tests — `tests/lib/calibration-baseline.test.ts`**

Append this to the END of `/root/judge-arena/tests/lib/calibration-baseline.test.ts` (after the final `});`):

```ts

describe('calibration/baseline: formatSelectiveAccuracyLines', () => {
  // The rendering lives here and not in scripts/calibration/run.ts for the same
  // reason formatConstantBaselineLines does: that file is outside every
  // coverage include (vitest.config.ts:37) and has no harness, so a template
  // built there ships untested — and the load-bearing parts of these strings
  // are the `<=` that decides the ⚠ and the CHOICE of floor, both of which are
  // silently wrong in exactly the way nothing downstream can detect.

  it('renders the production Qwen3.6 shape exactly, coverage first', () => {
    // cmtozu76f00012l5w4llb4pae, measured 2026-09-06: 619 verdicts, 610
    // committed, 549 correct, committed key 330 'A>B' / 280 'B>A'.
    const selectiveBaseline = constantVerdictBaseline({ 'A>B': 330, 'B>A': 280, tie: 0 });
    const constantBaseline = constantVerdictBaseline({ 'A>B': 336, 'B>A': 283, tie: 0 });
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 619,
        committedCount: 610,
        abstainedCount: 9,
        committedCorrectCount: 549,
        coverage: 610 / 619,
        selectiveAccuracy: 549 / 610,
        selectiveBaseline,
        selectiveMarginOverConstant: 549 / 610 - 330 / 610,
        constantBaseline,
      })
    ).toEqual([
      "  coverage   0.9855   (610/619 scored items the judge COMMITTED on; 9 abstained with 'tie')",
      "  selective  0.9000   (549/610 right where it COMMITTED)   floor 0.5410 ('A>B': 330/610)   margin +0.3590",
    ]);
  });

  it('warns when selective accuracy is AT OR BELOW the floor over the committed subset', () => {
    // Constructed, not measured: no completed production run is at or below its
    // own committed floor (Qwen3.6 +0.3590, lfm2.5-thinking +0.0071, lfm2.5:8b
    // +0.0194). The branch still has to exist and be pinned, because the judge
    // it exists for — one that stamps whenever it does commit — is exactly the
    // judge a coverage metric would otherwise flatter.
    const selectiveBaseline = constantVerdictBaseline({ 'A>B': 2, 'B>A': 1, tie: 0 });
    const constantBaseline = constantVerdictBaseline({ 'A>B': 5, 'B>A': 1, tie: 0 });
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 6,
        committedCount: 3,
        abstainedCount: 3,
        committedCorrectCount: 1,
        coverage: 0.5,
        selectiveAccuracy: 1 / 3,
        selectiveBaseline,
        selectiveMarginOverConstant: 1 / 3 - 2 / 3,
        constantBaseline,
      })
    ).toEqual([
      "  coverage   0.5000   (3/6 scored items the judge COMMITTED on; 3 abstained with 'tie')",
      "  selective  0.3333   (1/3 right where it COMMITTED)   floor 0.6667 ('A>B': 2/3)   margin -0.3333",
      '  ⚠ selective accuracy is at or below the floor OVER THE COMMITTED SUBSET — where it answers, the judge is not distinguishable from a stamp.',
    ]);
  });

  it('prints the COMMITTED floor, never the full-subset one, when the two name different classes', () => {
    // Fixture S3. Feeding the full-subset floor here renders "'A>B': 6/10"
    // instead of "'B>A': 4/7" — a wrong number under a wrong label, on the line
    // a reader uses to decide whether a judge beat a stamp.
    const lines = formatSelectiveAccuracyLines({
      verdictCount: 10,
      committedCount: 7,
      abstainedCount: 3,
      committedCorrectCount: 5,
      coverage: 0.7,
      selectiveAccuracy: 5 / 7,
      selectiveBaseline: constantVerdictBaseline({ 'A>B': 3, 'B>A': 4, tie: 0 }),
      selectiveMarginOverConstant: 5 / 7 - 4 / 7,
      constantBaseline: constantVerdictBaseline({ 'A>B': 6, 'B>A': 4, tie: 0 }),
    });
    expect(lines[1]).toContain("floor 0.5714 ('B>A': 4/7)");
    expect(lines[1]).not.toContain('A>B');
    expect(lines[1]).not.toContain('0.6000');
  });

  it('zero coverage prints the coverage line and says UNDEFINED — never a selective number', () => {
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 3,
        committedCount: 0,
        abstainedCount: 3,
        committedCorrectCount: 0,
        coverage: 0,
        selectiveAccuracy: null,
        selectiveBaseline: null,
        selectiveMarginOverConstant: null,
        constantBaseline: constantVerdictBaseline({ 'A>B': 3, 'B>A': 0, tie: 0 }),
      })
    ).toEqual([
      "  coverage   0.0000   (0/3 scored items the judge COMMITTED on; 3 abstained with 'tie')",
      '  ⚠ the judge committed on NOTHING (0/3) — selective accuracy is UNDEFINED, not 0 and not 1.',
    ]);
  });

  it('nothing scored → no lines at all, rather than a line reading n/a', () => {
    // Same contract as formatConstantBaselineLines: a line reading n/a suggests
    // a number exists and could not be rendered.
    expect(
      formatSelectiveAccuracyLines({
        verdictCount: 0,
        committedCount: 0,
        abstainedCount: 0,
        committedCorrectCount: 0,
        coverage: null,
        selectiveAccuracy: null,
        selectiveBaseline: null,
        selectiveMarginOverConstant: null,
        constantBaseline: null,
      })
    ).toEqual([]);
  });

  it('a key that CONTAINS ties says so — on such a set these two lines do not measure abstention', () => {
    // The whole framing "a tie is an abstention" is a property of a FORCED-
    // CHOICE key. GoldenSet cmt057h5d00097y01ymubpre5 is 336/284/0 and
    // cmt057hd001g17y01lhjzgfuj is 17/13/0, so this branch is unreachable on
    // today's corpus — and it is reachable through the API, which is precisely
    // when a reader would be most likely to quote the number wrongly.
    const lines = formatSelectiveAccuracyLines({
      verdictCount: 30,
      committedCount: 27,
      abstainedCount: 3,
      committedCorrectCount: 20,
      coverage: 0.9,
      selectiveAccuracy: 20 / 27,
      selectiveBaseline: constantVerdictBaseline({ 'A>B': 14, 'B>A': 10, tie: 3 }),
      selectiveMarginOverConstant: 20 / 27 - 14 / 27,
      constantBaseline: constantVerdictBaseline({ 'A>B': 17, 'B>A': 10, tie: 3 }),
    });
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "  ⓘ this answer key CONTAINS ties (3 of 30 scored items), so a 'tie' verdict is a real ANSWER here, " +
        'not an abstention — the two lines above do not measure abstention on this set.'
    );
  });
});

describe('calibration/baseline: the CLI actually prints the coverage block', () => {
  //   what it catches  — the block being deleted, renamed, computed and never
  //                      printed, or called with the wrong argument
  //   what it does NOT — where in the report the block appears, and anything
  //                      at all about whether the script RUNS
  const RUN_TS = readFileSync(new URL('../../scripts/calibration/run.ts', import.meta.url), 'utf8');

  it('imports formatSelectiveAccuracyLines and prints every line it returns', () => {
    // A bare substring count cannot tell `formatSelectiveAccuracyLines` from a
    // renamed `formatSelectiveAccuracyLinesV2` (failure mode 3), so the `(` is
    // part of the pattern.
    // NOT `toContain("from '@/lib/calibration/baseline'")` — that substring is
    // already in run.ts:60 at 2e7e142, so it is green before, during and after
    // this edit and guards nothing. Pin the SYMBOL into the import instead: this
    // regex is FALSE before Edit 8a and true after.
    expect(RUN_TS).toMatch(
      /import \{ formatConstantBaselineLines, formatSelectiveAccuracyLines \} from '@\/lib\/calibration\/baseline';/
    );
    expect(RUN_TS.match(/formatSelectiveAccuracyLines\(/g)).toHaveLength(1);
    expect(RUN_TS).toMatch(
      /for \(const line of formatSelectiveAccuracyLines\(score\)\) console\.log\(line\);/
    );
    // And the scoring-version line, which is the other half of this commit.
    expect(RUN_TS).toContain("from '@/lib/calibration/scoring-version'");
    expect(RUN_TS).toContain('describeScoringVersion(SCORING_RULES_VERSION)');
  });
});
```

**Two imports have to be added at the top of that file.** Read the current first lines and extend them.

old_string:
```
import { describe, expect, it } from 'vitest';
```
new_string:
```
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
```

and extend the module import. The current line is one line at `tests/lib/calibration-baseline.test.ts:2`, quoted here verbatim from `2e7e142` like every other `old_string` in this plan.

old_string:
```
import { constantVerdictBaseline, formatConstantBaselineLines } from '@/lib/calibration/baseline';
```
new_string:
```
import {
  constantVerdictBaseline,
  formatConstantBaselineLines,
  formatSelectiveAccuracyLines,
} from '@/lib/calibration/baseline';
```

- [ ] **Step 4: Run both test files and confirm they fail for the reason expected**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts
```

**Expected FAIL, and the two files fail differently — which is itself the check:**
- `tests/lib/calibration-baseline.test.ts` fails at **import time**: `SyntaxError: The requested module '/src/lib/calibration/baseline.ts' does not provide an export named 'formatSelectiveAccuracyLines'`. Every test in the file is reported failed, including the 15 pre-existing ones. **That is expected and is not a regression** — an ESM named-import failure takes the whole module down.
- `tests/lib/calibration-score.test.ts` compiles (the new fields are read off an object, not imported) and fails on **assertions**: `expect(score.coverage).toBe(1)` → `expected undefined to be 1`, and seven more in the same shape.

If `calibration-score.test.ts` fails at import time too, `SCORING_RULES_VERSION` was not added to its import list — fix that before continuing, because an import-time failure hides which assertions are actually unproven.

- [ ] **Step 5: Minimal implementation — `src/lib/calibration/score.ts` (six edits)**

**Edit 5a — the import.**

old_string:
```
} from '@/lib/calibration/readings';
import { prisma } from '@/lib/db';
```
new_string:
```
} from '@/lib/calibration/readings';
import { SCORING_RULES_VERSION } from '@/lib/calibration/scoring-version';
import { prisma } from '@/lib/db';
```

**Edit 5b — the result type.**

old_string:
```
  /** accuracy − constantBaseline.accuracy. Negative means the judge did worse
   *  than stamping. `null` when either side is. */
  marginOverConstant: number | null;
};
```
new_string:
```
  /** accuracy − constantBaseline.accuracy. Negative means the judge did worse
   *  than stamping. `null` when either side is. */
  marginOverConstant: number | null;
  /** Items the judge COMMITTED on — a raw verdict other than 'tie'. The
   *  denominator of `selectiveAccuracy`. */
  committedCount: number;
  /** Items the judge ABSTAINED on — raw verdict 'tie'. Equal to
   *  `verdictCount − committedCount` by construction; carried separately so the
   *  two being unequal is visible rather than assumed away, the same rule
   *  `itemCount` follows. */
  abstainedCount: number;
  /** Correct answers among the COMMITTED ones. EQUAL to `correctCount` on a
   *  forced-choice key and strictly smaller on a key that contains ties, where a
   *  'tie' verdict can itself be a hit. Reusing `correctCount` as the selective
   *  numerator over this denominator yields a "selective accuracy" above 1. */
  committedCorrectCount: number;
  /** committedCount / verdictCount — how often the judge COMMITTED, **CONDITIONAL
   *  ON HAVING ANSWERED AT ALL**. Not "how often it answered": a 'tie' IS an
   *  answer, and both operands here count only completed non-null verdicts, so an
   *  item that errored, dead-lettered or truncated is in NEITHER of them. A judge
   *  that fails outright therefore reads as HIGHER-coverage than one that ties —
   *  lfm2.5:8b's 500 ties give 0.1708, and the same 500 as truncations would give
   *  1.0000 over a verdictCount of 103. Always read this beside `missingVerdicts`.
   *  `null` — never 0 — when nothing was scored. Coverage 0 with a non-zero
   *  verdictCount IS a measurement: the judge replied and committed to none of
   *  them. And it is monotonically improvable by abstaining on your own errors,
   *  so `selectiveAccuracy` is never a ranking key without a coverage guard
   *  (Task 1 Step 1's scoreboard query). */
  coverage: number | null;
  /** committedCorrectCount / committedCount — how often the judge was RIGHT
   *  WHEN IT ANSWERED. `null` — never 0, never 1, never NaN — at zero coverage,
   *  because "it was never right when it answered" is a claim about answers
   *  that do not exist. `rawAgreement` is `coverage × selectiveAccuracy` and
   *  multiplying the two is exactly what hides a stamper: lfm2.5:8b and
   *  lfm2.5-thinking differ 5.3x on rawAgreement (0.0929 / 0.4887) and are
   *  indistinguishable here (0.5437 / 0.5363). */
  selectiveAccuracy: number | null;
  /** The constant floor over the COMMITTED subset — max(committed key
   *  class)/committedCount. NOT `constantBaseline`, which is over every scored
   *  item: comparing selective accuracy against THAT is the error v2l exists to
   *  prevent, one level down, and on production data it flips the margin's sign
   *  for two of four judges. The two can even name different top classes. */
  selectiveBaseline: ConstantBaseline | null;
  /** selectiveAccuracy − selectiveBaseline.accuracy. `null` when either is. */
  selectiveMarginOverConstant: number | null;
};
```

**Edit 5c — the accumulators.**

old_string:
```
  const keyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };

  const disagreements: CalibrationDisagreement[] = [];
  let correctCount = 0;
  let verdictCount = 0;
```
new_string:
```
  const keyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };
  // The SAME marginal, restricted to the items the judge COMMITTED on. It is
  // the selective floor's denominator, and it is not derivable from `keyCounts`
  // — the abstentions do not fall evenly across the key. On production data the
  // two floors can name DIFFERENT top classes, and quoting the wrong one is a
  // wrong number under a wrong label on the line a reader uses to decide
  // whether a judge beat a stamp.
  const committedKeyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };

  const disagreements: CalibrationDisagreement[] = [];
  let correctCount = 0;
  // Correct answers among the COMMITTED ones only. A 'tie' verdict against a
  // tie-KEYED item is a hit (score.ts's header, and constantVerdictBaseline
  // treats 'tie' as a class for the same reason), so `correctCount` can contain
  // hits that `committedCount` excluded — and 3/2 is a selective accuracy of
  // 1.5. Separate accumulator, past the same gate.
  let committedCorrectCount = 0;
  let verdictCount = 0;
```

**Edit 5d — the row loop.**

old_string:
```
    const actual = preferenceFromVerdict(row.verdict as Verdict, row.pairOrder as PairOrder);
    const expected = row.expected as Preference;
    keyCounts[expected] += 1;
    confusion[expected][actual] += 1;

    if (actual === expected) {
      correctCount += 1;
      return;
    }
```
new_string:
```
    const actual = preferenceFromVerdict(row.verdict as Verdict, row.pairOrder as PairOrder);
    const expected = row.expected as Preference;
    keyCounts[expected] += 1;
    confusion[expected][actual] += 1;
    // ABSTENTION IS THE RAW VERDICT 'tie', NOT THE DERIVED PREFERENCE. The two
    // agree here — `preferenceFromVerdict` maps 'tie' to 'tie' and maps nothing
    // else to it — but the raw letter is what the judge SAID, and this split
    // has to keep meaning the same thing under phase 2's BA sweep, which swaps
    // 'A'/'B' and leaves 'tie' alone.
    if (row.verdict !== 'tie') committedKeyCounts[expected] += 1;

    if (actual === expected) {
      correctCount += 1;
      if (row.verdict !== 'tie') committedCorrectCount += 1;
      return;
    }
```

**Edit 5e — the computed block.**

old_string:
```
  const accuracy = verdictCount === 0 ? null : correctCount / verdictCount;
  const result = agreement(projection.readings);
  // Null exactly when `accuracy` is: both share the denominator.
  const constantBaseline = constantVerdictBaseline(keyCounts);
  const marginOverConstant =
    accuracy !== null && constantBaseline !== null ? accuracy - constantBaseline.accuracy : null;
```
new_string:
```
  const accuracy = verdictCount === 0 ? null : correctCount / verdictCount;
  const result = agreement(projection.readings);
  // Null exactly when `accuracy` is: both share the denominator.
  const constantBaseline = constantVerdictBaseline(keyCounts);
  const marginOverConstant =
    accuracy !== null && constantBaseline !== null ? accuracy - constantBaseline.accuracy : null;

  // ── Coverage and selective accuracy ──────────────────────────────────────
  // The SAME pure function, over a DIFFERENT denominator. `denominator` is read
  // back off the baseline rather than accumulated a third time: it is the sum
  // of `committedKeyCounts` by construction, and a second counter that could
  // disagree with the floor's own denominator is two numbers for one thing.
  const selectiveBaseline = constantVerdictBaseline(committedKeyCounts);
  const committedCount = selectiveBaseline === null ? 0 : selectiveBaseline.denominator;
  const abstainedCount = verdictCount - committedCount;
  const coverage = verdictCount === 0 ? null : committedCount / verdictCount;
  // NULL, not 0 and not NaN. `0/0` is NaN and would flow into JSON and into the
  // column as null anyway — but by accident, and `committedCorrectCount / 0`
  // with a non-zero numerator is Infinity. Neither is a measurement.
  const selectiveAccuracy = committedCount === 0 ? null : committedCorrectCount / committedCount;
  const selectiveMarginOverConstant =
    selectiveAccuracy !== null && selectiveBaseline !== null
      ? selectiveAccuracy - selectiveBaseline.accuracy
      : null;
```

**Edit 5f — the result object and the row update.**

old_string:
```
    constantBaseline,
    marginOverConstant,
    method: {
```
new_string:
```
    constantBaseline,
    marginOverConstant,
    committedCount,
    abstainedCount,
    committedCorrectCount,
    coverage,
    selectiveAccuracy,
    selectiveBaseline,
    selectiveMarginOverConstant,
    method: {
```

old_string:
```
      constantBaselineAccuracy: constantBaseline === null ? null : constantBaseline.accuracy,
```
new_string:
```
      constantBaselineAccuracy: constantBaseline === null ? null : constantBaseline.accuracy,
      // v2n. `coverage` is deliberately NOT written: it is committedCount /
      // verdictCount and both operands are on this row, so a stored copy is a
      // derived duplicate that a partial re-score would leave stale.
      committedCount,
      selectiveAccuracy,
      selectiveBaselineAccuracy: selectiveBaseline === null ? null : selectiveBaseline.accuracy,
      // v2m. Scoring is ex post and re-runnable, so the numbers above are
      // uninterpretable without the generation that produced them. Written from
      // the CONSTANT, never a literal, in the same full overwrite: the stamp and
      // the numbers cannot move independently.
      scoringVersion: SCORING_RULES_VERSION,
```

- [ ] **Step 6: Minimal implementation — `src/lib/calibration/baseline.ts` (the formatter)**

Append after `formatConstantBaselineLines`. Edit `/root/judge-arena/src/lib/calibration/baseline.ts`.

old_string:
```
  if (score.accuracy <= floor.accuracy) {
    lines.push(
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.'
    );
  }
  return lines;
}
```
new_string:
```
  if (score.accuracy <= floor.accuracy) {
    lines.push(
      '  ⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.'
    );
  }
  return lines;
}

/**
 * The COVERAGE block: how often the judge answered, how often it was right when
 * it did, and the floor that second number has to clear.
 *
 * WHY THESE TWO NUMBERS AND NOT ONE. The golden key is FORCED CHOICE — 620
 * items, 336 'A>B' / 284 'B>A', no ties — so a 'tie' verdict can never be
 * correct and `rawAgreement` is the PRODUCT of two independent quantities:
 * coverage, and accuracy given coverage. Measured 2026-09-06 on that set,
 * lfm2.5:8b and lfm2.5-thinking:1.2b differ 5.3x on rawAgreement (0.0929 vs
 * 0.4887) — which reads as "broken vs mediocre" — and are statistically
 * indistinguishable on selective accuracy (0.5437 vs 0.5363). Same
 * discriminative ability; they differ only in how they express uncertainty.
 *
 * THE FLOOR HERE IS THE ONE OVER THE COMMITTED SUBSET, AND THAT IS THE WHOLE
 * POINT. `formatConstantBaselineLines` above prints the floor over every SCORED
 * item; this one prints the floor over the items the judge COMMITTED to.
 * Quoting the first beside selective accuracy is precisely the error v2l exists
 * to prevent, one level down, and on production data it FLIPS THE SIGN of the
 * margin for two of four judges (lfm2.5-thinking: +0.0071 over its committed
 * floor of 0.5292, −0.0056 against the full subset's 0.5419). The two can even
 * name different top classes, which is what the unit test pins.
 *
 * NULL-NOT-ZERO, and the two nulls mean different things. `coverage` is null
 * only when nothing was scored; coverage 0.0000 over a non-zero denominator IS
 * a measurement — the judge replied and committed to none of them.
 * `selectiveAccuracy` is null whenever coverage is 0, and the line says
 * UNDEFINED rather than printing 0.0000, which would read as "never right".
 *
 * A TIE-CONTAINING KEY GETS A CAVEAT RATHER THAN A SUPPRESSION. "A tie is an
 * abstention" is a property of a forced-choice key. Both live golden sets are
 * tie-free, but PATCH /api/golden-sets/[id]/items writes `expected` with no
 * vocabulary check on an unfrozen set, so the shape is reachable — and when it
 * is, these two lines are still arithmetically correct and no longer mean what
 * their labels say. The `ⓘ` says so on the same screen rather than leaving the
 * reader to work it out.
 *
 * The parameter is a structural literal rather than `Pick<CalibrationScore, …>`
 * for the same reason `formatConstantBaselineLines`'s is: score.ts imports THIS
 * module, and a type import back would close an import cycle. A whole
 * `CalibrationScore` satisfies it, which is how run.ts calls it. TypeScript
 * therefore narrows each field independently, which is why the guard below
 * names all three of the selective fields even though score.ts makes them null
 * together. The same structural requirement produces one arm that NO caller can
 * take: `coverage` is null only when `verdictCount` is 0, which the first guard
 * has already returned on, so the `'n/a'` in the coverage line is unreachable
 * from `score.ts` and exists purely to narrow `number | null` to `number`. That
 * is exactly the shape `formatConstantBaselineLines` documents above about its
 * `||` chain, and it carries the same instruction: **do not claim "100%
 * branches" for this file; read the printed coverage row** (Task 3 Step 15).
 */
export function formatSelectiveAccuracyLines(score: {
  verdictCount: number;
  committedCount: number;
  abstainedCount: number;
  committedCorrectCount: number;
  coverage: number | null;
  selectiveAccuracy: number | null;
  selectiveBaseline: ConstantBaseline | null;
  selectiveMarginOverConstant: number | null;
  constantBaseline: ConstantBaseline | null;
}): string[] {
  // Nothing scored: no lines at all. A line reading `n/a` would suggest a
  // number exists and could not be rendered — the same contract as above.
  if (score.verdictCount === 0) return [];

  const lines = [
    `  coverage   ${score.coverage === null ? 'n/a' : fmt4(score.coverage)}   ` +
      `(${score.committedCount}/${score.verdictCount} scored items the judge COMMITTED on; ` +
      `${score.abstainedCount} abstained with 'tie')`,
  ];

  if (
    score.selectiveAccuracy === null ||
    score.selectiveBaseline === null ||
    score.selectiveMarginOverConstant === null
  ) {
    lines.push(
      `  ⚠ the judge committed on NOTHING (0/${score.verdictCount}) — selective accuracy is UNDEFINED, not 0 and not 1.`
    );
  } else {
    const floor = score.selectiveBaseline;
    // `preferences` lists EVERY top class when the committed key ties; the count
    // printed is the first one's, and they are equal by construction, so the
    // pair stays honest under either label — same as above.
    const stamped = floor.keyCounts[floor.preferences[0]];
    const sign = score.selectiveMarginOverConstant >= 0 ? '+' : '';
    lines.push(
      `  selective  ${fmt4(score.selectiveAccuracy)}   ` +
        `(${score.committedCorrectCount}/${score.committedCount} right where it COMMITTED)   ` +
        `floor ${fmt4(floor.accuracy)} ('${floor.preferences.join('/')}': ${stamped}/${floor.denominator})   ` +
        `margin ${sign}${fmt4(score.selectiveMarginOverConstant)}`
    );
    // `<=`, not `<`: the judge this warning exists for is the one that lands ON
    // the floor by stamping whenever it does commit.
    if (score.selectiveAccuracy <= floor.accuracy) {
      lines.push(
        '  ⚠ selective accuracy is at or below the floor OVER THE COMMITTED SUBSET — where it answers, the judge is not distinguishable from a stamp.'
      );
    }
  }

  if (score.constantBaseline !== null && score.constantBaseline.keyCounts.tie > 0) {
    lines.push(
      `  ⓘ this answer key CONTAINS ties (${score.constantBaseline.keyCounts.tie} of ${score.constantBaseline.denominator} scored items), ` +
        "so a 'tie' verdict is a real ANSWER here, " +
        'not an abstention — the two lines above do not measure abstention on this set.'
    );
  }
  return lines;
}
```

- [ ] **Step 7: Bump the scoring generation — `src/lib/calibration/scoring-version.ts`**

The rules just changed, so the stamp changes in the same commit. Two edits.

old_string:
```
export const SCORING_RULES_VERSION = 1;
```
new_string:
```
export const SCORING_RULES_VERSION = 2;
```

old_string:
```
      'Cohen kappa over the three preference categories; constantBaselineAccuracy = ' +
      'max(key class)/verdictCount over the SCORED subset',
  },
];
```
new_string:
```
      'Cohen kappa over the three preference categories; constantBaselineAccuracy = ' +
      'max(key class)/verdictCount over the SCORED subset',
  },
  {
    version: 2,
    migration: 'v2n',
    rules:
      'generation 1 UNCHANGED (rawAgreement and kappa keep their exact meaning), plus ' +
      "committedCount = items whose raw verdict is not 'tie'; selectiveAccuracy = " +
      'correct-among-committed / committedCount, NULL at zero coverage; and ' +
      'selectiveBaselineAccuracy = max(committed key class)/committedCount, which is ' +
      'a DIFFERENT floor from constantBaselineAccuracy and can name a different class; ' +
      'and noVerdictRate = missingVerdicts/dispatchedItemCount, a FLEET property ' +
      '(truncation or dead request) that is NOT abstention and is not stored',
  },
];
```

> **AMENDMENT 2026-09-06:** the trailing clause about `noVerdictRate` is part of the
> generation-2 entry because Steps 15a–15e land in the SAME commit. A generation whose
> changelog under-describes its own rules is precisely the defect this stamp exists to
> prevent — if the amendment is dropped, drop this clause with it, and if it lands, this
> clause is not optional.

- [ ] **Step 8: Wire the report — two edits to `scripts/calibration/run.ts`**

**Edit 8a — the imports.** `formatConstantBaselineLines` is already imported from `baseline`; extend that line and add the scoring-version import beside it.

old_string:
```
import { formatConstantBaselineLines } from '@/lib/calibration/baseline';
import { scoreCalibrationRun } from '@/lib/calibration/score';
```
new_string:
```
import { formatConstantBaselineLines, formatSelectiveAccuracyLines } from '@/lib/calibration/baseline';
import { scoreCalibrationRun } from '@/lib/calibration/score';
import { SCORING_RULES_VERSION, describeScoringVersion } from '@/lib/calibration/scoring-version';
```

**Edit 8b — the printed block.**

old_string:
```
  for (const line of formatConstantBaselineLines(score)) console.log(line);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
  console.log(`  itemCount ${score.itemCount}   missingVerdicts ${score.missingVerdicts}`);
```
new_string:
```
  for (const line of formatConstantBaselineLines(score)) console.log(line);
  // Coverage and selective accuracy, with the floor over the COMMITTED subset —
  // never the full one. On this corpus that choice flips the margin's SIGN for
  // two of four judges, which is the same class of error v2l exists to prevent.
  // The rendering, including the `<=` that decides the ⚠ and the CHOICE of
  // floor, is in src/lib/calibration/baseline.ts where the unit suite pins it.
  for (const line of formatSelectiveAccuracyLines(score)) console.log(line);
  console.log(`  kappa      ${fmt(score.kappa)}   method ${JSON.stringify(score.method)}`);
  console.log(`  itemCount ${score.itemCount}   missingVerdicts ${score.missingVerdicts}`);
  // WHICH RULES produced every number above. Scoring is ex post and re-runnable,
  // so a stored figure is uninterpretable without its generation — and this is
  // the generation the row was just stamped with, read from the constant rather
  // than written as a literal.
  console.log(`  scoring    ${describeScoringVersion(SCORING_RULES_VERSION)}`);
```

- [ ] **Step 9: Run both files to pass**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts
```

Expected: `Test Files  2 passed (2)`, `Tests  60 passed (60)` — **30** pre-existing in `calibration-score` plus 8 new, **15** pre-existing in `calibration-baseline` plus 7 new. Both pre-existing counts are measured on `2e7e142` (`grep -c '  it(' tests/lib/calibration-score.test.ts` → 30, `… calibration-baseline.test.ts` → 15), not estimated. **Use the printed number**; if it is not 60, count the `it(` blocks in both files before assuming anything.

- [ ] **Step 10: INJECTION C — the floor's denominator**

The single most important injection in this plan. Edit `/root/judge-arena/src/lib/calibration/score.ts`.

old_string:
```
  const selectiveBaseline = constantVerdictBaseline(committedKeyCounts);
```
new_string:
```
  const selectiveBaseline = constantVerdictBaseline(keyCounts);
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts
```

**Expected RED, SIX tests — and the reason it is six and not one is worth reading before you run it.** `committedCount` is read back off `selectiveBaseline.denominator` (Edit 5e), so this one-token swap moves the COUNT, the COVERAGE, the SELECTIVE ACCURACY *and* the floor together, and vitest reports each test at its FIRST failing assertion. In file order, the messages you will actually see:

- `three ties: ACCURACY stays 0.9000 and selective accuracy is 1.0` → `expected 1 to be close to 0.9` (the `coverage` assertion)
- `the selective floor is over the COMMITTED subset — and here it names a DIFFERENT class` → `expected 1 to be close to 0.7` (the `coverage` assertion, not the floor)
- `a CORRECT tie against a tie KEY is not a commitment` → `expected 4 to be 2` (`committedCount`)
- `a judge that committed to NOTHING reports selectiveAccuracy null` → `expected 3 to be +0` (`committedCount`)
- `the row carries committedCount, selectiveAccuracy, its floor AND the scoring version` → `expected 10 to be 7`
- `re-scoring is idempotent on the new fields too` → `expected 3 to be 2`

**Do not read "the floor assertion did not fire" as "the injection did not land."** CONTRIBUTING.md:230-234 is the reason this is spelled out: a failure message that does not describe the defect is not evidence, and here the count coupling fires first. To see the LABEL evidence this fixture exists for in isolation, comment out the `coverage`/`committedCount`/`committedCorrectCount` assertions in the S3 test only, re-run, and confirm you get `expected { accuracy: 0.6, preferences: [ 'A>B' ], … } to deeply equal { accuracy: 0.5714285714285714, preferences: [ 'B>A' ], … }` — then put them back.

**Why this injection matters more than its failure count suggests:** the injected code is *plausible* — `keyCounts` is right there, it is the variable the line above uses, and the resulting number is in range, monotone and never absurd. Nothing downstream can detect it. What catches it here is the count coupling; what catches the *narrower* wrong implementation — a floor computed over `committedCount` but keyed off `keyCounts` — is S3's `preferences: ['B>A']` assertion, and **no injection in this plan reddens that one specifically.** Stated rather than implied. **Restore `committedKeyCounts` and re-run to green.**

- [ ] **Step 11: INJECTION D — the selective numerator**

Edit `/root/judge-arena/src/lib/calibration/score.ts`.

old_string:
```
  const selectiveAccuracy = committedCount === 0 ? null : committedCorrectCount / committedCount;
```
new_string:
```
  const selectiveAccuracy = committedCount === 0 ? null : correctCount / committedCount;
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts
```

**Expected RED, exactly one test:**
- `a CORRECT tie against a tie KEY is not a commitment — selective accuracy cannot exceed 1` → `expected 1.5 to be 0.5`

**That only one test reddens is the finding, not the reassurance.** On a forced-choice key `correctCount === committedCorrectCount` identically, so seven of the eight new tests cannot see this at all — and every live golden set is forced choice. The tie-KEY fixture is the only guard, and it is guarding a shape the API can still produce. **Restore and re-run to green.**

- [ ] **Step 12: INJECTION E — null-not-zero at zero coverage**

Edit `/root/judge-arena/src/lib/calibration/score.ts`.

old_string:
```
  const selectiveAccuracy = committedCount === 0 ? null : committedCorrectCount / committedCount;
```
new_string:
```
  const selectiveAccuracy = committedCount === 0 ? 0 : committedCorrectCount / committedCount;
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts
```

**Expected RED, exactly two tests:**
- `a judge that committed to NOTHING reports selectiveAccuracy null — not 0, not 1, not NaN` → `expected +0 to be null`
- `nothing scored at all: coverage is null too, and the counts are 0` → `expected +0 to be null`

`0` is the specific wrong value this discriminates against, and it is the tempting one: it keeps the column a `Float`, sorts, and averages. It also says "this judge was never right when it answered" about a judge that never answered — a fabricated measurement, and the exact failure the `NULLS LAST` / `COALESCE` trap in Task 1 Step 1 turns into a leaderboard. **Restore and re-run to green.**

- [ ] **Step 13: INJECTION F — `rawAgreement` MUST NOT CHANGE**

The pin the brief asks for, as an injection rather than only an assertion. Edit `/root/judge-arena/src/lib/calibration/score.ts`.

old_string:
```
      rawAgreement: accuracy,
```
new_string:
```
      rawAgreement: selectiveAccuracy,
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-score.test.ts
```

**Expected RED, EXACTLY TWO tests:**
- `three ties: ACCURACY stays 0.9000 and selective accuracy is 1.0` → `expected 1 to be 0.9`
- `the row carries committedCount, selectiveAccuracy, its floor AND the scoring version` → `expected 0.7142857142857143 to be 0.5`

**Both are new in this task, and that is the finding, not a reassurance.** Every pre-existing assertion on `rawAgreement` — `:545` (inside the test at `:534`), `:560` (inside `:551`) and `:594` — runs on a `withFlips(3)` fixture, and `withFlips` (`tests/lib/calibration-score.test.ts:141-155`) only swaps `'A>B'`↔`'B>A'`; **it never emits a `'tie'`.** On such a fixture `committedCount === verdictCount` and `selectiveAccuracy === accuracy` *identically*, so none of those three can see this substitution at all, and `:296`'s empty run has both sides null. The only fixtures that can see it are the two that abstain — which is why Step 2's `three ties` test captures the client and asserts the row, rather than leaving the whole-history contract resting on one new assertion.

This is the whole-history guard: every published number and every document quoting one is `correct/verdictCount`, and "selective accuracy is the better metric so let us store it in the column that already exists" is a one-line change that reads like an improvement and silently rewrites nine months of results. **Restore and re-run to green.**

- [ ] **Step 14: INJECTION G — the CLI actually prints the block**

Edit `/root/judge-arena/scripts/calibration/run.ts`.

old_string:
```
  for (const line of formatSelectiveAccuracyLines(score)) console.log(line);
```
new_string:
```
  formatSelectiveAccuracyLines(score);
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-baseline.test.ts
```

**Expected RED, exactly one test:**
- `imports formatSelectiveAccuracyLines and prints every line it returns` → `expected 'import { prisma } …' to match /for \(const line of formatSelectiveAccuracyLines\(score\)\) console\.log\(line\);/`

Computed-and-discarded is the wrong implementation a `toContain('formatSelectiveAccuracyLines')` cannot see, and `scripts/**` is outside every coverage include so nothing else guards it. **What this does NOT catch, stated rather than implied:** anything about where in the report the block appears, and anything at all about whether the script runs — nothing here executes `run.ts` (Post-landing checklist item 2). **Restore and re-run to green.**

- [ ] **Step 15: Gates**

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -30
```

Expected: lint 0; tsc silent; **`B + 22` tests over `F + 1` files** (Task 1's 7 + this task's 15) — on a 1007/61 baseline that is `Tests  1029 passed (1029)` over `Test Files  62 passed (62)`. **Arithmetic on Step 0's measurement, not a measurement.** If the delta is not exactly `+15` from Task 1's number, count the `it(` blocks you added (8 in `calibration-score.test.ts`, 7 in `calibration-baseline.test.ts`).

No floor is EXPECTED to move — `score.ts` and `baseline.ts` both gain covered lines — but that is a prediction, not a measurement, and the aggregate `branches` floor of 87 (`vitest.config.ts:190`) is the one that can fall: `formatSelectiveAccuracyLines` ships one arm no caller can take (the `coverage === null` render, unreachable past the `verdictCount === 0` return) and the `||` chain short-circuits on its one null fixture. **Read the printed `% Branch` row.** If it trips, **do not touch `vitest.config.ts`** — add a fixture for the uncovered branch instead.

`test:db:coverage`, `test:integration` and `build` are not re-run: Task 2 ran the full chain for the branch and this commit adds no schema, no DB-reaching code path and no Next surface. And **`scoreCalibrationRun` is NOT exercised by any `tests/db/**` file** — `tests/db/meta-eval.test.ts:277` says so in as many words ("No tests/db fixture drives scoreCalibrationRun against a real Postgres (the unit suite pins the write through the fake client's captured update data)"), and `grep -arn scoreCalibrationRun tests/db tests/integration` returns only that comment. Its only caller anywhere is `scripts/calibration/run.ts:287`. So this commit reaches no db-tested path at all — a stronger reason to skip the chain than "the behaviour is unchanged", and the reason the unit suite is where every new field is pinned.

> **AMENDMENT 2026-09-06 (operator-approved).** Steps 15a–15e below were added to this task
> AFTER the plan was approved, as the shippable half of the operator's `noAnswer` proposal.
> The other half — a deterministic TEXTUAL refusal classifier — was measured and **rejected**;
> see **M6** for the three grounds and the numbers. Nothing in Steps 0–15 changes. `noVerdictRate`
> is REPORTED and RETURNED but **NOT STORED**: Task 2 Step 1's rule is that a derived ratio whose
> operands are on the row is never stored, and `missingVerdicts` is already computed at
> `score.ts:315` and re-derivable from disk by counting `EvaluationRun` rows. No schema change,
> no v2o, and Task 2 is untouched.

- [ ] **Step 15a: Work the arithmetic for `noVerdictRate` BEFORE writing it**

`rawAgreement`'s denominator silently varies per judge — 619, 620, 603 on the same 620-item set (**M6 Result 6**) — because a truncated or dead request leaves an `EvaluationRun` with no completed judgment, and that item vanishes from every existing number. `missingVerdicts` already counts it (`score.ts:315`, both shapes: a null-verdict row AND a run with no completed judgment). What is missing is its **denominator** and therefore its **rate**.

**`dispatchedItemCount` is OBSERVED, never derived.** It is the count of `EvaluationRun` rows for this calibration run that carry a `goldenItem` — the items the judge was ASKED. Carry it as its own accumulator for the same reason `itemCount` is carried beside `verdictCount`: the identity `dispatchedItemCount === verdictCount + missingVerdicts` holds in phase 1 (one judgment per run) and **the point is that a future BA sweep breaking it is VISIBLE rather than assumed away**.

**`noVerdictRate` is a FLEET property, never a judge property.** Measured over the four completed runs on the 620 set (n = 2,480 item-rows): judge-behaviour refusals **0**, prose-not-JSON **0**, token-budget truncations **18**, infrastructure **0**. Every no-verdict row is a `finishReason='length'` truncation or a dead request. It must never be read as the judge declining — that is exactly the misattribution M6 rejects — so it is printed under its own label and NOT inside the coverage block.

| fixture | dispatched | verdictCount | missingVerdicts | `noVerdictRate` | why it is here |
|---|---|---|---|---|---|
| **N1** lfm2.5:8b (`cmtondblm…`) | 620 | 603 | 17 | `17/620 = 0.0274194` → **0.0274** | the production shape the amendment exists for |
| **N2** Qwen3.6 (`cmtozu76f…`) | 620 | 619 | 1 | `1/620 = 0.0016129` → **0.0016** | a healthy run is not zero |
| **N3** lfm2.5-thinking (`cmtp3jwrf…`) | 620 | 620 | 0 | `0/620 = 0` exactly → **0.0000** | **MUST be `0`, never `null`** — "nothing was lost" is a measurement |
| **N4** nothing dispatched | 0 | 0 | 0 | **`null`** | not `0`, not `NaN` from `0/0` — same rule `coverage` follows at Step 1's S5 |
| **N5** the DISCRIMINATOR | 10 | 2 | 8 | `8/10 = 0.8` | an implementation using `verdictCount` gives `8/2 = 4.0` — **above 1, and wrong by a factor of 5** |
| **N6** the void run (`cmton7ip5…`) | 620 | 16 | 604 | `604/620 = 0.9741935` → **0.9742** | an abandoned run reads as abandoned, not as a judge that answered 16 times |

**N5 is the fixture that earns its place.** S1/S2-style fixtures where the two denominators are close cannot tell `missingVerdicts / dispatchedItemCount` from `missingVerdicts / verdictCount`; N5 puts the wrong answer above 1.0, which no rate can be.

- [ ] **Step 15b: Write the failing tests**

Append to `tests/lib/calibration-score.test.ts` a `describe('noVerdictRate', …)` covering **N1–N6**, asserting `dispatchedItemCount` and `noVerdictRate` on the score returned by `scoreCalibrationRun` against the same fake client the file already uses. N4 asserts `toBeNull()`, N3 asserts `toBe(0)` — **`toBeNull()` and `toBe(0)` are the pair that pins the rule; a single `toBeFalsy()` passes on both and pins nothing.**

Append to `tests/lib/calibration-baseline.test.ts` a case per **N1, N3, N4** for the new formatter, asserting the rendered line, and one asserting the formatter returns **an empty array** when `noVerdictRate` is `null` — a NULL must not be rendered as `0.0000` or as `NaN` (the same contract Task 1's INJECTION B pins for the version stamp).

- [ ] **Step 15c: Minimal implementation**

**Edit 15c-i — `src/lib/calibration/score.ts`, the result type.** Two fields appended to `CalibrationScore`, immediately after `marginOverConstant`:

```ts
  /** `EvaluationRun` rows for this calibration run that carry a `goldenItem` —
   *  the items the judge was ASKED. OBSERVED, never derived. Equal to
   *  `verdictCount + missingVerdicts` in phase 1 (one judgment per run); carried
   *  separately so a future BA sweep breaking that identity is VISIBLE rather
   *  than assumed away, exactly as `itemCount` is carried beside `verdictCount`. */
  dispatchedItemCount: number;
  /** `missingVerdicts / dispatchedItemCount` — the share of asked items that
   *  produced no verdict at all. `null` — never 0, never NaN — when nothing was
   *  dispatched; `0` (not null) when everything answered, because "nothing was
   *  lost" is a measurement.
   *
   *  THIS IS A PROPERTY OF THE FLEET, NOT OF THE JUDGE, AND MUST NOT BE READ AS
   *  ABSTENTION. Measured 2026-09-06 over the four completed runs on the 620-item
   *  set (n = 2,480 item-rows): judge-behaviour refusals 0, prose-not-JSON 0,
   *  token-budget truncations 18, infrastructure 0. Every no-verdict row is a
   *  `finishReason='length'` truncation or a dead request. A judge that declines
   *  says `tie` — the enum has no other channel (M6 Result 1) — and that lands in
   *  `coverage`, not here. It exists because `rawAgreement`'s denominator
   *  otherwise varies silently per judge: 619, 620 and 603 on the SAME set, so
   *  lfm2.5:8b is scored over a strictly easier-to-reach subset than its peers
   *  with nothing on the scoreboard saying so (M6 Result 6). */
  noVerdictRate: number | null;
```

**Edit 15c-ii — the accumulator.** Beside `let unjudgedItems = 0;`:

```ts
  // Items the judge was ASKED — counted here, past the same `goldenItem === null`
  // gate as everything else, so a row that cannot be scored against anything is
  // not counted as having been asked either.
  let dispatchedItemCount = 0;
```
and `dispatchedItemCount += 1;` immediately AFTER the `if (run.goldenItem === null) continue;` guard and BEFORE the `modelJudgments.length === 0` branch — so an unjudged item counts as dispatched, which is the entire point.

**Edit 15c-iii — the computed block and the result.** After `marginOverConstant`:

```ts
  // Null at zero dispatched, 0 when everything answered. See the field's doc:
  // this is a fleet property and is not part of coverage.
  const noVerdictRate =
    dispatchedItemCount === 0 ? null : missingVerdicts / dispatchedItemCount;
```
`missingVerdicts` must be lifted to a `const` above the object literal (it is currently inlined at `score.ts:315` as `projection.missingVerdicts + unjudgedItems`) and **that same const used in both places** — computing it twice is how the two drift. Add `dispatchedItemCount` and `noVerdictRate` to the returned `score` object. **Nothing is added to the `client.calibrationRun.update` data block** — see the amendment note above.

**Edit 15c-iv — `src/lib/calibration/baseline.ts`, its OWN formatter.** A separate `formatNoVerdictRateLine`, NOT a line inside `formatSelectiveAccuracyLines`:

```ts
/** The no-verdict rate on its own line, under its own label, deliberately NOT
 *  inside the coverage block. Coverage is what the JUDGE did; this is what the
 *  FLEET did. Rendering them as one block is the exact conflation M6 rejects —
 *  a reader who sees them adjacent under one heading will read a truncation as
 *  an abstention. Returns [] when the rate is null: a NULL is not a 0.0000. */
export function formatNoVerdictRateLine(score: {
  noVerdictRate: number | null;
  missingVerdicts: number;
  dispatchedItemCount: number;
}): string[]
```
rendering, when non-null, one line in the file's existing style:
```
  no verdict 0.0274   17 of 620 asked items produced none — FLEET property (truncation/dead request), NOT abstention
```

**Edit 15c-v — `scripts/calibration/run.ts`.** Extend the `baseline` import with `formatNoVerdictRateLine`, and print it AFTER the `missingVerdicts` line and BEFORE the `scoring` line:

```ts
  for (const line of formatNoVerdictRateLine(score)) console.log(line);
```

- [ ] **Step 15d: Run both files to pass**

```bash
npx vitest run tests/lib/calibration-score.test.ts tests/lib/calibration-baseline.test.ts
```

- [ ] **Step 15e: INJECTION P — the denominator is DISPATCHED, not `verdictCount`**

In `score.ts`, change `missingVerdicts / dispatchedItemCount` to `missingVerdicts / verdictCount`.

**Expected RED: the N5 case, reporting `4` where `0.8` was expected** — a rate above 1. If N5 is the only case that reddens, that is correct and sufficient; N1/N2/N6 also move, and N3 does NOT (0/620 and 0/620 are both 0), which is why N3 alone could never have caught this. Restore, re-run, confirm green. **An injection that leaves the suite green is a FINDING, not a formality.**

- [ ] **Step 15f: RE-RUN THE GATES — Step 15 ran before this amendment existed**

Steps 15a–15e were appended AFTER Step 15's gate run, so that run did not see this code. Re-run the task's gate chain now, and **use THIS run's numbers in Step 16's `Gates:` line** — the earlier ones are stale.

```bash
npm run lint && npx tsc --noEmit && npm run test:coverage
```
Expected: lint 0, tsc 0, and a unit count **above** Step 15's by the number of cases added in Step 15b. `test:db` / `test:integration` are NOT run (Task 2 ran the full chain for the branch; no `tests/db` or `tests/integration` file is touched here). **If `test:coverage` prints a threshold failure, do NOT edit `vitest.config.ts`** — add a fixture for the uncovered branch. Every branch Step 15c introduces has a fixture in Step 15a by construction (`dispatchedItemCount === 0` both ways via N4/N1; the formatter's null arm via N4), so a branch failure here means a fixture did not land, not that a floor is wrong.

- [ ] **Step 16: Commit**

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/score.ts \
  src/lib/calibration/baseline.ts \
  src/lib/calibration/scoring-version.ts \
  scripts/calibration/run.ts \
  tests/lib/calibration-score.test.ts \
  tests/lib/calibration-baseline.test.ts
git -C /root/judge-arena status --short
```
Expected: exactly those six paths, each prefixed `M `. Then:

```bash
git -C /root/judge-arena commit --only \
  src/lib/calibration/score.ts \
  src/lib/calibration/baseline.ts \
  src/lib/calibration/scoring-version.ts \
  scripts/calibration/run.ts \
  tests/lib/calibration-score.test.ts \
  tests/lib/calibration-baseline.test.ts \
  -F - <<'EOF'
feat(calibration): coverage and selective accuracy, with the floor over the COMMITTED subset

The golden key is forced choice — 620 items, 336 A>B / 284 B>A, zero ties — so a
tie can never be correct and rawAgreement is the PRODUCT of two independent
quantities: how often the judge commits, and how often it is right when it does.
Measured 2026-09-06 on that set, lfm2.5:8b and lfm2.5-thinking:1.2b differ 5.3x
on rawAgreement (0.0929 vs 0.4887), which reads as broken vs mediocre, and are
statistically indistinguishable on selective accuracy (0.5437 vs 0.5363). Same
discriminative ability; they differ only in how they express uncertainty.

scoreCalibrationRun now accumulates the key marginal a second time, restricted to
the items the judge COMMITTED on, and feeds constantVerdictBaseline that
denominator. The floor moves with the denominator — v2l's argument, one level
down — and quoting the full-subset floor beside selective accuracy flips the
margin's SIGN for two of four production judges: lfm2.5-thinking is +0.0071 over
its committed floor of 0.5292 and -0.0056 against the full 0.5419. The two floors
can even name different top classes, which is what the S3 fixture pins and what
the injection that swaps the argument reddens on the LABEL, not a decimal.

committedCorrectCount is a separate accumulator, not correctCount reused. A tie
verdict against a tie KEY is a hit (score.ts has said so since A2.1, and the API
can still write such a key), so reusing correctCount over a denominator that
excluded those hits produces a selective accuracy of 1.5.

NULL at zero coverage: not 0, not 1, not NaN. Coverage 0.0000 over a non-zero
denominator is a measurement — the judge replied and committed to none of them —
and "never right when it answered" is not a fact about a judge that never
answered. Production row cmton7ip500012lyjubiqohy8 committed on one of sixteen.

rawAgreement and kappa are unchanged, pinned by a test whose injection swaps
selectiveAccuracy into the rawAgreement write and reddens two assertions.

Amended before landing: noVerdictRate ships in this commit too. rawAgreement's
denominator silently varies per judge — 619, 620 and 603 on the SAME 620-item set
— because a truncated or dead request leaves an EvaluationRun with no completed
judgment and that item vanishes from every existing number, so lfm2.5:8b is scored
over a strictly easier-to-reach subset than its peers. missingVerdicts already
counted those rows; this adds the observed denominator (dispatchedItemCount) and
the rate, under their own label and their own formatter. It is a FLEET property:
measured over the four completed runs, judge-behaviour refusals 0, prose-not-JSON
0, token-budget truncations 18. A judge that declines says tie, which the enum
forces and which lands in coverage. Not stored — a derived ratio whose operands
are on the row never is.

The scoring generation moves 1 -> 2 in this commit rather than a later one: the
bump IS the rule change's identity, and landing it separately would leave a
window where the rules had changed and the stamp had not.

Gates: lint 0, tsc 0, <B+22> unit / n-a db (no tests/db file touched; Task 2 ran the full chain for the branch) / n-a integration (no tests/integration file), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **6 files changed**.

---

### Task 4: the forced-choice projections — report STRATEGIES, never one invented number

**Files:**
- Create: `/root/judge-arena/src/lib/calibration/forced-choice.ts`
- Create (Test): `/root/judge-arena/tests/lib/calibration-forced-choice.test.ts`
- Modify: `/root/judge-arena/src/lib/calibration/score.ts` — import, one accumulator, one loop line, the computed block, the type, the result object
- Modify: `/root/judge-arena/scripts/calibration/run.ts` — one import line, one printed block after the confusion matrix

**Interfaces:**
- Consumes: `PREFERENCES` / `Preference` from `@/lib/calibration/readings` (type-and-constant only — `readings.ts`'s own sole import is type-only, so this stays a leaf for the esbuild bundle).
- Produces:
  - `export type ForcedChoiceStamp = { preference: Preference; hitsOnAbstained: number; accuracy: number };`
  - `export type ForcedChoiceBounds = { verdictCount: number; committedCount: number; abstainedCount: number; keyTieCount: number; allAbstentionsWrong: number; allAbstentionsRight: number; unbiasedCoinTiebreak: number | null; pluralityStampTiebreaks: ForcedChoiceStamp[] };`
  - `export function forcedChoiceBounds(input: { correctCount: number; verdictCount: number; committedCount: number; scoredKeyCounts: Readonly<Record<Preference, number>>; abstainedKeyCounts: Readonly<Record<Preference, number>> }): ForcedChoiceBounds | null;`
  - `export function formatForcedChoiceLines(bounds: ForcedChoiceBounds | null, selectiveAccuracy: number | null): string[];`
- Produces on `CalibrationScore`: `forcedChoice: ForcedChoiceBounds | null` (**null iff `verdictCount === 0`** — one meaning, and the tie-key case is carried by `keyTieCount` inside the object rather than by a second reason for the same null).

- [ ] **Step 0: Confirm the starting state**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena status --porcelain
```
HEAD must be Task 3's commit; tree clean apart from `?? docs/superpowers/plans/`.

- [ ] **Step 1: Record the "no columns" decision, and the two claims that are NOT made**

No code in this step. **The forced-choice projections get NO columns, and are printed by the CLI only.**

*Against a column:* every line except the first is a **projection under a stated assumption**, not a measurement. The scoreboard header is where measurements live; the moment a projection sits in the same row as `rawAgreement` a query will `ORDER BY` it and a document will quote it as "what the judge scored". The brief's own instruction is the argument — *never present a projected figure where a measured one is expected* — and the strongest enforcement available is not to store it. `allAbstentionsWrong` is additionally **identically `rawAgreement`**, so storing it would be a second column that must always equal the first.

*And the assumption that is NOT worth a field.* "The judge would be as accurate on the items it abstained on as on the ones it answered" gives `(correct + selective × abstained) / verdictCount` = `selective × (committed + abstained) / verdictCount` = **`selectiveAccuracy`, exactly, for every input.** The projection already exists under a different name. Step 3's test pins the identity so nobody re-derives it as a fifth strategy.

*Two claims this module deliberately does NOT make.*

1. **These are not a nested interval, and `selectiveAccuracy` is NOT the optimistic end.** Measured on `cmtondblm00012lzcx1m2cyql`: 275 of the 500 abstained items are keyed `A>B`, so a plurality stamp scores `331/603 = 0.5489` against a selective accuracy of `56/103 = 0.5437`. A stamp does not use the judge at all — it uses a property of the key — so it is under no obligation to sit below the judge's own hit rate. The formatter prints an explicit `ⓘ` when that happens, and it happens on two of the three completed runs on the 620-item set.
2. **`allAbstentionsRight` is an ORACLE and is labelled as one.** It is printed because a ceiling makes the other three legible (lfm2.5:8b: 0.0929 → 0.9221 is the width of what "forced" could mean for that judge), not because any strategy reaches it.

*And one thing that is NOT computable and is therefore not approximated.* A **risk-coverage curve / AURC** needs a per-item confidence ordering to sweep a threshold over. `ModelJudgment` stores a discrete verdict and nothing rankable — no logprobs, no self-reported confidence, no score. **AURC is not computable on this corpus and no proxy for it is shipped.** Recorded as follow-up F3 rather than approximated with something that would carry the name and not the meaning.

- [ ] **Step 2: Work the arithmetic BEFORE writing the module**

All four production fixtures come from Measurements M3, and every expected value below is hand-computed.

**F1 — Qwen3.6 (`cmtozu76f00012l5w4llb4pae`).** `correct 549`, `n 619`, `committed 610`, scored key `{A>B 336, B>A 283, tie 0}`, abstained key `{A>B 6, B>A 3, tie 0}`, abstained 9.
`allAbstentionsWrong = 549/619 = 0.8869144` · `allAbstentionsRight = 558/619 = 0.9014540` · `coin = (549 + 4.5)/619 = 553.5/619 = 0.8941842` · `stamp 'A>B' = (549 + 6)/619 = 555/619 = 0.8966075`.
Selective accuracy is `0.9000`, so the stamp is **below** it and the `ⓘ` does **not** fire here.

**F2 — lfm2.5:8b (`cmtondblm00012lzcx1m2cyql`).** `correct 56`, `n 603`, `committed 103`, scored key `{329, 274, 0}`, abstained key `{275, 225, 0}`, abstained 500.
`wrong = 56/603 = 0.0928689` · `right = 556/603 = 0.9220564` · `coin = 306/603 = 0.5074627` · `stamp 'A>B' = 331/603 = 0.5489220`.
Selective is `56/103 = 0.5436893`, so **the stamp beats it and the `ⓘ` fires.**

**F3 — a two-way tie among top key classes**, constructed: scored key `{A>B 12, B>A 12, tie 6}`, abstained key `{A>B 5, B>A 1, tie 0}`, `correct 10`, `n 30`, `committed 24`.
**Two stamps achieve the same floor and give DIFFERENT projections:** `'A>B'` hits 5 → `15/30 = 0.5`; `'B>A'` hits 1 → `11/30 = 0.3666667`. Reporting one of them under the label "the plurality stamp" would print a real number for a strategy the reader did not pick — so `pluralityStampTiebreaks` is an ARRAY. Three live classes, so `unbiasedCoinTiebreak` is **`null`**: a coin has two sides, and the expectation of a uniform choice over three categories is a different quantity that this module does not claim to compute.

**F4 — no abstentions at all**: every projection collapses onto accuracy, and the formatter says so in one line rather than printing four identical numbers.

**F5 — nothing scored**: `forcedChoiceBounds` returns `null`, and the formatter returns `[]`.

- [ ] **Step 3: Write the failing test**

Create `/root/judge-arena/tests/lib/calibration-forced-choice.test.ts` with exactly this content:

```ts
import { describe, expect, it } from 'vitest';
import {
  forcedChoiceBounds,
  formatForcedChoiceLines,
} from '@/lib/calibration/forced-choice';

// ─── Real runs, measured 2026-09-06 against judge-arena-pg-1 ───────────────
//
// GoldenSet cmt057h5d00097y01ymubpre5 is FORCED CHOICE: 620 items, 336 'A>B'
// and 284 'B>A', no ties. A 'tie' verdict can therefore never be correct, so
// ACCURACY already counts every abstention as a miss — the pessimistic end of a
// range whose other end depends entirely on what a forced judge would have
// done, which nobody observed. These fixtures are the two runs that make the
// range matter.
const QWEN36 = {
  correctCount: 549,
  verdictCount: 619,
  committedCount: 610,
  scoredKeyCounts: { 'A>B': 336, 'B>A': 283, tie: 0 } as const,
  abstainedKeyCounts: { 'A>B': 6, 'B>A': 3, tie: 0 } as const,
};
const LFM25_8B = {
  correctCount: 56,
  verdictCount: 603,
  committedCount: 103,
  scoredKeyCounts: { 'A>B': 329, 'B>A': 274, tie: 0 } as const,
  abstainedKeyCounts: { 'A>B': 275, 'B>A': 225, tie: 0 } as const,
};

describe('calibration/forced-choice: the pessimistic end IS rawAgreement', () => {
  it('allAbstentionsWrong is correctCount/verdictCount — the number already published', () => {
    // Not a new metric with a new name. If this ever differs from rawAgreement
    // the report is printing two numbers for one thing and a reader will quote
    // whichever is more flattering.
    expect(forcedChoiceBounds(QWEN36)?.allAbstentionsWrong).toBeCloseTo(549 / 619, 12);
    expect(forcedChoiceBounds(LFM25_8B)?.allAbstentionsWrong).toBeCloseTo(56 / 603, 12);
  });

  it('the "as good on ties as on commitments" projection IS selective accuracy, so it gets no field', () => {
    // (correct + selective*abstained)/n  =  selective*(committed+abstained)/n  =  selective.
    // Worked here on real counts so the identity is checked and not asserted.
    const selective = 56 / 103;
    const projected = (56 + selective * 500) / 603;
    expect(projected).toBeCloseTo(selective, 12);
    // And it is NOT the same thing as any of the strategies this module reports.
    expect(projected).not.toBeCloseTo(forcedChoiceBounds(LFM25_8B)!.allAbstentionsWrong, 3);
  });
});

describe('calibration/forced-choice: each strategy is computed, not guessed', () => {
  it('the unbiased coin is the exact expectation, not a simulation', () => {
    // (549 + 9/2)/619 and (56 + 500/2)/603. Half a hit per abstention is the
    // expectation of a fair tiebreak on a 2-class key; nothing here samples.
    expect(forcedChoiceBounds(QWEN36)?.unbiasedCoinTiebreak).toBeCloseTo(553.5 / 619, 12);
    expect(forcedChoiceBounds(LFM25_8B)?.unbiasedCoinTiebreak).toBeCloseTo(306 / 603, 12);
  });

  it('the plurality stamp uses the KEY on the abstained items, and is a measured count', () => {
    const stamps = forcedChoiceBounds(LFM25_8B)?.pluralityStampTiebreaks;
    expect(stamps).toEqual([
      { preference: 'A>B', hitsOnAbstained: 275, accuracy: 331 / 603 },
    ]);
  });

  it('the ORACLE end is labelled by its value, not by hope: every abstention right', () => {
    expect(forcedChoiceBounds(LFM25_8B)?.allAbstentionsRight).toBeCloseTo(556 / 603, 12);
    expect(forcedChoiceBounds(QWEN36)?.allAbstentionsRight).toBeCloseTo(558 / 619, 12);
  });

  it('SELECTIVE ACCURACY IS NOT AN UPPER BOUND — the stamp beats it on lfm2.5:8b', () => {
    // The correction this whole task exists for. A stamp does not use the judge
    // at all, so it is under no obligation to sit below the judge's own hit
    // rate: 331/603 = 0.5489 against 56/103 = 0.5437, on real counts.
    const stamp = forcedChoiceBounds(LFM25_8B)!.pluralityStampTiebreaks[0].accuracy;
    expect(stamp).toBeGreaterThan(56 / 103);
    // And the opposite case is real too — on Qwen3.6 the stamp is BELOW
    // selective accuracy, so neither ordering can be hardcoded.
    expect(forcedChoiceBounds(QWEN36)!.pluralityStampTiebreaks[0].accuracy).toBeLessThan(549 / 610);
  });
});

describe('calibration/forced-choice: the cases where a single number would be a lie', () => {
  it('two top classes give TWO different projections, both reported, in PREFERENCES order', () => {
    // Fixture F3. Same floor, different hits on the abstained subset — naming
    // one of them "the plurality stamp" prints a real number for a strategy the
    // reader did not choose.
    const bounds = forcedChoiceBounds({
      correctCount: 10,
      verdictCount: 30,
      committedCount: 24,
      scoredKeyCounts: { 'A>B': 12, 'B>A': 12, tie: 6 },
      abstainedKeyCounts: { 'A>B': 5, 'B>A': 1, tie: 0 },
    });
    expect(bounds?.pluralityStampTiebreaks).toEqual([
      { preference: 'A>B', hitsOnAbstained: 5, accuracy: 15 / 30 },
      { preference: 'B>A', hitsOnAbstained: 1, accuracy: 11 / 30 },
    ]);
  });

  it('three live key classes: the coin is NULL, because a coin has two sides', () => {
    const bounds = forcedChoiceBounds({
      correctCount: 10,
      verdictCount: 30,
      committedCount: 24,
      scoredKeyCounts: { 'A>B': 12, 'B>A': 12, tie: 6 },
      abstainedKeyCounts: { 'A>B': 5, 'B>A': 1, tie: 0 },
    });
    expect(bounds?.unbiasedCoinTiebreak).toBeNull();
    // …and the tie count travels with the object rather than becoming a second
    // reason for the same null.
    expect(bounds?.keyTieCount).toBe(6);
  });

  it('no abstentions: every projection equals accuracy and abstainedCount is 0', () => {
    const bounds = forcedChoiceBounds({
      correctCount: 25,
      verdictCount: 30,
      committedCount: 30,
      scoredKeyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      abstainedKeyCounts: { 'A>B': 0, 'B>A': 0, tie: 0 },
    });
    expect(bounds?.abstainedCount).toBe(0);
    expect(bounds?.allAbstentionsWrong).toBeCloseTo(25 / 30, 12);
    expect(bounds?.allAbstentionsRight).toBeCloseTo(25 / 30, 12);
    expect(bounds?.unbiasedCoinTiebreak).toBeCloseTo(25 / 30, 12);
    expect(bounds?.pluralityStampTiebreaks[0].accuracy).toBeCloseTo(25 / 30, 12);
  });

  it('nothing scored → null, never a zero-filled object', () => {
    expect(
      forcedChoiceBounds({
        correctCount: 0,
        verdictCount: 0,
        committedCount: 0,
        scoredKeyCounts: { 'A>B': 0, 'B>A': 0, tie: 0 },
        abstainedKeyCounts: { 'A>B': 0, 'B>A': 0, tie: 0 },
      })
    ).toBeNull();
  });

  it('committedCount above verdictCount THROWS rather than returning a negative abstention', () => {
    // A caller bug, not a data shape. A defensive clamp here would turn it into
    // a plausible number — the same rule constantVerdictBaseline follows.
    expect(() =>
      forcedChoiceBounds({
        correctCount: 1,
        verdictCount: 2,
        committedCount: 3,
        scoredKeyCounts: { 'A>B': 2, 'B>A': 0, tie: 0 },
        abstainedKeyCounts: { 'A>B': 0, 'B>A': 0, tie: 0 },
      })
    ).toThrow(RangeError);
  });
});

describe('calibration/forced-choice: formatForcedChoiceLines', () => {
  it('renders lfm2.5:8b exactly, including the ⓘ that selective accuracy is not a ceiling', () => {
    expect(formatForcedChoiceLines(forcedChoiceBounds(LFM25_8B), 56 / 103)).toEqual([
      "  forced-choice projection — on a key with no ties a 'tie' can never be right, so ACCURACY above",
      '  already counts every abstention as a miss. These are what a FORCED judge would have scored:',
      '    all abstentions wrong   0.0929   (= ACCURACY above — the pessimistic end)',
      '    unbiased coin           0.5075   (exact expectation over 500 abstention(s) on a 2-class key)',
      "    stamp 'A>B'             0.5489   (275 of the 500 abstained items are keyed 'A>B')",
      '    all abstentions right   0.9221   (an ORACLE tiebreak — unreachable, printed as the ceiling)',
      '  ⓘ selective accuracy 0.5437 is NOT an upper bound on a forced judge: the stamp above scores higher.',
      '  Every line except the first is a PROJECTION under the assumption named beside it. Never quote one where a measured number is expected.',
    ]);
  });

  it('omits the ⓘ when no stamp beats selective accuracy — Qwen3.6', () => {
    const lines = formatForcedChoiceLines(forcedChoiceBounds(QWEN36), 549 / 610);
    expect(lines.some((l) => l.includes('NOT an upper bound'))).toBe(false);
    expect(lines).toContain("    stamp 'A>B'             0.8966   (6 of the 9 abstained items are keyed 'A>B')");
  });

  it('a tie-containing KEY is REFUSED, not projected — there is nothing to force', () => {
    const bounds = forcedChoiceBounds({
      correctCount: 10,
      verdictCount: 30,
      committedCount: 24,
      scoredKeyCounts: { 'A>B': 12, 'B>A': 12, tie: 6 },
      abstainedKeyCounts: { 'A>B': 5, 'B>A': 1, tie: 0 },
    });
    expect(formatForcedChoiceLines(bounds, 10 / 24)).toEqual([
      "  forced-choice projection: NOT COMPUTED — this answer key contains 6 tie(s), so a 'tie' is a real answer here and there is nothing to force.",
    ]);
  });

  it('no abstentions: one line saying so, not four identical numbers', () => {
    const bounds = forcedChoiceBounds({
      correctCount: 25,
      verdictCount: 30,
      committedCount: 30,
      scoredKeyCounts: { 'A>B': 17, 'B>A': 13, tie: 0 },
      abstainedKeyCounts: { 'A>B': 0, 'B>A': 0, tie: 0 },
    });
    expect(formatForcedChoiceLines(bounds, 25 / 30)).toEqual([
      '  forced-choice projection: none needed — the judge abstained on 0 of 30 scored items.',
    ]);
  });

  it('nothing scored → no lines at all', () => {
    expect(formatForcedChoiceLines(null, null)).toEqual([]);
  });

  it('a null selective accuracy never produces the ⓘ, and never prints "null"', () => {
    // Zero coverage: every scored item was an abstention. The strategies are
    // still computable (they depend on the key, not on the judge) but there is
    // no selective accuracy to compare them against.
    const bounds = forcedChoiceBounds({
      correctCount: 0,
      verdictCount: 3,
      committedCount: 0,
      scoredKeyCounts: { 'A>B': 3, 'B>A': 0, tie: 0 },
      abstainedKeyCounts: { 'A>B': 3, 'B>A': 0, tie: 0 },
    });
    const lines = formatForcedChoiceLines(bounds, null);
    expect(lines.some((l) => l.includes('NOT an upper bound'))).toBe(false);
    expect(lines.some((l) => l.includes('null'))).toBe(false);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails for the reason expected**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected FAIL** — a resolution error, not assertions:

```
Error: Failed to resolve import "@/lib/calibration/forced-choice" from "tests/lib/calibration-forced-choice.test.ts". Does the file exist?
```

- [ ] **Step 5: Minimal implementation — `src/lib/calibration/forced-choice.ts`**

Create `/root/judge-arena/src/lib/calibration/forced-choice.ts` with exactly this content:

```ts
/**
 * ─── WHAT A FORCED JUDGE WOULD HAVE SCORED — BY STRATEGY, NEVER AS ONE NUMBER ─
 *
 * THE KEY IS FORCED CHOICE. GoldenSet cmt057h5d00097y01ymubpre5 is 620 items,
 * 336 'A>B' and 284 'B>A', with no ties; cmt057hd001g17y01lhjzgfuj is 17/13/0.
 * A 'tie' verdict can therefore never be correct, and `rawAgreement` — which is
 * accuracy — counts every one as a miss. That is the right thing for the
 * published number to do, and it is also the PESSIMISTIC end of a range: nobody
 * observed what the judge would have said if it had been made to choose.
 *
 * SO THIS MODULE REPORTS THE RANGE WITH EVERY ASSUMPTION NAMED, and refuses to
 * collapse it. Four strategies, in the order the report prints them:
 *
 *   all abstentions wrong  — correctCount/verdictCount. IDENTICALLY rawAgreement.
 *   unbiased coin          — correctCount + abstained/2, over verdictCount. The
 *                            exact EXPECTATION of a fair tiebreak on a 2-class
 *                            key; nothing is sampled. NULL when the scored key
 *                            does not have exactly two live classes, because a
 *                            coin has two sides and the uniform-over-three
 *                            quantity is a different one this does not compute.
 *   plurality stamp        — what a judge stamping the key's plurality class on
 *                            every abstention actually scores. It uses the KEY,
 *                            not the judge, so its hits are COUNTED from
 *                            `abstainedKeyCounts` rather than projected. An
 *                            ARRAY: when two classes tie for the plurality they
 *                            achieve the same FLOOR and DIFFERENT projections
 *                            (12/12/6 key with 5/1 abstained: 0.5000 vs 0.3667),
 *                            and naming one of them "the plurality stamp" would
 *                            print a real number for a strategy nobody chose.
 *   all abstentions right  — an ORACLE. Unreachable, printed as a ceiling so the
 *                            other three are legible (lfm2.5:8b spans
 *                            0.0929 to 0.9221).
 *
 * SELECTIVE ACCURACY IS NOT AN UPPER BOUND ON THESE, AND THE FORMATTER SAYS SO
 * WHEN IT ISN'T. Measured 2026-09-06 on cmtondblm00012lzcx1m2cyql: 275 of the
 * 500 abstained items are keyed 'A>B', so the stamp scores 331/603 = 0.5489
 * against a selective accuracy of 56/103 = 0.5437. A stamp does not use the
 * judge at all, so it is under no obligation to sit below the judge's own hit
 * rate. On Qwen3.6 the ordering is the other way round (0.8966 vs 0.9000), so
 * neither direction can be assumed.
 *
 * THE "AS GOOD ON TIES AS ON COMMITMENTS" PROJECTION IS DELIBERATELY ABSENT,
 * because it is not a fifth strategy — it is selective accuracy with extra
 * steps: (correct + selective*abstained)/n = selective*(committed+abstained)/n
 * = selective, for every input. The unit test pins the identity.
 *
 * NOTHING HERE IS STORED. Every line but the first is a projection under a
 * stated assumption, and the scoreboard header is where measurements live; a
 * projection in that row gets ORDER BY'd and then quoted as "what the judge
 * scored". The first line needs no column either — it IS `rawAgreement`.
 *
 * NOT COMPUTABLE, AND THEREFORE NOT APPROXIMATED: a risk-coverage curve / AURC.
 * That needs a per-item confidence ordering to sweep a threshold over, and
 * `ModelJudgment` stores a discrete verdict with nothing rankable beside it —
 * no logprobs, no self-reported confidence. A proxy would carry the name and
 * not the meaning.
 *
 * PURE, AND A LEAF. Only the preference vocabulary comes from readings.ts
 * (whose sole import is type-only), so this runs in the DB-free unit suite with
 * no mock and adds no edge to the esbuild bundle behind the calibration CLI.
 */

import { PREFERENCES, type Preference } from '@/lib/calibration/readings';

export type ForcedChoiceStamp = {
  preference: Preference;
  /** COUNTED, not projected: how many abstained items this key class covers. */
  hitsOnAbstained: number;
  /** (correctCount + hitsOnAbstained) / verdictCount. */
  accuracy: number;
};

export type ForcedChoiceBounds = {
  verdictCount: number;
  committedCount: number;
  abstainedCount: number;
  /** Tie-keyed items among the SCORED ones. Non-zero means the framing does not
   *  apply at all — a 'tie' is a real answer on such a key — and the formatter
   *  refuses rather than projecting. Carried here so the function's `null` keeps
   *  exactly ONE meaning: nothing was scored. */
  keyTieCount: number;
  /** IDENTICALLY `rawAgreement`. Not a new metric; the anchor the others are
   *  read against. */
  allAbstentionsWrong: number;
  /** The ORACLE end. Unreachable by construction. */
  allAbstentionsRight: number;
  /** Exact expectation of a fair tiebreak; `null` unless the scored key has
   *  exactly two live classes. */
  unbiasedCoinTiebreak: number | null;
  /** One entry per class achieving the scored key's plurality, in PREFERENCES
   *  order. Length > 1 when the top classes tie — and the entries DIFFER, which
   *  is the whole reason this is not a scalar. */
  pluralityStampTiebreaks: ForcedChoiceStamp[];
};

/**
 * `null` when nothing was scored — the same null-not-zero rule `accuracy` and
 * `constantVerdictBaseline` follow, and it has exactly one meaning here.
 *
 * Throws when `committedCount` exceeds `verdictCount`. That is a caller bug, not
 * a data shape, and a defensive clamp would turn it into a plausible number.
 */
export function forcedChoiceBounds(input: {
  correctCount: number;
  verdictCount: number;
  committedCount: number;
  scoredKeyCounts: Readonly<Record<Preference, number>>;
  abstainedKeyCounts: Readonly<Record<Preference, number>>;
}): ForcedChoiceBounds | null {
  const { correctCount, verdictCount, committedCount, scoredKeyCounts, abstainedKeyCounts } = input;
  if (verdictCount === 0) return null;

  const abstainedCount = verdictCount - committedCount;
  if (abstainedCount < 0) {
    throw new RangeError(
      `forcedChoiceBounds: committedCount ${committedCount} exceeds verdictCount ${verdictCount}; ` +
        `the committed items are a SUBSET of the scored ones`
    );
  }

  // "Live" = present in the answer key at all. A key class with zero items is
  // not a side of the coin.
  const liveClasses = PREFERENCES.filter((preference) => scoredKeyCounts[preference] > 0);

  let best = 0;
  for (const preference of PREFERENCES) {
    if (scoredKeyCounts[preference] > best) best = scoredKeyCounts[preference];
  }

  return {
    verdictCount,
    committedCount,
    abstainedCount,
    keyTieCount: scoredKeyCounts.tie,
    allAbstentionsWrong: correctCount / verdictCount,
    allAbstentionsRight: (correctCount + abstainedCount) / verdictCount,
    unbiasedCoinTiebreak:
      liveClasses.length === 2 ? (correctCount + abstainedCount / 2) / verdictCount : null,
    pluralityStampTiebreaks: PREFERENCES.filter(
      (preference) => best > 0 && scoredKeyCounts[preference] === best
    ).map((preference) => ({
      preference,
      hitsOnAbstained: abstainedKeyCounts[preference],
      accuracy: (correctCount + abstainedKeyCounts[preference]) / verdictCount,
    })),
  };
}

/** Four decimals, the same rendering as `fmt` in scripts/calibration/run.ts and
 *  as `fmt4` in ./baseline.ts. Local and null-free: every guard below has
 *  already excluded null, and a shared helper would mean importing one of these
 *  leaf modules into the other for four characters. */
const fmt4 = (n: number): string => n.toFixed(4);

/** Label column width. Chosen so the longest label ('all abstentions wrong',
 *  21 chars) still leaves three spaces before the number; every row therefore
 *  aligns whatever the stamp's preference is called. */
const LABEL_WIDTH = 24;

/**
 * The block the CLI prints. `[]` when nothing was scored — a line reading `n/a`
 * would suggest a projection exists and could not be rendered.
 *
 * `selectiveAccuracy` is passed in rather than recomputed so the `ⓘ` compares
 * against the number the report printed three lines earlier, not a second
 * derivation of it that could drift.
 */
export function formatForcedChoiceLines(
  bounds: ForcedChoiceBounds | null,
  selectiveAccuracy: number | null
): string[] {
  if (bounds === null) return [];

  // A tie-containing key is not a forced choice, so there is nothing to force.
  // Refusing beats projecting: every strategy below would still compute, and
  // every one of them would mean something other than its label says.
  if (bounds.keyTieCount > 0) {
    return [
      `  forced-choice projection: NOT COMPUTED — this answer key contains ${bounds.keyTieCount} tie(s), ` +
        "so a 'tie' is a real answer here and there is nothing to force.",
    ];
  }

  if (bounds.abstainedCount === 0) {
    return [
      `  forced-choice projection: none needed — the judge abstained on 0 of ${bounds.verdictCount} scored items.`,
    ];
  }

  const lines = [
    "  forced-choice projection — on a key with no ties a 'tie' can never be right, so ACCURACY above",
    '  already counts every abstention as a miss. These are what a FORCED judge would have scored:',
    `    ${'all abstentions wrong'.padEnd(LABEL_WIDTH)}${fmt4(bounds.allAbstentionsWrong)}   (= ACCURACY above — the pessimistic end)`,
  ];

  lines.push(
    bounds.unbiasedCoinTiebreak === null
      ? `    ${'unbiased coin'.padEnd(LABEL_WIDTH)}n/a   (the scored key does not have exactly 2 live classes — a coin is not defined here)`
      : `    ${'unbiased coin'.padEnd(LABEL_WIDTH)}${fmt4(bounds.unbiasedCoinTiebreak)}   ` +
          `(exact expectation over ${bounds.abstainedCount} abstention(s) on a 2-class key)`
  );

  for (const stamp of bounds.pluralityStampTiebreaks) {
    lines.push(
      `    ${`stamp '${stamp.preference}'`.padEnd(LABEL_WIDTH)}${fmt4(stamp.accuracy)}   ` +
        `(${stamp.hitsOnAbstained} of the ${bounds.abstainedCount} abstained items are keyed '${stamp.preference}')`
    );
  }

  lines.push(
    `    ${'all abstentions right'.padEnd(LABEL_WIDTH)}${fmt4(bounds.allAbstentionsRight)}   (an ORACLE tiebreak — unreachable, printed as the ceiling)`
  );

  // Local const so TypeScript narrows inside the closure below.
  const selective = selectiveAccuracy;
  if (selective !== null && bounds.pluralityStampTiebreaks.some((s) => s.accuracy > selective)) {
    lines.push(
      `  ⓘ selective accuracy ${fmt4(selective)} is NOT an upper bound on a forced judge: the stamp above scores higher.`
    );
  }

  lines.push(
    '  Every line except the first is a PROJECTION under the assumption named beside it. Never quote one where a measured number is expected.'
  );
  return lines;
}
```

- [ ] **Step 6: Wire it into `score.ts` (five edits)**

**Edit 6a — the import**, placed to keep the existing near-alphabetical order.

old_string:
```
import { constantVerdictBaseline, type ConstantBaseline } from '@/lib/calibration/baseline';
import {
```
new_string:
```
import { constantVerdictBaseline, type ConstantBaseline } from '@/lib/calibration/baseline';
import { forcedChoiceBounds, type ForcedChoiceBounds } from '@/lib/calibration/forced-choice';
import {
```

**Edit 6b — the accumulator.**

old_string:
```
  const committedKeyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };

  const disagreements: CalibrationDisagreement[] = [];
```
new_string:
```
  const committedKeyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };
  // The complement, and it is NOT `keyCounts − committedKeyCounts` computed at
  // the end: the forced-choice stamp COUNTS its hits on the abstained items
  // rather than projecting them, so this has to be a real accumulator past the
  // same gate. Abstentions do not fall evenly across the key — 275 of
  // lfm2.5:8b's 500 are keyed 'A>B' against a subset marginal of 329/603.
  const abstainedKeyCounts: Record<Preference, number> = { 'A>B': 0, 'B>A': 0, tie: 0 };

  const disagreements: CalibrationDisagreement[] = [];
```

**Edit 6c — the loop line.**

old_string:
```
    if (row.verdict !== 'tie') committedKeyCounts[expected] += 1;
```
new_string:
```
    if (row.verdict === 'tie') abstainedKeyCounts[expected] += 1;
    else committedKeyCounts[expected] += 1;
```

**Edit 6d — the computed block.**

old_string:
```
  const selectiveMarginOverConstant =
    selectiveAccuracy !== null && selectiveBaseline !== null
      ? selectiveAccuracy - selectiveBaseline.accuracy
      : null;
```
new_string:
```
  const selectiveMarginOverConstant =
    selectiveAccuracy !== null && selectiveBaseline !== null
      ? selectiveAccuracy - selectiveBaseline.accuracy
      : null;

  // What a FORCED judge would have scored, by strategy. Report-only: nothing
  // here is written to the row, because every entry but the first is a
  // projection under a stated assumption and the header is where measurements
  // live. The first IS `rawAgreement` and needs no second column.
  const forcedChoice = forcedChoiceBounds({
    correctCount,
    verdictCount,
    committedCount,
    scoredKeyCounts: keyCounts,
    abstainedKeyCounts,
  });
```

**Edit 6e — the type and the result object.**

old_string:
```
  /** selectiveAccuracy − selectiveBaseline.accuracy. `null` when either is. */
  selectiveMarginOverConstant: number | null;
};
```
new_string:
```
  /** selectiveAccuracy − selectiveBaseline.accuracy. `null` when either is. */
  selectiveMarginOverConstant: number | null;
  /** What a FORCED judge would have scored, one entry per named strategy.
   *  `null` iff `verdictCount` is 0 — the tie-KEY case travels inside the
   *  object as `keyTieCount`, so this null keeps one meaning. REPORT-ONLY: no
   *  field of it is written to the CalibrationRun row. */
  forcedChoice: ForcedChoiceBounds | null;
};
```

old_string:
```
    selectiveBaseline,
    selectiveMarginOverConstant,
    method: {
```
new_string:
```
    selectiveBaseline,
    selectiveMarginOverConstant,
    forcedChoice,
    method: {
```

- [ ] **Step 7: Wire the report — two edits to `scripts/calibration/run.ts`**

**Edit 7a — the import.**

old_string:
```
import { SCORING_RULES_VERSION, describeScoringVersion } from '@/lib/calibration/scoring-version';
```
new_string:
```
import { formatForcedChoiceLines } from '@/lib/calibration/forced-choice';
import { SCORING_RULES_VERSION, describeScoringVersion } from '@/lib/calibration/scoring-version';
```

**Edit 7b — the printed block, immediately after the confusion matrix.**

old_string:
```
  console.log('\n  confusion [expected][judged]:');
  for (const [exp, row] of Object.entries(score.confusion)) {
    console.log(`    ${exp.padEnd(5)} -> ${Object.entries(row).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }
```
new_string:
```
  console.log('\n  confusion [expected][judged]:');
  for (const [exp, row] of Object.entries(score.confusion)) {
    console.log(`    ${exp.padEnd(5)} -> ${Object.entries(row).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }

  // The forced-choice range, below the matrix that shows where the abstentions
  // landed. Report-only and stored nowhere: every line but the first is a
  // projection, and a projection in the header row gets quoted as a result.
  // `selectiveAccuracy` is handed in rather than recomputed so the ⓘ compares
  // against the number printed above it.
  console.log('');
  for (const line of formatForcedChoiceLines(score.forcedChoice, score.selectiveAccuracy)) {
    console.log(line);
  }
```

- [ ] **Step 8: Add the call-site guard**

`scripts/**` is outside every coverage `include` and no test imports it, so the wiring in Step 7 is otherwise unguarded (failure mode 5). Append this to the END of `/root/judge-arena/tests/lib/calibration-forced-choice.test.ts`:

```ts

describe('calibration/forced-choice: the CLI actually prints the block', () => {
  //   what it catches  — the block being deleted, renamed, computed and never
  //                      printed, or called with the wrong second argument
  //   what it does NOT — where in the report it appears, and whether the script
  //                      RUNS at all (nothing here executes run.ts)
  const RUN_TS = readFileSync(new URL('../../scripts/calibration/run.ts', import.meta.url), 'utf8');

  it('imports formatForcedChoiceLines and prints every line, with BOTH arguments pinned', () => {
    expect(RUN_TS).toContain("from '@/lib/calibration/forced-choice'");
    expect(RUN_TS.match(/formatForcedChoiceLines\(/g)).toHaveLength(1);
    // The ARGUMENTS are pinned, not skipped with `[^)]*`. The second parameter
    // is `number | null`, so `formatForcedChoiceLines(score.forcedChoice, null)`
    // type-checks, lints and passes every other assertion here — while
    // permanently suppressing the ⓘ that says selective accuracy is not an
    // upper bound, which is the one line this whole module exists to print.
    expect(RUN_TS).toMatch(
      /for \(const line of formatForcedChoiceLines\(score\.forcedChoice, score\.selectiveAccuracy\)\) \{/
    );
  });
});
```

and add the `node:fs` import at the top of that file.

old_string:
```
import { describe, expect, it } from 'vitest';
```
new_string:
```
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
```

- [ ] **Step 9: Run to pass**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts tests/lib/calibration-score.test.ts
```

Expected: `Test Files  2 passed (2)`, `Tests  56 passed (56)` — 18 new in the forced-choice file plus the **38** in `calibration-score` (30 pre-existing at `2e7e142` + Task 3's 8). Task 4 adds no `it(` to `calibration-score.test.ts`. **Use the printed number**; if it is not 56, count the `it(` blocks before assuming anything.

- [ ] **Step 10: INJECTION H — the stamp must COUNT its hits, not project them**

Edit `/root/judge-arena/src/lib/calibration/forced-choice.ts`.

old_string:
```
      hitsOnAbstained: abstainedKeyCounts[preference],
      accuracy: (correctCount + abstainedKeyCounts[preference]) / verdictCount,
```
new_string:
```
      hitsOnAbstained: abstainedKeyCounts[preference],
      accuracy: (correctCount + (abstainedCount * scoredKeyCounts[preference]) / verdictCount) / verdictCount,
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected RED, EXACTLY FOUR tests.** Work the arithmetic before you run it: on `LFM25_8B` the injected expression is `(56 + 500 × 329 / 603) / 603 = 328.802653…/603 = 0.545278032171921`, which renders **`0.5453`** — *not* the true `331/603 = 0.548922056384743` → `0.5489`.

- `the plurality stamp uses the KEY on the abstained items, and is a measured count` → the array diff shows `accuracy: 0.545278032171921` where `0.548922056384743` is expected
- `two top classes give TWO different projections` → on F3 both entries collapse to `(10 + 6 × 12 / 30)/30 = 0.41333333333333333`, so the diff shows that value where `0.5` and `0.36666666666666664` are expected
- `renders lfm2.5:8b exactly, including the ⓘ` → `expected "    stamp 'A>B'             0.5453   …" to equal "    stamp 'A>B'             0.5489   …"`
- `omits the ⓘ when no stamp beats selective accuracy — Qwen3.6` → `(549 + 9 × 336 / 619)/619 = 0.894806…` → the `toContain` on `"    stamp 'A>B'             0.8966   …"` fails against a rendered `0.8948`

And one that **stays green, which is the point**: `SELECTIVE ACCURACY IS NOT AN UPPER BOUND — the stamp beats it on lfm2.5:8b`. The injected 0.545278 is *still* above selective accuracy 0.543689 — by 0.0016, sixteen ten-thousandths — so the correction's headline assertion alone cannot catch this. Only a fixture that COUNTS can.

**Why this injection was chosen:** the replacement is the *plausible* wrong implementation — "the abstained items are a sample of the key, so scale the marginal" — and it is wrong precisely because abstentions are not a random sample of the key (275/500 = 0.5500 abstained vs 329/603 = 0.5456 overall on this run). It stays in range, keeps the same sign and would be invisible without a fixture that counts. **Restore and re-run to green.**

- [ ] **Step 11: INJECTION I — a coin has two sides**

Edit `/root/judge-arena/src/lib/calibration/forced-choice.ts`.

old_string:
```
      liveClasses.length === 2 ? (correctCount + abstainedCount / 2) / verdictCount : null,
```
new_string:
```
      (correctCount + abstainedCount / 2) / verdictCount,
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected RED, exactly one test:**
- `three live key classes: the coin is NULL, because a coin has two sides` → `expected 0.43333333333333335 to be null`

The number is `(correctCount + abstainedCount/2)/verdictCount` on F3, i.e. `(10 + 6/2)/30`, with `abstainedCount = 30 − 24 = 6`. If you see anything else, the fixture is not the one this plan describes.

**Restore and re-run to green.** *What wrong implementation would still pass this?* One that returned `null` for `liveClasses.length !== 2` but computed the coin over the ABSTAINED key's live classes instead of the scored key's — those are equal on every fixture here. That is stated rather than papered over: no test discriminates it, and it is a distinction with no consequence on any reachable corpus, because the abstained key is a subset of the scored key.

- [ ] **Step 12: INJECTION J — a tie key must be refused, not projected**

Edit `/root/judge-arena/src/lib/calibration/forced-choice.ts`.

old_string:
```
  if (bounds.keyTieCount > 0) {
```
new_string:
```
  if (bounds.keyTieCount > 999) {
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected RED, exactly one test:**
- `a tie-containing KEY is REFUSED, not projected — there is nothing to force` → the array is **9** lines of projections instead of the single refusal line, and the failure prints both. Count them so you can recognise the right failure: two header lines, `all abstentions wrong`, the `unbiased coin` **`n/a`** line (F3's key has three live classes), **two** stamp lines (`'A>B'` and `'B>A'` tie for the plurality at 12 each), `all abstentions right`, the `ⓘ` (stamp 0.5 beats selective 10/24 = 0.4167), and the trailing PROJECTION caveat.

The threshold is moved rather than the branch deleted so the failure is an assertion about content, not a crash — CONTRIBUTING.md:230-234, *a failure message that does not describe the defect is not evidence*. **Restore and re-run to green.**

- [ ] **Step 13: One boundary this deliberately does NOT pin — read it, do not "fix" it**

**This is NOT an injection step and nothing here is expected to go red.** It is recorded as a numbered step so the decision is visible where an executor would otherwise re-derive it, and it is the exception noted in the self-review. Optionally reproduce it once, in `/root/judge-arena/src/lib/calibration/forced-choice.ts`:

old_string:
```
  if (selective !== null && bounds.pluralityStampTiebreaks.some((s) => s.accuracy > selective)) {
```
new_string:
```
  if (selective !== null && bounds.pluralityStampTiebreaks.some((s) => s.accuracy >= selective)) {
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected: GREEN, and that is the recorded outcome, not a defect to chase.** No fixture sits exactly on the boundary, so `>` and `>=` are indistinguishable here. Unlike the `<=` in `formatConstantBaselineLines` — where the judge that lands ON the floor is precisely the judge the warning exists for — a stamp exactly EQUAL to selective accuracy is not a case anyone needs warned about: the ⓘ says "the stamp scores higher", and at equality it does not. So **the operator stays `>` and this boundary is deliberately unpinned.** Do not invent a fixture to make this go red; a test written only to redden an injection whose behaviour does not matter is decoration, and CONTRIBUTING.md:210-234 exists to stop the opposite mistake, not to require this one. **Restore `>` if you reproduced it, and move on.**

- [ ] **Step 14: INJECTION L — the wiring passes the real selective accuracy**

Edit `/root/judge-arena/scripts/calibration/run.ts`.

old_string:
```
  for (const line of formatForcedChoiceLines(score.forcedChoice, score.selectiveAccuracy)) {
```
new_string:
```
  for (const line of formatForcedChoiceLines(score.forcedChoice, null)) {
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-forced-choice.test.ts
```

**Expected RED, exactly one test:**
- `imports formatForcedChoiceLines and prints every line, with BOTH arguments pinned` → `expected 'import { prisma } …' to match /for \(const line of formatForcedChoiceLines\(score\.forcedChoice, score\.selectiveAccuracy\)\) \{/`

This one is worth the step because `null` **type-checks and lints** — the parameter is `number | null` — and the only visible effect is that the ⓘ never prints again. That line is the module's entire reason to exist, and nothing else in the suite or in `tsc` can see it go. **Restore and re-run to green.**

- [ ] **Step 15: Gates**

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -30
```

Expected: lint 0; tsc silent; **`B + 40` tests over `F + 2` files** (Task 1's 7, Task 3's 15, this task's 18) — on a 1007/61 baseline that is `Tests  1047 passed (1047)` over `Test Files  63 passed (63)`. **Arithmetic on Step 0's measurement, not a measurement.**

- [ ] **Step 16: Commit**

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/forced-choice.ts \
  src/lib/calibration/score.ts \
  scripts/calibration/run.ts \
  tests/lib/calibration-forced-choice.test.ts
git -C /root/judge-arena status --short
```
Expected: exactly those four paths (`A ` on the two new files, `M ` on the two others). Then:

```bash
git -C /root/judge-arena commit --only \
  src/lib/calibration/forced-choice.ts \
  src/lib/calibration/score.ts \
  scripts/calibration/run.ts \
  tests/lib/calibration-forced-choice.test.ts \
  -F - <<'EOF'
feat(calibration): report the forced-choice projections by strategy, never as one number

The key has no ties, so ACCURACY already counts every abstention as a miss —
the pessimistic end of a range whose other end nobody observed, because nobody
made the judge choose. This reports the range with each assumption named: all
abstentions wrong (identically rawAgreement), an unbiased coin (the exact
expectation, not a simulation), the key's plurality stamp (hits COUNTED on the
abstained items, not projected), and the oracle ceiling.

Two things this deliberately does not claim. Selective accuracy is NOT an upper
bound: measured on cmtondblm00012lzcx1m2cyql, 275 of the 500 abstained items are
keyed A>B, so a stamp scores 331/603 = 0.5489 against a selective accuracy of
56/103 = 0.5437. A stamp does not use the judge at all, so it is under no
obligation to sit below the judge's hit rate — and on Qwen3.6 the ordering
reverses (0.8966 vs 0.9000), so neither direction can be assumed. The report
prints an explicit note when a stamp wins.

And the "as good on ties as on commitments" projection is absent because it is
not a fifth strategy: (correct + selective*abstained)/n = selective, exactly, for
every input. The identity is pinned by test rather than shipped twice.

pluralityStampTiebreaks is an array. Two classes tying for the key's plurality
achieve the same floor and DIFFERENT projections (a 12/12/6 key with 5/1
abstained gives 0.5000 and 0.3667), so naming one of them "the plurality stamp"
would print a real number for a strategy nobody chose. The coin is null unless
the key has exactly two live classes.

Nothing is stored. Every line but the first is a projection, and the scoreboard
header is where measurements live; the first line IS rawAgreement. A
risk-coverage curve / AURC is not computable here at all — it needs a per-item
confidence ordering and ModelJudgment stores a discrete verdict with nothing
rankable beside it — so no proxy for it is shipped.

Gates: lint 0, tsc 0, <B+40> unit / n-a db (no tests/db file, no schema change) / n-a integration (no tests/integration file), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **4 files changed**.

---

### Task 5: abstention calibration — ask the judges that ANSWERED

**Files:**
- Create: `/root/judge-arena/src/lib/calibration/abstention.ts`
- Create (Test): `/root/judge-arena/tests/lib/calibration-abstention.test.ts`
- Create: `/root/judge-arena/scripts/calibration/abstention.ts`
- Modify: `/root/judge-arena/package.json:41` — one script entry
- Modify: `/root/judge-arena/Dockerfile:150-157` — one esbuild block appended after the calibration runner's. **Without it the CLI has nowhere to run:** the image bundles only `scripts/calibration/run.ts` (`Dockerfile:150`), the runner ships no TypeScript toolchain (`Dockerfile:128-129`), and a workstation has no route to `judge-arena-pg-rw.tenant-public` (`.dockerignore:66-70`), which is the only database holding these rows. `.dockerignore:79` copies the source into the build context; nothing compiles it.

**Interfaces:**
- Consumes: `Preference` from `@/lib/calibration/readings` (type only). The SCRIPT additionally consumes `prisma`, `preferenceFromVerdict`, `PairOrder`, `Verdict`.
- Produces:
  - `export const MIN_CONTRAST_N = 30;` · `export const COHORT_MIN_SELECTIVE_MARGIN = 0.05;`
  - `export function judgeFamilyKey(baseModel: string | null): string;`
  - `export type CohortJudgment = { itemId: string; expected: Preference; preference: Preference | null };`
  - `export type CohortMember = { calibrationRunId: string; judgeLabel: string; judgeModelVersionId: string; familyKey: string; scoringVersion: number | null; selectiveMarginOverConstant: number | null; judgments: readonly CohortJudgment[] };`
  - `export type SubjectItem = { itemId: string; abstained: boolean };`
  - `export type AbstentionSubject = { calibrationRunId: string; judgeModelVersionId: string; familyKey: string; scoringVersion: number | null; items: readonly SubjectItem[] };`
  - `export type ContrastArm = { n: number; correct: number; accuracy: number };`
  - `export type CohortAdmission = { calibrationRunId: string; judgeLabel: string; admitted: boolean; reason: string };`
  - `export type AbstentionContrast = { subjectCalibrationRunId: string; subjectAbstainedItems: number; subjectCommittedItems: number; cohort: CohortAdmission[]; admittedCount: number; onAbstained: ContrastArm | null; onCommitted: ContrastArm | null; contrast: number | null; interpretable: boolean };`
  - `export function abstentionDifficultyContrast(subject: AbstentionSubject, candidates: readonly CohortMember[]): AbstentionContrast;`
  - `export function formatAbstentionContrastLines(contrast: AbstentionContrast): string[];`

- [ ] **Step 0: Confirm the starting state**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena status --porcelain
```
HEAD must be Task 4's commit.

- [ ] **Step 1: Record the method, its cohort rule, and what it does NOT claim**

No code in this step.

**The method is handoff §5.3's, applied to abstentions instead of truncations:** *do not infer difficulty from the mechanism; check it against judges that answered.* For subject judge J with abstained set T and committed set C, compute the REFERENCE COHORT's accuracy on T and on C. If the cohort also does materially worse on T, J abstained on genuinely harder items. If the cohort does BETTER on T, J's abstentions are not tracking difficulty at all.

**This is CROSS-RUN and therefore does NOT belong in `scoreCalibrationRun`.** That function is defined over exactly one `calibrationRunId` and writes exactly one row; a metric whose value changes when an unrelated judge finishes a run cannot live in a full-overwrite scorer without making a re-score of run A depend on the state of run B. Separate pure function, separate CLI.

**Cohort admission, in order, each with the wrong implementation it excludes:**

1. **Not the subject run itself.** Trivially would give a contrast of `NaN` semantics — the subject is perfectly accurate about its own abstentions by construction.
2. **Not the same `judgeModelVersionId`.** A judge cannot certify its own abstentions. Two runs of the same version are the same rater.
3. **Not the same model FAMILY.** The brief's confound, stated exactly: lfm2.5:8b and lfm2.5-thinking:1.2b have near-identical selective accuracy (0.5437 / 0.5363) and if they sit in each other's cohort they may share a failure mode and manufacture agreement. `judgeFamilyKey` lowercases `JudgeModel.baseModel` and takes the segment before the first `:` and then before the first `-`: `lfm2.5:8b` → `lfm2.5`, `lfm2.5-thinking:1.2b` → `lfm2.5` (**same, excluded**); `qwen3.5:9b` → `qwen3.5` and `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf` → `qwen3.6` (**different, admitted** — which is right, they are separate model generations); `granite4.1:3b` → `granite4.1`, `granite4.2:3b` → `granite4.2`. **HONEST LIMITATION: this rule is NOT load-bearing on today's corpus** — rule 4 below already excludes every LFM pairing on its own — so it is a stated policy, not a measurement, and it exists for the future case where an LFM sibling clears the margin gate and still shares the failure mode. It is also crude: `claude-opus-4-5-…` and `claude-sonnet-4-5-…` both key to `claude`, which is correct here and would be wrong for a family whose members are genuinely independent.
4. **The member's `selectiveMarginOverConstant` must exceed `COHORT_MIN_SELECTIVE_MARGIN = 0.05`.** A judge at its own constant floor cannot certify an item as hard — it is not measuring the item, it is emitting its marginal. On the 620-item set this admits Qwen3.6 (+0.3590) and qwen3.5:9b (+0.2852) and rejects lfm2.5-thinking (+0.0071) and lfm2.5:8b (+0.0194). **0.05 is a policy number with a stated basis, not a measured threshold**: it sits an order of magnitude above the two rejected margins and an order of magnitude below the two admitted ones, so nothing on this corpus is near it. It will need re-examining the first time a judge lands between 0.02 and 0.20.
5. **The member's `scoringVersion` must equal the subject's.** Mixing generations is the thing Task 1 exists to prevent, and the margin in rule 4 only exists from generation 2 onward. A member with a different or NULL version is excluded **with an actionable reason** ("re-score it before comparing"), not silently dropped.

**Sample size, and NO p-value.** `MIN_CONTRAST_N = 30` on **each** arm. Below that the contrast is reported with its `n` and flagged **NOT INTERPRETABLE**. The basis is stated rather than derived from a test: with accuracies near 0.9 and arms of 493 and 100, one standard error on the difference is ≈ 0.029, so the −0.0355 measured for lfm2.5:8b is ≈ 1.2 se — **a difference this method can see needs to be several times larger than that, and at n < 30 the standard error exceeds 0.09 and swamps everything.** No p-value is computed anywhere: these arms are not independent (the same cohort judgments appear in both denominators of a comparison across item sets), the item sets are not random samples, and a number carrying a p-value's authority without its assumptions is worse than no number.

**A confound this method does NOT remove, and it is live today.** `MIN_CONTRAST_N` counts POOLED
cohort judgments, not cohort MEMBERS. On the 2026-09-06 corpus **every contrast rests on exactly one
admitted member** — Qwen3.6, because qwen3.5:9b is excluded by rule 5 until it is backfilled and both
LFM judges are excluded by rule 4 — so an `interpretable: true` here certifies one rater's view of
difficulty, not a consensus. That is the brief's "selection effects from which judges happen to have
run", and it is not fixed by a bigger `n` on one member. The report prints
`reference cohort (N admitted of M candidate(s))` as its second line specifically so the reader can
see `1` before reading the contrast. **Read a single-member contrast as one judge's opinion until a
second judge clears the margin gate.**

**One bias, measured rather than assumed.** Cohort accuracy is over the cohort's COMMITTED judgments only — a cohort member's own abstention is not evidence about an item. If the cohort *also* abstained preferentially on the hard items, dropping those inflates the abstained arm and biases the contrast toward zero, i.e. **conservative**. Measured on this corpus it is negligible: Qwen3.6 abstained on 7 of lfm2.5:8b's 500 abstained items (1.4%) and 2 of its 102 committed ones (2.0%).

- [ ] **Step 2: Write the failing test**

Create `/root/judge-arena/tests/lib/calibration-abstention.test.ts` with exactly this content:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COHORT_MIN_SELECTIVE_MARGIN,
  MIN_CONTRAST_N,
  abstentionDifficultyContrast,
  formatAbstentionContrastLines,
  judgeFamilyKey,
  type CohortJudgment,
  type CohortMember,
  type SubjectItem,
} from '@/lib/calibration/abstention';

// ─── The method, and the two real runs it separates ────────────────────────
//
// Handoff §5.3, applied to abstentions: do not infer difficulty from the
// mechanism, check it against judges that ANSWERED. lfm2.5:8b and
// lfm2.5-thinking:1.2b have statistically identical selective accuracy (0.5437
// vs 0.5363) and every metric before this one calls them the same object. The
// reference cohort does not: on the items lfm2.5:8b skipped Qwen3.6 scores
// 441/493 = 0.8945 against 93/100 = 0.9300 where it committed, while on the
// items lfm2.5-thinking skipped Qwen3.6 scores 51/52 = 0.9808 against 498/558 =
// 0.8925. One abstains on slightly harder items; the other abstains on items a
// competent judge finds EASIER.

/** Build a cohort member that is correct on exactly `correct` of the first
 *  `n` items of `itemIds` and wrong on the rest. Only counts matter to the
 *  function under test, so the construction is deliberately mechanical. */
function memberOver(
  base: Omit<CohortMember, 'judgments'>,
  arms: ReadonlyArray<{ itemIds: readonly string[]; correct: number }>
): CohortMember {
  const judgments: CohortJudgment[] = [];
  for (const arm of arms) {
    arm.itemIds.forEach((itemId, i) => {
      judgments.push({
        itemId,
        expected: 'A>B',
        preference: i < arm.correct ? 'A>B' : 'B>A',
      });
    });
  }
  return { ...base, judgments };
}

const ids = (prefix: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

const QWEN36_BASE = {
  calibrationRunId: 'cmtozu76f00012l5w4llb4pae',
  judgeLabel: 'Qwen3.6-35B-A3B (llama.cpp, local)',
  judgeModelVersionId: 'jv-qwen36',
  familyKey: 'qwen3.6',
  scoringVersion: 2,
  selectiveMarginOverConstant: 0.359,
};

describe('calibration/abstention: judgeFamilyKey', () => {
  it('collapses the two LFM judges onto one family and keeps the two Qwens apart', () => {
    // The confound the cohort rule exists for, and the pairing it must NOT
    // exclude. baseModel values are verbatim from JudgeModel, 2026-09-06.
    expect(judgeFamilyKey('lfm2.5:8b')).toBe('lfm2.5');
    expect(judgeFamilyKey('lfm2.5-thinking:1.2b')).toBe('lfm2.5');
    expect(judgeFamilyKey('qwen3.5:9b')).toBe('qwen3.5');
    expect(judgeFamilyKey('Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf')).toBe('qwen3.6');
    expect(judgeFamilyKey('granite4.1:3b')).toBe('granite4.1');
    expect(judgeFamilyKey('granite4.2:3b')).toBe('granite4.2');
    expect(judgeFamilyKey('mistrallite:7b')).toBe('mistrallite');
  });

  it('is a crude equality key and does not pretend otherwise', () => {
    // Both Claude models key to 'claude', which is right for them and would be
    // wrong for a family whose members are genuinely independent. Written down
    // as a known limitation rather than left to be discovered.
    expect(judgeFamilyKey('claude-opus-4-5-20250630')).toBe('claude');
    expect(judgeFamilyKey('claude-sonnet-4-6-20250627')).toBe('claude');
    // A bare filename with no separator survives whole; only equality matters.
    expect(judgeFamilyKey('Model.gguf')).toBe('model.gguf');
    // `JudgeModel.baseModel` is `String?` (schema :247), so null reaches here.
    // It keys to a sentinel, which means two judges with no baseModel exclude
    // EACH OTHER under rule 3 and neither joins a real family's cohort. Asserted
    // in this `it` rather than a new one because it is the same claim: the key
    // is an equality token and nothing more.
    expect(judgeFamilyKey(null)).toBe('(unknown)');
    expect(judgeFamilyKey(null)).not.toBe(judgeFamilyKey('lfm2.5:8b'));
  });
});

describe('calibration/abstention: cohort admission', () => {
  const subject = {
    calibrationRunId: 'cmtondblm00012lzcx1m2cyql',
    judgeModelVersionId: 'jv-lfm8b',
    familyKey: 'lfm2.5',
    scoringVersion: 2,
    items: [
      { itemId: 'a-0', abstained: true },
      { itemId: 'c-0', abstained: false },
    ] as SubjectItem[],
  };
  const candidate = (over: Partial<CohortMember>): CohortMember =>
    memberOver({ ...QWEN36_BASE, ...over } as Omit<CohortMember, 'judgments'>, [
      { itemIds: ['a-0'], correct: 1 },
      { itemIds: ['c-0'], correct: 1 },
    ]);

  it('admits a different judge, different family, matching version, clear margin', () => {
    const result = abstentionDifficultyContrast(subject, [candidate({})]);
    expect(result.admittedCount).toBe(1);
    expect(result.cohort[0].reason).toBe('admitted');
  });

  it('excludes the subject run itself', () => {
    const result = abstentionDifficultyContrast(subject, [
      candidate({ calibrationRunId: subject.calibrationRunId }),
    ]);
    expect(result.admittedCount).toBe(0);
    expect(result.cohort[0].reason).toContain('this IS the subject run');
  });

  it('excludes the same judge version — a judge cannot certify its own abstentions', () => {
    const result = abstentionDifficultyContrast(subject, [
      candidate({ judgeModelVersionId: 'jv-lfm8b' }),
    ]);
    expect(result.cohort[0].reason).toContain('same judge version');
  });

  it('excludes the same model family — the lfm2.5 confound, named in the reason', () => {
    const result = abstentionDifficultyContrast(subject, [
      candidate({ familyKey: 'lfm2.5', judgeModelVersionId: 'jv-lfm-thinking' }),
    ]);
    expect(result.admittedCount).toBe(0);
    expect(result.cohort[0].reason).toBe(
      'excluded: same model family (lfm2.5) as the subject — a shared failure mode manufactures agreement'
    );
  });

  it('excludes a judge at its own constant floor — lfm2.5-thinking at +0.0071', () => {
    const result = abstentionDifficultyContrast(subject, [
      candidate({
        familyKey: 'other',
        judgeModelVersionId: 'jv-other',
        selectiveMarginOverConstant: 0.0071,
      }),
    ]);
    expect(result.cohort[0].reason).toBe(
      'excluded: selective margin 0.0071 <= 0.05 — a judge at its own constant floor cannot certify an item as hard'
    );
  });

  it('excludes a member scored under a different generation, with an actionable reason', () => {
    const result = abstentionDifficultyContrast(subject, [candidate({ scoringVersion: null })]);
    expect(result.cohort[0].reason).toBe(
      "excluded: scoring version NULL does not match the subject's 2 — re-score it before comparing"
    );
  });

  it('a margin exactly ON the threshold is excluded — the rule is > , not >=', () => {
    const result = abstentionDifficultyContrast(subject, [
      candidate({ selectiveMarginOverConstant: COHORT_MIN_SELECTIVE_MARGIN }),
    ]);
    expect(result.admittedCount).toBe(0);
  });
});

describe('calibration/abstention: the contrast, on the two real runs', () => {
  it('lfm2.5:8b — the cohort does slightly WORSE where it abstained: 0.8945 vs 0.9300', () => {
    const abstained = ids('a', 500);
    const committed = ids('c', 103);
    const subject = {
      calibrationRunId: 'cmtondblm00012lzcx1m2cyql',
      judgeModelVersionId: 'jv-lfm8b',
      familyKey: 'lfm2.5',
      scoringVersion: 2,
      items: [
        ...abstained.map((itemId) => ({ itemId, abstained: true })),
        ...committed.map((itemId) => ({ itemId, abstained: false })),
      ] as SubjectItem[],
    };
    // 493 of the 500 and 100 of the 103 carry a COMMITTED Qwen3.6 judgment;
    // the rest are Qwen3.6's own 9 abstentions, which are no evidence about an
    // item and are dropped by passing `preference: null`.
    const cohort = memberOver(QWEN36_BASE, [
      { itemIds: abstained.slice(0, 493), correct: 441 },
      { itemIds: committed.slice(0, 100), correct: 93 },
    ]);
    const result = abstentionDifficultyContrast(subject, [cohort]);

    expect(result.onAbstained).toEqual({ n: 493, correct: 441, accuracy: 441 / 493 });
    expect(result.onCommitted).toEqual({ n: 100, correct: 93, accuracy: 93 / 100 });
    expect(result.contrast).toBeCloseTo(441 / 493 - 0.93, 12);
    expect(result.contrast).toBeLessThan(0);
    expect(result.interpretable).toBe(true);
  });

  it('lfm2.5-thinking — the cohort does BETTER where it abstained: 0.9808 vs 0.8925', () => {
    // The finding. Two judges that every prior metric calls identical, and this
    // one separates: these abstentions are anti-correlated with difficulty.
    const abstained = ids('a', 55);
    const committed = ids('c', 565);
    const subject = {
      calibrationRunId: 'cmtp3jwrf00012laoe6kmxgod',
      judgeModelVersionId: 'jv-lfm-thinking',
      familyKey: 'lfm2.5',
      scoringVersion: 2,
      items: [
        ...abstained.map((itemId) => ({ itemId, abstained: true })),
        ...committed.map((itemId) => ({ itemId, abstained: false })),
      ] as SubjectItem[],
    };
    const cohort = memberOver(QWEN36_BASE, [
      { itemIds: abstained.slice(0, 52), correct: 51 },
      { itemIds: committed.slice(0, 558), correct: 498 },
    ]);
    const result = abstentionDifficultyContrast(subject, [cohort]);

    expect(result.onAbstained).toEqual({ n: 52, correct: 51, accuracy: 51 / 52 });
    expect(result.onCommitted).toEqual({ n: 558, correct: 498, accuracy: 498 / 558 });
    expect(result.contrast).toBeGreaterThan(0);
    expect(result.contrast).toBeCloseTo(51 / 52 - 498 / 558, 12);
    expect(result.interpretable).toBe(true);
  });

  it('no overlap on one arm → that arm is null and the contrast is null, never 0', () => {
    // Qwen3.6's 9 abstentions overlap the still-draining qwen3.5:9b run on ZERO
    // items (verified against production 2026-09-06). A contrast of 0 would say
    // "the cohort found them exactly as hard", which was never measured.
    const subject = {
      calibrationRunId: 'cmtozu76f00012l5w4llb4pae',
      judgeModelVersionId: 'jv-qwen36',
      familyKey: 'qwen3.6',
      scoringVersion: 2,
      items: [
        ...ids('a', 9).map((itemId) => ({ itemId, abstained: true })),
        ...ids('c', 610).map((itemId) => ({ itemId, abstained: false })),
      ] as SubjectItem[],
    };
    const cohort = memberOver(
      {
        calibrationRunId: 'cmtluplg500012l0sj315kyar',
        judgeLabel: 'qwen3.5:9b (Ollama, local)',
        judgeModelVersionId: 'jv-qwen35',
        familyKey: 'qwen3.5',
        scoringVersion: 2,
        selectiveMarginOverConstant: 0.2852,
      },
      [{ itemIds: ids('c', 263), correct: 215 }]
    );
    const result = abstentionDifficultyContrast(subject, [cohort]);

    expect(result.onAbstained).toBeNull();
    expect(result.onCommitted).toEqual({ n: 263, correct: 215, accuracy: 215 / 263 });
    expect(result.contrast).toBeNull();
    expect(result.interpretable).toBe(false);
  });

  it('a cohort member that ABSTAINED on an item contributes nothing about it', () => {
    // preference: null is "no evidence", not "wrong". Counting it as a miss
    // would make a cautious cohort member manufacture difficulty everywhere.
    const subject = {
      calibrationRunId: 'subject',
      judgeModelVersionId: 'jv-s',
      familyKey: 'fam-s',
      scoringVersion: 2,
      items: [
        { itemId: 'a-0', abstained: true },
        { itemId: 'a-1', abstained: true },
        { itemId: 'c-0', abstained: false },
      ] as SubjectItem[],
    };
    const cohort: CohortMember = {
      ...QWEN36_BASE,
      judgments: [
        { itemId: 'a-0', expected: 'A>B', preference: 'A>B' },
        { itemId: 'a-1', expected: 'A>B', preference: null },
        { itemId: 'c-0', expected: 'A>B', preference: 'B>A' },
      ],
    };
    const result = abstentionDifficultyContrast(subject, [cohort]);

    expect(result.onAbstained).toEqual({ n: 1, correct: 1, accuracy: 1 });
    expect(result.onCommitted).toEqual({ n: 1, correct: 0, accuracy: 0 });
    expect(result.interpretable).toBe(false);
  });

  it('an EXCLUDED member contributes no judgments at all, not just no admission line', () => {
    // The wrong implementation this catches: building the admission list and
    // then pooling every candidate's judgments anyway.
    const subject = {
      calibrationRunId: 'subject',
      judgeModelVersionId: 'jv-s',
      familyKey: 'fam-s',
      scoringVersion: 2,
      items: [{ itemId: 'a-0', abstained: true }] as SubjectItem[],
    };
    const rejected: CohortMember = {
      ...QWEN36_BASE,
      familyKey: 'fam-s',
      judgments: [{ itemId: 'a-0', expected: 'A>B', preference: 'A>B' }],
    };
    const result = abstentionDifficultyContrast(subject, [rejected]);

    expect(result.admittedCount).toBe(0);
    expect(result.onAbstained).toBeNull();
  });
});

describe('calibration/abstention: formatAbstentionContrastLines', () => {
  const contrastFor = (abstainedN: number, abstainedCorrect: number) => {
    const abstained = ids('a', abstainedN);
    const committed = ids('c', 558);
    return abstentionDifficultyContrast(
      {
        calibrationRunId: 'cmtp3jwrf00012laoe6kmxgod',
        judgeModelVersionId: 'jv-lfm-thinking',
        familyKey: 'lfm2.5',
        scoringVersion: 2,
        items: [
          ...abstained.map((itemId) => ({ itemId, abstained: true })),
          ...committed.map((itemId) => ({ itemId, abstained: false })),
        ] as SubjectItem[],
      },
      [
        memberOver(QWEN36_BASE, [
          { itemIds: abstained, correct: abstainedCorrect },
          { itemIds: committed, correct: 498 },
        ]),
      ]
    );
  };

  it('reports both n values, the direction, and states that no p-value is computed', () => {
    const lines = formatAbstentionContrastLines(contrastFor(52, 51));
    expect(lines).toContain(
      '    cohort accuracy on the items the subject ABSTAINED on   0.9808   (51/52)'
    );
    expect(lines).toContain(
      '    cohort accuracy on the items the subject COMMITTED on   0.8925   (498/558)'
    );
    expect(lines).toContain('  contrast +0.0883   (abstained − committed)');
    expect(lines).toContain(
      '  POSITIVE: the cohort did BETTER on the items the subject skipped — the abstentions are NOT tracking difficulty.'
    );
    expect(lines[lines.length - 1]).toBe(
      '  No p-value is computed. This is a contrast with its sample sizes; read it with both n values or not at all.'
    );
  });

  it('flags NOT INTERPRETABLE below the minimum n, and still prints the numbers', () => {
    const lines = formatAbstentionContrastLines(contrastFor(10, 9));
    expect(lines.some((l) => l.includes('cohort accuracy on the items the subject ABSTAINED on'))).toBe(
      true
    );
    expect(lines).toContain(
      `  ⚠ NOT INTERPRETABLE: both arms need n >= ${MIN_CONTRAST_N} cohort judgments (have 10 and 558).`
    );
  });

  it('a NEGATIVE contrast says the abstentions land on HARDER items — the lfm2.5:8b direction', () => {
    // Every other fixture in this describe is built by `contrastFor`, which is
    // always POSITIVE (+0.0883 and +0.0075). Without this the NEGATIVE sentence
    // — the one the module's headline production result actually prints — is
    // never rendered by any test, and a formatter that printed POSITIVE for both
    // signs would pass the whole suite. 441/493 = 0.8945 against 93/100 = 0.9300,
    // the real lfm2.5:8b/Qwen3.6 shape.
    const abstained = ids('a', 493);
    const committed = ids('c', 100);
    const contrast = abstentionDifficultyContrast(
      {
        calibrationRunId: 'cmtondblm00012lzcx1m2cyql',
        judgeModelVersionId: 'jv-lfm8b',
        familyKey: 'lfm2.5',
        scoringVersion: 2,
        items: [
          ...abstained.map((itemId) => ({ itemId, abstained: true })),
          ...committed.map((itemId) => ({ itemId, abstained: false })),
        ] as SubjectItem[],
      },
      [
        memberOver(QWEN36_BASE, [
          { itemIds: abstained, correct: 441 },
          { itemIds: committed, correct: 93 },
        ]),
      ]
    );
    const lines = formatAbstentionContrastLines(contrast);
    expect(lines).toContain('  contrast -0.0355   (abstained − committed)');
    expect(lines).toContain(
      '  NEGATIVE: the cohort also did worse on the items the subject skipped — the abstentions land on genuinely harder items.'
    );
    expect(lines.some((l) => l.includes('POSITIVE'))).toBe(false);
  });

  it('lists every candidate with its admission reason, admitted or not', () => {
    const lines = formatAbstentionContrastLines(contrastFor(52, 51));
    expect(lines[1]).toBe('  reference cohort (1 admitted of 1 candidate(s)):');
    expect(lines[2]).toBe(
      '    ✓ Qwen3.6-35B-A3B (llama.cpp, local) [cmtozu76f00012l5w4llb4pae] — admitted'
    );
  });
});

describe('calibration/abstention: the CLI actually prints the contrast', () => {
  const SCRIPT = readFileSync(
    new URL('../../scripts/calibration/abstention.ts', import.meta.url),
    'utf8'
  );

  it('imports the module and prints every line it returns', () => {
    expect(SCRIPT).toContain("from '@/lib/calibration/abstention'");
    expect(SCRIPT.match(/formatAbstentionContrastLines\(/g)).toHaveLength(1);
    expect(SCRIPT).toMatch(
      /for \(const line of formatAbstentionContrastLines\(contrast\)\) console\.log\(line\);/
    );
    // The cohort is built from OTHER runs on the SAME golden set. A script that
    // passed `[]` would print a well-formed report with an empty cohort and no
    // error, which is the failure a shape assertion cannot see.
    expect(SCRIPT).toContain("goldenSetId: subject.goldenSetId");
    // …and TERMINAL runs only: a half-drained sibling contributes its
    // first-dequeued items to both arms, which is not a random subset.
    expect(SCRIPT).toContain('finishedAt: { not: null }');
  });
});
```

- [ ] **Step 3: Run it and confirm it fails for the reason expected**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected FAIL**: `Error: Failed to resolve import "@/lib/calibration/abstention" …`. The CLI guard's `readFileSync` will additionally throw `ENOENT … scripts/calibration/abstention.ts` once the module resolves, which is why that file is created in Step 5 and not later.

- [ ] **Step 4: Minimal implementation — `src/lib/calibration/abstention.ts`**

Create `/root/judge-arena/src/lib/calibration/abstention.ts` with exactly this content:

```ts
/**
 * ─── IS A JUDGE'S ABSTENTION CALIBRATED? ASK THE JUDGES THAT ANSWERED. ──────
 *
 * Coverage and selective accuracy say HOW MUCH a judge withholds and how good
 * it is when it does not. They cannot say whether the withholding is any good —
 * whether the items it skipped were actually hard, or whether 'tie' is just
 * noise it emits at some rate.
 *
 * THE METHOD IS HANDOFF §5.3's, applied to abstentions instead of truncations:
 * DO NOT INFER DIFFICULTY FROM THE MECHANISM, CHECK IT AGAINST JUDGES THAT
 * ANSWERED. For subject judge J with abstained set T and committed set C, take
 * a REFERENCE COHORT of other judges on the same golden set and compare their
 * accuracy on T against their accuracy on C. Materially worse on T means J
 * skipped genuinely harder items. BETTER on T means J's abstentions are not
 * tracking difficulty at all.
 *
 * IT SEPARATES TWO JUDGES THAT EVERY OTHER METRIC CALLS IDENTICAL. Measured
 * 2026-09-06 with Qwen3.6 as the cohort:
 *     lfm2.5:8b        abstained 441/493 = 0.8945   committed 93/100  = 0.9300
 *     lfm2.5-thinking  abstained  51/52  = 0.9808   committed 498/558 = 0.8925
 * Their selective accuracies are 0.5437 and 0.5363 — indistinguishable. Their
 * abstentions are not: one is weakly aimed at harder items, the other is aimed
 * at items a competent judge finds EASIER.
 *
 * CROSS-RUN, SO IT IS NOT IN scoreCalibrationRun. That function is defined over
 * one calibrationRunId and writes one row as a full overwrite; a value that
 * changes when an UNRELATED judge finishes would make re-scoring run A depend on
 * the state of run B. Nothing here is stored.
 *
 * WHO IS ALLOWED IN THE COHORT, in order, and why each rule exists:
 *   1. not the subject run itself;
 *   2. not the same judgeModelVersionId — a judge cannot certify its own
 *      abstentions;
 *   3. not the same model FAMILY — lfm2.5:8b and lfm2.5-thinking:1.2b have
 *      near-identical selective accuracy and may share a failure mode, and two
 *      judges failing the same way manufacture agreement. NOTE HONESTLY: rule 4
 *      already excludes every LFM pairing on today's corpus, so this rule is a
 *      POLICY for the future case, not a measurement;
 *   4. selectiveMarginOverConstant > COHORT_MIN_SELECTIVE_MARGIN — a judge at
 *      its own constant floor is emitting its marginal, not measuring the item.
 *      On the 620-item set: Qwen3.6 +0.3590 and qwen3.5:9b +0.2852 in;
 *      lfm2.5-thinking +0.0071 and lfm2.5:8b +0.0194 out;
 *   5. the same scoringVersion as the subject — mixing rule generations is what
 *      the stamp exists to prevent, and the margin in rule 4 only exists from
 *      generation 2 on. Excluded members get an ACTIONABLE reason, never a
 *      silent drop.
 *
 * COHORT ACCURACY IS OVER THE COHORT'S COMMITTED JUDGMENTS ONLY. A cohort
 * member's own abstention is not evidence about an item; counting it as a miss
 * would let a cautious member manufacture difficulty everywhere. KNOWN BIAS,
 * with its direction stated: if the cohort also abstains preferentially on hard
 * items, dropping those inflates the abstained arm and pulls the contrast toward
 * zero — CONSERVATIVE, it hides calibrated abstention rather than inventing it.
 * Measured here it is negligible (Qwen3.6 abstained on 1.4% of lfm2.5:8b's
 * abstained items and 2.0% of its committed ones).
 *
 * NO P-VALUE, DELIBERATELY. The two arms are not independent (the same cohort
 * judgments populate both comparisons), the item sets are not random samples,
 * and a figure carrying a p-value's authority without its assumptions is worse
 * than no figure. What IS reported is both n values, always, and a refusal to
 * call the contrast interpretable below MIN_CONTRAST_N on either arm.
 *
 * PURE AND A LEAF: one type-only import.
 */

import type { Preference } from '@/lib/calibration/readings';

/**
 * Minimum cohort judgments on EACH arm before the contrast means anything.
 *
 * A policy number with a stated basis, not a derived one. At the arms actually
 * measured (493 and 100, accuracies near 0.9) one standard error on the
 * difference is about 0.029, and the contrast measured for lfm2.5:8b is 0.0355
 * — roughly 1.2 se, i.e. already at the edge of readable. At n = 30 the
 * standard error exceeds 0.09 and swamps any contrast this method could see, so
 * below that the numbers are printed with their n and explicitly not called a
 * result.
 */
export const MIN_CONTRAST_N = 30;

/**
 * A cohort member must beat its own constant floor by more than this.
 *
 * Also a policy number: it sits an order of magnitude above the two margins it
 * rejects on this corpus (+0.0071, +0.0194) and an order of magnitude below the
 * two it admits (+0.2852, +0.3590), so nothing measured is anywhere near it.
 * The first judge to land between 0.02 and 0.20 is the reason to revisit it.
 */
export const COHORT_MIN_SELECTIVE_MARGIN = 0.05;

/**
 * A crude EQUALITY key for "same model family", from `JudgeModel.baseModel`:
 * lowercase, then the segment before the first ':' and then before the first
 * '-'. `lfm2.5:8b` and `lfm2.5-thinking:1.2b` both key to `lfm2.5` (the pairing
 * this exists to exclude); `qwen3.5:9b` and `Qwen3.6-35B-A3B-UD-Q3_K_XL.gguf`
 * key to `qwen3.5` and `qwen3.6` (different generations, correctly admitted).
 *
 * Crude on purpose, and its limits are in the unit test rather than in a
 * comment nobody reads: both Claude models key to `claude`, which is right for
 * them and would be wrong for a family whose members are genuinely independent;
 * a name with no separator survives whole. Only equality is ever asked of it.
 *
 * `JudgeModel.baseModel` is `String?` (prisma/schema.prisma:247), so the
 * parameter takes the null. NULL is not a family, and it maps to a SENTINEL
 * rather than to `''` or to the model's name: two judges with no baseModel then
 * key ALIKE and exclude EACH OTHER under rule 3 — the conservative direction,
 * since an unknown family cannot be proven different — and the exclusion reason
 * prints `(unknown)`, so an operator can see the cause and set the column.
 * Production has 10 JudgeModel rows and 0 NULLs today (read-only, 2026-09-06);
 * the branch is here because the COLUMN allows it, not because a row does.
 */
export function judgeFamilyKey(baseModel: string | null): string {
  if (baseModel === null) return '(unknown)';
  return baseModel.toLowerCase().split(':')[0].split('-')[0];
}

export type CohortJudgment = {
  itemId: string;
  expected: Preference;
  /** What the member MEANT, or `null` when it did not commit — it abstained
   *  with 'tie', or produced no usable verdict. Both are "no evidence about
   *  this item", which is the only thing this function asks of a member, and
   *  collapsing them here keeps the caller from having to decide. */
  preference: Preference | null;
};

export type CohortMember = {
  calibrationRunId: string;
  /** For the report. Normally `JudgeModel.name`. */
  judgeLabel: string;
  judgeModelVersionId: string;
  familyKey: string;
  scoringVersion: number | null;
  selectiveMarginOverConstant: number | null;
  judgments: readonly CohortJudgment[];
};

export type SubjectItem = { itemId: string; abstained: boolean };

export type AbstentionSubject = {
  calibrationRunId: string;
  judgeModelVersionId: string;
  familyKey: string;
  scoringVersion: number | null;
  /** Only items with a VERDICT. An item the subject never answered is neither
   *  an abstention nor a commitment and must not appear here. */
  items: readonly SubjectItem[];
};

export type ContrastArm = { n: number; correct: number; accuracy: number };

export type CohortAdmission = {
  calibrationRunId: string;
  judgeLabel: string;
  admitted: boolean;
  reason: string;
};

export type AbstentionContrast = {
  subjectCalibrationRunId: string;
  subjectAbstainedItems: number;
  subjectCommittedItems: number;
  /** EVERY candidate with its verdict and reason — the report prints the
   *  rejections too, because "the cohort was empty" and "the cohort was three
   *  judges that all failed rule 4" look identical in a number. */
  cohort: CohortAdmission[];
  admittedCount: number;
  onAbstained: ContrastArm | null;
  onCommitted: ContrastArm | null;
  /** onAbstained − onCommitted. `null` when either arm has no cohort judgment
   *  at all — NEVER 0, which would say "the cohort found them exactly as hard"
   *  about a comparison nobody made. */
  contrast: number | null;
  interpretable: boolean;
};

const ADMITTED = 'admitted';

function admissionReason(subject: AbstentionSubject, candidate: CohortMember): string {
  if (candidate.calibrationRunId === subject.calibrationRunId) {
    return 'excluded: this IS the subject run';
  }
  if (candidate.judgeModelVersionId === subject.judgeModelVersionId) {
    return 'excluded: same judge version as the subject — a judge cannot certify its own abstentions';
  }
  if (candidate.familyKey === subject.familyKey) {
    return (
      `excluded: same model family (${candidate.familyKey}) as the subject — ` +
      'a shared failure mode manufactures agreement'
    );
  }
  if (candidate.scoringVersion !== subject.scoringVersion) {
    const seen = candidate.scoringVersion === null ? 'NULL' : String(candidate.scoringVersion);
    const want = subject.scoringVersion === null ? 'NULL' : String(subject.scoringVersion);
    return `excluded: scoring version ${seen} does not match the subject's ${want} — re-score it before comparing`;
  }
  if (candidate.selectiveMarginOverConstant === null) {
    return (
      'excluded: selective margin is unavailable (selectiveAccuracy or ' +
      'selectiveBaselineAccuracy is NULL) — either the run has not been re-scored ' +
      'since v2n, or it committed on nothing; re-score it with --score-only and re-read'
    );
  }
  if (candidate.selectiveMarginOverConstant <= COHORT_MIN_SELECTIVE_MARGIN) {
    return (
      `excluded: selective margin ${candidate.selectiveMarginOverConstant.toFixed(4)} <= ` +
      `${COHORT_MIN_SELECTIVE_MARGIN} — a judge at its own constant floor cannot certify an item as hard`
    );
  }
  return ADMITTED;
}

export function abstentionDifficultyContrast(
  subject: AbstentionSubject,
  candidates: readonly CohortMember[]
): AbstentionContrast {
  const abstained = new Set<string>();
  const committed = new Set<string>();
  for (const item of subject.items) {
    (item.abstained ? abstained : committed).add(item.itemId);
  }

  const cohort: CohortAdmission[] = [];
  const admitted: CohortMember[] = [];
  for (const candidate of candidates) {
    const reason = admissionReason(subject, candidate);
    cohort.push({
      calibrationRunId: candidate.calibrationRunId,
      judgeLabel: candidate.judgeLabel,
      admitted: reason === ADMITTED,
      reason,
    });
    if (reason === ADMITTED) admitted.push(candidate);
  }

  let abstainedN = 0;
  let abstainedCorrect = 0;
  let committedN = 0;
  let committedCorrect = 0;
  for (const member of admitted) {
    for (const judgment of member.judgments) {
      // No evidence, not a miss.
      if (judgment.preference === null) continue;
      const hit = judgment.preference === judgment.expected ? 1 : 0;
      if (abstained.has(judgment.itemId)) {
        abstainedN += 1;
        abstainedCorrect += hit;
      } else if (committed.has(judgment.itemId)) {
        committedN += 1;
        committedCorrect += hit;
      }
    }
  }

  const onAbstained =
    abstainedN === 0
      ? null
      : { n: abstainedN, correct: abstainedCorrect, accuracy: abstainedCorrect / abstainedN };
  const onCommitted =
    committedN === 0
      ? null
      : { n: committedN, correct: committedCorrect, accuracy: committedCorrect / committedN };

  return {
    subjectCalibrationRunId: subject.calibrationRunId,
    subjectAbstainedItems: abstained.size,
    subjectCommittedItems: committed.size,
    cohort,
    admittedCount: admitted.length,
    onAbstained,
    onCommitted,
    contrast:
      onAbstained === null || onCommitted === null
        ? null
        : onAbstained.accuracy - onCommitted.accuracy,
    interpretable: abstainedN >= MIN_CONTRAST_N && committedN >= MIN_CONTRAST_N,
  };
}

const fmt4 = (n: number): string => n.toFixed(4);

const arm = (a: ContrastArm | null): string =>
  a === null ? 'n/a   (n=0)' : `${fmt4(a.accuracy)}   (${a.correct}/${a.n})`;

export function formatAbstentionContrastLines(contrast: AbstentionContrast): string[] {
  const lines = [
    `  subject ${contrast.subjectCalibrationRunId}   abstained on ${contrast.subjectAbstainedItems} item(s), committed on ${contrast.subjectCommittedItems}`,
    `  reference cohort (${contrast.admittedCount} admitted of ${contrast.cohort.length} candidate(s)):`,
  ];
  for (const member of contrast.cohort) {
    lines.push(
      `    ${member.admitted ? '✓' : '✗'} ${member.judgeLabel} [${member.calibrationRunId}] — ${member.reason}`
    );
  }

  if (contrast.onAbstained === null && contrast.onCommitted === null) {
    lines.push(
      '  the admitted cohort answered NOTHING the subject also answered — no contrast, and that is null, not zero.'
    );
    return lines;
  }

  lines.push(
    `    cohort accuracy on the items the subject ABSTAINED on   ${arm(contrast.onAbstained)}`
  );
  lines.push(
    `    cohort accuracy on the items the subject COMMITTED on   ${arm(contrast.onCommitted)}`
  );

  if (contrast.contrast === null) {
    lines.push('  contrast n/a — one arm carries no cohort judgment at all. That is null, not 0.');
  } else {
    const sign = contrast.contrast >= 0 ? '+' : '';
    lines.push(`  contrast ${sign}${fmt4(contrast.contrast)}   (abstained − committed)`);
    lines.push(
      contrast.contrast < 0
        ? '  NEGATIVE: the cohort also did worse on the items the subject skipped — the abstentions land on genuinely harder items.'
        : '  POSITIVE: the cohort did BETTER on the items the subject skipped — the abstentions are NOT tracking difficulty.'
    );
  }

  if (!contrast.interpretable) {
    lines.push(
      `  ⚠ NOT INTERPRETABLE: both arms need n >= ${MIN_CONTRAST_N} cohort judgments ` +
        `(have ${contrast.onAbstained?.n ?? 0} and ${contrast.onCommitted?.n ?? 0}).`
    );
  }

  lines.push(
    '  No p-value is computed. This is a contrast with its sample sizes; read it with both n values or not at all.'
  );
  return lines;
}
```

- [ ] **Step 5: Create the CLI**

Create `/root/judge-arena/scripts/calibration/abstention.ts` with exactly this content:

```ts
/**
 * ─── Is this judge's abstention calibrated? Ask the judges that answered. ───
 *
 * Usage:
 *   npm run calibration:abstention -- --subject=<calibrationRunId>
 *
 * EX POST AND READ-ONLY. Nothing here launches a judgment, calls a provider or
 * writes a row: it reads stored verdicts for the subject run and for every other
 * scored run on the SAME golden set, and prints one contrast. Safe to run while
 * a calibration is draining — which one is, as of 2026-09-06.
 *
 * The rules live in src/lib/calibration/abstention.ts and are unit-tested there;
 * this file selects rows and prints what the module returns
 * (CONTRIBUTING.md:247 — put every rule that can be silently wrong into
 * src/lib/** so that it CAN be unit-tested). scripts/** is outside every
 * coverage include, so a rule written here would be permanently unguarded.
 */
import {
  abstentionDifficultyContrast,
  formatAbstentionContrastLines,
  judgeFamilyKey,
  type CohortJudgment,
  type CohortMember,
  type SubjectItem,
} from '@/lib/calibration/abstention';
import {
  preferenceFromVerdict,
  type PairOrder,
  type Preference,
  type Verdict,
} from '@/lib/calibration/readings';
import { describeScoringVersion } from '@/lib/calibration/scoring-version';
import { prisma } from '@/lib/db';

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const PREFERENCE_KEYS = new Set(['A>B', 'B>A', 'tie']);

type JudgmentRow = {
  verdict: string | null;
  pairOrder: string | null;
  run: { goldenItemId: string | null; goldenItem: { expected: string | null } | null };
};

/** Stored verdicts for one calibration, projected onto the module's shape.
 *  A verdict this build cannot read yields `preference: null` — the same
 *  "absent, not wrong" rule the scorer uses — rather than being let fall
 *  through to 'tie', which readings.ts:106-113 refuses for exactly this
 *  reason. */
function project(rows: JudgmentRow[]): CohortJudgment[] {
  const out: CohortJudgment[] = [];
  for (const row of rows) {
    const itemId = row.run.goldenItemId;
    const expected = row.run.goldenItem?.expected ?? null;
    if (itemId === null || expected === null || !PREFERENCE_KEYS.has(expected)) continue;
    // An explicit VOCABULARY GATE rather than a cast that hopes, because the
    // docstring above promises a null and a bare cast cannot deliver one:
    // `preferenceFromVerdict` THROWS CalibrationReadingsError('unrecognised-verdict')
    // on anything outside 'A' | 'B' | 'tie' (readings.ts:102-114), so a single
    // corrupt row would kill the whole report; and it reads every non-'AB'
    // pairOrder as 'BA' (readings.ts:104-105), so a corrupt pairOrder would
    // silently INVERT a preference. `score.ts` is protected from both because
    // `groundTruthReadings` raises `missing-pair-order` first; this path has no
    // such guard. `SELECT DISTINCT "pairOrder"` returns only 'AB' today — this
    // is about what the COLUMNS allow, not about a row that exists.
    const readable =
      (row.verdict === 'A' || row.verdict === 'B') &&
      (row.pairOrder === 'AB' || row.pairOrder === 'BA');
    const preference = readable
      ? preferenceFromVerdict(row.verdict as Verdict, row.pairOrder as PairOrder)
      : null;
    out.push({ itemId, expected: expected as Preference, preference });
  }
  return out;
}

async function judgmentsFor(calibrationRunId: string): Promise<JudgmentRow[]> {
  return prisma.modelJudgment.findMany({
    where: { run: { calibrationRunId }, status: 'completed' },
    select: {
      verdict: true,
      pairOrder: true,
      run: { select: { goldenItemId: true, goldenItem: { select: { expected: true } } } },
    },
  });
}

async function main(): Promise<void> {
  const subjectId = arg('subject');
  if (!subjectId) throw new Error('Need --subject=<calibrationRunId>.');

  const subject = await prisma.calibrationRun.findUnique({
    where: { id: subjectId },
    select: {
      id: true,
      goldenSetId: true,
      scoringVersion: true,
      judgeModelVersionId: true,
      judgeModelVersion: { select: { judgeModel: { select: { name: true, baseModel: true } } } },
    },
  });
  if (!subject) throw new Error(`No CalibrationRun ${subjectId}.`);

  console.log('── Abstention calibration ─────────────────────────────────');
  console.log(`  subject   ${subject.judgeModelVersion.judgeModel.name}`);
  console.log(`  set       ${subject.goldenSetId}`);
  console.log(`  scoring   ${describeScoringVersion(subject.scoringVersion)}`);

  const subjectItems: SubjectItem[] = [];
  for (const row of await judgmentsFor(subject.id)) {
    // Only items with a VERDICT. An item the subject never answered is neither
    // an abstention nor a commitment.
    if (row.run.goldenItemId === null || row.verdict === null) continue;
    subjectItems.push({ itemId: row.run.goldenItemId, abstained: row.verdict === 'tie' });
  }

  const siblings = await prisma.calibrationRun.findMany({
    // TERMINAL runs only. A still-draining run's judgments are the items that
    // dequeued FIRST, not a random subset of the set, so pooling them biases
    // BOTH arms in a direction nothing here can measure. On 2026-09-06
    // cmtluplg500012l0sj315kyar is excluded by rule 5 anyway (its scoringVersion
    // is NULL) — but the moment an operator backfills it mid-flight it would
    // silently enter every cohort, which is exactly what §6.1 warns against.
    where: { goldenSetId: subject.goldenSetId, finishedAt: { not: null } },
    select: {
      id: true,
      scoringVersion: true,
      selectiveAccuracy: true,
      selectiveBaselineAccuracy: true,
      judgeModelVersionId: true,
      judgeModelVersion: { select: { judgeModel: { select: { name: true, baseModel: true } } } },
    },
  });

  const candidates: CohortMember[] = [];
  for (const sibling of siblings) {
    candidates.push({
      calibrationRunId: sibling.id,
      judgeLabel: sibling.judgeModelVersion.judgeModel.name,
      judgeModelVersionId: sibling.judgeModelVersionId,
      familyKey: judgeFamilyKey(sibling.judgeModelVersion.judgeModel.baseModel),
      scoringVersion: sibling.scoringVersion,
      // The margin the cohort rule gates on, reconstructed from the two stored
      // v2n columns rather than re-derived from judgments: it must be the same
      // number the scoreboard shows, and NULL when either side is.
      selectiveMarginOverConstant:
        sibling.selectiveAccuracy === null || sibling.selectiveBaselineAccuracy === null
          ? null
          : sibling.selectiveAccuracy - sibling.selectiveBaselineAccuracy,
      judgments: project(await judgmentsFor(sibling.id)),
    });
  }

  const contrast = abstentionDifficultyContrast(
    {
      calibrationRunId: subject.id,
      judgeModelVersionId: subject.judgeModelVersionId,
      familyKey: judgeFamilyKey(subject.judgeModelVersion.judgeModel.baseModel),
      scoringVersion: subject.scoringVersion,
      items: subjectItems,
    },
    candidates
  );

  for (const line of formatAbstentionContrastLines(contrast)) console.log(line);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

**The `goldenSetId: subject.goldenSetId` filter is the line the CLI guard test pins**, because a script that queried every `CalibrationRun` would build a cohort of judges that never saw these items, produce two empty arms, print a well-formed report and be wrong in a way no shape assertion can see.

- [ ] **Step 6: Register the script**

Edit `/root/judge-arena/package.json`.

old_string:
```
    "calibration:run": "tsx scripts/calibration/run.ts"
```
new_string:
```
    "calibration:run": "tsx scripts/calibration/run.ts",
    "calibration:abstention": "tsx scripts/calibration/abstention.ts"
```

- [ ] **Step 7: Run to pass**

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

Expected: `Tests  19 passed (19)`, `Test Files  1 passed (1)` — 2 family-key, 7 admission, 5 contrast, **4** formatter, 1 CLI guard. **Use the printed number**; if it is not 19, count the `it(` blocks before assuming anything.

- [ ] **Step 8: INJECTION M — the family rule**

Edit `/root/judge-arena/src/lib/calibration/abstention.ts`.

old_string:
```
  return baseModel.toLowerCase().split(':')[0].split('-')[0];
```
new_string:
```
  return baseModel.toLowerCase().split(':')[0];
```

(The single body line, not the whole function — the `null` guard above it is not
what this injection is about, and quoting only the line that changes keeps the
`old_string` unique in the file.)

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, exactly two tests:**
- `collapses the two LFM judges onto one family and keeps the two Qwens apart` → `expected 'lfm2.5-thinking' to be 'lfm2.5'`
- `is a crude equality key and does not pretend otherwise` → `expected 'claude' to be 'claude'`… **no** — under this injection `'claude-opus-4-5-20250630'` returns `'claude-opus-4-5-20250630'`, so the message is `expected 'claude-opus-4-5-20250630' to be 'claude'`.

Dropping the `-` split is the *plausible* wrong implementation (`:` alone looks like the separator that matters for Ollama tags) and it silently readmits the exact pairing the rule exists to exclude. **Restore and re-run to green.**

- [ ] **Step 9: INJECTION N — an excluded member must contribute NOTHING**

Edit `/root/judge-arena/src/lib/calibration/abstention.ts`.

old_string:
```
    if (reason === ADMITTED) admitted.push(candidate);
```
new_string:
```
    admitted.push(candidate);
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, EXACTLY FOUR tests — every one of them on `admittedCount`, none of them on a `reason` string** (in file order):

- `excludes the subject run itself` → `expected 1 to be +0`
- `excludes the same model family — the lfm2.5 confound, named in the reason` → `expected 1 to be +0`
- `a margin exactly ON the threshold is excluded — the rule is > , not >=` → `expected 1 to be +0`
- `an EXCLUDED member contributes no judgments at all, not just no admission line` → `expected 1 to be +0` (its `admittedCount` assertion precedes the `onAbstained` one, so that is the message you get, not `expected { n: 1, … } to be null`)

**Read the GREEN list, because it is the point.** `excludes the same judge version`, `excludes a judge at its own constant floor` and `excludes a member scored under a different generation` assert only on `reason`, and `admissionReason` is untouched by this injection — so they pass while the cohort is pooled from every rejected candidate. An admission list that is RIGHT over a pooling that is WRONG is the "well-formed report built from the wrong rows" failure, and only an assertion on `admittedCount` or on an arm can see it. `admits a different judge, …` also stays green, correctly: that member is admitted either way. **If a `reason` assertion moves under this injection, something other than the push guard has been edited.** **Restore and re-run to green.**

- [ ] **Step 10: INJECTION O — a cohort abstention is not a miss**

Edit `/root/judge-arena/src/lib/calibration/abstention.ts`.

old_string:
```
      // No evidence, not a miss.
      if (judgment.preference === null) continue;
      const hit = judgment.preference === judgment.expected ? 1 : 0;
```
new_string:
```
      const hit = judgment.preference === judgment.expected ? 1 : 0;
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, exactly one test:**
- `a cohort member that ABSTAINED on an item contributes nothing about it` → `expected { n: 2, correct: 1, accuracy: 0.5 } to deeply equal { n: 1, correct: 1, accuracy: 1 }`

The injected version counts a cohort abstention as a wrong answer, which makes any cautious cohort member report every item as hard — the exact way this method could manufacture the finding it is supposed to test. **Restore and re-run to green.**

- [ ] **Step 11: INJECTION P — null-not-zero on an empty arm**

Edit `/root/judge-arena/src/lib/calibration/abstention.ts`.

old_string:
```
    contrast:
      onAbstained === null || onCommitted === null
        ? null
        : onAbstained.accuracy - onCommitted.accuracy,
```
new_string:
```
    contrast: (onAbstained?.accuracy ?? 0) - (onCommitted?.accuracy ?? 0),
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, exactly one test:**
- `no overlap on one arm → that arm is null and the contrast is null, never 0` → `expected -0.8174904942965779 to be null`

The injected value is not even 0 — it is minus the committed arm — which is *worse* than the tempting `0` and lands in exactly the range a reader would interpret as "these abstentions were on catastrophically harder items". This is the Qwen3.6 case, which is real: its 9 abstentions overlap the qwen3.5:9b run on zero items. **Restore and re-run to green.**

- [ ] **Step 11b: INJECTION P2 — the direction sentence is the finding**

The `contrast` number and the sentence beside it are two renderings of one fact, and only the sentence is read. Edit `/root/judge-arena/src/lib/calibration/abstention.ts`.

old_string:
```
      contrast.contrast < 0
```
new_string:
```
      contrast.contrast > 0
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, exactly two tests — one in each direction, which is what makes this discriminating:**
- `reports both n values, the direction, and states that no p-value is computed` → `expected [ … ] to contain '  POSITIVE: the cohort did BETTER on the items the subject skipped — the abstentions are NOT tracking difficulty.'`
- `a NEGATIVE contrast says the abstentions land on HARDER items — the lfm2.5:8b direction` → `expected [ … ] to contain '  NEGATIVE: the cohort also did worse on the items the subject skipped — the abstentions land on genuinely harder items.'`

`flags NOT INTERPRETABLE below the minimum n` stays green: its contrast is `9/10 − 498/558 = +0.0075`, and it asserts nothing about direction. **This injection is the reason the negative fixture exists** — with only `contrastFor` fixtures, which are always positive, swapping the two sentences leaves the entire suite green while every negative result in production reads backwards. **Restore and re-run to green.**

- [ ] **Step 12: INJECTION Q — the CLI queries the SAME golden set**

Edit `/root/judge-arena/scripts/calibration/abstention.ts`.

old_string:
```
    where: { goldenSetId: subject.goldenSetId, finishedAt: { not: null } },
```
new_string:
```
    where: {},
```

```bash
npx vitest run --root /root/judge-arena tests/lib/calibration-abstention.test.ts
```

**Expected RED, exactly one test:**
- `imports the module and prints every line it returns` → `expected 'import {\n  abstentionDifficultyContrast,…' to contain "goldenSetId: subject.goldenSetId"` (the `goldenSetId` assertion precedes the `finishedAt` one, so that is the message; the injection deletes both filters at once)

**What this catches and what it does not.** It catches the filter being deleted or renamed. It does NOT prove the query returns the right rows — nothing here executes the script or touches a database (Post-landing checklist item 2). The failure it guards against is concrete and would be silent: `where: {}` builds a cohort out of the 15 runs on the OTHER golden set, which share no `goldenItemId` with the subject, so both arms come back empty and the report prints "the admitted cohort answered NOTHING the subject also answered" — a well-formed sentence, a plausible-looking outcome, and entirely an artefact of the query. **Restore and re-run to green.**

- [ ] **Step 12b: Bundle the CLI into the image — otherwise it cannot be run where the data is**

`Dockerfile:150` esbuilds `scripts/calibration/run.ts` and nothing else under `scripts/calibration/`. The runner ships no TypeScript toolchain, so an unbundled `scripts/calibration/abstention.ts` is a command with no in-cluster entry point — and `npm run calibration:abstention` from a workstation cannot reach the only database that has these rows. Edit `/root/judge-arena/Dockerfile`.

old_string:
```
RUN npx esbuild scripts/calibration/run.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/calibration-run.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning
```
new_string:
```
RUN npx esbuild scripts/calibration/run.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/calibration-run.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning

# Abstention calibration (ex post, read-only). Same treatment and the same
# reason as the runner above: it reads stored verdicts for the subject run AND
# for every other terminal scored run on the same golden set, and the only
# database holding those rows is production, which only a pod can reach. It
# launches nothing, calls no provider and writes no row. Unbundled it would be a
# CLI that cannot be run against the data it exists for.
RUN npx esbuild scripts/calibration/abstention.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/calibration-abstention.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning
```

Nothing in this plan builds the image — `npm run build` in Task 2 is `next build`, which does not read the `Dockerfile`. The esbuild block is proved only by CI on the operator's push, which is why the entry name `calibration-abstention.js` is repeated in the Post-landing checklist rather than assumed.

- [ ] **Step 13: Gates**

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -30
```

Expected: lint 0; tsc silent; **`B + 59` tests over `F + 3` files** (7 + 15 + 18 + 19) — on a 1007/61 baseline that is `Tests  1066 passed (1066)` over `Test Files  64 passed (64)`. **Arithmetic on Step 0's measurement.**

`package.json` is edited but no gate reads it here; the script is `tsc`-gated (`tsconfig.json` includes `**/*.ts`) and lint-gated (`eslint src/ prisma/ scripts/ tests/`). It is **not** run: running it needs a database, and the only database with these rows is production.

- [ ] **Step 14: Commit**

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add \
  src/lib/calibration/abstention.ts \
  scripts/calibration/abstention.ts \
  tests/lib/calibration-abstention.test.ts \
  package.json \
  Dockerfile
git -C /root/judge-arena status --short
git -C /root/judge-arena commit --only \
  src/lib/calibration/abstention.ts \
  scripts/calibration/abstention.ts \
  tests/lib/calibration-abstention.test.ts \
  package.json \
  Dockerfile \
  -F - <<'EOF'
feat(calibration): contrast a judge's abstentions against the cohort that answered them

Coverage says how much a judge withholds and selective accuracy says how good it
is when it does not. Neither says whether the withholding is any good. Handoff
§5.3's method answers that without inferring difficulty from the mechanism: for
subject J, compare a reference cohort's accuracy on the items J skipped against
its accuracy on the items J answered.

It separates two judges every other metric calls identical. With Qwen3.6 as the
cohort, measured 2026-09-06: on lfm2.5:8b's abstentions 441/493 = 0.8945 against
93/100 = 0.9300 where it committed; on lfm2.5-thinking's abstentions 51/52 =
0.9808 against 498/558 = 0.8925. Their selective accuracies are 0.5437 and
0.5363. One skips items that are slightly harder; the other skips items a
competent judge finds EASIER, which is anti-calibration and was invisible before.

Cross-run, so deliberately not in scoreCalibrationRun: a value that moves when an
unrelated judge finishes cannot live in a single-run full-overwrite scorer.
Nothing is stored.

Cohort admission is explicit and every rejection prints its reason. Not the
subject, not the same judge version, not the same model family — the brief's
confound, since lfm2.5:8b and lfm2.5-thinking have near-identical selective
accuracy and could manufacture agreement — same scoring version, and a selective
margin above 0.05, because a judge at its own constant floor is emitting its
marginal rather than measuring the item. The margin rule alone already excludes
every LFM pairing on this corpus, so the family rule is a stated policy for the
future case, not a measurement.

Cohort accuracy is over the cohort's COMMITTED judgments only; a member's own
abstention is no evidence about an item, and counting it as a miss would let a
cautious member report everything as hard. The bias that introduces is stated
with its direction — it pulls the contrast toward zero, so it hides calibrated
abstention rather than inventing it — and measures 1.4% vs 2.0% here.

Both n values are always reported and no p-value is computed: the arms are not
independent, the item sets are not random samples, and a figure with a p-value's
authority and none of its assumptions is worse than no figure. Below n=30 on
either arm the contrast is printed and explicitly not called a result. An arm
with no overlap at all is null, never 0 — Qwen3.6's 9 abstentions overlap the
in-flight qwen3.5:9b run on zero items.

The Dockerfile gains an esbuild block for the new CLI, for the same reason the
calibration runner has one: the runner ships no TypeScript toolchain and the only
database holding these rows is production, which only a pod can reach. Unbundled
it would be a command with no place to run.

Gates: lint 0, tsc 0, <B+59> unit / n-a db (no tests/db file, no schema change) / n-a integration (no tests/integration file), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **5 files changed** — the module, the CLI, its test, `package.json` and the `Dockerfile`.

---

### Task 6: the runbook — backfill order, the new report block, and a negative result

**Files:**
- Modify: `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md` — three insertions plus one CORRECTION: a new **§6.1** after §6 (`:276-280`), a new **§7.5** and **§7.6** immediately before `## 8. Known failure modes` (`:394-398`), a new **§10** appended after `:731`, and a **CORRECTION note appended to §7.1's existing v2l blockquote** (`:294-309`), because §7.1 claims its fenced Result block is "the print template applied to them, in the order `run.ts` prints" and Tasks 3 and 4 change that order. CONTRIBUTING.md:1653-1656 is explicit: a wrong claim in a doc gets a note that quotes what it used to say, never a silent overwrite.
- Test: **none.** No suite reads `docs/`. This is stated rather than implied: the only guard on these edits is the `grep` verification in Step 4, and Step 4 says what that grep can and cannot discriminate.

**Interfaces:** none. Documentation only.

- [ ] **Step 0: Confirm the starting state and capture the SHA**

```bash
git -C /root/judge-arena log -1 --format='%h %s' && git -C /root/judge-arena status --porcelain && wc -l /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
HEAD must be Task 5's commit. The runbook is **732 lines** on `2e7e142`; if it is not, a sibling plan has edited it and every anchor below must be re-verified with `grep -n` before use.

- [ ] **Step 1: Edit 1 — §6.1, the backfill and its ordering constraint**

Edit `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`.

old_string:
```
It **cannot** rescue a dead-lettered item — there is no verdict to score. Only a fresh run can, and a
fresh run against the same set is a **new** `CalibrationRun` row, not a repair of the old one.

---

## 7. How to read the output
```
new_string:
```
It **cannot** rescue a dead-lettered item — there is no verdict to score. Only a fresh run can, and a
fresh run against the same set is a **new** `CalibrationRun` row, not a repair of the old one.

### 6.1 Backfilling the whole table after a scoring-rule change

**This is the payoff of scoring being ex post.** Every metric added in v2m/v2n — the scoring version
stamp, `committedCount`, `selectiveAccuracy`, `selectiveBaselineAccuracy` — is derivable from rows
that are already on disk, so the whole table can be brought onto the new rules **without re-running a
single judge and without calling a single provider.** `--score-only` is the seam; there is no
migration step that writes any of these values, and there should never be one, because scoring also
rewrites `rawAgreement`, `kappa` and `finishedAt`.

**FIRST, know what generation each row is on.** Never compare across generations — see §7.6.

```sql
SELECT COALESCE("scoringVersion"::text, 'NULL (pre-v2m)') AS generation, count(*)
FROM "CalibrationRun" GROUP BY 1 ORDER BY 1;
```

Immediately after v2m/v2n apply, every row reads `NULL (pre-v2m)`. There were **20** of them on
2026-09-06.

**THE ORDERING CONSTRAINT, and it is the only thing in this section that can go wrong.**

> **A run that is still draining must NOT be scored mid-flight.** `scoreCalibrationRun` is a FULL
> OVERWRITE, so scoring a partial run stamps it `scoringVersion = 2` and writes a
> `selectiveAccuracy` over whatever landed first — **which is not a random sample of the set**; it is
> the items that dequeued earliest. The row then looks exactly like a finished one on the scoreboard,
> because nothing in the header distinguishes "620 items scored" from "263 items scored" except
> `verdictCount`, which a reader has to notice. It is not destructive — re-scoring after the run
> drains replaces every field — but between the two scores the board carries a stamped, plausible,
> partial number.
>
> On 2026-09-06 that run is **`cmtluplg500012l0sj315kyar`** (qwen3.5:9b on `cmt057h5d00097y01ymubpre5`,
> 263 of 620 completed, `finishedAt` NULL, roughly 28 h remaining). **Backfill the 19 terminal rows
> first; score that one exactly once, after it drains.** Check before starting:
>
> ```sql
> SELECT id, "verdictCount", "finishedAt" FROM "CalibrationRun" WHERE "finishedAt" IS NULL;
> ```

**THE SEQUENCE** (operator; each command is a separate deliberate action, and the image must already
carry v2m/v2n — promoting it is a separate homelab-setup change):

```sh
# 1. The 19 rows with a finishedAt, ONE AT A TIME. Each prints its own report,
#    and each is idempotent, so a repeat is free.
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-run.js \
  --score-only=<calibrationRunId>

# 2. Confirm the generation histogram has moved before touching the last one.
#    Expect: 19 rows at 2, one row at NULL (the in-flight qwen3.5:9b run).

# 3. Only after `finishedAt IS NULL` returns nothing: score the last run.
```

**Three things the backfill will surface that are correct and read as bugs.**

1. **`cmton7ip500012lyjubiqohy8` currently shows `verdictCount 0` and a NULL `rawAgreement`, and has
   16 completed judgments on disk.** It was scored at launch and never re-scored. Backfilling it
   produces `verdictCount 16`, `committedCount 1`, coverage `0.0625`, `rawAgreement 0.0000` and
   `selectiveAccuracy 0.0000` — a selective accuracy over a denominator of **one**. That is a correct
   measurement of an aborted run, and it is not a regression. **`selectiveAccuracy` has no minimum-`n`
   rule** — §7.6's `n = 30` gates the abstention contrast's arms and nothing else — so this row is
   precisely why the scoreboard query in §7.6 filters on `committedCount` before it ranks.
2. **`cmtkt3sg200017h3tlf87khhn` is the same shape as (1) and is easy to miss**, because unlike
   `cmton7ip5…` it looks finished: `verdictCount 0`, `rawAgreement` NULL, but a `finishedAt` of
   2026-09-03 01:21:37. It has **9 completed judgments on disk** (verified read-only, 2026-09-06), so
   backfilling it produces `verdictCount 9` out of nowhere. Predict the number before you run it
   rather than reading it as an appearance:

   ```sql
   SELECT count(*) FROM "ModelJudgment" mj
   JOIN "EvaluationRun" er ON er.id = mj."runId"
   WHERE er."calibrationRunId" = 'cmtkt3sg200017h3tlf87khhn' AND mj.status = 'completed';
   ```

   Three rows carry a NULL `rawAgreement` in total — these two and the in-flight `cmtluplg5…` — which
   is why 17 of the 20 are non-null.
3. **`finishedAt` moves on every row you touch.** It has always dated the scoring pass rather than
   the drain (§6, "idempotent, and safe to run repeatedly"), but a 19-row backfill makes that visible
   all at once: after it, every historical run appears to have "finished" on the same afternoon. The
   column that dates the DRAIN is the last judgment's `completedAt`, not this.

---

## 7. How to read the output
```

- [ ] **Step 2: Edit 2 — §7.5 and §7.6, the new report block**

old_string:
```
skip everything else, read the disagreements.

---

## 8. Known failure modes
```
new_string:
```
skip everything else, read the disagreements.

### 7.5 Coverage, selective accuracy, and the forced-choice projections

The golden sets are **forced choice** — `cmt057h5d00097y01ymubpre5` is 620 items keyed 336 `A>B` /
284 `B>A` with **no ties**, and `cmt057hd001g17y01lhjzgfuj` is 17/13/0. A `tie` verdict can therefore
never be correct, and `ACCURACY` counts every one as a miss. That is right, and it also means
`ACCURACY` is the **product** of two independent quantities: how often the judge commits, and how
often it is right when it does.

```
ACCURACY   0.0929   (56/603 items with a verdict)
constant   0.5456   (a judge stamping 'A>B' on every SCORED item: 329/603)   margin -0.4527
⚠ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.
coverage   0.1708   (103/603 scored items the judge COMMITTED on; 500 abstained with 'tie')
selective  0.5437   (56/103 right where it COMMITTED)   floor 0.5243 ('A>B': 54/103)   margin +0.0194
kappa      …
```

**Read the two `margin`s as different claims, because they have different denominators.** The
`constant` line's floor is over every SCORED item; the `selective` line's floor is over the items the
judge COMMITTED on, and the second is the only one selective accuracy may be compared against.
Quoting the first beside the second is the same mistake v2l was written to prevent, one level down,
and on this corpus it **flips the sign for two of four judges**: lfm2.5-thinking's 0.5363 is +0.0071
over its committed floor of 0.5292 and −0.0056 against the full subset's 0.5419. Neither is a strong
claim; the sign is what a reader takes away.

**What this separates that nothing before it could.** Measured on the 620-item set, 2026-09-06:

| judge | coverage | selective | committed floor | ACCURACY |
|---|---|---|---|---|
| Qwen3.6-35B-A3B | 0.9855 | 0.9000 | 0.5410 | 0.8869 |
| lfm2.5-thinking:1.2b | 0.9113 | 0.5363 | 0.5292 | 0.4887 |
| lfm2.5:8b | 0.1708 | 0.5437 | 0.5243 | 0.0929 |

The two lfm rows differ **5.3×** on `ACCURACY` — "mediocre versus broken" — and are statistically
indistinguishable on `selective`. Same discriminative ability. They differ only in how they express
uncertainty, and `ACCURACY` alone cannot say so.

At zero coverage there is **no `selective` line at all.** The report prints
`⚠ the judge committed on NOTHING (0/N) — selective accuracy is UNDEFINED, not 0 and not 1.` instead.
A judge that committed on nothing was never right when it answered *because it never answered*, and
`0.0000` would be a measurement.

**Read `coverage` beside `missingVerdicts`, never alone.** Both of coverage's operands count only
completed non-null verdicts, so an item that errored, dead-lettered or truncated is in neither. A
judge that *fails* on 500 items therefore scores higher coverage than one that *ties* on them —
lfm2.5:8b's 500 ties give 0.1708, and the same 500 as truncations would read 1.0000 over a
`verdictCount` of 103. The `⚠ N item(s) produced no verdict` line under `itemCount` is the other half
of the sentence.

Below the confusion matrix the report prints the **forced-choice projections**:

```
forced-choice projection — on a key with no ties a 'tie' can never be right, so ACCURACY above
already counts every abstention as a miss. These are what a FORCED judge would have scored:
  all abstentions wrong   0.0929   (= ACCURACY above — the pessimistic end)
  unbiased coin           0.5075   (exact expectation over 500 abstention(s) on a 2-class key)
  stamp 'A>B'             0.5489   (275 of the 500 abstained items are keyed 'A>B')
  all abstentions right   0.9221   (an ORACLE tiebreak — unreachable, printed as the ceiling)
ⓘ selective accuracy 0.5437 is NOT an upper bound on a forced judge: the stamp above scores higher.
```

**Only the first line is a measurement.** It is `rawAgreement`. The rest are projections under the
assumption named beside them — **never quote one where a measured number is expected**, and never
quote the oracle at all except as a ceiling. And note the `ⓘ`: selective accuracy is *not* the
optimistic end, because a stamp does not use the judge at all, it uses a property of the key. On
Qwen3.6 the ordering is the other way round (stamp 0.8966 against selective 0.9000), so neither
direction can be assumed.

**Not computable, and therefore not printed:** a risk-coverage curve or AURC. Both need a per-item
confidence ordering to sweep a threshold over, and `ModelJudgment` stores a discrete verdict with
nothing rankable beside it. A proxy would carry the name and not the meaning.

### 7.6 Which rules produced these numbers — and never mixing two generations

Directly under `itemCount` in the Result block — the missing-verdict `⚠`, the raw verdict
distribution, the confusion matrix and the forced-choice block all print *after* it:

```
scoring    2 (v2n) — generation 1 UNCHANGED (rawAgreement and kappa keep their exact meaning), plus …
```

Scoring is **ex post**: a score is a pure function over stored judgments and `--score-only` re-derives
it without executing a model, so the rules can improve while the data does not. A stored number is
then uninterpretable unless the row says which rules made it. `CalibrationRun.scoringVersion` (v2m)
says. `src/lib/calibration/scoring-version.ts` holds the constant and the changelog.

**NULL means one thing: scored before v2m, generation unrecorded. It does NOT mean 0 and does NOT
mean version 1.** A row that was never stamped cannot prove which rules made it.

**Any query that compares rows must filter on a version.** Run the histogram first:

```sql
SELECT COALESCE("scoringVersion"::text, 'NULL (pre-v2m)') AS generation, count(*)
FROM "CalibrationRun" WHERE "rawAgreement" IS NOT NULL GROUP BY 1 ORDER BY 1;
```

More than one row back means the table holds more than one generation and no cross-row comparison is
valid until you filter. **The trap to avoid:** a v1 row has `rawAgreement` and a NULL
`selectiveAccuracy`, so `ORDER BY "selectiveAccuracy" DESC` sorts it first — and "fixing" that with
`COALESCE(…, 0)` makes every un-backfilled judge read as "never commits, always wrong", a fabricated
measurement produced by a query. Filter; do not coalesce.

**The board itself, and it is never ordered by selective accuracy alone:**

```sql
SELECT jm.name, cr."rawAgreement", cr."constantBaselineAccuracy",
       cr."committedCount"::float / NULLIF(cr."verdictCount",0) AS coverage,
       cr."selectiveAccuracy", cr."selectiveBaselineAccuracy", cr."verdictCount"
FROM "CalibrationRun" cr
JOIN "JudgeModelVersion" jv ON jv.id = cr."judgeModelVersionId"
JOIN "JudgeModel" jm ON jm.id = jv."judgeModelId"
WHERE cr."goldenSetId" = '<one set>' AND cr."scoringVersion" = 2
  AND cr."committedCount" >= 100
  AND cr."committedCount"::float / NULLIF(cr."verdictCount",0) >= 0.5
ORDER BY cr."rawAgreement" DESC NULLS LAST, cr."selectiveAccuracy" DESC NULLS LAST;
```

**Why the two `committedCount` guards are not decoration.** Selective accuracy is monotonically
improvable by abstaining on your own errors — a judge can raise it to 1.0000 without getting a single
extra item right. Take `cmtondblm00012lzcx1m2cyql` (lfm2.5:8b): 103 committed, 56 correct, selective
0.5437. Have it abstain on the 47 committed items it got **wrong** and nothing else changes —
`committedCount` 56, `selectiveAccuracy` **1.0000** over a committed floor around 0.54, **no `⚠`**
(1.0 is not at or below the floor), and unguarded it sorts above Qwen3.6's 0.9000 while its coverage
falls to 0.0929 and its `rawAgreement` does not move at all. The standard mitigation for this is a
risk-coverage curve, which is **not computable here** (no per-item confidence to sweep — see §7.5), so
the guard and the sort key are the whole defence. There is also **no minimum-`n` rule on
`selectiveAccuracy`** anywhere in the code — `n = 30` gates the abstention contrast below and nothing
else — which is why `cmton7ip500012lyjubiqohy8`, whose selective accuracy sits over a denominator of
**one**, is kept off the board by `committedCount >= 100` rather than by anything the scorer does.

**Abstention calibration is a separate command**, because it is cross-run and cannot live in a
single-run scorer. Run it the same way as `--score-only` — from a pod, because a workstation has no
route to `judge-arena-pg-rw.tenant-public` and production is the only database with these rows:

```sh
kubectl -n tenant-public exec deploy/judge-arena-web -- node /app/calibration-abstention.js \
  --subject=<calibrationRunId>
```

`npm run calibration:abstention -- --subject=<id>` is the identical local form and works only against
a database a workstation can reach (§5). It is read-only either way: it launches no judgment, calls no
provider and writes no row, so it is safe while a calibration is draining.

It compares a reference cohort's accuracy on the items the subject ABSTAINED on against its accuracy
on the items the subject COMMITTED on — handoff §5.3's rule, *do not infer difficulty from the
mechanism, check it against judges that answered*. It prints every candidate with the reason it was
admitted or rejected (same judge, same model family, wrong scoring version, or a selective margin at
its own constant floor), **both `n` values always**, and **no p-value** — the arms are not
independent and the item sets are not random samples. Below `n = 30` on either arm it prints the
numbers and says `NOT INTERPRETABLE`. An arm with no overlap at all is `n/a`, never 0.

Measured 2026-09-06 with Qwen3.6 as the cohort — the result that motivated the command:

| subject | cohort on its ABSTENTIONS | cohort on its COMMITMENTS | contrast |
|---|---|---|---|
| lfm2.5:8b | 0.8945 (441/493) | 0.9300 (93/100) | −0.0355 |
| lfm2.5-thinking:1.2b | **0.9808 (51/52)** | 0.8925 (498/558) | **+0.0883** |

lfm2.5:8b skips items that are *slightly* harder — 1.2 standard errors, so directionally consistent
and not distinguishable from noise. lfm2.5-thinking skips items a competent judge finds **easier**.
Two judges with identical selective accuracy, and their abstentions are opposite in kind.

---

## 8. Known failure modes
```

- [ ] **Step 3: Edit 3 — §10, the negative result on textual hedging**

old_string:
```
**The higher number is the worse result.** Full reasoning, and the storage footprint measured off
these rows: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`.
```
new_string:
```
**The higher number is the worse result.** Full reasoning, and the storage footprint measured off
these rows: `docs/superpowers/specs/2026-08-31-calibration-baseline-and-footprint.md`.

---

## 10. What was tried and does NOT work: uncertainty markers in `reasoningContent`

`reasoningContent` is captured on every judgment and is long — mean 27,988 chars on lfm2.5:8b, 9,441
on lfm2.5-thinking, 9,713 on Qwen3.6, measured over the completed judgments of the 620-item runs on
2026-09-06. A judge that answers `tie` after reasoning "these are genuinely equivalent" is a different
object from one that ties after "I am not sure", and a judge that commits to A while its reasoning
says "this is extremely close" is expressing uncertainty *without* abstaining. **So it is tempting to
read uncertainty out of the text. It was tried, against this corpus, and it does not work. Nothing
was shipped.**

The rule tested was the strongest cheap one available — a case-insensitive substring match for ten
terminal hedges: `not sure`, `unsure`, `not certain`, `hard to say`, `too close to call`, `toss-up`,
`coin flip`, `difficult to decide`, `hard to decide`, `no clear winner`.

**Result 1 — it does not track the verdict channel's abstention at all.**

| judge | rate on ABSTAINED (`tie`) | rate on COMMITTED |
|---|---|---|
| Qwen3.6 | 0.0000 (0/9) | 0.0639 (39/610) |
| lfm2.5-thinking | 0.4182 (23/55) | 0.3558 (201/565) |
| lfm2.5:8b | 0.3560 (178/500) | 0.3495 (36/103) |

On the one judge with real discriminative ability the marker fires **more often when it commits**. On
the other two it is flat around a base rate of ~0.35 — a stylistic tic of the model, not a signal
about the item.

**Result 2 — within the committed set the sign of the effect is not stable across judges.**

| judge | selective accuracy, marker ABSENT | marker PRESENT |
|---|---|---|
| Qwen3.6 | 0.9177 (524/571) | **0.6410** (25/39) |
| lfm2.5-thinking | 0.5082 (185/364) | **0.5871** (118/201) |
| lfm2.5:8b | 0.5373 (36/67) | **0.5556** (20/36) |

On Qwen3.6 hedging predicts being wrong, strongly. On the other two it predicts being *right* — the
lfm2.5-thinking swing is +0.079 on n=364/201, about 1.8 se, so not significant and **not in the
predicted direction**. A quantity whose sign depends on which judge produced it cannot go on a
scoreboard beside accuracy.

**Result 3 — the false-positive mode, quoted from the corpus.** Every sampled `not sure` in
`cmtp3jwrf00012laoe6kmxgod` is a mid-stream rhetorical hedge inside a rambling chain that then
resolves to a confident verdict:

```
… which would correspond to a tie? Not sure. Alternatively, perhaps since I have to pick based on
the criteria, maybe Response A is more accurate and Respo…
```

A substring match cannot tell a transient hedge from a terminal one, and the models that hedge most
are the models that ramble most. **The rule measures verbosity and reports it under a label that says
uncertainty.**

**Conclusion: no honest cheap textual signal exists on this corpus, so none is shipped** — no module,
no field, no column, no line in the report. An LLM-judge-of-the-judge is not the fallback; that is a
separate research question with its own validity problems. What *does* work is the behavioural
channel in §7.6, which needs no text at all. The queries behind all three results are in
`docs/superpowers/plans/2026-09-06-ex-post-scoring-coverage-and-abstention.md` §M5 — start from the
measurement, not from the intuition.
```

- [ ] **Step 3b: Edit 4 — the CORRECTION to §7.1, whose print-order claim this plan invalidates**

§7.1 holds the canonical Result block and says of it: *"The block is the print template applied to
them, in the order `run.ts` prints."* After Task 3 the script prints `coverage` and `selective`
between the `constant`/`⚠` lines and `kappa`, and a `scoring` line after `itemCount`; after Task 4 it
prints the forced-choice block below the confusion matrix. That sentence is then false, and the
runbook would carry two blocks (§7.1 and §7.5) that disagree about what the tool prints.

**The fence itself is left exactly as it is, deliberately.** It is a RECONSTRUCTION of run 9 from its
stored row — run 9 has no `committedCount`, `selectiveAccuracy` or `scoringVersion` until it is
backfilled (§6.1) — so editing placeholders into it would replace one wrong block with a second wrong
block that *looks* captured. The note says it is wrong and says what replaces it.

Edit `/root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md`.

old_string:
```
> block is the print template applied to them, in the order `run.ts` prints. Re-paste it verbatim —
> and drop the two `#` label lines at the top of the fence — after the first `--score-only` on an
> image carrying v2l.
```
new_string:
```
> block is the print template applied to them, in the order `run.ts` prints. Re-paste it verbatim —
> and drop the two `#` label lines at the top of the fence — after the first `--score-only` on an
> image carrying v2l.

> **CORRECTION (2026-09-06, v2m/v2n).** The blockquote above says of the fence that "the block is the
> print template applied to them, **in the order `run.ts` prints**". **That is no longer the order,
> and the fence above is no longer the whole block.** `run.ts` now prints a `coverage` line and a
> `selective` line between the `constant`/`⚠` lines and `kappa`, a `scoring` line immediately after
> `itemCount`, and a forced-choice projection block below the confusion matrix — see §7.5 and §7.6.
> The fence is left unedited on purpose: it is a reconstruction of run 9 from its stored row, and run
> 9 has no `committedCount`, `selectiveAccuracy` or `scoringVersion` at all until it is backfilled
> (§6.1), so inserting placeholder lines would turn one stale block into one that merely looks
> captured. **Replace the whole fence with a real paste** after the first `--score-only` on an image
> carrying v2m/v2n, and delete this note and the one above it when you do.
```

- [ ] **Step 4: Verify the four edits, and inject against the verification**

```bash
grep -c "6.1 Backfilling the whole table\|7.5 Coverage, selective accuracy\|7.6 Which rules produced\|10. What was tried and does NOT work\|CORRECTION (2026-09-06, v2m/v2n)" \
  /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
grep -n "cmtluplg500012l0sj315kyar" /root/judge-arena/docs/runbooks/scoring-a-judge-against-a-golden-set.md
```
Expected: `5`, and one hit for the in-flight run id in §6.1.

**INJECTION R:** delete the whole `> **A run that is still draining must NOT be scored mid-flight.**` blockquote from §6.1 and re-run the second grep. **Expected: `0` hits** — the ordering constraint is the only thing in this task that can cost anything, and it is carried entirely by that block. **Restore it.**

**What this verification can and cannot do, stated rather than implied.** `grep -c` on a substring cannot detect a heading renamed to `6.1 Backfilling the whole tableX` (failure mode 3), and nothing here checks that the SQL in §6.1 or §7.6 runs. The SQL was executed read-only against `judge-arena-pg-1` on 2026-09-06 while writing this plan — that is the evidence, and it does not transfer to a future edit of these blocks.

- [ ] **Step 5: Gates**

```bash
npm --prefix /root/judge-arena run lint && npx --prefix /root/judge-arena tsc --noEmit -p /root/judge-arena/tsconfig.json && npm --prefix /root/judge-arena run test:coverage 2>&1 | tail -10
```

Expected: lint 0; tsc silent; **unchanged from Task 5 — `B + 59`.** This commit is documentation only and adds no test. `eslint` and `tsc` do not read `docs/`, so both are formalities here and are run only to prove the tree is still clean.

- [ ] **Step 6: Commit**

```bash
git -C /root/judge-arena diff --cached --name-only
```
Expected: **empty**. Then:

```bash
git -C /root/judge-arena add docs/runbooks/scoring-a-judge-against-a-golden-set.md
git -C /root/judge-arena commit --only docs/runbooks/scoring-a-judge-against-a-golden-set.md -F - <<'EOF'
docs(calibration): backfill order, the new report block, and a negative result on textual hedging

§6.1 is the payoff of scoring being ex post: v2m/v2n bring the whole table onto
the new rules with no judge re-run and no provider call, because every new value
is derivable from rows already on disk. --score-only is the seam and there is no
migration step that writes any of them.

It carries the one ordering constraint that can cost something. scoreCalibrationRun
is a FULL OVERWRITE, so scoring a still-draining run stamps it as generation 2 and
writes a selectiveAccuracy over whatever landed first — which is not a random
sample, it is the items that dequeued earliest — and the row then looks exactly
like a finished one. On 2026-09-06 that run is cmtluplg500012l0sj315kyar
(qwen3.5:9b, 263 of 620). Backfill the 19 terminal rows first; score that one once,
after it drains.

Three things the backfill surfaces that are correct and read as bugs are named:
cmton7ip500012lyjubiqohy8 becomes coverage 0.0625 with a selective accuracy over a
denominator of one; cmtkt3sg200017h3tlf87khhn is the same shape but looks finished
and produces a verdictCount of 9 out of nowhere; and finishedAt moves on every row
touched because it has always dated the scoring pass rather than the drain.

§7.5 reads the new block, with the point that the constant floor and the selective
floor have different denominators and only the second may be compared against
selective accuracy — quoting the first flips the sign for two of four judges. It
also states that only the first forced-choice line is a measurement, that selective
accuracy is not an upper bound on a forced judge, and that AURC is not computable
here at all.

§7.6 is the version-mixing rule, the guarded scoreboard query and the abstention
command. The COALESCE trap is written out — a v1 row has a NULL selectiveAccuracy,
and coalescing it to 0 makes every un-backfilled judge read as "never commits,
always wrong" — and so is the gaming one: selective accuracy is monotonically
improvable by abstaining on your own errors, so lfm2.5:8b could abstain on its 47
wrong commitments and read 1.0000 with no extra item right. The board therefore
guards on committedCount and sorts on rawAgreement first. A risk-coverage curve is
the standard mitigation and is not computable here.

§7.1 gets a CORRECTION note rather than a rewrite. It claimed its fenced Result
block was "the print template applied to them, in the order run.ts prints", which
Tasks 3 and 4 make false. The note quotes what it said, states the new order, and
leaves the fence alone because it is a reconstruction, not a capture.

§10 records a NEGATIVE result in full. A ten-marker hedge match over reasoningContent
was tested against this corpus: it fires more often on committed judgments than on
abstentions for the one judge with real discriminative ability, its within-committed
effect has the opposite sign on the two weak judges, and every sampled hit is a
mid-stream rhetorical hedge in a chain that then resolves confidently. It measures
verbosity and would report it as uncertainty. Nothing was shipped, and the queries
are recorded so the next attempt starts from the measurement.

Gates: lint 0, tsc 0, <B+59> unit (unchanged; docs-only) / n-a db (docs-only; no suite reads docs/) / n-a integration (docs-only), coverage 0.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WT7bB4SAZpJtRDEGhpGyRv
EOF
git -C /root/judge-arena show --stat --oneline HEAD
```
Expected: **1 file changed**.

---

## Out of scope, recorded as follow-ups

Each of these was considered and deliberately not done. Where the reason is a measurement, the measurement is stated.

- **F1 — `kappa` and `rawAgreement` are not changed, redefined or recomputed.** Cohen's kappa already treats `tie` as a third category and already scores a stamper correctly: lfm2.5:8b's kappa is ≈ 0.0046 on the 620-item set. `rawAgreement` is `correct/verdictCount` and every published number depends on it. This plan only adds; Task 3 Injection F is the guard.
- **F2 — a golden key with GENUINE ties** (handoff open item #9). Every metric here says "a tie is an abstention" *because the key has none*, and `formatSelectiveAccuracyLines` prints an `ⓘ` and `formatForcedChoiceLines` refuses outright when it does not. Building a set where `tie` is a real answer is a **corpus** question — it needs items whose ground truth is genuinely "equivalent", and the current import path rejects `tie` at `golden-sets.ts` on purpose. Not a code change.
- **F3 — a risk-coverage curve / AURC is NOT computable on this data, and no proxy is shipped.** Both need a per-item confidence ORDERING to sweep a threshold over. `ModelJudgment` stores a discrete verdict and nothing rankable beside it — no logprobs, no self-reported confidence, no score. Approximating one with, say, reasoning length would produce a number carrying AURC's name and none of its meaning. **The honest statement is that it cannot be computed, not that it was approximated.**
- **F4 — per-item confidence scores.** The prerequisite for F3, and a change to the judgment schema and the prompt, i.e. a re-run of every judge. Out of scope by construction: this plan re-executes nothing.
- **F5 — re-running any judge.** Nothing here calls a provider. The whole point is that the framework improved and the data did not have to.
- **F6 — the textual uncertainty signal, revisited only with a different method.** Measurements M5 and runbook §10 record the negative result and the queries. **Do not retry the same marker approach with a longer marker list** — the failure is not coverage of the marker set, it is that the channel measures verbosity and its sign is not stable across judges. An LLM-judge-of-the-judge is explicitly not the recommended fallback; it is a separate research question with its own validity problems (who validates the validator, and against what).
- **F7 — `judgeFamilyKey` is crude and is not load-bearing today.** It keys both Claude models to `claude`, and a name with no `:` or `-` survives whole. On the current corpus the selective-margin rule already excludes every same-family pairing, so the family rule has never actually decided an admission. Revisit when a family sibling first clears +0.05.
- **F8 — `COHORT_MIN_SELECTIVE_MARGIN = 0.05` and `MIN_CONTRAST_N = 30` are policy numbers with stated bases, not derived thresholds.** Nothing measured is near either: the margins are +0.0071, +0.0194, +0.2852, +0.3590, and the arms are 52, 100, 263, 493, 558. **The first judge that lands between 0.02 and 0.20, or the first cohort arm between 20 and 60, is the reason to revisit them** — and at that point the right move is to state a new basis, not to nudge the constant until a judge you like gets admitted.
- **F9 — the scoreboard SQL itself.** Handoff §8 step 3 owns it. This plan gives it the columns and the version filter it needs and writes the canonical guard query into the runbook; it does not build the board.
- **F10 — `finishedAt` means "when this row was last scored", not "when the run drained".** Pre-existing, made visible by a 19-row backfill (runbook §6.1). A separate `scoredAt` column, or reading the last judgment's `completedAt`, would fix it. Not this plan's concern, and deliberately not folded in: it is a fourth meaning for a column three tasks already write.

---

## Post-landing checklist — operator actions, none of them performed by this plan

1. **Promote an image carrying `2e7e142 + 6 commits`.** A separate homelab-setup change. **This plan never pushes, never promotes and never mutates the cluster.** Before promoting, read `bash scripts/ci/ci-status.sh <sha>` (the Gitea tasks + commit-status APIs) and assert the Harbor tag for the SHA — **a green-looking runner pod log is not evidence that an image exists** (failure mode 6/7; handoff §6 traps 3-4). Push **one head at a time**: Gitea 1.23.6 cancels the previous run on every push to the same ref.
2. **Nothing in this plan has ever executed `scripts/calibration/run.ts` or `scripts/calibration/abstention.ts`.** Both are `tsc`- and lint-gated and both have a `readFileSync` call-site guard, and **neither of those proves the script runs.** The first real execution is the operator's first `--score-only` on the promoted image. **Check both bundles exist before relying on either** — `node /app/calibration-run.js --help`-style smoke is not available, so list them: `kubectl -n tenant-public exec deploy/judge-arena-web -- ls /app/calibration-run.js /app/calibration-abstention.js`. The second is new in Task 5 and is produced by an esbuild block that nothing in this plan executes. Expect the Result block to gain three lines (coverage, selective, scoring) plus the forced-choice block below the confusion matrix.
3. **Apply the migrations in production, then run the generation histogram** from runbook §6.1 and confirm it returns exactly one row reading `NULL (pre-v2m)` with a count of 20 (or whatever `SELECT count(*) FROM "CalibrationRun"` says at that moment — the number grows).
4. **Backfill in the order §6.1 gives**, 19 terminal rows first. **Do not score `cmtluplg500012l0sj315kyar` until `finishedAt IS NULL` returns nothing.**
5. **Re-verify the four production tables in this plan after the backfill.** The `selectiveAccuracy` and `selectiveBaselineAccuracy` columns should reproduce Measurements M2 exactly for the four completed runs; the qwen3.5:9b row will not, because it is still moving. **A mismatch on a completed run is a finding**, not a rounding difference — every figure in M2 is an exact integer ratio.
6. **Record the walk.** The runbook's own convention (`docs/runbooks/studio-manual-verification.md`'s dated table is the shape) is to log the commit, who ran it, and anything that failed. §7.5's sample output is transcribed from the fixtures, **not captured from a real run** — replace it with a real paste the first time one exists, and say in the commit that it was reconstructed before.

---

## Self-review — spec coverage, placeholders, type consistency

**Required scope, item by item.**

| # | requirement | where | done |
|---|---|---|---|
| 1 | scoring version stamp: column, where written, NULL meaning, cross-version query | Task 1 (module + decision record + guard SQL), Task 2 (v2m), Task 3 (written by `score.ts`, bumped to 2), runbook §7.6 | ✅ |
| 2 | `committed`/`abstained`, `coverage`, `selectiveAccuracy` with its own floor over the COMMITTED subset, null-not-zero at zero coverage | Task 3 (all seven fields, S3 fixture pins the floor by its LABEL, S5 pins the null) | ✅ |
| 3 | `rawAgreement` MUST NOT CHANGE, pinned by a test | Task 3 Step 2 test 2 + Injection F | ✅ |
| 4 | forced-choice BOUNDS by strategy, assumption in the name, never a projected figure where a measured one is expected | Task 4 (four named strategies, array of stamps, report-only, no columns) | ✅ |
| 5a | cross-judge abstention contrast, separate pure function + CLI, cohort rule, confound addressed, `n` reported, minimum-`n` stated, no invented p-value | Task 5 (module + `scripts/calibration/abstention.ts`, five admission rules, `MIN_CONTRAST_N`, explicit no-p-value line) | ✅ |
| 5b | textual signal: propose OR scope out with reasoning; if proposed, TEST against real `reasoningContent` and report hit rate + false positives | **Tested and SCOPED OUT** — Measurements M5 (three results, real hit rates, quoted false positives), runbook §10, follow-up F6. No code. | ✅ |
| 6 | backfill sequence, FULL OVERWRITE noted, in-flight run must not be re-scored mid-flight, where it is safe | Runbook §6.1 (Task 6 Edit 1) + Injection R | ✅ |
| 7 | CLI report prints coverage, selective + sub-floor, forced bounds beside the existing block; existing lines unchanged | Task 3 Edit 8b (inserted after `formatConstantBaselineLines`, before `kappa`), Task 4 Edit 7b (after the confusion matrix). **No existing `console.log` is modified or deleted by any edit in this plan** — every `old_string` that quotes one reproduces it verbatim in its `new_string`. | ✅ |
| — | out of scope recorded as follow-ups (kappa/rawAgreement, tie key, AURC not computable, per-item confidence, re-running judges) | F1-F5 | ✅ |

**Placeholders.** There are none. Every code block is complete and compilable as written; every `old_string` is quoted verbatim from the tree at `2e7e142` (or from a `new_string` earlier in this plan, where a later task edits a line this plan created — Task 4's `score.ts` edits and Task 4 Edit 7a both anchor on Task 3's output, and each says so). The only intentionally symbolic values are `<B+n>` in the six `Gates:` lines and `<calibrationRunId>` in operator commands, both of which the surrounding text tells the executor to replace with a printed or chosen value.

**Type consistency, checked field by field.**

- `CalibrationScore` gains eight fields across Tasks 3 and 4. Three are `number` (`committedCount`, `abstainedCount`, `committedCorrectCount`), three are `number | null` (`coverage`, `selectiveAccuracy`, `selectiveMarginOverConstant`), one is `ConstantBaseline | null` (`selectiveBaseline`), one is `ForcedChoiceBounds | null` (`forcedChoice`).
- `formatSelectiveAccuracyLines`'s structural parameter lists exactly those first seven plus `verdictCount` and `constantBaseline`; a whole `CalibrationScore` satisfies it, which is how `run.ts` calls it with `score`.
- `formatForcedChoiceLines(score.forcedChoice, score.selectiveAccuracy)` — `ForcedChoiceBounds | null` and `number | null` match the declaration exactly.
- `forcedChoiceBounds` returns `ForcedChoiceBounds | null` and is called with `scoredKeyCounts: keyCounts` (`Record<Preference, number>`) against a `Readonly<Record<Preference, number>>` parameter — assignable.
- `ForcedChoiceBounds.allAbstentionsWrong` / `.allAbstentionsRight` are plain `number`, not `number | null`, because the whole object is `null` when `verdictCount === 0`; the tie-key case is carried by `keyTieCount` so the null keeps one meaning.
- `abstentionDifficultyContrast` takes `AbstentionSubject` and `readonly CohortMember[]`; the CLI builds `CohortMember[]` with `selectiveMarginOverConstant` reconstructed as `selectiveAccuracy − selectiveBaselineAccuracy` from the two v2n columns, both `Float?` → `number | null`, and the subtraction is guarded to `null` when either is.
- `scoringVersion` is `Int?` → `number | null` everywhere it appears: on the row, in `describeScoringVersion(version: number | null)`, on `CohortMember` and on `AbstentionSubject`.
- `judgeFamilyKey(baseModel: string | null)` — **`JudgeModel.baseModel` is `String?`** (`prisma/schema.prisma:247`; the generated client renders it `string | null`), and `tsconfig.json` sets `strict: true`, so a `(baseModel: string)` signature would fail `npx tsc --noEmit` at BOTH call sites in `scripts/calibration/abstention.ts` with `TS2345: Argument of type 'string | null' is not assignable to parameter of type 'string'`. The null branch is explicit, returns a sentinel (so two unset judges exclude each other rather than joining a family), and is asserted in the `judgeFamilyKey` describe. Production has 0 NULLs in 10 rows today, so nothing but `tsc` would have caught this.
- `SCORING_RULES_VERSION` is a `const` initialised to a numeric literal, so TypeScript infers the literal type `1` (then `2`). **This is deliberate and has one consequence to know:** `expect(data.scoringVersion).toBe(SCORING_RULES_VERSION)` compares against that literal type, and `describeScoringVersion(99)` still accepts `99` because the parameter is declared `number | null`. Nothing in the plan compares `SCORING_RULES_VERSION` against a variable in a way a literal type would reject.

**Three things this plan does NOT prove, said plainly rather than left to be discovered.** (a) Nothing here executes either CLI script; the call-site guards read source text. (b) No test runs against a database — `scoreCalibrationRun` is exercised through structural stand-ins, exactly as the existing suite does. (c) Task 4 Step 13 is **not** an injection and is not listed as one — it is a recorded decision that the `>` / `>=` boundary on the `ⓘ` is deliberately unpinned, with the argument for why a fixture there would be decoration. Nothing in this plan ships an injection that is expected to stay green.
