/** Shared type definitions for Judge Arena */

export interface CriteriaScore {
  criterionId: string;
  criterionName: string;
  score: number;
  maxScore: number;
  weight: number;
  comment?: string;
}

export interface EvaluationWithRelations {
  id: string;
  projectId: string;
  inputText: string;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  project: {
    id: string;
    name: string;
  };
  modelJudgments: ModelJudgmentView[];
  humanJudgment: HumanJudgmentView | null;
}

export interface ModelJudgmentView {
  id: string;
  evaluationId: string;
  modelConfigId: string;
  overallScore: number | null;
  reasoning: string | null;
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
  evaluationId: string;
  overallScore: number;
  reasoning: string | null;
  criteriaScores: CriteriaScore[];
  selectedBestModelId: string | null;
  createdAt: string;
}

export interface RubricWithCriteria {
  id: string;
  name: string;
  description: string | null;
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

export interface ProjectWithDetails {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  _count: {
    evaluations: number;
  };
}

export type EvaluationStatus = 'pending' | 'judging' | 'completed' | 'error';
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
}
