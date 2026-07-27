import { z } from 'zod';

// Extracted from route.ts: Next.js 15 validates route.ts exports against a
// known allowlist (GET/POST/.../config exports) and rejects arbitrary named
// exports like a zod schema. Colocated here so the route and its tests
// (tests/lib/human-judgment-schema.test.ts) can both import it — same schema,
// same behavior, just relocated out of the route module.
export const humanJudgmentSchema = z.object({
  overallScore: z.number().min(0).max(10).optional(),
  reasoning: z.string().max(5000).optional(),
  criteriaScores: z
    .array(
      z.object({
        criterionId: z.string(),
        criterionName: z.string(),
        score: z.number().min(0),
        maxScore: z.number().min(1),
        weight: z.number(),
        comment: z.string().optional(),
      })
    )
    .optional(),
  selectedBestModelId: z.string().nullable().optional(),
});
