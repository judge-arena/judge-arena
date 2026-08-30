import { describe, expect, it } from 'vitest';
import { parseAddJudgeArgs } from '@/../scripts/admin/add-judge';

describe('add-judge CLI argument parsing', () => {
  const base = ['--name=Q', '--backend=llamacpp', '--base-model=m.gguf'];

  it('accepts the minimum viable invocation and defaults protocol to pairwise', () => {
    const a = parseAddJudgeArgs(base);
    expect(a).toMatchObject({ name: 'Q', backend: 'llamacpp', baseModel: 'm.gguf', protocol: 'pairwise', dryRun: false });
  });

  it('REJECTS an unknown backend rather than letting it fail at judgment time', () => {
    // The whole point: a bad backend that reaches the database produces a judge
    // that looks fine in the catalog and throws only when a run dispatches it.
    expect(() => parseAddJudgeArgs(['--name=Q', '--backend=llamacpp2', '--base-model=m'])).toThrow(/Unknown --backend/);
  });

  it('accepts every backend the API write path accepts — including llamacpp', () => {
    for (const b of ['anthropic', 'openai', 'openrouter', 'vllm', 'llamacpp', 'ollama']) {
      expect(() => parseAddJudgeArgs(['--name=Q', `--backend=${b}`, '--base-model=m'])).not.toThrow();
    }
  });

  it('requires the three fields that cannot be guessed', () => {
    expect(() => parseAddJudgeArgs(['--backend=llamacpp', '--base-model=m'])).toThrow(/--name/);
    expect(() => parseAddJudgeArgs(['--name=Q', '--base-model=m'])).toThrow(/--backend/);
    expect(() => parseAddJudgeArgs(['--name=Q', '--backend=llamacpp'])).toThrow(/--base-model/);
  });

  it('rejects a non-numeric or non-positive max-tokens instead of coercing it to NaN', () => {
    expect(() => parseAddJudgeArgs([...base, '--max-tokens=lots'])).toThrow(/--max-tokens/);
    expect(() => parseAddJudgeArgs([...base, '--max-tokens=0'])).toThrow(/--max-tokens/);
    expect(parseAddJudgeArgs([...base, '--max-tokens=8192']).maxTokens).toBe(8192);
  });

  it('rejects an unknown protocol', () => {
    expect(() => parseAddJudgeArgs([...base, '--protocol=telepathy'])).toThrow(/Unknown --protocol/);
  });

  it('parses --dry-run as a bare flag, not a --k=v pair', () => {
    expect(parseAddJudgeArgs([...base, '--dry-run']).dryRun).toBe(true);
  });
});
