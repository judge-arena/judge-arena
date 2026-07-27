import { z } from 'zod';

// Extracted from route.ts: Next.js 15 validates route.ts exports against a
// known allowlist (GET/POST/.../config exports) and rejects arbitrary named
// exports like a zod schema. Colocated here so the route and its tests
// (tests/lib/create-version-schema.test.ts) can both import it — same schema,
// same behavior, just relocated out of the route module.
export const createVersionSchema = z.object({
  samples: z.array(z.object({
    input: z.string().min(1),
    expected: z.string().optional().nullable(),
    metadata: z.record(z.unknown()).optional(),
  })).optional(),
});
