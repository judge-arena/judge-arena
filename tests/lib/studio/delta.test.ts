import { describe, expect, it } from 'vitest';
import { toSpanText } from '@/lib/studio/content';
import { delta } from '@/lib/studio/delta';

const d = (a: string, b: string) => delta(toSpanText(a), toSpanText(b));
const textOf = (runs: { text: string; change: string }[], change: string) =>
  runs
    .filter((r) => r.change === change)
    .map((r) => r.text)
    .join('');

describe('delta', () => {
  it('identical input is one unchanged run', () => {
    expect(d('the same words', 'the same words')).toEqual([
      { text: 'the same words', change: 'unchanged' },
    ]);
  });

  it('marks an insertion as added and nothing as removed', () => {
    const runs = d('a c', 'a b c');
    expect(textOf(runs, 'added').trim()).toBe('b');
    expect(textOf(runs, 'removed')).toBe('');
  });

  it('marks a deletion as removed and nothing as added', () => {
    const runs = d('a b c', 'a c');
    expect(textOf(runs, 'removed').trim()).toBe('b');
    expect(textOf(runs, 'added')).toBe('');
  });

  it('a replacement is both a removal and an addition', () => {
    const runs = d('the cat sat', 'the dog sat');
    expect(textOf(runs, 'removed')).toContain('cat');
    expect(textOf(runs, 'added')).toContain('dog');
    expect(textOf(runs, 'unchanged')).toContain('the');
  });

  it('reconstructs BOTH sides exactly — unchanged+removed is the before, unchanged+added is the after', () => {
    // The invariant. Without it a diff can look right on screen while having
    // quietly dropped a word.
    const before = 'alpha beta gamma delta',
      after = 'alpha gamma epsilon delta';
    const runs = d(before, after);
    expect(
      runs
        .filter((r) => r.change !== 'added')
        .map((r) => r.text)
        .join('')
    ).toBe(before);
    expect(
      runs
        .filter((r) => r.change !== 'removed')
        .map((r) => r.text)
        .join('')
    ).toBe(after);
  });

  it('diffs by WORD, not character — a changed word is one run, not a letter soup', () => {
    const runs = d('configuration', 'configurations');
    expect(runs.filter((r) => r.change !== 'unchanged')).toHaveLength(2);
  });

  it('reconstructs both sides across NEWLINES and runs of whitespace', () => {
    // The reconstruction invariant is only worth anything if it holds for the
    // text this actually renders: model reasoning is multi-line and
    // irregularly spaced. A tokenizer that treats '\n' as a plain separator
    // rebuilds it as a space, which is a silent reflow.
    const before = 'first line\n\nsecond   line\ttabbed';
    const after = 'first line\n\nsecond   line\tchanged';
    const runs = d(before, after);
    expect(
      runs
        .filter((r) => r.change !== 'added')
        .map((r) => r.text)
        .join('')
    ).toBe(before);
    expect(
      runs
        .filter((r) => r.change !== 'removed')
        .map((r) => r.text)
        .join('')
    ).toBe(after);
  });

  it('an empty before is all added, and an empty after is all removed', () => {
    // The first-render case: a panel with one version and nothing to compare
    // against must not report the whole text as unchanged, which would show a
    // brand-new answer as though it had always been there.
    expect(textOf(d('', 'brand new'), 'added')).toBe('brand new');
    expect(textOf(d('', 'brand new'), 'unchanged')).toBe('');
    expect(textOf(d('gone entirely', ''), 'removed')).toBe('gone entirely');
  });

  it('merges ADJACENT runs of the same change into one', () => {
    // Two consecutive changed words are one edit to a reader. Emitting them as
    // separate runs produces visually shattered highlighting and, in
    // DeltaTextView, a stream of separate <ins> elements a screen reader
    // announces one at a time.
    const runs = d('one two three four', 'one CHANGED ALSO four');
    expect(runs.filter((r) => r.change === 'removed')).toHaveLength(1);
    expect(runs.filter((r) => r.change === 'added')).toHaveLength(1);
  });

  it('a WHITESPACE-ONLY change between the same words still reconstructs both sides', () => {
    // The two tokens are the same WORD but not the same BYTES. Treating them
    // as one unchanged run reconstructs `before` correctly and `after`
    // wrongly — so a test that only checks `before`, or only checks which
    // words are highlighted, passes while the diff is lying about one side.
    // Found by injection: forcing the byte check to `true` broke nothing until
    // this case existed.
    const before = 'spaced  out words';
    const after = 'spaced out words';
    const runs = d(before, after);
    expect(
      runs
        .filter((r) => r.change !== 'added')
        .map((r) => r.text)
        .join('')
    ).toBe(before);
    expect(
      runs
        .filter((r) => r.change !== 'removed')
        .map((r) => r.text)
        .join('')
    ).toBe(after);
  });

  it('LEADING whitespace is a token of its own and reconstructs on both sides', () => {
    // `tokenize` emits at most one whitespace-only token, and only at index 0,
    // because every other token absorbs its own trailing whitespace. That one
    // token is the only place `keyOf`'s empty key is reachable, so without
    // this case the whole leading-whitespace path is unexercised.
    const before = '\n\n  indented start';
    const after = '  indented start';
    const runs = d(before, after);
    expect(
      runs
        .filter((r) => r.change !== 'added')
        .map((r) => r.text)
        .join('')
    ).toBe(before);
    expect(
      runs
        .filter((r) => r.change !== 'removed')
        .map((r) => r.text)
        .join('')
    ).toBe(after);
  });

  it('never emits an empty run', () => {
    // An empty run renders as nothing but still costs a DOM node, and in the
    // <ins>/<del> case announces an empty insertion.
    for (const [a, b] of [
      ['', ''],
      ['same', 'same'],
      ['a b', 'b a'],
      ['x', ''],
    ]) {
      expect(d(a, b).every((r) => r.text.length > 0)).toBe(true);
    }
  });
});
