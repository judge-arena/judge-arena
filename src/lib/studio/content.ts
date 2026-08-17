/**
 * A1.5 — the span-ready content model.
 *
 * ── THE OFFSETS CONTRACT, WHICH IS THE WHOLE POINT OF THIS MODULE ──────────
 *
 * **A `Span`'s `start`/`end` are UTF-16 code-unit offsets into ALREADY-NORMALIZED
 * text** — line endings folded to `\n`, then NFC. Any producer of spans must
 * compute them against the output of `toSpanText`, never against the raw
 * source.
 *
 * NOTHING PRODUCES SPANS YET. This exists now anyway, because the contract is
 * the one thing here that cannot be retrofitted: every producer written
 * against un-normalized text would need revisiting, and the symptom of getting
 * it wrong is a highlight covering the wrong words WITH NO ERROR ANYWHERE.
 * Both normalizations are silent-drift generators:
 *
 *   - A CRLF source is one code unit longer per line than its `\n` form, so a
 *     span computed before folding is off by the number of preceding lines.
 *   - A decomposed 'é' is two code units where the composed form is one, so a
 *     single accented character earlier in the string shifts everything after
 *     it by one.
 *
 * Neither produces an exception. Both produce a highlight that is a little bit
 * wrong, in a way that looks like a rendering bug rather than a data one.
 *
 * ── WHY CODE UNITS RATHER THAN CODE POINTS ─────────────────────────────────
 *
 * Because that is what `String.prototype.slice` takes, and slicing is what
 * `segment` does. Choosing code points would mean every consumer converting,
 * and a conversion nobody remembers is worse than an offset nobody
 * misinterprets. `segment` never splits a surrogate pair: boundaries come only
 * from span endpoints, and a span whose endpoint lands mid-pair is a malformed
 * span, not something this module can repair — see the astral test, which
 * pins the well-formed case.
 */

export type Span = { start: number; end: number; kind: string; id?: string };
export type SpanText = { text: string; spans: Span[] };
export type Run = { text: string; spans: Span[] };

/**
 * Normalize raw text into the form offsets are defined against.
 *
 * IDEMPOTENT, deliberately and by test: callers cannot always know whether a
 * string has been through here already, and a second pass must be a no-op
 * rather than a second shift.
 *
 * `spans` are taken on trust as already being in normalized coordinates —
 * there is no way to re-derive them, since the mapping from raw to normalized
 * offsets is not recoverable after the fact. That is why the contract is
 * stated at the top rather than enforced here.
 */
export function toSpanText(raw: string, spans?: Span[]): SpanText {
  const text = raw.replace(/\r\n?/g, '\n').normalize('NFC');
  return { text, spans: spans ?? [] };
}

/**
 * Cut `value.text` at every span boundary, returning runs that carry every
 * span covering them.
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * `segment(v).map(r => r.text).join('') === v.text`, always. Segmentation may
 * not lose, duplicate or reorder a single character. Every other guarantee
 * here is downstream of that one, which is why it is tested directly rather
 * than inferred from the cases below.
 *
 * EVERY covering span is attached, not just the first. Overlap is the case a
 * naive implementation silently drops, and — because the dropped span is
 * usually the one that would have added a second colour — the rendered result
 * looks entirely plausible either way.
 */
export function segment(value: SpanText): Run[] {
  const { text } = value;
  if (text.length === 0) return [];

  // Clamped first, so a span reaching past the end contributes a boundary at
  // the end rather than a boundary that would produce phantom text. Dropped
  // when empty or inverted after clamping: there is nothing to highlight, and
  // emitting a zero-length run would put an empty string into the output that
  // every consumer then has to filter.
  const spans = value.spans
    .map((span) => ({
      ...span,
      start: Math.max(0, Math.min(span.start, text.length)),
      end: Math.max(0, Math.min(span.end, text.length)),
    }))
    .filter((span) => span.start < span.end);

  if (spans.length === 0) return [{ text, spans: [] }];

  const boundaries = [...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end])])].sort(
    (a, b) => a - b
  );

  const runs: Run[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    runs.push({
      text: text.slice(start, end),
      // A span covers this run iff it covers the whole of it — which it must,
      // because every span endpoint is itself a boundary, so no run can be
      // partially covered.
      spans: spans.filter((s) => s.start <= start && s.end >= end),
    });
  }
  return runs;
}
