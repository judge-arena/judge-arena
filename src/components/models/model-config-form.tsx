'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

/** One entry from GET /api/models/catalog. */
export interface CatalogEntry {
  judgeModelVersionId: string;
  judgeModelId: string;
  ordinal: number;
  servingBackend: string;
  quantization: string;
  trustState: string;
  name: string;
  slug: string;
  judgeClass: string;
  scoringMechanism: string;
  baseModel: string | null;
}

/** Data this form hands back to `onSubmit` — a discriminated union matching
 * `POST /api/models`'s two create shapes, or the PATCH-shaped connection-only
 * edit. `mode: 'edit'` is used both for the "Add Model" dialog's edit path
 * and standalone editing of an existing ModelEndpoint. */
export type ModelConfigFormSubmit =
  | { mode: 'catalog'; judgeModelVersionId: string; endpoint: string; apiKey: string; isActive: boolean }
  | {
      mode: 'custom';
      name: string;
      judgeClass: string;
      scoringMechanism: string;
      servingBackend: string;
      baseModel: string;
      endpoint: string;
      apiKey: string;
      isActive: boolean;
    }
  | { mode: 'edit'; endpoint: string; apiKey: string; isActive: boolean };

interface EditingSummary {
  name: string;
  servingBackend: string;
  baseModel: string | null;
  ordinal: number;
}

interface ModelConfigFormProps {
  /** Catalog to pick from — required for create mode, ignored in edit mode. */
  catalog: CatalogEntry[];
  /** When set, the form is in EDIT mode: only endpoint/apiKey/isActive are
   * editable, and `editingSummary` renders a read-only catalog header
   * instead of the catalog/custom picker (the underlying JudgeModel/Version
   * is immutable — see `/api/models/[id]`'s doc). */
  editingSummary?: EditingSummary;
  initialData?: {
    endpoint: string;
    apiKey: string;
    isActive: boolean;
  };
  onSubmit: (data: ModelConfigFormSubmit) => void;
  loading?: boolean;
  submitLabel?: string;
}

const JUDGE_CLASS_OPTIONS = [
  { value: 'prompted_api', label: 'Prompted (hosted API)' },
  { value: 'prompted_open_weight', label: 'Prompted (open-weight)' },
  { value: 'finetuned_judge_lm', label: 'Fine-tuned judge LM' },
  { value: 'sequence_classifier_rm', label: 'Sequence-classifier reward model' },
  { value: 'generative_rm', label: 'Generative reward model' },
  { value: 'specialized_safety', label: 'Specialized: safety' },
  { value: 'specialized_factuality', label: 'Specialized: factuality' },
];

const SCORING_MECHANISM_OPTIONS = [
  { value: 'critique_generative', label: 'Generative critique (text -> parsed score)' },
  { value: 'token_probability', label: 'Token probability' },
  { value: 'reward_head_scalar', label: 'Reward-head scalar' },
];

const SERVING_BACKEND_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'vllm', label: 'vLLM (self-hosted, guided decoding)' },
  { value: 'ollama', label: 'Ollama (local, respond-only — not judge-eligible)' },
];

export function ModelConfigForm({
  catalog,
  editingSummary,
  initialData,
  onSubmit,
  loading,
  submitLabel,
}: ModelConfigFormProps) {
  const isEdit = !!editingSummary;
  const [pickMode, setPickMode] = useState<'catalog' | 'custom'>('catalog');

  const [judgeModelVersionId, setJudgeModelVersionId] = useState(catalog[0]?.judgeModelVersionId ?? '');
  const [name, setName] = useState('');
  const [judgeClass, setJudgeClass] = useState(JUDGE_CLASS_OPTIONS[0].value);
  const [scoringMechanism, setScoringMechanism] = useState(SCORING_MECHANISM_OPTIONS[0].value);
  const [servingBackend, setServingBackend] = useState(SERVING_BACKEND_OPTIONS[0].value);
  const [baseModel, setBaseModel] = useState('');

  const [endpoint, setEndpoint] = useState(initialData?.endpoint ?? '');
  const [apiKey, setApiKey] = useState(initialData?.apiKey ?? '');
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  const catalogOptions = catalog.map((c) => ({
    value: c.judgeModelVersionId,
    label: `${c.name} v${c.ordinal} (${c.servingBackend})`,
  }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEdit) {
      onSubmit({ mode: 'edit', endpoint, apiKey, isActive });
      return;
    }
    if (pickMode === 'catalog') {
      if (!judgeModelVersionId) return;
      onSubmit({ mode: 'catalog', judgeModelVersionId, endpoint, apiKey, isActive });
    } else {
      onSubmit({
        mode: 'custom',
        name,
        judgeClass,
        scoringMechanism,
        servingBackend,
        baseModel,
        endpoint,
        apiKey,
        isActive,
      });
    }
  };

  const canSubmit = isEdit
    ? true
    : pickMode === 'catalog'
      ? !!judgeModelVersionId
      : !!name.trim() && !!baseModel.trim();

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {isEdit && editingSummary && (
        <div className="rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-3 py-2.5">
          <p className="text-sm font-medium text-surface-800 dark:text-surface-200">
            {editingSummary.name} <span className="text-xs text-surface-400">v{editingSummary.ordinal}</span>
          </p>
          <p className="text-xs text-surface-500 dark:text-surface-400 font-mono">
            {editingSummary.servingBackend} · {editingSummary.baseModel ?? 'no base model set'}
          </p>
          <p className="mt-1 text-2xs text-surface-400">
            The judge identity is fixed once created — only the connection below (endpoint/key/active) can be edited here.
          </p>
        </div>
      )}

      {!isEdit && (
        <>
          <div className="flex gap-2 rounded-lg border border-surface-200 dark:border-surface-700 p-1">
            <button
              type="button"
              onClick={() => setPickMode('catalog')}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                pickMode === 'catalog'
                  ? 'bg-brand-600 text-white'
                  : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700'
              }`}
            >
              Pick from catalog
            </button>
            <button
              type="button"
              onClick={() => setPickMode('custom')}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                pickMode === 'custom'
                  ? 'bg-brand-600 text-white'
                  : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700'
              }`}
            >
              Add custom model
            </button>
          </div>

          {pickMode === 'catalog' ? (
            catalog.length === 0 ? (
              <div className="rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-3 py-2 text-xs text-surface-500 dark:text-surface-400">
                No catalog entries yet — add a custom model instead.
              </div>
            ) : (
              <Select
                label="Judge model"
                options={catalogOptions}
                value={judgeModelVersionId}
                onChange={(e) => setJudgeModelVersionId(e.target.value)}
                hint="Your own endpoint/key will be created for this catalog entry."
              />
            )
          ) : (
            <>
              <Input
                label="Display name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., My fine-tuned Llama judge"
                required
              />
              <Select
                label="Judge class"
                options={JUDGE_CLASS_OPTIONS}
                value={judgeClass}
                onChange={(e) => setJudgeClass(e.target.value)}
              />
              <Select
                label="Scoring mechanism"
                options={SCORING_MECHANISM_OPTIONS}
                value={scoringMechanism}
                onChange={(e) => setScoringMechanism(e.target.value)}
              />
              <Select
                label="Serving backend"
                options={SERVING_BACKEND_OPTIONS}
                value={servingBackend}
                onChange={(e) => setServingBackend(e.target.value)}
              />
              <Input
                label="Base model id"
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value)}
                placeholder="e.g., claude-sonnet-4-5-20250514, meta-llama/Llama-3-70b"
                required
                hint="The exact model identifier used for API calls"
              />
            </>
          )}
        </>
      )}

      <Input
        label="API Endpoint"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        placeholder="http://localhost:8000/v1 (optional — leave blank for the official host)"
        hint="Custom/self-hosted endpoint. Leave blank to use the backend's default host."
      />

      <Input
        label="API Key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="Leave blank to keep the current key / use no auth"
        hint="Stored encrypted. Falls back to the server's env var for Anthropic/OpenAI with no custom endpoint."
      />

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
        />
        <span className="text-sm text-surface-700 dark:text-surface-300">
          Active (include in evaluations)
        </span>
      </label>

      <Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!canSubmit}>
        {submitLabel ?? (isEdit ? 'Save Model' : 'Add Model')}
      </Button>
    </form>
  );
}
