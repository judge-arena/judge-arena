# A1 and A1.5 complete, residuals closed — handoff

**Written 2026-08-17.** Supersedes `2026-08-17-l2-complete-a1-handoff.md`, whose §1 branch table,
§2 suite counts and §4 next-steps are all now stale. That document remains worth reading for its
**§8 method notes**, which are unchanged, were repeatedly vindicated this session, and are the most
transferable thing either handoff contains.

**Everything below was verified against the tree, the remote and the live cluster on 2026-08-17.**
Nothing is carried forward. Two rows in the previous handoff had already moved by the time this one
was written, which is the point.

---

## 0. Read these, in this order

| # | Document | Why |
|---|---|---|
| 1 | `specs/2026-08-17-integration-release-and-a2-roadmap.md` | **The new one, and the one that matters.** What happens next, why the order is fixed, and the verified state of prod. |
| 2 | This handoff §3 and §4 | What landed, and the traps. |
| 3 | `plans/2026-08-17-l2-complete-a1-handoff.md` **§8** | Method notes. Not superseded. |
| 4 | `plans/2026-08-17-a1-human-verification.md` → "Defects found during execution" | Before reusing anything from that plan. |
| 5 | `plans/2026-08-17-a1_5-annotation-studio.md` → same section | Five injections that proved nothing, and what each exposed. |

Read the roadmap first. **If you read only one section of it, read "The finding that reorders
everything."**

---

## 1. Where the code is

| Ref | SHA | Note |
|---|---|---|
| `feat/a0-golden-set-substrate` | `4e7028f` | **A0 + L1 + L2 + R1 + R3 + A1 + A1.5 + R4 + R5.** Worktree `/root/judge-arena-worktrees/a0`. Clean. |
| `gitea/feat/a0-golden-set-substrate` | `4e7028f` | **In sync — pushed.** |
| `gitea/main` | `ddfc55b` | **PR #12 is MERGED**, carrying A0+L1+L2+R1+R3. |
| PR for A1/A1.5 | **does not exist** | Branch pushed, PR never opened — see §2. |
| `main` (local) | badly stale | **Do not use as a base.** |

Latest migration: `20260818120000_v2h_human_verification` — **18 in the chain**.

**Other worktrees are not ours.** `/root/judge-arena` is on `feat/1c-deploy-readiness`; `llamacpp`,
`preflight`, `rebaseline`, `roundtrip` are older branches.

## 2. The one thing waiting on a human

**The A1/A1.5 PR is not open.** There is no `tea` CLI and no Gitea token on this workstation, and
the credential was deliberately not hunted for — reading a cluster secret for this was refused in an
earlier session, and the right move is to stop and hand it over rather than find another route to
the same secret.

- **Compare URL:** `https://gitea.lab.asethi.com/trij/judge-arena/compare/main...feat/a0-golden-set-substrate`
- **Body:** committed at `docs/superpowers/pr-a1-body.md` — not left in a scratchpad, because a
  scratchpad does not survive a session and PR #12's body went stale for exactly that reason.
  Pasting it is the owner's step; nothing here claims it has been applied.
- **Decide before opening:** ten commits is a large review surface. Splitting A1.5 onto its own
  branch off `main` is cheap **now** and annoying once the PR exists.

`/pulls` looking empty is correct and not a symptom: #12 is merged and closed, and that page
defaults to open PRs.

## 3. Suites at `4e7028f`

| Suite | Files | Tests |
|---|---|---|
| unit | 42 | **578** |
| db | 42 | **633** |
| integration | 10 | **80** |

`npx tsc --noEmit` and `npm run lint` exit 0 **with no warnings**; `npm run build` compiles.
`prisma migrate status`: 18 migrations, up to date. Both coverage configs exit 0, no floor touched.

**Run the DB and integration suites serially.** They share one Postgres and produce spurious
failures concurrently. (This session re-learned a neighbouring version of that: a full DB run picked
up a test file edited *while it was collecting*, and the resulting 4 failures looked like a
regression. If a baseline surprises you, check whether you were editing during it.)

**The stage ladder, extended:**

| Stage | migrations | unit | db | integration |
|---|---|---|---|---|
| +R1 (`96b7c12`) | 17 | 508 / 37 | 555 / 39 | 80 / 10 |
| +A1 (`eef73fb`) | 18 | 533 / 39 | 633 / 42 | 80 / 10 |
| +R4/R5 (`6528b32`) | 18 | 533 / 39 | 633 / 42 | 80 / 10 |
| +A1.5 (`05bf29b`) | 18 | **578 / 42** | 633 / 42 | 80 / 10 |

A1.5 moves only the unit count, which is the shape you want: it is library and UI work, and it
touches no route and no schema.

## 4. Traps, each of which cost something

- **`charts/judge-arena/values.yaml`'s image tag is INERT.** The authoritative tag is in
  `apps/public/judge-arena/helmrelease.yaml`. Bumping the chart default produces no change and no
  error. Full detail in the roadmap's "THE TRAP" section.
- **Production is five migrations behind and has zero golden sets.** A0's substrate has never
  existed there. Do not assume anything about prod from the fact that the suites are green.
- **judge-arena is manual-promote** (`286da59`, excluded from the build-lag exporter). Nothing
  deploys itself. Flux being green means Flux is doing what it was told, not that the app is current.
- **A quoted `DATABASE_URL`.** `.env.local` holds it quoted, so `grep | cut` yields a quoted string
  and Prisma fails `P1012` — which reads like schema drift. Bare `npx prisma` fails the same way
  because Prisma loads `.env` and this tree has none. Source it:
  `sh -c 'set -a; . ./.env.local; set +a; npx prisma …'`.
- **`prisma db execute` needs `--schema` or `--url`.** It is not a drop-in for a psql one-liner.
- **Local Postgres is the podman container `judge-arena-pg`. Production is the Kubernetes pod
  `judge-arena-pg-1` in namespace `tenant-public` and must never be touched.** The names differ by
  one character. Never `prisma db push`; never `migrate deploy` against anything but local.
- **Backticks in a `git commit -m` shell string get expanded.** One commit message this session lost
  a word to command substitution. Use `-F <file>`.

## 5. What A1 and A1.5 actually shipped

**A1** gave `GoldenLabel` its first writer, and the apparatus that makes the rows mean something:
the `v2h` schema (item revisions, assignments, `round`, `preference`, three hand-edited
constraints), `src/lib/agreement.ts` (Cohen/Fleiss, weighted on value distance), before-image
provenance on item edits, retest eligibility, blinded queue selection, six routes, and reporting
that states its method and its overlap.

**A1.5** gave it a surface: a composable panel shell with layout persisted to localStorage and
reconciled against untrusted input, span-ready content with a normalization contract, a word diff,
and A1's labelling view as the first composition.

**The exit gates of both are met** — A1's four clauses each pinned by a named test, A1.5's five by a
browser-walked checklist.

### The distinction most likely to be got wrong

**One annotator is a DEVELOPMENT constraint, not a product one**, and A1 now enforces it in code
rather than prose: `agreement()` returns `{ value: null, reason: 'insufficient-annotators' }`,
never `0`, because `0` reads as total disagreement — the opposite of "not measurable". `testRetest`
is the only reliability signal that yields a number until a second account exists.

**The overlap model, assignment rows, Fleiss path and disagreement queue are all built and tested
now**, against fixtures creating N `User` rows. What waits on a second account is only *real* data —
which is E3 in the roadmap, and is the first moment the product does the thing it exists to do.

## 6. What this session cost, and what would have prevented it

Additions to the previous handoff's §8, not replacements. In descending order of what they saved.

- **The injections that proved NOTHING were worth more than the ones that worked.** Across A1 and
  A1.5, five prescribed injections left the suite green. Every one was a real gap: an unreachable
  guard, a dead special case, an untested equality check, a clamp test using a value the standard
  library clamps anyway (`-5`, where only `-1` discriminates), and a de-dup test asserting a length
  that a `Map` gives for free. **A passing injection is a finding, not a formality** — if breaking
  the code changes nothing, either the code or the test is decoration.
- **A green test can be impossible to fail.** A1's value-vs-rank fixture could not pass under any
  implementation (`0 > 0`). A1.5's NFC fixture asserted a length that depended on the source file's
  encoding, and the obvious fix — changing the 7 to a 6 — would have made it green while deleting
  the only thing under test. **Work the arithmetic by hand before writing the module.**
- **A failure message that does not describe the defect is not evidence.** A1's round injection
  failed with `expected 500 to be 201` because trusting the client's round collided with a unique
  index rather than writing the wrong round. That surfaced a real bug (a bare 500 on a concurrent
  double-submit, now a 409) but proved nothing about the assertion, which needed a second, cleaner
  injection.
- **Walk the manual checklist; do not write it and defer it.** A1.5's row 7 caught a defect no unit
  test could have: the progression rail read "not started" directly above a message explaining that
  a reading had just been recorded. The rule was right and the *composition* was wrong, which is
  exactly the class the untestable layer's checklist exists for.
- **Verify a cluster fact before writing it down.** This session re-measured T5 rather than quoting
  it (54.6%, unchanged — so the gate is stable rather than a spike), and in doing so found the
  inert-chart-tag trap, the five-migration gap and the empty prod catalog. None of those were
  visible from the repository.
- **`tsc` catches test shortcuts, not just type errors.** A test reached for a property that exists
  on only one branch of a union; the shortest way past it would have been a cast, which erases the
  field under assertion. A whole-object `toEqual` was both correct and stronger.

## 7. Open, and who it is waiting on

| Item | State | Waiting on |
|---|---|---|
| **A1/A1.5 PR** | branch pushed, PR not created | **the owner** — §2 |
| **Promote + migrate + seed** | prod 5 migrations behind, 0 golden sets | roadmap M1–M4 |
| **Real labels** | none exist anywhere | roadmap E1–E3 |
| **T5** | zero scrapes, zero rules, 54.6% at idle | roadmap Part T5 — **hard gate on A2** |
| **A2 spec** | decisions recorded, spec deliberately unwritten | real label data + T5 |
| **`reasoning_content` capture** | backlogged | preflight Stage 5 |
| **Roadmap decisions #4, #7** | open | settled when A2 is specced |
| **Cross-user annotation policy (#5)** | mechanism built, policy is owner's | a second account existing |
| Preflight Stage 5 | the only open preflight stage | — |
| R1–R6 residuals | **all closed** | — |

## 8. Starting the next session

```bash
cd /root/judge-arena-worktrees/a0
git status                                     # expect clean at 4e7028f
git ls-remote gitea main                       # has the PR landed? do not trust this file
sh -c 'set -a; . ./.env.local; set +a; npx prisma migrate status'   # 18, up to date
npx tsc --noEmit && npm run lint
npm test                                       # 578
npm run test:db                                # 633 — packaged, includes a migrate reset
npm run test:integration                       # 80 — needs Redis :6379 and RabbitMQ :5672
```

Write those numbers down; the plans forbid asserting absolute suite counts, so each task's contract
is zero failures and no fewer tests than the previous task left.

Then re-check the two facts most likely to have moved, because both moved *during* the session that
wrote this:

```bash
kubectl get deploy -n tenant-public judge-arena-web \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'    # still sha-70fce84bee11?
kubectl exec -n tenant-public judge-arena-pg-1 -- \
  psql -U postgres -d judge_arena -tAc 'select count(*) from "_prisma_migrations"'   # still 13?
```

**If the PR has landed and the image has been promoted, the roadmap's Part M is done and you start
at E1.** If not, start at M1 — and it is a five-minute job that unblocks everything downstream.
