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
