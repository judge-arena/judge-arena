import { describe, expect, it } from 'vitest';
import { segment, toSpanText } from '@/lib/studio/content';

describe('toSpanText — the offsets contract', () => {
  it('normalizes line endings, so a CRLF source does not shift every later offset', () => {
    expect(toSpanText('a\r\nb').text).toBe('a\nb');
  });

  it('normalizes a lone CR too — an old Mac paste is not a different rule', () => {
    expect(toSpanText('a\rb').text).toBe('a\nb');
  });

  it('normalizes to NFC, so a decomposed accent is one code point not two', () => {
    // 'é' decomposed (e + combining acute) is length 2; composed is length 1.
    // A span computed against one and applied to the other is off by one for
    // the whole remainder of the string.
    //
    // THE COMBINING MARK IS WRITTEN AS AN ESCAPE ON PURPOSE. The plan's
    // version of this test wrote the decomposed form as a literal `'éclair'`
    // and asserted length 7 — but a literal typed into a source file is
    // whatever that file's encoding holds, and here it was already composed,
    // so the assertion failed at length 6. The trap is the "fix": changing
    // the 7 to a 6 turns it green while removing the only thing under test,
    // because both sides of the assertion would then be the composed form and
    // `normalize('NFC')` could be deleted without failing anything.
    // `́` cannot be silently normalized by an editor, a formatter, or a
    // copy-paste through a different application.
    const decomposed = 'e\u0301clair'; // e + U+0301 COMBINING ACUTE
    expect(decomposed).toHaveLength(7);
    expect(toSpanText(decomposed).text).toHaveLength(6);
    expect(toSpanText(decomposed).text).toBe('\u00e9clair'); // U+00E9 precomposed
  });

  it('is idempotent — normalizing twice changes nothing', () => {
    const once = toSpanText('a\r\né');
    expect(toSpanText(once.text).text).toBe(once.text);
  });

  it('defaults spans to an empty array rather than undefined', () => {
    // Every consumer maps over `.spans`. Leaving it undefined makes the
    // no-spans case — which is EVERY case until span targeting exists — a
    // crash rather than a plain render.
    expect(toSpanText('x').spans).toEqual([]);
  });
});

describe('segment', () => {
  it('with no spans returns the whole text as one run', () => {
    expect(segment(toSpanText('hello world'))).toEqual([{ text: 'hello world', spans: [] }]);
  });

  it('splits at span boundaries and marks only the covered run', () => {
    const v = toSpanText('hello world', [{ start: 6, end: 11, kind: 'evidence' }]);
    const runs = segment(v);
    expect(runs.map((r) => r.text)).toEqual(['hello ', 'world']);
    expect(runs[0].spans).toEqual([]);
    expect(runs[1].spans.map((s) => s.kind)).toEqual(['evidence']);
  });

  it('carries BOTH spans on the overlapping region', () => {
    // Overlap is the case a naive implementation silently drops, and the
    // rendered result looks plausible either way.
    const v = toSpanText('abcdef', [
      { start: 0, end: 4, kind: 'x' },
      { start: 2, end: 6, kind: 'y' },
    ]);
    const runs = segment(v);
    expect(runs.map((r) => r.text)).toEqual(['ab', 'cd', 'ef']);
    expect(runs[1].spans.map((s) => s.kind).sort()).toEqual(['x', 'y']);
  });

  it('drops a zero-length span rather than emitting an empty run', () => {
    const runs = segment(toSpanText('abc', [{ start: 1, end: 1, kind: 'x' }]));
    expect(runs.map((r) => r.text)).toEqual(['abc']);
  });

  it('clamps an out-of-range span instead of throwing or emitting phantom text', () => {
    const runs = segment(toSpanText('abc', [{ start: 2, end: 99, kind: 'x' }]));
    expect(runs.map((r) => r.text).join('')).toBe('abc');
    expect(runs.at(-1)!.spans.map((s) => s.kind)).toEqual(['x']);
  });

  it('drops a wholly out-of-range or inverted span', () => {
    // start > end after clamping, and a span entirely past the end, are both
    // "nothing to highlight" — not an error, and not a phantom run.
    const runs = segment(toSpanText('abc', [
      { start: 5, end: 9, kind: 'past-end' },
      { start: 2, end: 1, kind: 'inverted' },
    ]));
    expect(runs).toEqual([{ text: 'abc', spans: [] }]);
  });

  it('segments an EMPTY text to no runs rather than one empty run', () => {
    expect(segment(toSpanText(''))).toEqual([]);
  });

  it('reassembles to exactly the original text, always', () => {
    // The invariant that makes every other case safe: segmentation may not
    // lose, duplicate or reorder a single character.
    const v = toSpanText('the quick brown fox', [
      { start: 4, end: 9, kind: 'a' },
      { start: 0, end: 3, kind: 'b' },
      { start: 7, end: 15, kind: 'c' },
    ]);
    expect(
      segment(v)
        .map((r) => r.text)
        .join('')
    ).toBe(v.text);
  });

  it('offsets are CODE UNITS, and an astral character is never split down the middle', () => {
    // '😀' is a surrogate pair: two UTF-16 code units, one character. A span
    // boundary landing between them would emit a lone surrogate, which renders
    // as a replacement glyph — visible corruption from an invisible cause.
    const v = toSpanText('a😀b', [{ start: 1, end: 3, kind: 'emoji' }]);
    const runs = segment(v);
    expect(runs.map((r) => r.text)).toEqual(['a', '😀', 'b']);
    expect(runs[1].spans.map((s) => s.kind)).toEqual(['emoji']);
  });
});
