'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
  }) => void;
  loading?: boolean;
  submitLabel?: string;
}

export function RubricBuilder({
  initialName = '',
  initialDescription = '',
  initialCriteria,
  onSubmit,
  loading,
  submitLabel = 'Create Rubric',
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, description, criteria });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-4">
        <Input
          label="Rubric Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Code Quality Assessment"
          required
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the purpose and scope of this rubric..."
          rows={2}
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-surface-700">
            Criteria ({criteria.length})
          </h3>
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
              <div className="flex items-start justify-between gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-brand-700 text-xs font-semibold mt-0.5">
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

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Input
                  placeholder="Criterion name"
                  value={criterion.name}
                  onChange={(e) =>
                    updateCriterion(index, 'name', e.target.value)
                  }
                  required
                />
                <div className="flex gap-2">
                  <Input
                    placeholder="Max"
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
                    className="w-20"
                  />
                  <Input
                    placeholder="Weight"
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
                    className="w-20"
                  />
                </div>
              </div>

              <Textarea
                placeholder="Describe what this criterion evaluates..."
                value={criterion.description}
                onChange={(e) =>
                  updateCriterion(index, 'description', e.target.value)
                }
                rows={2}
                required
                className="text-sm"
              />
            </div>
          ))}
        </div>
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={loading}
        disabled={!name || criteria.some((c) => !c.name || !c.description)}
      >
        {submitLabel}
      </Button>
    </form>
  );
}
