import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  effectiveSamplingParams,
  JUDGE_DEFAULT_SAMPLING_PARAMS,
  RESPOND_DEFAULT_SAMPLING_PARAMS,
} from '@/lib/llm/sampling';
import { effectiveSamplingParams as viaRegistry } from '@/lib/llm/registry';

// ─── src/lib/llm/sampling.ts is a LEAF, and that is its whole reason to exist ─
//
// `src/lib/calibration/launch.ts` resolves a version's effective sampling
// params to snapshot them on the CalibrationRun header (v2k). launch.ts is
// bundled into the image's calibration-run.js by esbuild with only
// @prisma/client external (Dockerfile, `scripts/calibration/run.ts` block), so
// if the resolver were reached through registry.ts or the `@/lib/llm` barrel
// the CLI would ship @anthropic-ai/sdk, every backend module and the redis
// client. The resolver's BEHAVIOUR is pinned by tests/lib/registry.test.ts
// (`registry: effectiveSamplingParams`, through the re-export); this file
// pins the two things that test cannot see.

const SOURCE = readFileSync(new URL('../../src/lib/llm/sampling.ts', import.meta.url), 'utf8');

describe('llm/sampling: a leaf module', () => {
  it('has NO value import or re-export at all — the property that keeps SDKs and redis out of the CLI bundle', () => {
    // WHOLE FILE, not line-by-line. A per-line regex misses the multi-line
    // form —
    //
    //     export {
    //       getDescriptor,
    //     } from './registry';
    //
    // — whose first line carries no `from` and whose last line starts with
    // `}`; esbuild bundles that re-export exactly like an import, so it has to
    // be caught here too, as does a top-level dynamic `import('./x')`.
    // Strip comment lines and type-only statements (esbuild erases those),
    // then require that NO module specifier survives anywhere in the file.
    const code = SOURCE.split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n')
      .replace(/\b(?:import|export)\s+type\s[^;]*;/g, '');
    const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]+['"]/g)].map((m) => m[0]);
    expect(
      specifiers,
      'src/lib/llm/sampling.ts must stay a LEAF: no value import, no `export … from`, no dynamic import'
    ).toEqual([]);
  });

  it('is what registry.ts hands out — one resolver, not a copy', () => {
    expect(viaRegistry).toBe(effectiveSamplingParams);
    expect(effectiveSamplingParams(null)).toEqual(JUDGE_DEFAULT_SAMPLING_PARAMS);
    expect(effectiveSamplingParams(null, undefined, RESPOND_DEFAULT_SAMPLING_PARAMS)).toEqual({
      temperature: 0.4,
      max_tokens: 4096,
    });
  });
});

describe('llm/sampling: penalties', () => {
  it('carries repeat_penalty from the version defaults', () => {
    const params = effectiveSamplingParams({ temperature: 0.3, max_tokens: 8192, repeat_penalty: 1.15 });
    expect(params.repeat_penalty).toBe(1.15);
    expect(params.max_tokens).toBe(8192);
  });

  it('omits the penalties entirely when nothing sets them', () => {
    const params = effectiveSamplingParams({ temperature: 0.3, max_tokens: 4096 });
    expect('repeat_penalty' in params).toBe(false);
    expect('frequency_penalty' in params).toBe(false);
  });

  it('lets a per-call override beat the version default', () => {
    const params = effectiveSamplingParams({ repeat_penalty: 1.1 }, { repeat_penalty: 1.3 });
    expect(params.repeat_penalty).toBe(1.3);
  });
});
