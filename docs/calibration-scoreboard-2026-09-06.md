# Judge Arena — calibration scoreboard (ex-post metrics)

Computed 2026-09-06 from production `judge-arena-pg-1`, **read-only**, recomputed from
`ModelJudgment` rows rather than read off `CalibrationRun` aggregates (two of which are stale).
Built and adversarially verified by 21 agents; every numeric claim independently re-derived.

**Validation:** the derived query reproduces stored `rawAgreement` on all 18 non-stale rows, and
the derived constant floor matches the stored v2l `constantBaselineAccuracy` bit-exactly on 8/8
rows that carry it.

---

## 1. THE DEFAULT SORT: `marginOverConstant` DESC, within golden set, within tier

**Not `selectiveMarginOverConstant`.** It fails the exact hazard it was proposed for. On the 30-item set it puts lfm2.5:8b at **+0.2000** (sel 0.8000 = 4/5, committed floor 0.6000 = 3/5) *above* granite4.1:3b at **+0.0952** (sel 0.7143 = 15/21, floor 0.6190 = 13/21) — the naive misordering survives intact. On the 620-item set it puts lfm2.5:8b at **+0.0194** (56/103) above lfm2.5-thinking at **+0.0071** (303/565). Subtracting a floor estimated on the *same five items* removes none of the small-n inflation.

**Not `rawAgreement`.** Its denominator and its key marginal both move per run: on the full set alone the denominator is 619 / 620 / 603 / 329 / 16 and the floor is 0.5428 / 0.5419 / 0.5456 / 0.5410 / 0.6875. Raw shows granite4.2:3b `cmtiplr3x` at **0.6667** — sixth of twenty, reading as "better than a coin flip" — on a 15-item truncated subset whose key was 10/5, so its own floor is **0.6667** too. Margin renders that same run as **+0.0000**: exactly a stamp.

**`marginOverConstant` (= `rawAgreement − constantBaseline`, both over the run's own scored subset).**
- lfm2.5:8b 30-set → **−0.4333**; granite4.1:3b → **−0.0667**. Hazard reversed.
- Qwen3.6 v2 **+0.3441** > lfm2.5-thinking **−0.0532** > lfm2.5:8b **−0.4527** on the full set.
- Qwen3.6 v1 (30-set) → **+0.3000**; the live qwen3.5:9b row → **+0.2827** *(snapshot, n=329)*, quarantined out of the ranking anyway.
- On this tie-free corpus `rawAgreement = coverage × selectiveAccuracy` **exactly** (`correct == committedCorrect` on 20/20 runs), so `margin = coverage×selective − constantFloor` — it *is* the coverage-weighted composite. **The guard the plan asks for is already the shipped default metric; the only job is to not replace it with the selective one.**
- Decisive: granite4.1:3b ran three times on the same set with identical measurement (30/30 verdicts, 15 correct, raw 0.5000 every time). Margin spread **0.0000**. Selective spread **0.0621** (0.6522 / 0.6522 / 0.7143), driven purely by the tie count moving 7→7→9. Selective moves while nothing measurable moves.

Deterministic tiebreak: `margin DESC, verdictCount DESC, finishedAt DESC`.
Empirical least-significant-difference from repeated runs of the same judge/version/set: **0.0586** (Qwen3.6 v1, 5 runs). Ranks closer than that are not separated.

**Sorting is always WITHIN one golden set.** Qwen3.6 scores 0.8333 on the 30-set and 0.8869 on the 620-set; different key, different floor, different population.

---

## 2. GUARDS — exact trigger, exact text

| marker | trigger (SQL) | effect | exact inline text |
|---|---|---|---|
| `⛔VOID` | `exists(ModelJudgment.error LIKE 'VOID:%')` on the run | **tier 3, unranked** | `⛔ VOID — 604 of 620 judgments carry a VOID: marker ("run abandoned at max_tokens 8192"). This run was abandoned, not measured; its 16 verdicts are a non-random prefix. Excluded from ranking.` |
| `⏳LIVE` | `CalibrationRun.finishedAt IS NULL OR exists(judgment.status IN ('pending','running'))` | **tier 2, unranked** | `⏳ IN FLIGHT — snapshot 2026-09-06 21:40:49 UTC, 329 of 620 answered (258 pending, 1 running, 32 error). Every figure on this row MOVES between queries; this is a snapshot, not a measurement.` |
| `⚠LOSS!` | `noVerdictRate >= 0.25` | **tier 3, unranked** | `⚠ no verdict 0.5000 (15 of 30 asked produced none) — scored over a NON-RANDOM half of the set. FLEET property (finishReason='length' truncation / dead request), NOT abstention. Excluded from ranking.` |
| `⚠LOSS` | `0.10 <= noVerdictRate < 0.25` | warn, still ranked | `⚠ no verdict 0.1333 (4 of 30 asked) — the denominator below is a subset; its floor (0.5769, 15/26) is not the set's floor (0.5667, 17/30).` |
| | *in-flight override* | replaces the two above on tier 2 | `⚠ 291 of 620 asked items have no verdict, but 259 are STILL QUEUED, not lost. Realized loss so far: 32/620 = 0.0516 (0.0886 of the 361 attempted). Do not read 0.4694 as a fleet loss rate until the run is terminal.` |
| `⚠COV` | `coverage < 0.50` | selective bracketed, never ranked | `⚠ coverage 0.1667 (5/30 committed; 25 abstained with 'tie') — the selective accuracy beside it is computed on FIVE items and is not comparable to a 21-item or a 610-item selective.` |
| `⚠n<20` | `committedCount < 20` | selective bracketed | `⚠ selective accuracy rests on 5 committed items; Wilson 95% [0.3755, 0.9638], width 0.5882 — 6.9x the 0.0857 gap it is being used to decide.` |
| `⚑FLOOR` | `rawAgreement <= constantBaseline.accuracy` | warn (verbatim from baseline.ts) | `⚑ accuracy is at or below the constant floor — on this subset the judge is not distinguishable from a stamp.` |
| `⚑SFLOOR` | `selectiveAccuracy <= selectiveBaseline.accuracy` | warn (verbatim from baseline.ts) | `⚑ selective accuracy is at or below the floor OVER THE COMMITTED SUBSET — where it answers, the judge is not distinguishable from a stamp.` |
| `ⓘCLASS` | `selectiveBaseline.preferences <> constantBaseline.preferences` | inline note | `ⓘ the committed floor names a DIFFERENT top class ('B>A', 3/5) than the scored floor ('A>B', 17/30) — the two margins are not measured against the same stamp.` |
| `ⓘTIEKEY` | `constantBaseline.keyCounts.tie > 0` | inline note (**dormant: 0/20**) | `ⓘ this answer key CONTAINS ties (N of M scored items), so a 'tie' verdict is a real ANSWER here, not an abstention — the coverage and selective lines above do not measure abstention on this set.` |
| `⚠STALE` | `CalibrationRun.verdictCount IS DISTINCT FROM computed verdictCount` | provenance note | `⚠ stored verdictCount 0 disagrees with the rows (329). This row is computed from ModelJudgment; CalibrationRun's aggregates were not refreshed for this run.` |

Both `<=` comparisons are load-bearing: `cmtiplr3x` sits at 0.6667 = 0.6667 and `cmtp3jods` at 0.5667 = 0.5667 and 0.6071 = 0.6071 exactly. Relaxing to `<` silences the warning on precisely the judges it exists for.

`⚠COV` uses strict `< 0.50`: **mistrallite:7b sits exactly on the boundary at 15/30 = 0.5000 and does NOT fire it.** The boundary case is real in this corpus; it is called out rather than left to a reader.

---

## 3. NEVER DISPLAYED WITHOUT ITS COMPANION

1. `selectiveAccuracy` — never without **`coverage` AND `committedCount/verdictCount` AND its Wilson interval**. `0.0000 (0/1) [0.0000–0.7935]` is honest; a bare `0.0000` is a lie.
2. Any margin — never without **which floor, that floor's top class, and the floor's own count**: `+0.2000 vs 'B>A' 3/5`, not `+0.2000`. The two floors name different classes on `cmtozvve1`.
3. `rawAgreement` — never without `correct/verdictCount`. Five different denominators on one set.
4. `coverage` — never without `abstainedCount` **and** `missingVerdicts`. A judge that fails outright reads as *higher*-coverage than one that ties (score.ts: 500 ties → 0.1708; the same 500 as truncations → 1.0000 over 103).
5. `noVerdictRate` — never without `missing/dispatched` **and** the words *FLEET property, not abstention*; on an in-flight run, never without the queued/errored split.
6. Any figure on a live run — never without its **snapshot clock and n**.
7. `kappa` — never as a cross-set key, and never without `kappaVariant`/`kappaWeighting` (score.ts stores both for this reason). Omitted from the board entirely.

---

## 4. COLUMN SET AND ORDER

`#` · `judge · v` · `run · finished` · **`margin*`** · `raw agr. (n)` · `constant floor (class, n)` · `coverage (n, ties)` · `selective (n) [95% CI]` · `selective floor (class, n)` · `sel. margin` · `no-verdict (n)` · `guards`

The sort key sits in column 4, immediately left of the number it is derived from, and each rate is immediately followed by its own denominator. `selective` and `sel. margin` are **diagnostics**, never sort keys, and are separated from the sort key by the coverage column so they cannot be read as the ranking.

---

# RENDERED BOARD — judge-arena calibration, production `judge-arena-pg-1`
**Computed 2026-09-06 21:40–21:43 UTC. All figures recomputed from `ModelJudgment`; nothing read off `CalibrationRun` aggregates.**
Sorted by **`margin*` = rawAgreement − constantBaseline**, descending, within golden set, within tier. `*` = the sort key.

### Golden set: `JudgeBench pairwise — full` (620 items, key 336 'A>B' / 284 'B>A', forced choice)

#### ▸ TIER 1 — RANKED (terminal, non-void, noVerdictRate < 0.25)

| # | judge · v | run · finished (UTC) | margin* | raw agr. (n) | constant floor | coverage (n) | selective (n) [95% CI] | selective floor | sel. margin | no-verdict (n) | guards |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Qwen3.6-35B-A3B (llama.cpp) v2 | `cmtozu76f` · 09-06 07:41 | **+0.3441** | 0.8869 (549/619) | 0.5428 'A>B' 336/619 | 0.9855 (610/619, 9 tie) | 0.9000 (549/610) [0.8736–0.9214] | 0.5410 'A>B' 330/610 | +0.3590 | 0.0016 (1/620) | — |
| 2 | lfm2.5-thinking:1.2b (Ollama) v1 | `cmtp3jwrf` · 09-06 01:57 | **−0.0532** | 0.4887 (303/620) | 0.5419 'A>B' 336/620 | 0.9113 (565/620, 55 tie) | 0.5363 (303/565) [0.4951–0.5770] | 0.5292 'A>B' 299/565 | +0.0071 | 0.0000 (0/620) | ⚑FLOOR |
| 3 | lfm2.5:8b (Ollama) v2 | `cmtondblm` · 09-05 23:02 | **−0.4527** | 0.0929 (56/603) | 0.5456 'A>B' 329/603 | 0.1708 (103/603, 500 tie) | 0.5437 (56/103) [0.4477–0.6366] | 0.5243 'A>B' 54/103 | +0.0194 | 0.0274 (17/620) | ⚠COV ⚑FLOOR |

> **⚑FLOOR** (row 2) — accuracy is at or below the constant floor: on this subset the judge is not distinguishable from a stamp.
> **⚠COV** (row 3) — coverage 0.1708 (103/603 committed; 500 abstained with 'tie') — the selective accuracy beside it is computed on 103 items, not 603.
> **The rows 2/3 selective column is why selective does not sort.** 0.5437 [0.4477–0.6366] vs 0.5363 [0.4951–0.5770]: a 0.0074 gap inside a 0.1889-wide interval (25.5x). `baseline.ts` calls these "statistically indistinguishable"; the interval says by how much. Their *margins* — +0.0194 vs +0.0071 — repeat the same non-difference. Their **sort keys** differ by 0.3995.

#### ▸ TIER 2 — IN FLIGHT · NOT RANKED · SNAPSHOT ONLY

| # | judge · v | run · finished (UTC) | margin* | raw agr. (n) | constant floor | coverage (n) | selective (n) [95% CI] | selective floor | sel. margin | no-verdict (n) | guards |
|---|---|---|---|---|---|---|---|---|---|---|---|

> *No rows currently shown here. The `cmtluplg5` row previously in this tier (qwen3.5:9b v2, snapshot 2026-09-06 21:40:49 UTC, n=329/620) went terminal at 2026-09-07 17:25:44 UTC and has moved to TIER 3 below — see its `⚠LOSS!` guard.*

#### ▸ TIER 3 — NOT MEASURED · NOT RANKED

| # | judge · v | run · finished (UTC) | margin* | raw agr. (n) | constant floor | coverage (n) | selective (n) [95% CI] | selective floor | sel. margin | no-verdict (n) | guards |
|---|---|---|---|---|---|---|---|---|---|---|---|
| — | lfm2.5:8b (Ollama) v1 | `cmton7ip5` · 09-05 17:18 | ~~−0.6875~~ | ~~0.0000 (0/16)~~ | 0.6875 'A>B' 11/16 | ~~0.0625 (1/16, 15 tie)~~ | ~~0.0000 (0/1) [0.0000–0.7935]~~ | 1.0000 'A>B' 1/1 | ~~−1.0000~~ | 0.9742 (604/620) | ⛔VOID ⚠LOSS! ⚠COV ⚠n<20 ⚑FLOOR ⚑SFLOOR ⚠STALE |
| — | qwen3.5:9b (Ollama) v2 | `cmtluplg5` · 09-07 17:25 | ~~+0.3246~~ | ~~0.8575 (391/456)~~ | 0.5329 'A>B' 243/456 | ~~0.9978 (455/456, 1 tie)~~ | ~~0.8593 (391/455) [0.8244–0.8883]~~ | 0.5341 'A>B' 243/455 | ~~+0.3253~~ | 0.2645 (164/620) | ⚠LOSS! |

> **⛔ VOID** — 604 of 620 judgments carry a `VOID:` marker ("run abandoned at max_tokens 8192 — relaunched at 32768"). Abandoned, not measured.
> **⚠ n<20** — selective accuracy 0.0000 rests on **ONE** committed item. Its Wilson 95% interval is **[0.0000, 0.7935]**, width 0.7935. A judge whose selective accuracy is "0.0000" with an upper bound of 0.79 has been measured on nothing. Its own selective floor is 1.0000 ('A>B', 1/1) — stamping would have been perfect on n=1.
> **`cmtluplg5` — terminal, moved from TIER 2.** Finished **2026-09-07 17:25:44 UTC**: verdictCount 456/620, errors 164. `noVerdictRate` **0.2645 (164/620)** crosses the `⚠LOSS!` guard's `>= 0.25` threshold, so on the board's own rule this run is **excluded from ranking** — it is no longer the in-flight snapshot it was shown as before. kappa **0.7151** (not a board column per rule 3.7; recorded here). Exactly one of those 164 is judgment `cmtluq5t5038x2l0s83p3h1aw`, error `reaper: abandoned` — the only `reaper: abandoned` row among all 4200 production judgments. It was an **infrastructure kill of a healthy, queued judgment, not a judge failure**: the reaper reclaimed it (lease expired, requeued to `pending`, republished), then force-finalized it later in the SAME sweep, because the reclaim did not clear the run's execution deadline. The timings prove it — `startedAt` 2026-09-06 21:40:09.334, `deadlineAt` 21:56:09.34 (`startedAt` + `960_000` ms, exactly), `updatedAt` (the abandon) 21:59:25.437 (`deadlineAt` + the 180s force-finalize grace + sweep granularity); `attemptCount` was 2 — it had already been reclaimed once. Fixed on this branch in `f0db7fe` (`src/worker/reaper.ts` now calls `clearRunDeadlineOnRequeue` after a successful republish). **True judge-attributable loss for this run is therefore at most 163/620 — 0.2645 is an upper bound, not a measurement.** Not re-scored: `scoreCalibrationRun` is a full overwrite and this run is terminal and published, so re-scoring would move `finishedAt`, stamp the current `scoringVersion`, and recompute every stored column. This note IS the correction.
> **ⓘ near-balanced slots, a genuine finding.** Raw verdict distribution: A 233, B 222, tie 1 (233+222+1=456). Against a key that is ~53% 'A>B' (243/456, the constant floor above), this judge splits almost evenly between slots A and B — essentially no slot preference. Contrast `smollm2:1.7b`, which picks slot A on only 198/617 = **0.3214** of AB items (`docs/superpowers/specs/2026-09-07-ba-sweep-position-bias-design.md`): this run's near-50/50 split sits at the opposite end of that spectrum.

---

### Golden set: `JudgeBenchSample — 30 random` (30 items, key 17 'A>B' / 13 'B>A', forced choice)

#### ▸ TIER 1 — RANKED

| # | judge · v | run · finished (UTC) | margin* | raw agr. (n) | constant floor | coverage (n) | selective (n) [95% CI] | selective floor | sel. margin | no-verdict (n) | guards |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | qwen3.5:9b (Ollama) v2 | `cmtkub3ym` · 09-03 15:36 | **+0.3214** | 0.8571 (24/28) | 0.5357 'A>B' 15/28 | 1.0000 (28/28, 0 tie) | 0.8571 (24/28) [0.6851–0.9430] | 0.5357 'A>B' 15/28 | +0.3214 | 0.0667 (2/30) | — |
| 2 | Qwen3.6-35B-A3B (llama.cpp) v1 | `cmtipm1nb` · 09-01 13:59 | **+0.3000** | 0.8667 (26/30) | 0.5667 'A>B' 17/30 | 1.0000 (30/30, 0 tie) | 0.8667 (26/30) [0.7032–0.9469] | 0.5667 'A>B' 17/30 | +0.3000 | 0.0000 (0/30) | — |
| 3 | Qwen3.6-35B-A3B (llama.cpp) v1 | `cmtgib0xr` · 08-31 01:47 | **+0.2692** | 0.8462 (22/26) | 0.5769 'A>B' 15/26 | 0.9615 (25/26, 1 tie) | 0.8800 (22/25) [0.7004–0.9583] | 0.5600 'A>B' 14/25 | +0.3200 | 0.1333 (4/30) | ⚠LOSS |
| 4 | Qwen3.6-35B-A3B (llama.cpp) v1 | `cmtht0o9a` · 08-31 22:45 | **+0.2667** | 0.8333 (25/30) | 0.5667 'A>B' 17/30 | 1.0000 (30/30, 0 tie) | 0.8333 (25/30) [0.6644–0.9266] | 0.5667 'A>B' 17/30 | +0.2667 | 0.0000 (0/30) | — |
| 5 | Qwen3.6-35B-A3B (llama.cpp) v1 | `cmthr58r1` · 08-31 21:51 | **+0.2667** | 0.8333 (25/30) | 0.5667 'A>B' 17/30 | 1.0000 (30/30, 0 tie) | 0.8333 (25/30) [0.6644–0.9266] | 0.5667 'A>B' 17/30 | +0.2667 | 0.0000 (0/30) | — |
| 6 | Qwen3.6-35B-A3B (llama.cpp) v1 | `cmtimssel` · 09-01 12:38 | **+0.2414** | 0.7931 (23/29) | 0.5517 'A>B' 16/29 | 0.9655 (28/29, 1 tie) | 0.8214 (23/28) [0.6441–0.9212] | 0.5357 'A>B' 15/28 | +0.2857 | 0.0333 (1/30) | — |
| 7 | granite4.2:3b (Ollama) v1 | `cmtircx0x` · 09-01 16:30 | **+0.0400** | 0.6000 (15/25) | 0.5600 'A>B' 14/25 | 0.9200 (23/25, 2 tie) | 0.6522 (15/23) [0.4489–0.8119] | 0.5652 'A>B' 13/23 | +0.0870 | 0.1667 (5/30) | ⚠LOSS |
| 8 | lfm2.5-thinking:1.2b (Ollama) v1 | `cmtp3jods` · 09-06 00:54 | **+0.0000** | 0.5667 (17/30) | 0.5667 'A>B' 17/30 | 0.9333 (28/30, 2 tie) | 0.6071 (17/28) [0.4241–0.7643] | 0.6071 'A>B' 17/28 | +0.0000 | 0.0000 (0/30) | ⚑FLOOR ⚑SFLOOR |
| 9 | granite4.1:3b (Ollama) v1 | `cmtlof24j` · 09-03 15:26 | **−0.0667** | 0.5000 (15/30) | 0.5667 'A>B' 17/30 | 0.7000 (21/30, 9 tie) | 0.7143 (15/21) [0.5004–0.8619] | 0.6190 'A>B' 13/21 | +0.0952 | 0.0000 (0/30) | ⚑FLOOR |
| 10 | granite4.1:3b (Ollama) v1 | `cmtimse5m` · 09-01 12:18 | **−0.0667** | 0.5000 (15/30) | 0.5667 'A>B' 17/30 | 0.7667 (23/30, 7 tie) | 0.6522 (15/23) [0.4489–0.8119] | 0.5652 'A>B' 13/23 | +0.0870 | 0.0000 (0/30) | ⚑FLOOR |
| 11 | granite4.1:3b (Ollama) v1 | `cmtht0o9d` · 08-31 22:42 | **−0.0667** | 0.5000 (15/30) | 0.5667 'A>B' 17/30 | 0.7667 (23/30, 7 tie) | 0.6522 (15/23) [0.4489–0.8119] | 0.5652 'A>B' 13/23 | +0.0870 | 0.0000 (0/30) | ⚑FLOOR |
| 12 | mistrallite:7b (Ollama) v1 | `cmtpv1n5s` · 09-06 13:43 | **−0.2000** | 0.3667 (11/30) | 0.5667 'A>B' 17/30 | 0.5000 (15/30, 15 tie) | 0.7333 (11/15) [0.4805–0.8910] | 0.8000 'A>B' 12/15 | −0.0667 | 0.0000 (0/30) | ⚠n<20 ⚑FLOOR ⚑SFLOOR |
| 13 | lfm2.5:8b (Ollama) v2 | `cmtozvve1` · 09-05 23:24 | **−0.4333** | 0.1333 (4/30) | 0.5667 'A>B' 17/30 | 0.1667 (5/30, 25 tie) | 0.8000 (4/5) [0.3755–0.9638] | 0.6000 'B>A' 3/5 | +0.2000 | 0.0000 (0/30) | ⚠COV ⚠n<20 ⚑FLOOR ⓘCLASS |

> **THE HAZARD, ON THIS BOARD.** Sorting on `selective` puts **row 13 first** (0.8000) and row 9 fourth (0.7143). Sorting on `sel. margin` *also* puts row 13 first (+0.2000 vs +0.0952). Sorting on `margin*` puts row 13 **last**, and the guards on the row say why: **⚠COV** coverage 0.1667 (5/30 committed; 25 abstained with 'tie'), **⚠n<20** selective rests on 5 items with Wilson 95% [0.3755, 0.9638] — a 0.5882-wide interval that *strictly contains* row 9's entire [0.5004, 0.8619]. The 0.0857 point gap is 6.9x smaller than the interval it lives in.
> **ⓘ CLASS** (row 13) — the committed floor names a **different** top class ('B>A', 3/5) than the scored floor ('A>B', 17/30). The +0.2000 and the −0.4333 are not measured against the same stamp. Only production run that trips this.
> **⚑ SFLOOR** (row 8) — 0.6071 = 0.6071 **exactly**: where lfm2.5-thinking commits on this set it is *precisely* a stamp. (Row 12: 0.7333 ≤ 0.8000 — mistrallite is *below* its committed floor.) This is why the comparison is `<=` and not `<`.
> **⚑ FLOOR** fires on 10 of the 20 runs in the whole corpus. Half this board is at or below a stamp on its own scored subset.
> **Rows 9/10/11 are the same judge, same version, same set, same measurement**: 30/30 verdicts and 15 correct on all three, `margin*` **−0.0667** on all three (spread **0.0000**). Only the tie count moved (9, 7, 7), and `selective` swung **0.0621** (0.7143 / 0.6522 / 0.6522). That 0.0621 of pure noise is 8.4x the 0.0074 gap the selective column is asked to adjudicate on the full set. Rows 2–6 (Qwen3.6 v1 ×5) give the board's least-significant-difference on the sort key: **0.0586**.

#### ▸ TIER 3 — NOT MEASURED · NOT RANKED

| # | judge · v | run · finished (UTC) | margin* | raw agr. (n) | constant floor | coverage (n) | selective (n) [95% CI] | selective floor | sel. margin | no-verdict (n) | guards |
|---|---|---|---|---|---|---|---|---|---|---|---|
| — | qwen3.5:9b (Ollama) v1 | `cmtkt3sg2` · 09-03 01:21 | ~~+0.2222~~ | ~~0.7778 (7/9)~~ | 0.5556 'A>B' 5/9 | ~~1.0000 (9/9, 0 tie)~~ | ~~0.7778 (7/9) [0.4526–0.9368]~~ | 0.5556 'A>B' 5/9 | ~~+0.2222~~ | 0.7000 (21/30) | ⛔VOID ⚠LOSS! ⚠n<20 ⚠STALE |
| — | granite4.2:3b (Ollama) v1 | `cmtiplr3x` · 09-01 14:19 | ~~+0.0000~~ | ~~0.6667 (10/15)~~ | 0.6667 'A>B' 10/15 | ~~0.9333 (14/15, 1 tie)~~ | ~~0.7143 (10/14) [0.4535–0.8828]~~ | 0.6429 'A>B' 9/14 | ~~+0.0714~~ | 0.5000 (15/30) | ⚠LOSS! ⚠n<20 ⚑FLOOR |

> `cmtkt3sg2` — **⛔ VOID**: 21 of 30 judgments carry `VOID: run abandoned at max_tokens 6144`. **⚠ STALE**: stored `verdictCount` 0 / `rawAgreement` NULL (deliberately voided) while the rows carry 9 verdicts. Do **not** re-score it (`scoreCalibrationRun` is a full overwrite and would resurrect the +0.2222).
> `cmtiplr3x` — **carries NO `VOID:` marker in the database** even though the spec calls it VOID; only the independent `noVerdictRate >= 0.25` guard catches it (0.5000, 15 of 30 truncated at `finishReason='length'`). Its raw 0.6667 would rank it **6th of 13** on the tier-1 board; its `margin*` is **+0.0000** — a 15-item subset keyed 10/5 whose floor is also 0.6667. This is the flattering-a-partial-run failure `v2l` exists for, live.

**LEGEND** — ⛔VOID = `error LIKE 'VOID:%'` · ⏳LIVE = `finishedAt IS NULL OR pending/running` · ⚠LOSS!/⚠LOSS = noVerdictRate ≥ 0.25 / ≥ 0.10 · ⚠COV = coverage < 0.50 · ⚠n<20 = committedCount < 20 · ⚑FLOOR = raw ≤ constant floor · ⚑SFLOOR = selective ≤ committed floor · ⓘCLASS = the two floors name different top classes · ⓘTIEKEY = key contains ties (**dormant, 0/20**) · ⚠STALE = stored `verdictCount` ≠ rows.
`selective` and `sel. margin` are **diagnostics, never sort keys**. `no-verdict` is a **FLEET** property (truncation / dead request), **not** abstention — abstention is `coverage`.

---

## THE SQL (read-only; `SELECT`/`WITH` only)

```sql
-- ═══ judge-arena calibration scoreboard ═══════════════════════════════════
-- READ-ONLY. Recomputes every figure from ModelJudgment; reads NOTHING
-- aggregate off CalibrationRun. UPDATED: v2m/v2n LANDED on judge-arena-pg-1
-- at 2026-09-06 21:43:08 UTC — minutes after this file's figures were
-- computed (21:40-21:43 UTC) — so scoringVersion / committedCount /
-- selectiveAccuracy / selectiveBaselineAccuracy DO now exist as columns.
-- This query still avoids them: the columns that exist are stale on 3 of 20
-- runs and NULL on 12 of 20, migration timing notwithstanding, so
-- ModelJudgment remains the only trustworthy source for every figure below.
-- Semantics mirror src/lib/calibration/score.ts @ c0785f0 exactly.
with j as (
  select cr.id                     as crid,
         jm.name                   as judge,
         jv.ordinal                as jver,
         gs.name                   as setname,
         cr."verdictCount"         as stored_vc,
         cr."finishedAt"           as finished,
         gi.expected               as expected,
         mj.status                 as mstat,
         mj.error                  as merr,
         mj.verdict                as verdict,
         -- pairOrder is NOT uniformly 'AB' anymore: the permuted calibration
         -- (migration v2p) produces 'BA' rows too. The join below now filters
         -- on er."pairOrder" = 'AB', so every row reaching this CASE is
         -- ENFORCED to be 'AB' by the join predicate, not merely observed to
         -- be — preferenceFromVerdict's identity mapping is guaranteed
         -- correct here, not assumed. See the assertion query at the bottom
         -- for the tripwire that protects this join.
         case when mj.verdict = 'tie' then 'tie'
              when mj.verdict = 'A'   then 'A>B'
              when mj.verdict = 'B'   then 'B>A'
         end                       as pref
  from "CalibrationRun" cr
  join "JudgeModelVersion" jv on jv.id = cr."judgeModelVersionId"
  join "JudgeModel"       jm on jm.id = jv."judgeModelId"
  join "GoldenSet"        gs on gs.id = cr."goldenSetId"
  join "EvaluationRun"    er on er."calibrationRunId" = cr.id
                             and er."pairOrder" = 'AB'    -- v2p: exclude 'BA' rows from a permuted run
  join "GoldenItem"       gi on gi.id = er."goldenItemId"   -- = dispatchedItemCount
  left join "ModelJudgment" mj on mj."runId" = er.id        -- ALL statuses; gated below
),
a as (
  select crid, judge, jver, setname, stored_vc, finished,
    count(*)                                                                as dispatched,
    count(*) filter (where mstat = 'completed' and verdict is not null)     as verdicts,
    count(*) filter (where mstat = 'completed' and verdict <> 'tie')        as committed,
    count(*) filter (where mstat = 'completed' and verdict  = 'tie')        as abstained,
    count(*) filter (where mstat = 'completed' and pref = expected)         as correct,
    -- SEPARATE accumulator, past the same gate: on a tie-KEYED item a 'tie'
    -- verdict is a hit, so reusing `correct` over `committed` can exceed 1.
    count(*) filter (where mstat = 'completed' and verdict <> 'tie' and pref = expected) as committed_correct,
    -- key marginal over the SCORED subset
    count(*) filter (where mstat = 'completed' and expected = 'A>B')        as k_ab,
    count(*) filter (where mstat = 'completed' and expected = 'B>A')        as k_ba,
    count(*) filter (where mstat = 'completed' and expected = 'tie')        as k_tie,
    -- key marginal over the COMMITTED subset — a DIFFERENT denominator, and
    -- it can name a DIFFERENT top class (it does, on cmtozvve1).
    count(*) filter (where mstat = 'completed' and verdict <> 'tie' and expected = 'A>B') as ck_ab,
    count(*) filter (where mstat = 'completed' and verdict <> 'tie' and expected = 'B>A') as ck_ba,
    count(*) filter (where mstat = 'completed' and verdict <> 'tie' and expected = 'tie') as ck_tie,
    count(*) filter (where mstat in ('pending','running'))                  as still_queued,
    count(*) filter (where mstat = 'error')                                 as errored,
    count(*) filter (where merr like 'VOID:%')                              as void_marked
  from j group by 1,2,3,4,5,6
),
m as (
  select a.*,
    greatest(k_ab,  k_ba,  k_tie)   as k_max,
    greatest(ck_ab, ck_ba, ck_tie)  as ck_max,
    dispatched - verdicts           as missing,
    -- top class(es), in PREFERENCES order, ties REPORTED not broken
    array_to_string(array_remove(array[
      case when k_ab  = greatest(k_ab,k_ba,k_tie)    then 'A>B' end,
      case when k_ba  = greatest(k_ab,k_ba,k_tie)    then 'B>A' end,
      case when k_tie = greatest(k_ab,k_ba,k_tie)    then 'tie' end], null), '/')  as floor_class,
    array_to_string(array_remove(array[
      case when ck_ab  = greatest(ck_ab,ck_ba,ck_tie) then 'A>B' end,
      case when ck_ba  = greatest(ck_ab,ck_ba,ck_tie) then 'B>A' end,
      case when ck_tie = greatest(ck_ab,ck_ba,ck_tie) then 'tie' end], null), '/') as sfloor_class
  from a
),
r as (
  select m.*,
    correct::numeric        / nullif(verdicts,0)                                as raw_agreement,
    k_max::numeric          / nullif(verdicts,0)                                as constant_floor,
    (correct - k_max)::numeric / nullif(verdicts,0)                             as margin,
    committed::numeric      / nullif(verdicts,0)                                as coverage,
    committed_correct::numeric / nullif(committed,0)                            as selective,
    ck_max::numeric         / nullif(committed,0)                               as selective_floor,
    (committed_correct - ck_max)::numeric / nullif(committed,0)                 as selective_margin,
    missing::numeric        / nullif(dispatched,0)                              as no_verdict_rate,
    -- Wilson 95% on the SELECTIVE proportion. The whole hazard is that this
    -- column's n is decoupled from the run's n (5 of 30; 103 of 603).
    case when committed > 0 then
      (committed_correct::float/committed + 1.9208/committed
       - 1.96*sqrt((committed_correct::float/committed)*(1-committed_correct::float/committed)/committed
                   + 0.9604/(committed::float*committed)))/(1+3.8416/committed) end as sel_lo,
    case when committed > 0 then
      (committed_correct::float/committed + 1.9208/committed
       + 1.96*sqrt((committed_correct::float/committed)*(1-committed_correct::float/committed)/committed
                   + 0.9604/(committed::float*committed)))/(1+3.8416/committed) end as sel_hi
  from m
),
g as (
  select r.*,
    (void_marked > 0)                                            as g_void,
    (finished is null or still_queued > 0)                       as g_inflight,
    (missing::numeric/nullif(dispatched,0) >= 0.25)              as g_loss_hard,
    (missing::numeric/nullif(dispatched,0) >= 0.10)              as g_loss_warn,
    (committed::numeric/nullif(verdicts,0) < 0.50)               as g_cov,
    (committed < 20)                                             as g_smalln,
    (correct::numeric/nullif(verdicts,0) <= k_max::numeric/nullif(verdicts,0))               as g_floor,
    (committed_correct::numeric/nullif(committed,0) <= ck_max::numeric/nullif(committed,0))  as g_sfloor,
    (floor_class is distinct from sfloor_class)                  as g_class,
    (k_tie > 0)                                                  as g_tiekey,
    (stored_vc is distinct from verdicts)                        as g_stale
  from r
)
select
  setname,
  case when g_void then 3 when g_inflight then 2 when g_loss_hard then 3 else 1 end as tier,
  judge || ' v' || jver                                             as judge,
  left(crid,9)                                                      as run,
  coalesce(to_char(finished,'YYYY-MM-DD HH24:MI'), 'OPEN')          as finished,
  to_char(round(margin,4), 'S0.0000')                               as "margin*",
  to_char(round(raw_agreement,4),'0.0000') || ' (' || correct || '/' || verdicts || ')'         as raw_agr,
  to_char(round(constant_floor,4),'0.0000') || ' ' || floor_class || ' ' || k_max || '/' || verdicts as const_floor,
  to_char(round(coverage,4),'0.0000') || ' (' || committed || '/' || verdicts || ', ' || abstained || ' tie)' as coverage,
  coalesce(to_char(round(selective,4),'0.0000') || ' (' || committed_correct || '/' || committed || ') ['
    || to_char(round(sel_lo::numeric,4),'0.0000') || '-' || to_char(round(sel_hi::numeric,4),'0.0000') || ']', 'UNDEFINED (0/0)') as selective,
  coalesce(to_char(round(selective_floor,4),'0.0000') || ' ' || sfloor_class || ' ' || ck_max || '/' || committed, 'n/a') as sel_floor,
  coalesce(to_char(round(selective_margin,4),'S0.0000'),'n/a')      as sel_margin,
  to_char(round(no_verdict_rate,4),'0.0000') || ' (' || missing || '/' || dispatched || ')'    as no_verdict,
  concat_ws(' ',
    case when g_void      then '**VOID**'   end,
    case when g_inflight  then '**LIVE**'   end,
    case when g_loss_hard then 'LOSS!'  when g_loss_warn then 'LOSS' end,
    case when g_cov       then 'COV'    end,
    case when g_smalln    then 'n<20'   end,
    case when g_floor     then 'FLOOR'  end,
    case when g_sfloor    then 'SFLOOR' end,
    case when g_class     then 'CLASS'  end,
    case when g_tiekey    then 'TIEKEY' end,
    case when g_stale     then 'STALE'  end)                        as guards
from g
order by setname,
         case when g_void then 3 when g_inflight then 2 when g_loss_hard then 3 else 1 end,
         margin desc nulls last,   -- ← THE DEFAULT SORT KEY
         verdicts desc,            -- deterministic tiebreak 1: larger scored subset
         finished desc nulls last; -- deterministic tiebreak 2: most recent
```

### Assertion query — run this BEFORE trusting the `pairOrder` shortcut above

```sql
-- One row per distinct pairOrder actually present: 'AB' alone on a
-- single-order calibration, 'AB' and 'BA' both on a permuted one (v2p) --
-- NOT "exactly one row" any more. What matters on a permuted run is that
-- the two counts are EQUAL (detector A's key-doubling property: every AB
-- dispatch gets a matching BA dispatch) -- not the row count, and not any
-- particular total (whatever the current total is, checked at the time).
-- coalesce() is required: a bare GROUP BY hides a NULL pairOrder in plain sight,
-- and a NULL order makes preferenceFromVerdict THROW rather than assume 'AB'.
select coalesce("pairOrder",'<<NULL>>') as pair_order, count(*)
from "ModelJudgment" group by 1 order by 1;

-- Must all return 0.
select count(*) from "ModelJudgment" where status='completed' and verdict is null;
select count(*) from "EvaluationRun" where "calibrationRunId" is not null and "goldenItemId" is null;
-- Re-keyed: under one judgment per EvaluationRun by construction, the old
-- `group by "runId" having count(*)>1` returns 0 UNCONDITIONALLY — disarmed
-- by that very design, it could never fire again. The invariant the v2p
-- partial unique index actually protects is one completed judgment per
-- (calibrationRunId, goldenItemId, pairOrder): a permuted run legitimately
-- gets a SECOND EvaluationRun for the same item (the 'BA' leg), so runId-level
-- duplication is no longer the thing worth catching.
select count(*) from (select er."calibrationRunId", er."goldenItemId", er."pairOrder"
                      from "EvaluationRun" er
                      join "ModelJudgment" mj on mj."runId" = er.id and mj.status = 'completed'
                      where er."calibrationRunId" is not null
                      group by 1,2,3
                      having count(*) > 1) d;                          -- duplicate (run,item,order)
select count(*) from (select er."calibrationRunId" from "EvaluationRun" er
                      join "ModelJudgment" mj on mj."runId"=er.id and mj.status='completed'
                      where er."calibrationRunId" is not null group by 1
                      having count(distinct mj."judgeModelVersionId")<>1
                          or count(*) filter (where mj."judgeModelVersionId" is null)>0) d;
```

Run with:
```
kubectl exec -i -n tenant-public judge-arena-pg-1 -- psql -U postgres -d judge_arena -f - < scoreboard.sql
```