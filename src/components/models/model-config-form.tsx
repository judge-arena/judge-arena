'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

interface ModelConfigFormProps {
  initialData?: {
    name: string;
    provider: string;
    modelId: string;
    endpoint: string;
    apiKey: string;
    isActive: boolean;
  };
  onSubmit: (data: {
    name: string;
    provider: string;
    modelId: string;
    endpoint: string;
    apiKey: string;
    isActive: boolean;
  }) => void;
  loading?: boolean;
  submitLabel?: string;
}

const providerOptions = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT)' },
  { value: 'local', label: 'Local / Self-Hosted' },
];

const presetModels: Record<string, Array<{ value: string; label: string }>> = {
  anthropic: [
    { value: 'claude-sonnet-4-5-20250514', label: 'Claude Sonnet 4.5' },
    { value: 'claude-sonnet-4-6-20250627', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-5-20250630', label: 'Claude Opus 4.5' },
    { value: 'claude-haiku-3-5-20241022', label: 'Claude Haiku 3.5' },
    { value: 'custom', label: 'Custom Model ID...' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'o1', label: 'o1' },
    { value: 'o3-mini', label: 'o3-mini' },
    { value: 'custom', label: 'Custom Model ID...' },
  ],
  local: [
    { value: 'custom', label: 'Enter Model ID...' },
  ],
};

export function ModelConfigForm({
  initialData,
  onSubmit,
  loading,
  submitLabel = 'Add Model',
}: ModelConfigFormProps) {
  const [provider, setProvider] = useState(initialData?.provider || 'anthropic');
  const [modelPreset, setModelPreset] = useState('custom');
  const [modelId, setModelId] = useState(initialData?.modelId || '');
  const [name, setName] = useState(initialData?.name || '');
  const [endpoint, setEndpoint] = useState(initialData?.endpoint || '');
  const [apiKey, setApiKey] = useState(initialData?.apiKey || '');
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    setModelPreset('custom');
    setModelId('');
    setEndpoint(newProvider === 'local' ? 'http://localhost:11434/v1' : '');
  };

  const handlePresetChange = (preset: string) => {
    setModelPreset(preset);
    if (preset !== 'custom') {
      setModelId(preset);
      // Auto-set name from preset label
      const presetItem = presetModels[provider]?.find((m) => m.value === preset);
      if (presetItem && !name) {
        setName(presetItem.label);
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name || modelId,
      provider,
      modelId,
      endpoint,
      apiKey,
      isActive,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Select
        label="Provider"
        options={providerOptions}
        value={provider}
        onChange={(e) => handleProviderChange(e.target.value)}
      />

      {presetModels[provider] && (
        <Select
          label="Model"
          options={presetModels[provider]}
          value={modelPreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          placeholder="Select a model..."
        />
      )}

      {(modelPreset === 'custom' || provider === 'local') && (
        <Input
          label="Model ID"
          value={modelId}
          onChange={(e) => setModelId(e.target.value)}
          placeholder={
            provider === 'local'
              ? 'e.g., llama3, mistral, codestral'
              : 'e.g., claude-sonnet-4-5-20250514'
          }
          required
          hint="The exact model identifier used for API calls"
        />
      )}

      <Input
        label="Display Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g., Claude Sonnet 4.5"
        hint="Friendly name shown in the UI"
      />

      {provider === 'local' && (
        <Input
          label="API Endpoint"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="http://localhost:11434/v1"
          hint="OpenAI-compatible API endpoint (Ollama, vLLM, llama.cpp, LM Studio)"
        />
      )}

      <Input
        label="API Key"
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={
          provider === 'local'
            ? 'Optional for local models'
            : 'Overrides environment variable'
        }
        hint={
          provider === 'local'
            ? 'Leave blank for local models that don\'t require authentication'
            : 'Leave blank to use the environment variable'
        }
      />

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
        />
        <span className="text-sm text-surface-700">
          Active (include in evaluations)
        </span>
      </label>

      <Button
        type="submit"
        variant="primary"
        className="w-full"
        loading={loading}
        disabled={!modelId}
      >
        {submitLabel}
      </Button>
    </form>
  );
}
