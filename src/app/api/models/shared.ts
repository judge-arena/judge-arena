/**
 * Shared `ModelEndpoint` -> wire-shape helpers for `/api/models` and
 * `/api/models/[id]`. Extracted out of route.ts (rather than exported from
 * one): Next.js 15 validates route.ts exports against a known allowlist
 * (GET/POST/.../config) and rejects arbitrary named exports — same reason
 * `.../human-judgment/schema.ts` is a sibling file instead of living inside
 * its route.ts.
 */
import { Prisma } from '@prisma/client';

export const modelEndpointInclude = {
  judgeModelVersion: {
    include: {
      judgeModel: true,
    },
  },
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.ModelEndpointInclude;

export type EndpointWithVersion = Prisma.ModelEndpointGetPayload<{ include: typeof modelEndpointInclude }>;

/** Flattens a `ModelEndpoint` + its `JudgeModelVersion`/`JudgeModel` join
 * into the wire shape `GET`/`POST`/`PATCH` all return — sanitized (no
 * `apiKeyEnc`), with legacy-shaped aliases (`provider`, `modelId`) so the
 * models page and `getProviderInfo()` don't need to know about the new
 * catalog/endpoint split. */
export function modelEndpointToWireShape(endpoint: EndpointWithVersion) {
  const version = endpoint.judgeModelVersion;
  const judgeModel = version.judgeModel;
  return {
    id: endpoint.id,
    judgeModelVersionId: version.id,
    judgeModelId: judgeModel.id,
    name: judgeModel.name,
    slug: judgeModel.slug,
    judgeClass: judgeModel.judgeClass,
    scoringMechanism: judgeModel.scoringMechanism,
    servingBackend: version.servingBackend,
    ordinal: version.ordinal,
    baseModel: judgeModel.baseModel,
    // Legacy-shaped aliases — the pre-Task-12 UI/components read
    // `model.provider`/`model.modelId`; keeping these means
    // getProviderInfo()/model-judgment-card.tsx keep working unmodified.
    provider: version.servingBackend,
    modelId: judgeModel.baseModel ?? '',
    endpoint: endpoint.endpoint,
    isActive: endpoint.isActive,
    isVerified: endpoint.verifiedAt !== null,
    verifiedAt: endpoint.verifiedAt,
    verificationError: endpoint.verificationError,
    archFingerprint: endpoint.archFingerprint,
    hasApiKey: !!endpoint.apiKeyEnc,
    userId: endpoint.userId,
    user: endpoint.user,
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}
