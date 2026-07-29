/**
 * ─── Judge identity display fallback (Task 12) ─────────────────────────────
 *
 * `ModelJudgment`/`RunModelSelection`/`EvaluationModelSelection` rows created
 * before Task 12 carry `modelConfig` (a `ModelConfig` join); rows created by
 * the current write path carry `judgeModelVersion` (a `JudgeModelVersion` +
 * `JudgeModel` join) instead — `modelConfigId` is left `null` on every new
 * row (see `src/lib/run-launch.ts`'s module doc). Every UI/API surface that
 * displays "which model produced this judgment" needs to read EITHER shape
 * depending on when the row was created — these two small, pure helpers are
 * the ONE place that fallback logic lives, so it can't silently drift
 * between the run-detail page, the evaluations list, the leaderboard, and
 * CSV/JSONL export.
 */

export interface ModelDisplayIdentity {
  /** Stable key for React lists / dedupe — the underlying ModelConfig or
   * JudgeModelVersion id, never a synthesized value. */
  id: string;
  name: string;
  provider: string;
  modelId: string;
}

interface LegacyModelConfigLike {
  id: string;
  name: string;
  provider: string;
  modelId?: string;
}

interface JudgeModelVersionLike {
  id: string;
  ordinal: number;
  servingBackend: string;
  judgeModel: { id: string; name: string; baseModel: string | null };
}

const UNKNOWN_MODEL_DISPLAY: ModelDisplayIdentity = {
  id: 'unknown',
  name: 'Unknown model',
  provider: 'unknown',
  modelId: 'unknown',
};

/**
 * Resolve a stable `{ id, name, provider, modelId }` triple for display,
 * preferring the legacy `modelConfig` join (present on pre-Task-12 rows)
 * and falling back to `judgeModelVersion`/`judgeModel` (every row created by
 * the current write path). Falls back to a generic "Unknown model" only
 * when a row somehow carries neither (a data integrity issue, not a normal
 * runtime condition).
 */
export function resolveModelDisplay(row: {
  modelConfig?: LegacyModelConfigLike | null;
  judgeModelVersion?: JudgeModelVersionLike | null;
}): ModelDisplayIdentity {
  if (row.modelConfig) {
    return {
      id: row.modelConfig.id,
      name: row.modelConfig.name,
      provider: row.modelConfig.provider,
      modelId: row.modelConfig.modelId ?? '',
    };
  }
  if (row.judgeModelVersion) {
    const v = row.judgeModelVersion;
    return {
      id: v.id,
      name: v.ordinal > 1 ? `${v.judgeModel.name} v${v.ordinal}` : v.judgeModel.name,
      provider: v.servingBackend,
      modelId: v.judgeModel.baseModel ?? '',
    };
  }
  return UNKNOWN_MODEL_DISPLAY;
}

/**
 * Stable identity key for matching a respond-mode "best response" pick
 * against a completed `ModelJudgment` row — prefers the new
 * `judgeModelVersionId`, falling back to the legacy `modelConfigId` for rows
 * that predate Task 12. Returns `null` only if a row carries neither
 * (matches nothing, never crashes a `.includes()`/`===` check).
 */
export function judgmentIdentityKey(row: {
  judgeModelVersionId?: string | null;
  modelConfigId?: string | null;
}): string | null {
  return row.judgeModelVersionId ?? row.modelConfigId ?? null;
}
