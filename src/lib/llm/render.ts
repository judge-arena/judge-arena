/**
 * ─── DB-templated prompt rendering ──────────────────────────────────────────
 *
 * Renders a `PromptTemplate` row (see prisma/schema.prisma's "Prompt
 * Templates" section) + a rubric + a submission into the judge's system
 * prompt, plus the `<submission>`-wrapped user prompt.
 *
 * ── Task 10 review CRITICAL fix: no more `new Function` ─────────────────────
 * This module used to re-parse `PromptTemplate.body` as a JS template
 * literal via `new Function(...argNames, \`return \\\`${source}\\\`;\`)`.
 * That is a proven RCE primitive, not a theoretical one: `body` is a DB
 * column, and a single unescaped backtick in it breaks out of the
 * surrounding template-literal string and turns the REST of the body into
 * arbitrary, fully-privileged JS statements spliced straight into the
 * generated function source — e.g. a body of
 * `` `${rubricName}` + require('child_process').execSync('...') + ` ``
 * would execute that `execSync` call the moment the template was rendered.
 * `new Function` bodies don't capture this module's closure, but they DO
 * run with full access to Node's globals (`process.env`, `require`,
 * `fetch`, ...) — closure-isolation is not sandboxing. `PromptTemplate` has
 * no CRUD route today (seed/admin-authored only), which is why this was
 * merged as an accepted-risk trust boundary rather than blocked outright,
 * but "no route reaches it YET" is not a defense against a future route,
 * an admin-tooling bug, or a restore-from-backup of a tampered row — a
 * rendering engine for a DB column should never itself be a code-execution
 * primitive. Same eval-class pattern the 1a critique already killed in
 * redis-bus; this is the render.ts instance of it.
 *
 * The replacement below (`evalTemplateLiteral`) is a small, bounded,
 * whitelisted interpolator: it parses `body` into an AST using a hand-
 * rolled recursive-descent parser, then walks that AST substituting values
 * — there is no `new Function`, no `eval`, no dynamic code construction of
 * any kind anywhere in this file. The grammar it accepts is exactly what
 * the seeded `v1-legacy` template (and every template this renderer is
 * documented to support) uses:
 *   - `${identifier}` — substitute `identifier`'s value from the fixed
 *     `TemplateContext` whitelist below. An identifier not in that
 *     whitelist is a parse-time-adjacent (evaluation-time) error, not a
 *     silent no-op or an arbitrary property lookup.
 *   - `${identifier ? \`literal text with ${otherIdentifier}\` : 'fallback'}`
 *     — exactly ONE ternary shape: a whitelisted identifier's truthiness
 *     selects between a nested template-literal (plain text plus further
 *     `${identifier}` substitutions — no further ternary nesting) and a
 *     single/double-quoted string-literal fallback.
 * Anything outside that grammar — an unknown identifier, an unsupported
 * construct, or (this is the important one) a stray backtick anywhere at
 * the top level of the body — is a hard parse error. Top-level backticks
 * are disallowed on purpose, not merely "not handled": the ONLY place a
 * backtick is meaningful in this grammar is as the ternary's nested-
 * template-literal delimiter, consumed inline by the parser that expects
 * it. A backtick reached while scanning ordinary top-level text can only
 * mean the body doesn't match the supported grammar, and this closes off
 * the exact shape of breakout string the old `new Function` version was
 * vulnerable to — even though nothing here would ever `eval` it, refusing
 * to render it at all is the more defensible posture for a template body
 * whose provenance (DB row) this module has no way to verify.
 *
 * Verified byte-for-byte against the original `buildJudgmentSystemPrompt`
 * in `tests/lib/render.test.ts`'s golden test (all three
 * `rubricDescription` branches: present / undefined / empty string) — this
 * parser reproduces the same `\n`-escape-decoding-on-reparse behavior the
 * old `new Function` approach relied on (see `decodeEscapeChar` below),
 * just via an explicit, bounded, closed set of escapes instead of the real
 * JS engine. `tests/lib/render.test.ts` also carries the adversarial
 * regression tests for the exploit class above: a raw-backtick breakout
 * payload (asserted to throw AND to produce no side effect) and an unknown
 * `${identifier}` (asserted to throw).
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

// ─── Safe template AST + parser ─────────────────────────────────────────────
//
// See the module doc for why this exists instead of `new Function`/`eval`.
// Two passes, deliberately: `parseTemplate` turns `source` into a `Node[]`
// AST with NO access to `ctx` at all (a parse error can never depend on
// what values happen to be in scope), then `renderNodes` walks that AST
// against `ctx` to produce the output string. Nothing in either pass
// constructs or executes code — every substitution is a plain string
// concatenation driven by a whitelist lookup.

/** A plain-text run, copied to the output verbatim. */
interface TextNode {
  kind: 'text';
  value: string;
}

/** `${identifier}` — substitute `ctx[identifier]` (whitelist-checked at
 * render time; see `lookup`). */
interface IdentNode {
  kind: 'ident';
  name: string;
}

/** The nested template literal inside a ternary's true-branch: plain text
 * plus `${identifier}` substitutions only — no further ternary (out of the
 * one supported shape; see module doc). */
type NestedNode = TextNode | IdentNode;

/** `${identifier ? \`...\` : 'fallback'}` — the ONE supported ternary
 * shape. `name`'s truthiness (per `ctx`) selects `trueBranch` (rendered)
 * or `falseBranch` (used as-is, already a decoded string). */
interface TernaryNode {
  kind: 'ternary';
  name: string;
  trueBranch: NestedNode[];
  falseBranch: string;
}

type TemplateNode = TextNode | IdentNode | TernaryNode;

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Decode the small, closed set of backslash escapes this renderer's
 * string-literal / nested-template-literal grammar supports. This is
 * deliberately NOT a general JS-escape decoder (e.g. no `\uXXXX`, no
 * `\xXX`, no octal) — only what the ternary's nested template literal
 * (`` `\n${rubricDescription}\n` ``, see `V1_LEGACY_JUDGMENT_SYSTEM_PROMPT`
 * in prisma/seed-prompt-templates.ts) and quoted string-literal fallbacks
 * actually need. Anything outside this set is a parse error, not a
 * best-effort guess.
 */
function decodeEscapeChar(ch: string | undefined): string {
  switch (ch) {
    case 'n':
      return '\n';
    case 't':
      return '\t';
    case 'r':
      return '\r';
    case '\\':
      return '\\';
    case '`':
      return '`';
    case '$':
      return '$';
    case "'":
      return "'";
    case '"':
      return '"';
    default:
      throw new Error(`unsupported escape sequence "\\${ch ?? ''}"`);
  }
}

/**
 * Recursive-descent parser for the bounded template grammar described in
 * the module doc. Structural only — never consults `ctx`; identifier
 * whitelist-membership is checked later, at render time (`lookup`).
 */
class TemplateParser {
  private readonly src: string;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
  }

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private expect(ch: string): void {
    if (this.src[this.pos] !== ch) {
      const got = this.eof() ? 'end of input' : JSON.stringify(this.src[this.pos]);
      throw new Error(`expected "${ch}" at position ${this.pos}, got ${got}`);
    }
    this.pos += 1;
  }

  private skipSpaces(): void {
    while (!this.eof() && /[ \t\n\r]/.test(this.src[this.pos])) {
      this.pos += 1;
    }
  }

  private readIdentifier(): string {
    if (this.eof() || !IDENT_START.test(this.src[this.pos])) {
      throw new Error(`expected identifier at position ${this.pos}`);
    }
    const start = this.pos;
    this.pos += 1;
    while (!this.eof() && IDENT_PART.test(this.src[this.pos])) {
      this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }

  /** Single/double-quoted string literal — the ternary's fallback branch
   * (e.g. `''`, `""`). */
  private readStringLiteral(): string {
    const quote = this.src[this.pos];
    if (quote !== "'" && quote !== '"') {
      throw new Error(`expected a string literal at position ${this.pos}`);
    }
    this.pos += 1;
    let out = '';
    while (true) {
      if (this.eof()) throw new Error('unterminated string literal');
      const ch = this.src[this.pos];
      if (ch === quote) {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        if (this.eof()) throw new Error('unterminated string literal escape');
        out += decodeEscapeChar(this.src[this.pos]);
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  /** Backtick-delimited nested template literal — the ternary's
   * true-branch. Supports plain text, the closed escape set, and
   * `${identifier}` interpolations; a nested `${...}` that isn't a bare
   * identifier (e.g. a further ternary) is out of grammar and throws. */
  private readNestedTemplateLiteral(): NestedNode[] {
    this.expect('`');
    const nodes: NestedNode[] = [];
    let text = '';
    const flush = () => {
      if (text) {
        nodes.push({ kind: 'text', value: text });
        text = '';
      }
    };
    while (true) {
      if (this.eof()) throw new Error('unterminated nested template literal (missing closing "`")');
      const ch = this.src[this.pos];
      if (ch === '`') {
        this.pos += 1;
        flush();
        return nodes;
      }
      if (ch === '\\') {
        this.pos += 1;
        if (this.eof()) throw new Error('unterminated nested template literal escape');
        text += decodeEscapeChar(this.src[this.pos]);
        this.pos += 1;
        continue;
      }
      if (ch === '$' && this.src[this.pos + 1] === '{') {
        this.pos += 2;
        this.skipSpaces();
        const name = this.readIdentifier();
        this.skipSpaces();
        this.expect('}');
        flush();
        nodes.push({ kind: 'ident', name });
        continue;
      }
      text += ch;
      this.pos += 1;
    }
  }

  /** The contents of one `${...}` slot — cursor is positioned right after
   * the opening `${`. Supports exactly `identifier` or
   * `identifier ? \`...\` : '...'`. */
  private readInterpolation(): TemplateNode {
    this.skipSpaces();
    const name = this.readIdentifier();
    this.skipSpaces();

    if (this.peek() === '}') {
      this.pos += 1;
      return { kind: 'ident', name };
    }

    if (this.peek() === '?') {
      this.pos += 1;
      this.skipSpaces();
      const trueBranch = this.readNestedTemplateLiteral();
      this.skipSpaces();
      this.expect(':');
      this.skipSpaces();
      const falseBranch = this.readStringLiteral();
      this.skipSpaces();
      this.expect('}');
      return { kind: 'ternary', name, trueBranch, falseBranch };
    }

    throw new Error(
      `unsupported interpolation syntax after identifier "${name}" at position ${this.pos} — only ` +
        '"${identifier}" and "${identifier ? `...` : \'...\'}" are supported'
    );
  }

  /**
   * Parse the whole top-level body. A bare backtick reached while scanning
   * ordinary top-level text is a hard error — see module doc for why this
   * is intentional (it's also what forecloses the classic `new Function`
   * breakout-string shape, on top of there being no `eval`/`new Function`
   * to break out of in the first place).
   */
  parse(): TemplateNode[] {
    const nodes: TemplateNode[] = [];
    let text = '';
    const flush = () => {
      if (text) {
        nodes.push({ kind: 'text', value: text });
        text = '';
      }
    };
    while (!this.eof()) {
      const ch = this.src[this.pos];
      if (ch === '$' && this.src[this.pos + 1] === '{') {
        this.pos += 2;
        flush();
        nodes.push(this.readInterpolation());
        continue;
      }
      if (ch === '`') {
        throw new Error(
          `unexpected "\`" at position ${this.pos} — bare backticks are only valid inside a ` +
            '"${identifier ? `...` : \'...\'}" construct'
        );
      }
      text += ch;
      this.pos += 1;
    }
    flush();
    return nodes;
  }
}

function parseTemplate(source: string): TemplateNode[] {
  return new TemplateParser(source).parse();
}

/** Whitelist lookup — the only place a template body's identifiers ever
 * touch real data. `ctx` is the fixed `TemplateContext` shape, so this can
 * never resolve to anything the renderer didn't explicitly build. */
function lookup(ctx: TemplateContext, name: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(ctx, name)) {
    throw new Error(
      `unknown identifier "\${${name}}" — not in the renderer's whitelist (${Object.keys(ctx).join(', ')})`
    );
  }
  return (ctx as unknown as Record<string, unknown>)[name];
}

function renderNested(nodes: NestedNode[], ctx: TemplateContext): string {
  let out = '';
  for (const node of nodes) {
    out += node.kind === 'text' ? node.value : String(lookup(ctx, node.name));
  }
  return out;
}

function renderNodes(nodes: TemplateNode[], ctx: TemplateContext): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.value;
        break;
      case 'ident':
        out += String(lookup(ctx, node.name));
        break;
      case 'ternary':
        out += lookup(ctx, node.name) ? renderNested(node.trueBranch, ctx) : node.falseBranch;
        break;
    }
  }
  return out;
}

/**
 * Render `source` (a `PromptTemplate.body`) against `ctx` using the
 * bounded whitelisted grammar described in the module doc. Two-stage error
 * wrapping preserved from the pre-fix version (parse errors vs. render/
 * evaluation errors) so callers/tests keying off the `"PromptTemplate
 * body ..."` message prefix are unaffected by this rewrite.
 */
function evalTemplateLiteral(source: string, ctx: TemplateContext): string {
  let nodes: TemplateNode[];
  try {
    nodes = parseTemplate(source);
  } catch (error) {
    throw new Error(
      `renderJudgmentSystemPrompt: PromptTemplate body is not valid template syntax: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    return renderNodes(nodes, ctx);
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
