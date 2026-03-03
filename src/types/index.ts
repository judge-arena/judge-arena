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
    modelConfigId: string;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
      modelId: string;
    };
  }[];
  /** Summary of runs for this template (sorted newest-first) */
  runs: EvaluationRunSummary[];
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
    modelConfigId: string;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
    };
  }[];
  modelJudgments: {
    id: string;
    status: string;
    overallScore: number | null;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
    };
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
    modelConfigId: string;
    modelConfig: {
      id: string;
      name: string;
      provider: string;
      modelId: string;
    };
  }[];
  modelJudgments: ModelJudgmentView[];
  humanJudgment: HumanJudgmentView | null;
}

// ─── Judgments ───────────────────────────────────────────────────────────────

export interface ModelJudgmentView {
  id: string;
  runId: string;
  modelConfigId: string;
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
  };
}

export interface HumanJudgmentView {
  id: string;
  runId: string;
  overallScore: number;
  reasoning: string | null;
  criteriaScores: CriteriaScore[];
  selectedBestModelId: string | null;
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

// ─── Model Config ─────────────────────────────────────────────────────────────

export interface ModelConfigView {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  endpoint: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  hasApiKey: boolean;
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
