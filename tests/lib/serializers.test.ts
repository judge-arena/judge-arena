import { describe, it, expect } from 'vitest';
import {
  toPublicOwner,
  toPublicRubric,
  toPublicDataset,
  toPublicDatasetSample,
  toPublicProject,
  toPublicGoldenSet,
  toPublicLeaderboardEntry,
  type RubricForPublicSerialize,
  type DatasetForPublicSerialize,
  type ProjectForPublicSerialize,
  type GoldenSetForPublicSerialize,
} from '@/lib/serializers';

// Pure-function unit tests — no DB needed (see vitest.config.ts's
// tests/**/*.test.ts include). Every public serializer is an allow-list
// projection (src/lib/serializers.ts's module doc); these tests assert
// the NEGATIVE space as much as the positive: `email` (or any other
// owner PII) must never survive the round trip, no matter what's on the
// input row.

const PII_EMAIL = 'owner-secret@example.com';

describe('src/lib/serializers.ts — public (PII-stripped) serializers', () => {
  describe('toPublicOwner', () => {
    it('keeps id + name, has no email key at all', () => {
      const owner = toPublicOwner({ id: 'u1', name: 'Ada' } as any);
      expect(owner).toEqual({ id: 'u1', name: 'Ada' });
      expect(Object.keys(owner)).not.toContain('email');
    });
  });

  describe('toPublicRubric', () => {
    const input: RubricForPublicSerialize = {
      id: 'r1',
      name: 'Helpfulness',
      slug: 'helpfulness',
      description: 'How helpful is the response',
      version: 2,
      parentId: 'r0',
      visibility: 'public',
      publishedAt: new Date('2026-01-01'),
      retiredAt: null,
      criteria: [
        { id: 'c1', name: 'Clarity', description: 'Is it clear', maxScore: 10, weight: 1, order: 0 },
      ],
      user: { id: 'owner-1', name: 'Owner Name' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    };
    // Attach an email to the raw user join the way a real Prisma `include`
    // would — toPublicRubric must never read it.
    const rawWithEmail = { ...input, user: { ...input.user, email: PII_EMAIL } };

    it('never includes owner email, even when present on the input row', () => {
      const result = toPublicRubric(rawWithEmail as any);
      expect(result.owner).toEqual({ id: 'owner-1', name: 'Owner Name' });
      expect(JSON.stringify(result)).not.toContain(PII_EMAIL);
    });

    it('preserves the public-safe fields', () => {
      const result = toPublicRubric(input);
      expect(result).toMatchObject({
        id: 'r1',
        name: 'Helpfulness',
        slug: 'helpfulness',
        description: 'How helpful is the response',
        version: 2,
        parentId: 'r0',
        visibility: 'public',
      });
      expect(result.criteria).toEqual([
        { id: 'c1', name: 'Clarity', description: 'Is it clear', maxScore: 10, weight: 1, order: 0 },
      ]);
    });
  });

  describe('toPublicDataset', () => {
    const input: DatasetForPublicSerialize = {
      id: 'd1',
      name: 'Eval Set',
      slug: 'eval-set',
      description: 'A dataset',
      source: 'local',
      visibility: 'public',
      publishedAt: null,
      inputType: 'query-response',
      version: 1,
      parentId: null,
      sourceUrl: null,
      huggingFaceId: null,
      sampleCount: 10,
      splits: null,
      features: null,
      tags: null,
      user: { id: 'owner-2', name: 'Dataset Owner' },
      project: { id: 'p1', name: 'Project One' },
      _count: { samples: 10 },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    };
    const rawWithEmail = { ...input, user: { ...input.user, email: PII_EMAIL } };

    it('never includes owner email, even when present on the input row', () => {
      const result = toPublicDataset(rawWithEmail as any);
      expect(result.owner).toEqual({ id: 'owner-2', name: 'Dataset Owner' });
      expect(JSON.stringify(result)).not.toContain(PII_EMAIL);
    });

    it('never includes apiKeyEnc or any credential-shaped field, even if present on the input row', () => {
      const withStrayCreds = { ...input, apiKeyEnc: 'sk-should-never-appear', endpoint: 'http://leak.example' };
      const result = toPublicDataset(withStrayCreds as any);
      expect(JSON.stringify(result)).not.toContain('sk-should-never-appear');
      expect(JSON.stringify(result)).not.toContain('leak.example');
    });

    it('flattens _count.samples to sampleTotal and keeps project as {id, name}', () => {
      const result = toPublicDataset(input);
      expect(result.sampleTotal).toBe(10);
      expect(result.project).toEqual({ id: 'p1', name: 'Project One' });
      expect((result as any)._count).toBeUndefined();
    });

    it('carries publishedAt through (Task 15 — parity with Rubric/Project)', () => {
      const published = new Date('2026-02-01');
      const result = toPublicDataset({ ...input, publishedAt: published });
      expect(result.publishedAt).toBe(published);
      expect(toPublicDataset(input).publishedAt).toBeNull();
    });

    it('project: null passes through as null (dataset with no project)', () => {
      const result = toPublicDataset({ ...input, project: null });
      expect(result.project).toBeNull();
    });
  });

  describe('toPublicDatasetSample', () => {
    it('passes sample fields through verbatim (no owner/user data on a sample row)', () => {
      const sample = { id: 's1', index: 0, input: 'Q', expected: 'A', metadata: null };
      expect(toPublicDatasetSample(sample)).toEqual(sample);
    });
  });

  describe('toPublicProject', () => {
    const input: ProjectForPublicSerialize = {
      id: 'proj1',
      name: 'Leaderboard',
      slug: 'leaderboard',
      description: 'The public leaderboard project',
      isDefault: true,
      visibility: 'public',
      publishedAt: new Date('2026-01-01'),
      user: { id: 'owner-3', name: 'Project Owner' },
      _count: { evaluations: 5 },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    };
    const rawWithEmail = { ...input, user: { ...input.user, email: PII_EMAIL } };

    it('never includes owner email, even when present on the input row', () => {
      const result = toPublicProject(rawWithEmail as any);
      expect(result.owner).toEqual({ id: 'owner-3', name: 'Project Owner' });
      expect(JSON.stringify(result)).not.toContain(PII_EMAIL);
    });

    it('never includes evaluations — user-created data stays gated regardless of project visibility (spec §7 D3)', () => {
      const withEvaluations = {
        ...input,
        evaluations: [{ id: 'e1', user: { id: 'x', name: 'X', email: 'contributor@example.com' } }],
      };
      const result = toPublicProject(withEvaluations as any);
      expect((result as any).evaluations).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('contributor@example.com');
    });

    it('flattens _count.evaluations to evaluationCount', () => {
      const result = toPublicProject(input);
      expect(result.evaluationCount).toBe(5);
    });
  });

  describe('toPublicGoldenSet', () => {
    const input: GoldenSetForPublicSerialize = {
      id: 'g1',
      name: 'Golden Set One',
      description: null,
      visibility: 'public',
      publishedAt: null,
      retiredAt: null,
      owner: { id: 'owner-4', name: 'Golden Owner' },
      _count: { items: 3 },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    };

    it('never includes owner email, even when present on the input row', () => {
      const rawWithEmail = { ...input, owner: { ...input.owner!, email: PII_EMAIL } };
      const result = toPublicGoldenSet(rawWithEmail as any);
      expect(result.owner).toEqual({ id: 'owner-4', name: 'Golden Owner' });
      expect(JSON.stringify(result)).not.toContain(PII_EMAIL);
    });

    it('owner: null (no owner set) passes through as null', () => {
      const result = toPublicGoldenSet({ ...input, owner: null });
      expect(result.owner).toBeNull();
    });

    it('flattens _count.items to itemCount', () => {
      expect(toPublicGoldenSet(input).itemCount).toBe(3);
    });

    it('carries publishedAt/retiredAt through (Task 15 — parity with Rubric; retiredAt is the new account-deletion soft-delete signal)', () => {
      const published = new Date('2026-02-01');
      const retired = new Date('2026-03-01');
      const result = toPublicGoldenSet({ ...input, publishedAt: published, retiredAt: retired });
      expect(result.publishedAt).toBe(published);
      expect(result.retiredAt).toBe(retired);
    });
  });

  describe('toPublicLeaderboardEntry', () => {
    it('is a pure passthrough of the already-public aggregate shape', () => {
      const entry = {
        modelId: 'm1',
        modelName: 'GPT-Fixture',
        provider: 'openai',
        providerModelId: 'gpt-fixture',
        avgScore: 8.5,
        medianScore: 8.5,
        minScore: 7,
        maxScore: 10,
        evaluationCount: 4,
        completedRuns: 4,
      };
      expect(toPublicLeaderboardEntry(entry)).toEqual(entry);
    });
  });
});
