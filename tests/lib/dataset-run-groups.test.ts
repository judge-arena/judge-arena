import { describe, expect, it } from 'vitest';
import { projectCalibrationRunRows, type CalibrationRunLike } from '@/lib/dataset-run-groups';

// Task 9 (spec §2): "in the front-end and users point of view, they're all
// the same record but with a 'BA vs AB bias'" — one row per golden item, not
// two a human has to reconcile. These tests pin the pure projection function
// the run-detail page (src/app/evaluate/[id]/page.tsx) uses to collapse a
// permuted calibration's 2N EvaluationRuns back down to N rows.

function run(overrides: Partial<CalibrationRunLike> & { id: string }): CalibrationRunLike {
  return { calibrationRunId: null, goldenItemId: null, pairOrder: null, ...overrides };
}

describe('projectCalibrationRunRows', () => {
  it('collapses an AB/BA pair sharing (calibrationRunId, goldenItemId) into ONE row', () => {
    const ab = run({ id: 'run-ab', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' });
    const ba = run({ id: 'run-ba', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'BA' });

    const rows = projectCalibrationRunRows([ba, ab]); // API order is createdAt desc: BA usually lands after AB

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isPair: true, ab, ba, single: null });
  });

  it('projects 2N runs across N golden items down to N rows', () => {
    const runs: CalibrationRunLike[] = [];
    for (let i = 0; i < 5; i += 1) {
      runs.push(run({ id: `ba-${i}`, calibrationRunId: 'calib-1', goldenItemId: `item-${i}`, pairOrder: 'BA' }));
      runs.push(run({ id: `ab-${i}`, calibrationRunId: 'calib-1', goldenItemId: `item-${i}`, pairOrder: 'AB' }));
    }
    expect(runs).toHaveLength(10);

    const rows = projectCalibrationRunRows(runs);

    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.isPair)).toBe(true);
  });

  it('does not merge pairs from DIFFERENT golden items, even under the same calibrationRunId', () => {
    const rows = projectCalibrationRunRows([
      run({ id: 'a1', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' }),
      run({ id: 'b1', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'BA' }),
      run({ id: 'a2', calibrationRunId: 'calib-1', goldenItemId: 'item-2', pairOrder: 'AB' }),
      run({ id: 'b2', calibrationRunId: 'calib-1', goldenItemId: 'item-2', pairOrder: 'BA' }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual([
      'pair:calib-1:item-1',
      'pair:calib-1:item-2',
    ]);
  });

  it('leaves ordinary (non-calibration) runs as their own single-run rows, in input order', () => {
    const r1 = run({ id: 'run-1' });
    const r2 = run({ id: 'run-2' });
    const r3 = run({ id: 'run-3' });

    const rows = projectCalibrationRunRows([r1, r2, r3]);

    expect(rows).toEqual([
      { key: 'run:run-1:run-1', isPair: false, ab: null, ba: null, single: r1 },
      { key: 'run:run-2:run-2', isPair: false, ab: null, ba: null, single: r2 },
      { key: 'run:run-3:run-3', isPair: false, ab: null, ba: null, single: r3 },
    ]);
  });

  it('does not collapse a partial pair — one order missing (e.g. a publish failure) stays a single row', () => {
    const abOnly = run({ id: 'run-ab', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' });

    const rows = projectCalibrationRunRows([abOnly]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isPair: false, ab: null, ba: null, single: abOnly });
  });

  it('does not collapse a mismatched group — a manually launched THIRD run on a calibration-origin Evaluation is never silently folded in', () => {
    // A human can click "New Run" on a calibration item's Evaluation
    // (POST .../runs sets no calibrationRunId), so a group keyed on
    // evaluationId alone could pick up an unrelated third run. This function
    // keys on (calibrationRunId, goldenItemId) instead, so that extra run
    // never enters this group at all — it gets its own `run:<id>` key. This
    // test instead pins the DEFENSIVE arm: if three runs somehow DO share one
    // (calibrationRunId, goldenItemId) — which the DB's partial unique index
    // (v2p) should make unreachable — render them as singles rather than
    // guess which two form "the" pair.
    const ab = run({ id: 'run-ab', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' });
    const ba = run({ id: 'run-ba', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'BA' });
    const extra = run({ id: 'run-extra', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' });

    const rows = projectCalibrationRunRows([ab, ba, extra]);

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.isPair === false)).toBe(true);
    expect(rows.map((r) => r.single?.id).sort()).toEqual(['run-ab', 'run-ba', 'run-extra'].sort());
  });

  it('a manually launched run on a calibration Evaluation never merges with the calibration pair', () => {
    const ab = run({ id: 'run-ab', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'AB' });
    const ba = run({ id: 'run-ba', calibrationRunId: 'calib-1', goldenItemId: 'item-1', pairOrder: 'BA' });
    // No calibrationRunId/goldenItemId — an ordinary run a human launched by
    // hand against the same (shared) Evaluation.
    const manual = run({ id: 'run-manual', pairOrder: 'AB' });

    const rows = projectCalibrationRunRows([manual, ab, ba]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ isPair: false, single: manual });
    expect(rows[1]).toMatchObject({ isPair: true, ab, ba });
  });

  it('handles the empty list', () => {
    expect(projectCalibrationRunRows([])).toEqual([]);
  });
});
