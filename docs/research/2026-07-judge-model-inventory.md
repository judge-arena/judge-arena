# Judge-Model Inventory & Landscape — July 2026

**Program:** Judge Arena v2, Phase R deliverable (see
`docs/superpowers/specs/2026-07-22-judge-arena-v2-program-design.md`)
**Produced:** 2026-07-22, deep-research harness — 5 search angles, 26 sources
fetched, 130 claims extracted, top 25 adversarially verified (3-vote panels):
**25 confirmed, 0 refuted**; plus a targeted round-2 gap-fill (§8; four
agents on the harness's flagged gaps, claims verified against primary
sources/model configs, per-finding confidence stated inline).
**Purpose:** ground the Phase 1 schema (judge model classes + versioning) and
the Phase 3 in-product meta-evaluation harness.

---

## 1. Executive summary

- The literature converges on a **schema-ready taxonomy along three axes**:
  *system shape* (single-LLM / multi-LLM / human-AI), *architecture* (reward-head
  scalar vs token-probability vs critique-generating), and *protocol*
  (pointwise / pairwise / listwise × score / ranking / selection). Rubric-anchored
  judging — Judge Arena's core protocol — is **not** in the standard I/O taxonomy
  and must be modeled as an extra dimension. [F1, F2]
- **Judge quality is architecture- and vintage-dependent**, confirming the
  program's premise: discriminative (reward-head) RMs win in-distribution but
  degrade badly out-of-distribution (a SOTA 8B RM scored *below random* on
  RM-Bench hard subsets); generative judges generalize better OOD. [F16]
  Fine-tuned judges have a **shelf life** — they degrade on outputs from
  newer/stronger generators than they were trained on — which directly motivates
  `trainingDataVintage` and version-lineage fields. [F13, F14]
- **Reasoning/thinking mode is a first-class judge attribute**: explicit
  reasoning improves accuracy and bias robustness (~10pp at <2× cost in
  controlled same-model comparisons), with real caveats (overthinking,
  adversarial surface, counter-evidence in some pointwise CoT settings). [F15]
- **Meta-evaluation must be multi-benchmark and chance-corrected**: raw
  exact-match agreement overstates chance-corrected agreement by 33.8–41.3pp on
  MT-Bench; JudgeBench discriminates ~4.5× more sharply than MT-Bench; judge
  rankings shift up to 15 positions across benchmarks. Cohen's κ is the headline
  metric; position bias needs paired AB+BA runs; high test-retest consistency
  can mask severe position bias (the "consistency–bias paradox"). [F10–F12]
- **A 7–8B fine-tuned judge is a viable single-GPU deployment target** on the
  RTX 4000 SFF Ada 20GB: CompassJudger-2-7B (~15.2GB bf16) and Selene-1-Mini
  (~16GB bf16) fit with ~4–5GB KV headroom; CompassJudger-2-32B requires int4
  (~16–17GB) — a VRAM-fit statement only, quality-at-int4 addressed in §8. [F17]

## 2. Taxonomy of judge classes (schema dimensions)

Three verified, complementary axes [F1, F2]:

**Axis 1 — system shape** (Awesome-LLMs-as-Judges survey):
single-LLM (prompt-based / tuning-based / post-processing), multi-LLM
(cooperation / competition / aggregation), human-AI collaboration.
Judge Arena's multi-model + human workflow is a *multi-LLM aggregation +
human-AI collaboration* system; individual judge configs are single-LLM units.

**Axis 2 — architecture** (arXiv 2602.09305):
1. **Discriminative / reward-head:** linear head atop a decoder-only LM,
   emits scalar scores (sequence-classifier reward models).
2. **Generative probability-based:** token probabilities (e.g. yes/no logits)
   as the reward signal.
3. **Critique-based generative:** emits textual critique + score (the
   LLM-as-judge shape Judge Arena uses today; includes fine-tuned critique
   models like the Selene lineage).

**Axis 3 — protocol I/O** (EMNLP 2025 survey, Li et al.):
inputs pointwise (n=1) / pairwise (n=2) / listwise (n>2); outputs score /
ranking / selection. **Rubric-anchored evaluation is absent from this taxonomy**
and must be a separate schema flag (rubric injected into the judge prompt, as
Judge Arena does).

**Practical lineage roster** (instantiated by a March 2026 empirical study,
arXiv 2603.08091 — these are the four product-relevant classes):

| Class | Examples (verified roster) |
|---|---|
| Prompted frontier-API judges | GPT-3.5-Turbo, Claude-3.7-Sonnet, o4-mini, DeepSeek-R1, Kimi-K2 |
| Prompted open-weight generative | Qwen3-8B |
| Fine-tuned judge LMs | JudgeLM-7B, Auto-J-13B, Prometheus-7B-V2.0, Selene-1-Mini |
| Sequence-classifier RMs | Skywork-Reward-V2 series, GRM-Llama3-8B |

Plus, from the research question's framing (round-2, §8): **generative reward
models** and **specialized judges** (safety, factuality/hallucination).

## 3. Model lineages

**Fine-tuned judge LM baseline (2023–2024)** [F3]: JudgeLM (2023),
Prometheus (ICLR 2024), Prometheus-2 (2024), PandaLM (ICLR 2024),
CompassJudger-1 (2024), Themis (EMNLP 2024), CritiqueLLM (ACL 2024), PHUDGE (2024).

**Training-technique evolution** [F4, F5]: SFT (on manually-labeled or
GPT-4-synthesized judgments) remains dominant; DPO and RLVR (J1, JudgeLRM,
RM-R1 lineage) are the newer alternatives with better generalization.
**CompassJudger-2** (July 2025, arXiv 2507.09104) is the current lineage head:
7B/32B generalist judges fine-tuned from Qwen2.5-Instruct with verifiable
rewards + rejection sampling + margin policy-gradient loss — the class has
moved beyond plain SFT.

**Verified benchmark picture (self-reported)** [F6]:

| Model | JudgerBenchV2 | JudgeBench | RMB | RewardBench (v1) | Avg |
|---|---|---|---|---|---|
| CompassJudger-2-32B | 62.21 | 65.48 | 72.98 | 92.62 | 73.32 |
| Qwen2.5-32B-Instruct (base) | 62.97 | 59.84 | 74.99 | 85.61 | 70.85 |
| CompassJudger-2-7B | — | 63.06 | — | 90.96 | 72.11 |

The 7B edges DeepSeek-V3-0324 (71.86) and Qwen3-235B-A22B (71.91) on the
4-benchmark average — near-frontier judging at single-GPU scale. Caveats: all
self-reported; RewardBench column is saturated v1; JudgerBenchV2 is in-house.
Fine-tuning gains concentrate on RewardBench (+7pp) and JudgeBench (+5.6pp);
the 32B *loses slightly* to its base on JudgerBenchV2 and RMB.

**Atla Selene-1-Mini** [F7]: 8.03B, post-trained from Llama-3.1-8B-Instruct
(combined DPO+SFT, arXiv 2501.17195), BF16, 128K context, critique+score
generative judge (not an RM). License: Apache-2.0 declared (base-license
tension noted in §8.4).

## 4. Architecture-dependence findings

| Finding | Evidence | Schema consequence |
|---|---|---|
| Discriminative RMs: strong in-distribution, fragile OOD — SOTA Skywork-Reward-Llama-3.1-8B scored **46.6% (below random)** on RM-Bench hard subsets; generative judges generalize better OOD [F16] | GRAM (ICML 2025), survey consensus | `scoringMechanism` field; product guidance: RMs for in-domain ranking, generative judges for open-ended/rubric work |
| Fine-tuned judges degrade on newer/stronger generators ("all FutureProof values negative" across 3 bases × 3 recipes × 2 domains × 8 generators) [F13] | arXiv 2509.23542 (ICLR 2026) | `trainingDataVintage` (date), `baseModel`, version lineage on judge models |
| Retrained judges are largely backward-compatible (drop-in replacement; DPO recipes cleanest, SFT-heavy recipes show small drops; noisy — "evaluate model-by-model") [F14, medium confidence, 2-1 vote] | same | Version *supersession* semantics are viable, but calibration re-runs per version are mandatory, not optional |
| Explicit reasoning/thinking improves judge accuracy & bias robustness (~10pp accuracy/consistency at <2× cost; thinking-mode on/off controlled: 83.48 vs 73.86 consistency under verbosity bias); counter-evidence in some pointwise CoT settings [F15] | EMNLP 2025 §7.2; arXiv 2603.08091; 2509.13332; counter: 2503.03064 | `reasoningMode` attribute (none / optional / always) recorded **per judgment**, not just per model |

## 5. Meta-evaluation benchmarks & product metrics

**Canon** [F8]: RewardBench (2024), RM-Bench (ICLR 2025), JudgeBench
(ICLR 2025), MLLM-as-a-Judge (ICML 2024), MM-Eval (2024);
RewardBench 2 (Ai2, June 2025, arXiv 2506.01937) post-dates the older catalogs.
**2025–2026 additions** [F9]: **JudgerBenchV2** (10,000 questions, 10 scenarios,
Mixture-of-Judgers consensus ground truth; accuracy + rank consistency) and
**JudgeBiasBench** (arXiv 2603.08091: Bias Sensitivity Rate — proportion of
originally-correct judgments that flip after bias injection — across 12 bias
types in 4 dimensions). Bias robustness is now a distinct axis from accuracy.

**What the product adopts** (all verified against arXiv 2606.19544,
"Reliability without Validity", 21 judges / ~541k judgments) [F10–F12]:

1. **Cohen's κ (chance-corrected) as the headline agreement metric** — raw
   exact-match overstates agreement by 33.8–41.3pp (MT-Bench cohort; 23.7pp on
   JudgeBench, 10.4pp on binary RewardBench). Krippendorff's α acceptable
   alternative.
2. **At least two benchmarks / golden sets per judge** — kappa spreads:
   JudgeBench 60.4pp vs MT-Bench 13.5pp (4.5× discrimination); rankings shift
   up to 14–15 positions across benchmarks (Llama 3.3 70B: rank 5 → rank 20).
3. **Position bias via paired AB+BA runs**, reported as |P(A wins) − 0.5|,
   *jointly* with test-retest consistency. The consistency–bias paradox is
   real: Qwen3-8B hit 0.992 test-retest with 0.192 position bias. Treat
   test-retest > 0.95 with position bias > 0.10 as a **failure mode**.
4. **Bias Sensitivity Rate** (JudgeBiasBench-style bias injection) as the
   bias-robustness axis complementing accuracy.

## 6. Serving feasibility — RTX 4000 SFF Ada 20GB (gharial)

Verified [F17]:

| Model | Params | Precision | Weights VRAM | Fits 20GB? |
|---|---|---|---|---|
| CompassJudger-2-7B | 7.6B | bf16 | ~15.2GB | ✅ ~4–5GB KV headroom |
| Selene-1-Mini | 8.03B | bf16 | ~16GB | ✅ ~4GB KV headroom |
| CompassJudger-2-32B | 32.8B | bf16 | ~64GB | ❌ |
| CompassJudger-2-32B | 32.8B | int4 (AWQ) | ~16–17GB | ⚠️ Fits; indirect evidence says 32B@int4 is *low-risk* (~1% class loss at 14B+), but judge-metric validation required (§8.1) |

Recommended local targets, in order: (1) 7–8B fine-tuned judge at native bf16
— zero quantization risk; (2) CompassJudger-2-32B at AWQ-int4 — stronger
judge, small indirect-evidence risk, **gated on a flip-rate A/B calibration
against golden set** (§8.1). Avoid 7–8B at int4 (measurably lossy at that
size). vLLM-vs-Ollama: §8.3.

## 7. Schema implications (input contract for Phase 1)

Fields the verified findings *require* the v2 schema to carry:

**On JudgeModel (versioned; new version on any change to starred fields):**
- `judgeClass` — enum: `prompted_api` | `prompted_open_weight` |
  `finetuned_judge_lm` | `sequence_classifier_rm` | `generative_rm` |
  `specialized_safety` | `specialized_factuality` [F1, §8]
- `scoringMechanism` — `reward_head_scalar` | `token_probability` |
  `critique_generative` [F1, F16]
- `baseModel`, `paramsB`, `contextLength` [F5, F7, F13]
- ★ `weightsRevision` (HF revision / API model snapshot), ★ `quantization`
  (none/fp8/int8/int4 + method AWQ/GPTQ/GGUF), ★ `servingBackend`
  (anthropic / openai / openrouter / vllm / ollama), `endpointClass` [F17]
- `trainingRecipe` — `prompted` | `sft` | `dpo` | `rlvr` | mixed [F4, F5]
- `trainingDataVintage` (date) + `parentVersionId` lineage [F13, F14]
- `reasoningMode` — `none` | `optional` | `always` [F15]
- Protocol support matrix: {pointwise, pairwise, listwise} × {score, ranking,
  selection} + `supportsRubricAnchored` flag [F2]
- `license` (serving/redistribution constraints differ by lineage) [F5, F7, §8]

**On ModelJudgment (per-judgment provenance):**
- `judgeModelVersionId` (immutable pin), `promptTemplateVersion`,
  `rubricVersionId` (exists today), sampling params,
  `reasoningEnabled` (actual per-run state) [F15],
  `pairOrder` (AB vs BA) for pairwise runs [F12]

**Meta-eval entities (Phase 3 tables, Phase 1 schema):**
- GoldenSet / GoldenLabel (human labels)
- CalibrationRun: judge-version × golden-set → κ (headline), raw agreement,
  test-retest consistency, position bias |P(A)−0.5|, BSR [F10–F12, F9]
- Product rule: a judge version with no passing CalibrationRun is untrusted;
  version supersession allowed but never silent [F13, F14]

## 8. Round-2 gap-fill findings

The primary harness produced **zero surviving claims** on four topics; a
targeted second round addressed them. *(Sections below integrate round-2
results; confidence is per-finding.)*

### 8.1 Quantization effects on judge quality

**The direct literature is silent — a verified gap, not a search failure.**
No published study measures judge-specific metrics (agreement, position bias,
calibration) at int4/int8 vs bf16 for any dedicated judge model; the 2606.19544
reliability study contains zero quantization content (full-text grep), and
official quantized judge artifacts ship without quality data (Flow-Judge AWQ/
GGUF, `atla/selene-mini:q4_k_m` on Ollama, community CompassJudger GGUFs).

**Converging indirect evidence** (all quotes verified against sources):

- **Quantization selectively damages the judge-critical skills.** IJCAI-25
  study (1B–405B, GPTQ/AWQ/SmoothQuant/FP8, 13 datasets): quantized models
  "often struggle with instruction-following and hallucination detection";
  "FP8 consistently emerges as the most robust option"; AWQ > GPTQ.
  (arXiv 2409.11055)
- **FP8 ≈ lossless; well-tuned INT8 loses 1–3%; INT4 W4A16 rivals 8-bit** —
  including on Arena-Hard (itself judge-evaluated), with overlapping 95% CIs
  (Neural Magic ~500K-eval study, arXiv 2411.02355, EMNLP Industry 2025;
  vendor incentive noted, methodology public).
- **Size × bit-width interaction favors 32B@int4 over 8B@int4:** Qwen3
  quantization study (arXiv 2505.02214): int8 near-lossless at all sizes;
  int4 costs Qwen3-8B ~3 MMLU pts (74.7→71.9 AWQ) but Qwen3-14B only ~1%.
  → **CompassJudger-2-32B at int4 is the *low-risk* quantized config on 20GB;
  8B judges should run bf16 (they fit anyway) or int8, not int4.**
- **Aggregate parity hides per-verdict divergence.** "Accuracy is Not All You
  Need" (Microsoft, 2407.09141): compressed models flip individual answers
  correct↔incorrect even at similar accuracy. A June 2026 follow-up
  (2606.10154, 51 quant configs) found "hidden-danger" rows where quality
  holds while behavior shifts 12–68pp, and calibration probes failed to
  detect them. **The product consequence: a quantized judge must be validated
  by flip-rate A/B against its bf16 parent on a fixed verdict set — benchmark
  parity is not evidence.**
- Quantization "tends to slightly increase stereotypes and unfairness"
  (2508.18088); **position bias under quantization has never been measured.**
- One counter-shape: Llama Guard 3-1B-INT4 matches its parent via **QAT +
  distillation** (2411.17713) — deliberate compression can preserve
  judgment-style classification; post-training GPTQ/AWQ conversions carry no
  such guarantee.

**Schema/product deltas:** `quantization` as a version-bumping field is now
evidence-backed (per-verdict flips at aggregate parity). CalibrationRun gains a
**flip-rate-vs-parent metric** for quantized variants: every quantized judge
version calibrates against its full-precision parent *and* the golden set,
and position-bias probes are mandatory for quantized judges since the
literature has never measured it.

### 8.2 RewardBench 2 leaderboard state & specialized judges

**RewardBench 2** (arXiv 2506.01937; ICLR 2026): deliberately much harder than
v1 — "models score about 20 points on average lower... compared to the first
RewardBench" (best-of-4 across factuality, instruction following, math, safety,
focus, ties). **Top open-weight entry: Skywork-Reward-V2-Llama-3.1-8B at 84.1**
— an 8B Bradley–Terry *sequence classifier* holds #1 (confirmed independently
by its model card); top tier compresses into ~76–84 with strong sub-10B
presence (Skywork-Reward-V2-Qwen3-8B 78.4; LMUnit-72B 82.1; Databricks PGRM
80.0 — ranks 2–8 medium confidence, leaderboard Space unreadable headless).
RewardBench 2 is standard but has **not displaced** RM-Bench/JudgeBench (e.g.
AdaJudge, Jan 2026, evaluates on RM-Bench + JudgeBench only); the Ai2
results dataset was last modified 2025-12-23 — treat the hosted leaderboard as
semi-stale in 2026. **Skywork-Reward-V2** (arXiv 2507.01352): 8 BT reward
models 0.6B–8B (Qwen3 + Llama-3 bases, 26M-pair curated SynPref subset), top
rankings on seven RM benchmarks; the 8B variants beat Claude-3.7-Sonnet and
Gemini-2.5-Flash on RewardBench 2. License: Llama 3.1 community (8B variant).

**Safety judges** (ICLR 2026 workshop benchmark, arXiv 2605.28830, 14+ guards):
small models are competitive — **Qwen Guard 4B achieves the highest recall
(83.97%)**, beating 20B gpt-oss-safeguard and 12B Llama Guard 4. Current
landscape:
- **Llama Guard 4-12B** (Apr 2025, lineage head; no LG5 as of Jul 2026):
  dense early-fusion multimodal classifier pruned from Llama 4 Scout;
  *generative* output (safe/unsafe + MLCommons taxonomy categories); Llama 4
  community license.
- **Qwen3Guard** (Oct 2025, Apache 2.0, 0.6B/4B/8B, 119 languages, tri-class
  safe/controversial/unsafe) in two shapes: **-Gen** (generative) and
  **-Stream** (token-level classification head for moderation *during*
  generation) — streaming capability is a new schema-relevant property.
- **gpt-oss-safeguard** (OpenAI, Oct 2025, Apache 2.0, 20B/120B MoE):
  interprets a *developer-supplied policy at inference time* with CoT — policy-
  conditioned rather than fixed-taxonomy, a structurally new judge shape.
- ShieldGemma text (2B/9B/27B, Yes/No generative); ShieldGemma 2 (4B) is
  *image* moderation, not a text upgrade. WildGuard remains at its 2024 7B.

**Factuality/grounding judges:** Vectara **HHEM-2.1-Open** (0.1B flan-t5
classifier, Apache 2.0, 0–1 faithfulness score) remains the open model
(HHEM-2.3 is commercial-only); Patronus **Lynx** (Llama-3 8B/70B, CC-BY-NC,
generative REASONING + PASS/FAIL). On **LLM-AggreFact** (39 models):
**Bespoke-MiniCheck-7B leads at 77.4, above Claude-3.5-Sonnet (77.2) and
GPT-4o (75.9)**; sub-1B classifiers rank remarkably high (FactCG-DeBERTa-L
0.4B = 75.6); IBM Granite Guardian 3.3 8B (76.5) straddles safety +
groundedness.

**Schema deltas forced by this section** (extends §7): specialized judges
*do* warrant distinct classes, with new fields — `outputType`
(scalar / binary / tri-class / categories+CoT), `taxonomyMode`
(fixed-taxonomy vs policy-conditioned), `streamingCapable`, `modality`
(text / image / multimodal). License diversity (Apache-2.0 vs CC-BY-NC vs
Llama/Gemma community) is commercial-use-relevant across all three families
and confirms `license` as a required field.
*(Unanswered: full live RB2 table ranks 2–8; formal v1-leaderboard
deprecation; successors to WildGuard/Lynx/open-HHEM — negative results, not
proofs of absence.)*

### 8.3 vLLM vs Ollama for judge workloads

**Throughput under concurrency — decisive for batch judging.** The only
peer-reviewed head-to-head (Applied Sciences/MDPI, May 2026, H100, Qwen3-4B):
vLLM sustains **20–29× throughput** and **0% error rate at 100 concurrent
users vs Ollama's 39.29%**; under concurrent load Ollama's task accuracy
collapsed to 0.00 via "timeout-induced truncation" — unusable judge outputs,
not just slow ones. Corroborated by Red Hat's A100 benchmark (793 vs 41 output
tok/s; flagged: Red Hat is vLLM's principal commercial sponsor) and an
independent 2×A6000 benchmark. At single-request concurrency the stacks are
near parity (Ollama TTFT slightly better). Source audit: one candidate blog
(markaicode) discounted as a likely AI content farm with implausible numbers;
exxact is vendor marketing. No published benchmark exists for the RTX 4000 SFF
Ada specifically — expect the same ratio pattern at lower absolutes.

**Serving stack shifts judge scores for identical weights — up to 16.6pp.**
CISPA's "The Silent Hyperparameter" (arXiv 2605.19537, controlled, full-PDF
verified): Llama-3.1-8B drops **10pp on GSM8K under Ollama** vs transformers
reference (74.30 vs 84.23); DeepSeek-R1-Distill-7B disagrees on **27.37% of
outputs**. Root causes: Ollama's **hidden default `repeat_penalty=1.1`**
(disabling it: +11.67pp on R1), **forced BOS-token prepend** even with
raw=True (+8.34pp when removed), and FP32-vs-FP16 matmul accumulation drift.
All at FP16, greedy — quantization adds divergence on top.
**→ Judge scores are NOT portable across serving stacks. `servingBackend` as a
version-bumping schema field is now direct-evidence-backed, and per-judgment
provenance must capture effective sampling params.**

**Long rubric prompts — the correctness footgun.** Ollama **silently
front-truncates** input beyond its context setting (default **4096 tokens**;
verified experiment: 3,464-token prompt clipped to 2,047 with no error, cut
"from the front... precisely where system prompts and instructions typically
reside"). vLLM chunk-prefills by default and rejects over-limit prompts with
an API error. For multi-KB rubric prompts, Ollama's failure mode is a judge
that silently never saw the rubric. If Ollama is used at all: set
`num_ctx` explicitly and **assert `prompt_eval_count` ≥ expected on every
call**.

**Structured output:** both stacks support JSON-schema constrained decoding;
vLLM's surface is richer (schema/regex/CFG/**choice** — choice mode emits
exactly one of N labels, mapping rubric scores with zero parsing). Guided
decoding is necessary (unconstrained compliance ≤72%, as low as 61%) and has
throughput cost on vLLM's default XGrammar backend at batch ≥8; a single
fixed score schema amortizes (compiled-grammar caching), LLGuidance backend
stays stable if schemas vary.

**KV-cache economics on 20GB:** vLLM preallocates (`gpu_memory_utilization`
0.92) — an 8B bf16 judge (~16GB weights) leaves only ~2GB KV, fine for
sequential calibration runs but thin for concurrency; **automatic prefix
caching** is tailor-made for judge workloads (shared rubric prefix prefilled
once, reused across all judgments). Ollama multiplies context allocation
linearly per parallel slot (default `OLLAMA_NUM_PARALLEL=1`, then FIFO/503).

**Verdict:** the GPU seam runs **vLLM** — quantized-or-8B weights + prefix
caching + one fixed score schema (choice mode where applicable). Ollama is
acceptable only for low-volume interactive use with explicit `num_ctx`,
`repeat_penalty=1.0`, and truncation assertions — and any Ollama-scored
judgments are a *different judge version* than vLLM-scored ones (16.6pp).

### 8.4 Remaining inventory rows — verified from model cards/configs

- **Prometheus-2** (HIGH confidence): 7B = 7.24B on Mistral-7B-v0.2; 8x7B =
  46.7B MoE (2-of-8 active) on Mixtral; both bf16, 32K ctx, Apache-2.0 (card
  caveat: outputs subject to OpenAI ToU — GPT-4-synthesized training data);
  both pointwise-absolute (1–5 Likert + rubric + reference answer) *and*
  pairwise in one merged-weight model with distinct prompt templates per mode.
  Paper scores: 7B pairwise HHH 74.66 / MT-Bench-Human 70.78, Pearson-vs-GPT-4
  0.583; 8x7B HHH 85.52, Pearson 0.656. RewardBench/JudgeBench: unverified.
- **SFR-Judge** (MEDIUM-HIGH): **no public weights as of 2026-07-22** —
  `Salesforce/SFR-*-Judge-r` HF IDs 404; GitHub ships eval code only,
  research-only. DPO-trained ("direct judgement preference optimization"),
  three protocols (pairwise/pointwise/binary). RewardBench v1 computed from
  official allenai results JSONs: 8B **88.7**, 12B **90.3**, 70B **92.7**.
  *Inventory status: leaderboard-only, not deployable.*
- **Selene-1-Mini license resolved** (HIGH): HF card metadata declares
  **Apache-2.0** (no LICENSE file in repo) despite the Llama-3.1-8B-Instruct
  base — an unresolved tension with the Llama 3.1 Community License worth a
  provenance note wherever the inventory records `license`. RewardBench v1
  **89.1** ("highest-scoring 8B generative model" per paper, beats GPT-4o on
  RewardBench/EvalBiasBench/Auto-J); ctx 131,072; protocols: pointwise,
  binary, pairwise.
- **Skywork-Reward-V2** (HIGH): 8 Bradley-Terry sequence classifiers
  (scalar head, `num_labels=1`), bf16, **pointwise scalar only**, trained max
  length 16,384 (card: cap inference at 16,384 regardless of base ctx).
  Qwen3 bases (0.6B–8B) Apache-2.0; Llama bases community-licensed. Spread:
  RB2 from 61.3 (0.6B) to **84.1 (Llama-3.1-8B, the #1 open entry)**;
  the 8B-40M variant scores higher (86.5) but is research-only per card.
- **RM-R1** (HIGH): 6 reasoning GenRMs (Qwen2.5-Instruct and
  R1-Distill bases, 7/14/32B), MIT, bf16, **pairwise-only** (Chain-of-Rubrics:
  classify task → rubric or self-solve → `[[A/B]]`; no native pointwise).
  Distillation + RLVR training. RewardBench: 32B-Instruct 91.4 (canonical;
  flag: third parties cite 92.9 from an earlier paper version).
- **Post-CompassJudger-2 releases** (MEDIUM-HIGH): the only clear supersession
  at the top is NVIDIA's GenRM line — **Qwen3-Nemotron-235B-A22B-GenRM**
  (Dec 2025, Apache-2.0, 235B MoE/22B active, reasoning GenRM, pointwise 1–5 +
  pairwise ranking): **RM-Bench 87.3 / JudgeBench 87.4** (card-verified) —
  far above every ≤32B open judge, but MoE-235B ⇒ API/aggregator-served only
  for a 20GB host. Successors (GenRM-2603, Nemotron-3-Ultra-550B GenRM)
  unbenchmarked in cards or NVIDIA-licensed. Nothing found in 2026 at the
  7–70B open-weights generalist tier that supersedes CompassJudger-2 /
  Skywork-V2; most 2026 "judge" uploads are small task-specific classifiers.

### 8.5 Consolidated inventory table (Phase R deliverable)

VRAM = weights-only estimate (params × bytes/param); ✅ = fits 20GB with KV
headroom; scores are best-available, self-/card-reported unless noted.

| Model | Class | Params | Base | Protocols | Ctx | License | 20GB fit | Key scores |
|---|---|---|---|---|---|---|---|---|
| CompassJudger-2-7B | FT judge LM | 7.6B | Qwen2.5-7B-Inst | pt+pw, rubric | unverif. | Apache-2.0 | ✅ bf16 ~15.2G | RB 90.96 · JB 63.06 · avg 72.11 |
| CompassJudger-2-32B | FT judge LM | 32.8B | Qwen2.5-32B-Inst | pt+pw, rubric | unverif. | Apache-2.0 | ⚠️ int4 ~16–17G | RB 92.62 · JB 65.48 · JBv2 62.21 |
| Selene-1-Mini | FT judge LM | 8.03B | Llama-3.1-8B-Inst | pt+bin+pw | 131K | Apache-2.0* | ✅ bf16 ~16G | RB 89.1 (top-8B generative) |
| Prometheus-2-7B | FT judge LM | 7.24B | Mistral-7B-v0.2 | pt-abs(rubric)+pw | 32K | Apache-2.0* | ✅ bf16 ~14.5G | HHH 74.66 · Pearson .583 |
| Prometheus-2-8x7B | FT judge LM (MoE) | 46.7B | Mixtral-8x7B | pt-abs(rubric)+pw | 32K | Apache-2.0* | ❌ (int4 ~23G) | HHH 85.52 · Pearson .656 |
| SFR-Judge 8B/12B/70B | FT judge LM | 8/12/70B | L3.1/NeMo/L3.1 | pt+pw+bin | unverif. | **no weights** | ❌ n/a | RB 88.7 / 90.3 / 92.7 |
| Skywork-RW-V2-Llama-3.1-8B | Seq-clf RM | 8B | Llama-3.1-8B-Inst | pt scalar only | ≤16,384 | Llama-3.1 comm. | ✅ bf16 ~16G | **RB2 84.1 (#1 open)** · RB 96.4 · JB 80.0 |
| Skywork-RW-V2-Qwen3-8B | Seq-clf RM | 8B | Qwen3-8B | pt scalar only | ≤16,384 | Apache-2.0 | ✅ bf16 ~16G | RB2 78.4 · avg 79.3 |
| Skywork-RW-V2-Qwen3-0.6B | Seq-clf RM | 0.6B | Qwen3-0.6B | pt scalar only | ≤16,384 | Apache-2.0 | ✅ ~1.2G (cheap CI tier) | RB2 61.3 |
| RM-R1-Qwen2.5-Inst-7B | Reasoning GenRM | 7B | Qwen2.5-7B-Inst | **pw only** | 32K | MIT | ✅ bf16 ~14G | RB 85.2 · RM-B 70.2 |
| RM-R1-Qwen2.5-Inst-32B | Reasoning GenRM | 32B | Qwen2.5-32B-Inst | **pw only** | 32K | MIT | ⚠️ int4 ~16G | RB 91.4 · RM-B 79.1 |
| Qwen3-Nemotron-235B GenRM | Reasoning GenRM | 235B MoE | Qwen3-235B-A22B | pt 1–5 + pw rank | 128K | Apache-2.0 | ❌ API-only | **RM-B 87.3 · JB 87.4** |
| Qwen3Guard-Gen-8B | Specialized: safety | 8B | Qwen3-8B | tri-class gen | — | Apache-2.0 | ✅ bf16 ~16G | top-recall family (4B: 83.97%) |
| Llama Guard 4-12B | Specialized: safety | 12B | Llama-4-Scout prune | categories gen, multimodal | — | Llama-4 comm. | ⚠️ int8 ~12G | lineage head |
| gpt-oss-safeguard-20b | Specialized: safety | 21B MoE (3.6B act) | gpt-oss | policy-cond. + CoT | — | Apache-2.0 | ⚠️ MXFP4 ~13–16G (unverif.) | policy-reasoning shape |
| HHEM-2.1-Open | Specialized: factuality | 0.1B | flan-t5-base | (doc,claim)→0–1 | — | Apache-2.0 | ✅ trivial | open Vectara line |
| Bespoke-MiniCheck-7B | Specialized: factuality | 7B | InternLM2.5 | (doc,claim) binary | — | **CC-BY-NC** | ✅ ~14G, non-comm. | **AggreFact 77.4 (#1)** |
| Lynx-8B | Specialized: factuality | 8B | Llama-3 | RAG faithfulness gen | — | **CC-BY-NC** | ✅ ~16G, non-comm. | — |
| Claude / GPT / o-series / DeepSeek-R1 / Kimi-K2 | Prompted frontier API | — | — | all, incl. rubric | — | API ToS | n/a | reference class |

\* Apache-2.0 with provenance caveats: Prometheus-2 outputs subject to OpenAI
ToU (GPT-4-synthesized training data); Selene declares Apache atop a
Llama-3.1-community base — record license *provenance*, not just SPDX id.

## 9. Caveats (verbatim from the verification harness)

- **Source age:** the Awesome-LLMs-as-Judges catalog is ~Dec 2024; its silence
  on RewardBench 2 is a vintage artifact, not evidence.
- **Preprint reliance:** the three most decision-relevant empirical sources
  (2606.19544 reliability study; 2603.08091 JudgeBiasBench; 2509.23542
  shelf-life, ICLR 2026-accepted) are recent; headline figures (33.8–41.3pp κ
  deflation, 4.5× discrimination) come from one 21-judge study.
- **Self-reporting/COI:** all CompassJudger-2 scores are author-reported;
  JudgerBenchV2 is in-house to the same team.
- **Scope limits:** shelf-life/backward-compat findings cover author-trained
  8–24B judges on math/knowledge tasks; backward-compat carried a 2-1 vote;
  reasoning-mode benefits have pointwise-CoT counter-evidence; the four-group
  benchmark taxonomy is one survey's proposal, not consensus.

## 10. Sources

Primary (verified claims): github.com/CSHaitao/Awesome-LLMs-as-Judges ·
aclanthology.org/2025.emnlp-main.138 (Li et al., EMNLP 2025) ·
arXiv 2606.19544 · 2509.23542 · 2602.09305 · 2603.08091 · 2507.09104
(CompassJudger-2) · 2501.17195 (Selene) · 2506.01937 (RewardBench 2) ·
2410.12784 · 2410.16184 · 2505.02387 (RM-R1) · 2508.06225 · 2512.22245 ·
2505.10320 · 2512.16041 · HF: opencompass/CompassJudger-2-{7B,32B}-Instruct,
AtlaAI/Selene-1-Mini-Llama-3.1-8B, spaces/allenai/reward-bench ·
salesforce.com/blog/sfr-judge. Round-2 sources cited inline in §8.

Finding references [F1–F17] map to the verified-claims list in the workflow
journal (`wf_613060e9-09f`), 25 claims, all 3-0 or 2-1 confirmed, 0 refuted.
