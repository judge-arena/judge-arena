'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { cn, getScoreColor } from '@/lib/utils';
import type { CriteriaScore, RubricCriterionView } from '@/types';

interface HumanJudgmentFormProps {
  criteria: RubricCriterionView[];
  modelJudgmentIds: Array<{ id: string; name: string }>;
  existingJudgment?: {
    overallScore: number;
    reasoning: string | null;
    criteriaScores: CriteriaScore[];
    selectedBestModelId: string | null;
  };
  onSubmit: (data: {
    overallScore: number;
    reasoning: string;
    criteriaScores: CriteriaScore[];
    selectedBestModelId: string | null;
  }) => void;
  loading?: boolean;
}

export function HumanJudgmentForm({
  criteria,
  modelJudgmentIds,
  existingJudgment,
  onSubmit,
  loading,
}: HumanJudgmentFormProps) {
  const [overallScore, setOverallScore] = useState(
    existingJudgment?.overallScore ?? 5
  );
  const [reasoning, setReasoning] = useState(
    existingJudgment?.reasoning ?? ''
  );
  const [criteriaScores, setCriteriaScores] = useState<CriteriaScore[]>(
    existingJudgment?.criteriaScores ??
      criteria.map((c) => ({
        criterionId: c.id,
        criterionName: c.name,
        score: Math.round(c.maxScore / 2),
        maxScore: c.maxScore,
        weight: c.weight,
        comment: '',
      }))
  );
  const [selectedBestModelId, setSelectedBestModelId] = useState<string | null>(
    existingJudgment?.selectedBestModelId ?? null
  );

  const updateCriterionScore = (criterionId: string, score: number) => {
    setCriteriaScores((prev) =>
      prev.map((cs) =>
        cs.criterionId === criterionId ? { ...cs, score } : cs
      )
    );
  };

  const updateCriterionComment = (criterionId: string, comment: string) => {
    setCriteriaScores((prev) =>
      prev.map((cs) =>
        cs.criterionId === criterionId ? { ...cs, comment } : cs
      )
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      overallScore,
      reasoning,
      criteriaScores,
      selectedBestModelId,
    });
  };

  // Handle numeric keyboard shortcuts for quick scoring
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if typing in an input
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      ) {
        return;
      }

      const num = parseInt(e.key);
      if (num >= 1 && num <= 9 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setOverallScore(num);
      }

      if (e.key === '0' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setOverallScore(10);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-surface-900 dark:text-surface-100 mb-1">
          Your Judgment
        </h3>
        <p className="text-xs text-surface-500 dark:text-surface-400">
          Score the submission and select the best model response. Press 1-9 for quick scoring.
        </p>
      </div>

      {/* Overall Score */}
      <div className="bg-surface-50 dark:bg-surface-800 rounded-xl p-4">
        <div className="flex items-baseline justify-between mb-3">
          <span className="text-sm font-medium text-surface-700 dark:text-surface-300">
            Overall Score
          </span>
          <span
            className={cn(
              'text-2xl font-bold font-mono',
              getScoreColor(overallScore)
            )}
          >
            {overallScore}
            <span className="text-sm text-surface-400 font-normal">/10</span>
          </span>
        </div>
        <Slider
          value={overallScore}
          onChange={setOverallScore}
          min={0}
          max={10}
          step={1}
          showValue={false}
        />
      </div>

      {/* Criteria Scores */}
      {criteriaScores.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider">
            Criteria Scores
          </h4>
          {criteriaScores.map((cs) => {
            const criterion = criteria.find((c) => c.id === cs.criterionId);
            return (
              <div
                key={cs.criterionId}
                className="rounded-lg border border-surface-200 dark:border-surface-700 p-3"
              >
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-sm font-medium text-surface-700 dark:text-surface-300">
                    {cs.criterionName}
                  </span>
                  <span className="text-xs font-mono text-surface-500 dark:text-surface-400">
                    ×{cs.weight}
                  </span>
                </div>
                {criterion?.description && (
                  <p className="text-xs text-surface-400 mb-2">
                    {criterion.description}
                  </p>
                )}
                <Slider
                  value={cs.score}
                  onChange={(v) => updateCriterionScore(cs.criterionId, v)}
                  min={0}
                  max={cs.maxScore}
                  step={1}
                />
                <input
                  type="text"
                  placeholder="Optional comment..."
                  value={cs.comment || ''}
                  onChange={(e) =>
                    updateCriterionComment(cs.criterionId, e.target.value)
                  }
                  className="mt-2 w-full rounded border border-surface-200 dark:border-surface-600 bg-white dark:bg-surface-700 px-2 py-1 text-xs text-surface-600 dark:text-surface-300 placeholder:text-surface-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand-500"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Best Model Selection */}
      {modelJudgmentIds.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-surface-500 dark:text-surface-400 uppercase tracking-wider mb-2">
            Best Model Response
          </h4>
          <div className="flex flex-wrap gap-2">
            {modelJudgmentIds.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() =>
                  setSelectedBestModelId(
                    selectedBestModelId === model.id ? null : model.id
                  )
                }
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs font-medium transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  selectedBestModelId === model.id
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-400'
                    : 'border-surface-200 dark:border-surface-600 text-surface-600 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-500'
                )}
              >
                {model.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Reasoning */}
      <Textarea
        label="Reasoning"
        value={reasoning}
        onChange={(e) => setReasoning(e.target.value)}
        placeholder="Explain your judgment... What stood out? Where did models agree or disagree?"
        rows={4}
        hint="Use 1-9 for quick score"
      />

      {/* Submit */}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={loading}
      >
        {existingJudgment ? 'Update Judgment' : 'Submit Judgment'}
      </Button>
    </form>
  );
}
