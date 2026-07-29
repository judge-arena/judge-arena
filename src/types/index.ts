/** Shared type definitions for Judge Arena */

export interface CriteriaScore {
  criterionId: string;
  criterionName: string;
  score: number;
  maxScore: number;
  weight: number;
  comment?: string;
}

// ─── Evaluation Template ─────────────────────────────────────────────────────

export interface EvaluationWithRelations {
  id: string;
  projectId: string;
  mode?: EvaluationMode;
  inputText: string;
  promptText?: string | null;
  responseText?: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  project: {
    id: string;
    name: string;
  };
  rubric?: {
    id: string;
    name: string;
    version: number;
    parentId: string | null;
  } | null;
  dataset?: {
    id: string;
    name: string;
    sampleCount: number | null;
  } | null;
  datasetSample?: {
    id: string;
    index: number;
    input: string;
    expected: string | null;
  } | null;
  modelSelections: {
    id: string;
    // Task 12: judgeModelVersionId is the current selection identity;
    // modelConfigId/modelConfig are legacy (pre-Task-12 rows only — null on
    // every row the current write path creates). See src/lib/model-display.ts.
    modelConfigId: string | null;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
      modelId: string;
    } | null;
    judgeModelVersionId: string | null;
    judgeModelVersion: JudgeModelVersionView | null;
  }[];
  /** Summary of runs for this template (sorted newest-first) */
  runs: EvaluationRunSummary[];
}

/** Minimal JudgeModelVersion+JudgeModel shape used for identity display
 * fallback — see src/lib/model-display.ts's resolveModelDisplay. */
export interface JudgeModelVersionView {
  id: string;
  ordinal: number;
  servingBackend: string;
  judgeModel: {
    id: string;
    name: string;
    baseModel: string | null;
  };
}

// ─── Evaluation Run ───────────────────────────────────────────────────────────

export interface EvaluationRunSummary {
  id: string;
  evaluationId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  rubric?: {
    id: string;
    name: string;
    version: number;
  } | null;
  triggeredBy: {
    id: string;
    name: string | null;
    email: string;
  };
  runModelSelections: {
    id: string;
    modelConfigId: string | null;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
    } | null;
    judgeModelVersionId: string | null;
    judgeModelVersion: JudgeModelVersionView | null;
  }[];
  modelJudgments: {
    id: string;
    status: string;
    overallScore: number | null;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
    } | null;
    judgeModelVersion: JudgeModelVersionView | null;
  }[];
  humanJudgment?: {
    overallScore: number;
  } | null;
}

export interface EvaluationRunDetail {
  id: string;
  evaluationId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  mode?: EvaluationMode;
  rubric?: {
    id: string;
    name: string;
    version: number;
    parentId: string | null;
    criteria: RubricCriterionView[];
  } | null;
  triggeredBy: {
    id: string;
    name: string | null;
    email: string;
  };
  evaluation: {
    id: string;
    title: string | null;
    inputText: string;
    promptText?: string | null;
    responseText?: string | null;
    project: {
      id: string;
      name: string;
    };
  };
  runModelSelections: {
    id: string;
    modelConfigId: string | null;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
      modelId: string;
    } | null;
    judgeModelVersionId: string | null;
    judgeModelVersion: JudgeModelVersionView | null;
  }[];
  modelJudgments: ModelJudgmentView[];
  humanJudgment: HumanJudgmentView | null;
}

// ─── Judgments ───────────────────────────────────────────────────────────────

export interface ModelJudgmentView {
  id: string;
  runId: string;
  // Task 12: modelConfigId/modelConfig are legacy (null on every row the
  // current write path creates); judgeModelVersion is the current identity
  // source. See src/lib/model-display.ts's resolveModelDisplay.
  modelConfigId: string | null;
  overallScore: number | null;
  reasoning: string | null;
  rawResponse: string | null;
  criteriaScores: CriteriaScore[];
  latencyMs: number | null;
  tokenCount: number | null;
  status: string;
  error: string | null;
  createdAt: string;
  modelConfig: {
    id: string;
    name: string;
    provider: string;
    modelId: string;
  } | null;
  judgeModelVersionId: string | null;
  judgeModelVersion: JudgeModelVersionView | null;
}

export interface HumanJudgmentView {
  id: string;
  runId: string;
  overallScore: number;
  reasoning: string | null;
  criteriaScores: CriteriaScore[];
  // Task 12: selectedBestJudgeModelVersionId is the current "best response"
  // identity; selectedBestModelId is legacy (pre-Task-12 rows only). See
  // src/lib/model-display.ts's judgmentIdentityKey.
  selectedBestModelId: string | null;
  selectedBestJudgeModelVersionId: string | null;
  createdAt: string;
  user?: {
    id: string;
    name: string | null;
    email: string;
  };
}

// ─── Rubric ───────────────────────────────────────────────────────────────────

export interface RubricWithCriteria {
  id: string;
  name: string;
  description: string | null;
  version: number;
  parentId: string | null;
  criteria: RubricCriterionView[];
  createdAt: string;
  updatedAt: string;
}

export interface RubricCriterionView {
  id: string;
  rubricId: string;
  name: string;
  description: string;
  maxScore: number;
  weight: number;
  order: number;
}

// ─── Models (Task 12: JudgeModel catalog + ModelEndpoint) ─────────────────────
// GET/POST/PATCH /api/models wire shape — see CONTRIBUTING.md's "API
// wire-format changes (v2, 1b Task 12)" section for the full breaking-change
// writeup (this replaces the pre-Task-12 ModelConfig-shaped response).

export interface ModelEndpointView {
  id: string; // ModelEndpoint id
  judgeModelVersionId: string;
  judgeModelId: string;
  name: string;
  slug: string;
  judgeClass: string;
  scoringMechanism: string;
  servingBackend: string;
  ordinal: number;
  baseModel: string | null;
  /** Legacy-shaped aliases (== servingBackend / baseModel) kept for UI/
   * getProviderInfo() compat — see src/app/api/models/shared.ts. */
  provider: string;
  modelId: string;
  endpoint: string | null;
  isActive: boolean;
  isVerified: boolean;
  verifiedAt: string | null;
  verificationError: string | null;
  archFingerprint: unknown;
  hasApiKey: boolean;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Project ──────────────────────────────────────────────────────────────────

export interface ProjectWithDetails {
  id: string;
  name: string;
  description: string | null;
  isDefault?: boolean;
  createdAt: string;
  updatedAt: string;
  _count: {
    evaluations: number;
  };
}

// ─── Dataset ──────────────────────────────────────────────────────────────────

export type DatasetSource = 'local' | 'remote';
export type DatasetVisibility = 'private' | 'public';

export interface DatasetListItem {
  id: string;
  name: string;
  description: string | null;
  source: DatasetSource;
  visibility: DatasetVisibility;
  sourceUrl: string | null;
  huggingFaceId: string | null;
  sampleCount: number | null;
  tags: string | null;
  splits: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string | null; email: string };
  project: { id: string; name: string } | null;
  _count: { samples: number };
}

export interface DatasetSampleView {
  id: string;
  index: number;
  input: string;
  expected: string | null;
  metadata: string | null;
  createdAt: string;
}

export interface DatasetDetail extends DatasetListItem {
  remoteMetadata: string | null;
  format: string | null;
  localData: string | null;
  features: string | null;
  samples: DatasetSampleView[];
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export type EvaluationStatus = 'pending' | 'judging' | 'needs_human' | 'completed' | 'error';
export type JudgmentStatus = 'pending' | 'running' | 'completed' | 'error';
export type ModelProvider = 'anthropic' | 'openai' | 'local';
export type EvaluationMode = 'judge' | 'respond';

export interface KeyboardShortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  action: () => void;
  scope?: string;
}

export interface AppStats {
  totalProjects: number;
  totalEvaluations: number;
  completedEvaluations: number;
  pendingEvaluations: number;
  activeModels: number;
  totalRubrics: number;
  totalDatasets: number;
}
