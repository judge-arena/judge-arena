'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { TooltipIcon } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface CriterionData {
  name: string;
  description: string;
  maxScore: number;
  weight: number;
}

interface RubricBuilderProps {
  initialName?: string;
  initialDescription?: string;
  initialCriteria?: CriterionData[];
  onSubmit: (data: {
    name: string;
    description: string;
    criteria: CriterionData[];
  }) => void | Promise<void>;
  onSubmitIntent?: (
    data: {
      name: string;
      description: string;
      criteria: CriterionData[];
    },
    intent: string
  ) => void | Promise<void>;
  loading?: boolean;
  secondaryLoading?: boolean;
  cancelLoading?: boolean;
  submitLabel?: string;
  secondarySubmitLabel?: string;
  secondarySubmitIntent?: string;
  submitIntent?: string;
  onCancel?: () => void;
}

function FieldLabel({
  htmlFor,
  label,
  tooltip,
  required,
}: {
  htmlFor?: string;
  label: string;
  tooltip?: string;
  required?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <label
        htmlFor={htmlFor}
        className="text-sm font-medium text-surface-700 select-none"
      >
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {tooltip && <TooltipIcon content={tooltip} />}
    </div>
  );
}

export function RubricBuilder({
  initialName = '',
  initialDescription = '',
  initialCriteria,
  onSubmit,
  onSubmitIntent,
  loading,
  secondaryLoading,
  cancelLoading,
  submitLabel = 'Create Rubric',
  secondarySubmitLabel,
  secondarySubmitIntent = 'secondary',
  submitIntent = 'primary',
  onCancel,
}: RubricBuilderProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [criteria, setCriteria] = useState<CriterionData[]>(
    initialCriteria ?? [
      { name: '', description: '', maxScore: 10, weight: 1 },
    ]
  );

  const addCriterion = () => {
    setCriteria([
      ...criteria,
      { name: '', description: '', maxScore: 10, weight: 1 },
    ]);
  };

  const removeCriterion = (index: number) => {
    if (criteria.length <= 1) return;
    setCriteria(criteria.filter((_, i) => i !== index));
  };

  const updateCriterion = (
    index: number,
    field: keyof CriterionData,
    value: string | number
  ) => {
    setCriteria(
      criteria.map((c, i) => (i === index ? { ...c, [field]: value } : c))
    );
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const payload = { name, description, criteria };
    const submitter = (e.nativeEvent as SubmitEvent).submitter as
      | HTMLButtonElement
      | undefined;
    const intent = submitter?.value || submitIntent;

    if (onSubmitIntent) {
      await onSubmitIntent(payload, intent);
      return;
    }

    await onSubmit(payload);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* ── Rubric header ── */}
      <div className="space-y-4">
        <div>
          <FieldLabel
            htmlFor="rubric-name"
            label="Rubric Name"
            required
            tooltip="A short, descriptive title for this rubric. Appears as a label when selecting rubrics for a project — e.g. 'Code Quality Assessment'."
          />
          <Input
            id="rubric-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Code Quality Assessment"
            required
          />
        </div>

        <div>
          <FieldLabel
            htmlFor="rubric-description"
            label="Description"
            tooltip="Provides evaluators context about this rubric's purpose. This text is also prepended to the LLM judge's system prompt, so describe the type of content being graded and what 'good' looks like at a high level."
          />
          <Textarea
            id="rubric-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the purpose and scope of this rubric, e.g. 'Assess the quality of prose writing for clarity, correctness, and reader engagement…'"
            rows={2}
          />
        </div>
      </div>

      {/* ── Criteria ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-surface-700">
              Criteria ({criteria.length})
            </h3>
            <TooltipIcon
              content="Each criterion is an independent dimension of quality. The LLM judge scores submissions on every criterion individually; a weighted average produces the final score."
              side="right"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addCriterion}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Criterion
          </Button>
        </div>

        <div className="space-y-3">
          {criteria.map((criterion, index) => (
            <div
              key={index}
              className={cn(
                'rounded-xl border border-surface-200 bg-surface-50 p-4 space-y-3',
                'transition-colors hover:border-surface-300'
              )}
            >
              {/* Badge + remove */}
              <div className="flex items-center justify-between">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold">
                  {index + 1}
                </span>
                {criteria.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeCriterion(index)}
                    className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    aria-label={`Remove criterion ${index + 1}`}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Criterion name */}
              <div>
                <FieldLabel
                  htmlFor={`criterion-name-${index}`}
                  label="Name"
                  required
                  tooltip="A concise label for this dimension of quality — 1 to 3 words (e.g. 'Accuracy', 'Clarity', 'Depth'). Shown in score breakdowns and summary tables."
                />
                <Input
                  id={`criterion-name-${index}`}
                  placeholder="e.g., Accuracy"
                  value={criterion.name}
                  onChange={(e) => updateCriterion(index, 'name', e.target.value)}
                  required
                />
              </div>

              {/* Scoring guide (description) */}
              <div>
                <FieldLabel
                  htmlFor={`criterion-desc-${index}`}
                  label="Scoring Guide"
                  required
                  tooltip="Explain precisely what the judge should evaluate and how to assign scores. Describe what a low, medium, and high score looks like. This text is sent verbatim to the LLM judge — the more specific, the more consistent the results."
                />
                <Textarea
                  id={`criterion-desc-${index}`}
                  placeholder="Describe what constitutes a low, mid, and high score for this criterion…"
                  value={criterion.description}
                  onChange={(e) =>
                    updateCriterion(index, 'description', e.target.value)
                  }
                  rows={3}
                  required
                  className="text-sm"
                />
              </div>

              {/* Max score + Weight */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel
                    htmlFor={`criterion-max-${index}`}
                    label="Max Score"
                    tooltip="The ceiling for raw scores on this criterion. Scores are normalized when computing the weighted average, so this just sets the scale — e.g. 0–10 or 0–100."
                  />
                  <Input
                    id={`criterion-max-${index}`}
                    type="number"
                    min={1}
                    max={100}
                    value={criterion.maxScore}
                    onChange={(e) =>
                      updateCriterion(
                        index,
                        'maxScore',
                        parseInt(e.target.value) || 10
                      )
                    }
                  />
                </div>
                <div>
                  <FieldLabel
                    htmlFor={`criterion-weight-${index}`}
                    label="Weight"
                    tooltip="Relative importance of this criterion. A weight of 2.0 counts twice as much as 1.0 in the final score. Leave all weights at 1.0 for equal weighting across criteria."
                  />
                  <Input
                    id={`criterion-weight-${index}`}
                    type="number"
                    min={0}
                    max={10}
                    step={0.1}
                    value={criterion.weight}
                    onChange={(e) =>
                      updateCriterion(
                        index,
                        'weight',
                        parseFloat(e.target.value) || 1
                      )
                    }
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            onClick={onCancel}
            loading={cancelLoading}
          >
            Cancel
          </Button>
        )}

        {secondarySubmitLabel && (
          <Button
            type="submit"
            variant="outline"
            value={secondarySubmitIntent}
            loading={secondaryLoading}
            disabled={!name || criteria.some((c) => !c.name || !c.description)}
          >
            {secondarySubmitLabel}
          </Button>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className={secondarySubmitLabel || onCancel ? '' : 'w-full'}
          value={submitIntent}
          loading={loading}
          disabled={!name || criteria.some((c) => !c.name || !c.description)}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
