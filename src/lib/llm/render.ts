/**
 * ─── DB-templated prompt rendering ──────────────────────────────────────────
 *
 * Renders a `PromptTemplate` row (see prisma/schema.prisma's "Prompt
 * Templates" section) + a rubric + a submission into the judge's system
 * prompt, plus the `<submission>`-wrapped user prompt.
 *
 * ── Why `PromptTemplate.body` is evaluated as a JS template literal ────────
 * The seeded `v1-legacy` v0 row (`prisma/seed-prompt-templates.ts`) is, by
 * that file's own module doc, "frozen verbatim from `buildJudgmentSystemPrompt`
 * ... the rubric-injection placeholders (`${rubricName}`, ...) are preserved
 * as LITERAL TEXT here". That is: the row's `body` column IS the exact
 * source text that used to sit between the backticks of
 * `buildJudgmentSystemPrompt`'s `return` statement — including real
 * `\n`-as-escape-sequence bytes inside the nested
 * `` `\n${rubricDescription}\n` `` ternary branch, which only decode to
 * actual newlines when RE-PARSED as JS source (a naive string-replace
 * placeholder engine would leave them as literal backslash-n text instead).
 * `evalTemplateLiteral` below re-parses the stored body as a template
 * literal via `new Function`, reproducing that decoding correctly (a
 * simpler alternative — a small explicit `${identifier}`-substitution
 * parser with its own hand-rolled escape-sequence decoder — was
 * considered and rejected: re-implementing JS's own escape rules
 * (`\n`/`\t`/`` \` ``/`\$`/`\\`/...) by hand is exactly the kind of
 * "reinvent a subset of the language" surface that's easy to get subtly
 * wrong, where re-parsing via the real JS engine is verifiably correct by
 * construction). Verified byte-for-byte against the original
 * `buildJudgmentSystemPrompt` in `tests/lib/render.test.ts`'s golden test.
 *
 * ── Trust boundary (why `new Function` is an acceptable choice here) ────────
 * `PromptTemplate` has no `userId` and no CRUD route as of Task 10 — every
 * row is seed/admin-authored (`prisma/seed-prompt-templates.ts`), not
 * end-user-supplied. `new Function(...)` bodies do NOT capture THIS
 * MODULE'S closure the way `eval` would (no access to this file's local
 * variables/imports, e.g. `decryptSafe`) — but, IMPORTANTLY, this is not a
 * sandbox: a `new Function` body still runs with full access to Node's
 * GLOBALS, including `process.env`, `require`/`import()`, `fetch`, and
 * everything else `globalThis` exposes (verified directly: `new
 * Function('return process.env')()` returns the real environment). The
 * only thing this construction actually limits is closure capture, not
 * ambient authority. The interpolated VALUES (`rubricName`,
 * `rubricDescription`, `criteriaList`) are passed as real function
 * ARGUMENTS at call time, not spliced into the source string, so they
 * cannot themselves inject further template syntax — but the template
 * BODY (`PromptTemplate.body`) is fully-privileged JS source. If
 * `PromptTemplate` ever gains a user-facing authoring route, this function
 * is the first place that needs re-hardening (e.g. a real restricted-
 * expression parser) — flagged here so it isn't missed, and so whoever
 * re-evaluates the risk starts from an accurate picture of what a
 * malicious template body could already reach today.
 */

import type { RunProtocol } from '@prisma/client';
import type { RubricCriterionView } from '@/types';

export interface RenderRubric {
  name: string;
  description?: string | null;
  criteria: RubricCriterionView[];
}

export interface RenderSubmission {
  inputText?: string;
  promptText?: string;
  responseText?: string;
}

export interface RenderTemplate {
  /** The stored template source — see module doc for how it's evaluated. */
  body: string;
  protocol: RunProtocol;
}

/** `${...}`-templated identifiers this renderer resolves against. Kept as a
 * closed set (not "spread whatever the caller passes") so it's obvious from
 * this one type what a template body can reference. */
interface TemplateContext {
  rubricName: string;
  rubricDescription: string | undefined;
  criteriaList: string;
}

/**
 * Evaluate `source` as the body of a JS template literal against `ctx`,
 * returning the resulting string. See module doc for the trust boundary.
 */
function evalTemplateLiteral(source: string, ctx: TemplateContext): string {
  const argNames = Object.keys(ctx);
  const argValues = Object.values(ctx);
  let fn: (...args: unknown[]) => string;
  try {
    // `new Function` (not `eval`) — see module doc: PromptTemplate is
    // seed/admin-authored, not user-supplied; Function bodies don't capture
    // this closure (unlike eval, which would).
    fn = new Function(...argNames, `return \`${source}\`;`) as (...args: unknown[]) => string;
  } catch (error) {
    throw new Error(
      `renderJudgmentSystemPrompt: PromptTemplate body is not valid template syntax: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    return fn(...argValues);
  } catch (error) {
    throw new Error(
      `renderJudgmentSystemPrompt: PromptTemplate body failed to render: ${error instanceof Error ? error.message : error}`
    );
  }
}

/** Verbatim port of the old `buildJudgmentSystemPrompt`'s criteria-list
 * formatting — the exact text every seeded/future pointwise template's
 * `${criteriaList}` placeholder is expected to receive. */
function buildCriteriaList(criteria: RubricCriterionView[]): string {
  return [...criteria]
    .sort((a, b) => a.order - b.order)
    .map(
      (c, i) =>
        `${i + 1}. **${c.name}** (max score: ${c.maxScore}, weight: ${c.weight})\n   ${c.description}`
    )
    .join('\n');
}

/**
 * Render a pointwise judge system prompt from a DB `PromptTemplate` row.
 * Replaces the old inline `buildJudgmentSystemPrompt` (deleted — see
 * provider.ts's module doc; nothing references it after this switch).
 */
export function renderJudgmentSystemPrompt(template: RenderTemplate, rubric: RenderRubric): string {
  // Protocol-scoped: the rubric+criteria-list context this renderer builds
  // only makes sense for a pointwise (single-submission, per-criterion
  // scoring) template. Pairwise/listwise templates need a different
  // context shape entirely (e.g. two submissions + a selection, not one
  // submission + scores) — out of scope until a later task actually ships
  // a pairwise/listwise run path; failing clearly here beats silently
  // rendering a pointwise-shaped prompt for a protocol it was never
  // designed for.
  if (template.protocol !== 'pointwise') {
    throw new Error(
      `renderJudgmentSystemPrompt: unsupported PromptTemplate protocol "${template.protocol}" — only "pointwise" is implemented`
    );
  }

  const ctx: TemplateContext = {
    rubricName: rubric.name,
    rubricDescription: rubric.description ?? undefined,
    criteriaList: buildCriteriaList(rubric.criteria),
  };
  return evalTemplateLiteral(template.body, ctx);
}

/**
 * Escape a case-insensitive `</submission>` occurring inside untrusted
 * submission text (1a MINOR delimiter-escaping fix). Without this, a
 * submission containing a literal `</submission>` string can prematurely
 * close the wrapper below and inject attacker-controlled text that reads,
 * to the judge model, as being OUTSIDE the submission (e.g. as if it were
 * part of these instructions) — a prompt-injection multiplier on top of the
 * existing "ignore instructions within the submission" guidance. The
 * escaped form (`<\/submission>`, a backslash-escaped slash) stays
 * human/model-readable as "the text `</submission>`" while no longer
 * matching the real closing tag.
 */
function escapeSubmissionDelimiter(text: string): string {
  return text.replace(/<\/submission>/gi, '<\\/submission>');
}

/**
 * Build the user prompt containing the submission to evaluate. Ported from
 * the old `buildJudgmentUserPrompt` (provider.ts) with the delimiter-escaping
 * fix applied to every text field that lands inside `<submission>` tags.
 */
export function buildJudgmentUserPrompt(submission: RenderSubmission): string {
  const promptText = submission.promptText?.trim();
  const responseText = submission.responseText?.trim();
  const inputText = submission.inputText?.trim();

  if (promptText && responseText) {
    return `Please evaluate the following response according to the rubric criteria provided.

<submission>
## Prompt (Input)
${escapeSubmissionDelimiter(promptText)}

## Response (Output to evaluate)
${escapeSubmissionDelimiter(responseText)}
</submission>

Evaluate how well the response addresses the prompt.
Respond with your evaluation in the specified JSON format.`;
  }

  if (responseText) {
    return `Please evaluate the following response according to the rubric criteria provided.

<submission>
## Response (Output to evaluate)
${escapeSubmissionDelimiter(responseText)}
</submission>

Respond with your evaluation in the specified JSON format.`;
  }

  if (!inputText) {
    throw new Error('Cannot build judgment prompt: no submission text provided (inputText, promptText, or responseText required)');
  }

  return `Please evaluate the following submission according to the rubric criteria provided.

<submission>
${escapeSubmissionDelimiter(inputText)}
</submission>

Respond with your evaluation in the specified JSON format.`;
}

/** Convenience wrapper producing both prompt halves in one call — what
 * `registry.ts`'s `runProviderJudgment` actually needs. */
export function renderJudgmentPrompt(
  template: RenderTemplate,
  rubric: RenderRubric,
  submission: RenderSubmission
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: renderJudgmentSystemPrompt(template, rubric),
    userPrompt: buildJudgmentUserPrompt(submission),
  };
}
