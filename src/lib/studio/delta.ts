import type { SpanText } from '@/lib/studio/content';

/**
 * A1.5 — word-level diff between two versions of the same text.
 *
 * ── THE INVARIANT, AND WHY IT IS THE THING UNDER TEST ──────────────────────
 *
 *   unchanged + removed, in order, reconstructs BEFORE exactly.
 *   unchanged + added,   in order, reconstructs AFTER  exactly.
 *
 * A diff that violates this still looks completely reasonable on screen — the
 * highlighting is plausible, the words are in the right order, and the only
 * evidence is a word that quietly is not there any more. So the tests assert
 * reconstruction rather than appearance. The classic way to break it is
 * `split(/\s+/)`, which discards the separators and rebuilds every run of
 * whitespace as a single space: a silent reflow of anything multi-line, which
 * model reasoning always is.
 *
 * ── WHY WORDS, NOT CHARACTERS ──────────────────────────────────────────────
 *
 * A character diff of 'configuration' -> 'configurations' is one added 's',
 * which is precise and useless: what a reader needs to see is that THIS WORD
 * changed. Character diffs of prose degenerate into letter soup wherever two
 * words share letters, which is everywhere.
 *
 * ── WHY NO DIFF LIBRARY ────────────────────────────────────────────────────
 *
 * LCS over word tokens is ~40 lines and is exactly what a library would do.
 * The supply-chain surface of a dependency is not worth it for prose
 * comparison.
 *
 * COST: the LCS table is O(n*m) in tokens. For two model answers — hundreds of
 * words — that is trivial. It is NOT suitable for whole documents, and if this
 * is ever pointed at one, that is the moment to reach for a real diff
 * algorithm rather than to widen this one.
 */

export type DeltaRun = { text: string; change: 'unchanged' | 'added' | 'removed' };

/**
 * Split into tokens that CONCATENATE BACK TO THE INPUT EXACTLY.
 *
 * Each token is one word plus the whitespace that follows it, so no separator
 * is ever discarded and reconstruction is exact by construction rather than by
 * care. Leading whitespace becomes its own token for the same reason.
 *
 * Compared by their trimmed word, so that a word whose trailing spacing
 * changed is still recognised as the same word — see `keyOf`.
 */
function tokenize(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/\s+|\S+\s*/g) ?? [];
}

/**
 * Two tokens are "the same word" when their non-whitespace content matches.
 *
 * A whitespace-only token — which `tokenize` produces at most one of, at index
 * 0, since every other token absorbs its own trailing whitespace — keys to the
 * empty string, and so matches only another whitespace-only token. That is
 * correct rather than lax: whether the two are byte-identical is settled by
 * the equality check in `delta`, which is what preserves reconstruction. An
 * earlier version special-cased whitespace here to keep a paragraph break from
 * matching a single space; injecting that special case away changed no
 * observable behaviour, because the byte check downstream already covers it.
 */
function keyOf(token: string): string {
  return token.trim();
}

export function delta(before: SpanText, after: SpanText): DeltaRun[] {
  const a = tokenize(before.text);
  const b = tokenize(after.text);

  // Standard LCS length table over token keys.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        keyOf(a[i]) === keyOf(b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const runs: DeltaRun[] = [];
  // Appends, merging into the previous run when the change matches. Merging
  // matters beyond tidiness: DeltaTextView emits one <ins>/<del> per run, and
  // an unmerged sequence announces a multi-word edit to a screen reader one
  // word at a time.
  // No empty-text guard here on purpose. `tokenize` cannot yield an empty
  // token — both alternatives of its regex require at least one character, and
  // empty input returns no tokens at all — so a guard would be a branch no
  // test could reach. Deleting it rather than commenting it is the same call
  // R4 made about an inert read: unreachable code that claims to protect
  // something is worse than absent code, because it reads as a guarantee.
  // 'never emits an empty run' in the tests pins the property through the
  // public API, where the tokenizer actually enforces it.
  const push = (text: string, change: DeltaRun['change']) => {
    const last = runs[runs.length - 1];
    if (last && last.change === change) last.text += text;
    else runs.push({ text, change });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (keyOf(a[i]) === keyOf(b[j])) {
      // The two sides may differ in trailing whitespace. `before`'s token is
      // what reconstructs `before` and `after`'s is what reconstructs `after`,
      // so when they are not byte-identical this cannot be one shared run:
      // emit it as a removal plus an addition, which reconstructs both sides.
      if (a[i] === b[j]) {
        push(a[i], 'unchanged');
      } else {
        push(a[i], 'removed');
        push(b[j], 'added');
      }
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(a[i++], 'removed');
    } else {
      push(b[j++], 'added');
    }
  }
  while (i < a.length) push(a[i++], 'removed');
  while (j < b.length) push(b[j++], 'added');

  return runs;
}
