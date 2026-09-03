import { describe, expect, it } from 'vitest';
import { canonicalJson, describeSamplingSnapshot, detectSamplingDrift } from '@/lib/calibration/sampling-drift';

// ─── header (launch-time snapshot) vs judgments (execution-time truth) ─────
//
// CalibrationRun.samplingParams (v2k) is written from the same resolver the
// worker uses per judgment, so the two agree unless the version row was edited
// mid-run (runbook §8.8). The trap in comparing them is JSONB: Postgres stores
// object keys shortest-first, so the header written as { temperature,
// max_tokens } reads back from a judgment row as { max_tokens, temperature }.
// A naive JSON.stringify comparison would report drift on EVERY run.

const LAUNCHED = { temperature: 0.3, max_tokens: 4096 }; // in-process key order
const FROM_JSONB = { max_tokens: 4096, temperature: 0.3 }; // what Postgres hands back
const RAISED = { max_tokens: 12288, temperature: 0.3 };

describe('calibration/sampling-drift: canonicalJson', () => {
  it('sorts keys so a JSONB round-trip compares equal to what was written', () => {
    expect(canonicalJson(LAUNCHED)).toBe(canonicalJson(FROM_JSONB));
    expect(canonicalJson(LAUNCHED)).toBe('{"max_tokens":4096,"temperature":0.3}');
  });

  it('is total over the values a Json? column can hold', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('undefined');
    expect(canonicalJson('4096')).toBe('"4096"');
  });
});

describe('calibration/sampling-drift: describeSamplingSnapshot', () => {
  it('a NULL header is rendered as pre-v2k, never as a config', () => {
    // NULL means exactly one thing — launched before v2k. Falling through to a
    // default here would present a guess as a launch-time snapshot.
    expect(describeSamplingSnapshot(null)).toMatch(/launched before v2k/);
    expect(describeSamplingSnapshot(undefined)).toMatch(/launched before v2k/);
    // A real snapshot renders canonically (same function as the drift check).
    expect(describeSamplingSnapshot(FROM_JSONB)).toBe(canonicalJson(FROM_JSONB));
  });
});

describe('calibration/sampling-drift: detectSamplingDrift', () => {
  it('JSONB key order is NOT drift', () => {
    expect(
      detectSamplingDrift(LAUNCHED, [
        { status: 'completed', samplingParams: FROM_JSONB },
        { status: 'completed', samplingParams: FROM_JSONB },
      ])
    ).toEqual({ kind: 'consistent', executedUnder: canonicalJson(LAUNCHED) });
  });

  it('two distinct configs among COMPLETED judgments is a run that moved mid-run', () => {
    const drift = detectSamplingDrift(LAUNCHED, [
      { status: 'completed', samplingParams: FROM_JSONB },
      { status: 'completed', samplingParams: RAISED },
    ]);
    expect(drift.kind).toBe('moved_mid_run');
    expect(drift.kind === 'moved_mid_run' && drift.executedUnder).toEqual([
      canonicalJson(FROM_JSONB),
      canonicalJson(RAISED),
    ]);
  });

  it('a pending/error judgment with NULL samplingParams does not collapse the comparison (spec §4.1 caveat)', () => {
    expect(
      detectSamplingDrift(LAUNCHED, [
        { status: 'completed', samplingParams: FROM_JSONB },
        { status: 'error', samplingParams: null },
        { status: 'pending', samplingParams: null },
      ])
    ).toEqual({ kind: 'consistent', executedUnder: canonicalJson(LAUNCHED) });
  });

  it('every judgment agreeing with each other but not with the header is a row edited between launch and execution', () => {
    expect(detectSamplingDrift(LAUNCHED, [{ status: 'completed', samplingParams: RAISED }])).toEqual({
      kind: 'differs_from_header',
      header: canonicalJson(LAUNCHED),
      executedUnder: canonicalJson(RAISED),
    });
  });

  it('a pre-v2k header (null) is never reported as drift — there is nothing to compare against', () => {
    expect(detectSamplingDrift(null, [{ status: 'completed', samplingParams: FROM_JSONB }])).toEqual({
      kind: 'consistent',
      executedUnder: canonicalJson(FROM_JSONB),
    });
    expect(detectSamplingDrift(null, [])).toEqual({ kind: 'consistent', executedUnder: null });
  });

  it('a header with nothing completed yet is not drift — the poll can time out with every judgment still pending', () => {
    // The state scripts/calibration/run.ts hands the detector when the poll
    // loop times out with everything still pending: a REAL header (v2k wrote
    // it at launch) and zero completed judgments. It is the only case that
    // exercises the `only !== null` arm — every other test here either has a
    // completed judgment or a null header, where `header != null`
    // short-circuits first.
    expect(detectSamplingDrift(LAUNCHED, [{ status: 'pending', samplingParams: null }])).toEqual({
      kind: 'consistent',
      executedUnder: null,
    });
    expect(detectSamplingDrift(LAUNCHED, [])).toEqual({ kind: 'consistent', executedUnder: null });
  });
});
