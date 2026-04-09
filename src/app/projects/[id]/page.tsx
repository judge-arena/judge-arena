'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { buildRubricVersionOptions, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import {
  buildDatasetRunGroups,
  getEvaluationRunCount,
  getLatestRun,
  summarizeDatasetRunGroup,
} from '@/lib/dataset-run-groups';

function toList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload &&
    Array.isArray((payload as { data: unknown }).data)
  ) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [createEvalOpen, setCreateEvalOpen] = useState(false);
  const [evalTitle, setEvalTitle] = useState('');
  const [textEvalFormat, setTextEvalFormat] = useState<'respond' | 'judge'>('respond');
  const [respondInputText, setRespondInputText] = useState('');
  const [judgePromptText, setJudgePromptText] = useState('');
  const [judgeResponseText, setJudgeResponseText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitMode, setSubmitMode] = useState<'create' | 'create_and_run' | null>(null);
  const [selectedRubricVersionId, setSelectedRubricVersionId] = useState('');
  const [allRubrics, setAllRubrics] = useState<any[]>([]);
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [quickAddModelId, setQuickAddModelId] = useState('');

  // ── Dataset mode state ──
  const [evalMode, setEvalMode] = useState<'text' | 'dataset'>('text');
  const [availableDatasets, setAvailableDatasets] = useState<any[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState('');
  const [datasetSource, setDatasetSource] = useState<'local' | 'remote'>('local');

  // ── Remote (HuggingFace) dataset state ──
  const [hfIdInput, setHfIdInput] = useState('');
  const [hfMeta, setHfMeta] = useState<any>(null);
  const [, setHfPreview] = useState<any>(null);
  const [hfFetching, setHfFetching] = useState(false);
  const [hfConfig, setHfConfig] = useState('');
  const [hfSplit, setHfSplit] = useState('');
  const [hfSampleCount, setHfSampleCount] = useState(10);
  const [hfInputColumn, setHfInputColumn] = useState('');
  const [hfExpectedColumn, setHfExpectedColumn] = useState('');
  const [hfColumns, setHfColumns] = useState<string[]>([]);
  const [hfPreviewRows, setHfPreviewRows] = useState<any[]>([]);
  const [hfFetchError, setHfFetchError] = useState('');
  const [hfPreviewError, setHfPreviewError] = useState('');

  const hfRemoteUnavailable =
    datasetSource === 'remote' &&
    Boolean(hfMeta?.serverCapabilities) &&
    !hfMeta.serverCapabilities.viewer;

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close export menu on outside click
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen]);

  const handleProjectExport = (format: 'csv' | 'jsonl', scope: 'evaluations' | 'datasets' | 'all') => {
    const url = `/api/projects/${projectId}/export?format=${format}&scope=${scope}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    const scopeLabel = scope === 'all' ? 'all data' : scope;
    toast.success(`Exporting ${scopeLabel} as ${format.toUpperCase()}…`);
  };

  const getHfConfigOptions = (meta: any): string[] => {
    const fromConfigs = Array.isArray(meta?.configs) ? meta.configs : [];
    const fromMapping = meta?.configSplits ? Object.keys(meta.configSplits) : [];
    const merged = [...fromConfigs, ...fromMapping]
      .map((value) => String(value).trim())
      .filter(Boolean);

    return [...new Set(merged)];
  };

  const getHfSplitOptions = (meta: any, config: string): string[] => {
    const fromConfig = Array.isArray(meta?.configSplits?.[config])
      ? meta.configSplits[config]
      : [];
    const fallback = Array.isArray(meta?.splits) ? meta.splits : [];
    const merged = [...(fromConfig.length ? fromConfig : []), ...fallback]
      .map((value) => String(value).trim())
      .filter(Boolean);

    return [...new Set(merged)];
  };

  const applyHfPreviewData = (data: any) => {
    setHfPreview(data);

    const featureColumns = Array.isArray(data?.features)
      ? data.features
          .map((feature: any) => feature?.name)
          .filter(
            (value: unknown): value is string =>
              typeof value === 'string' && value.trim().length > 0
          )
      : [];

    const rowColumns = Array.isArray(data?.rows)
      ? Array.from(
          new Set(
            data.rows.flatMap((item: any) =>
              item?.row && typeof item.row === 'object' ? Object.keys(item.row) : []
            )
          )
        )
      : [];

    const cols = [...new Set([...featureColumns, ...rowColumns])];

    setHfColumns(cols);
    setHfPreviewRows(Array.isArray(data?.rows) ? data.rows.map((r: any) => r.row) : []);

    const preferredInput = ['question', 'prompt', 'input', 'text', 'instruction', 'query'];
    const preferredExpected = ['answer', 'response', 'output', 'expected', 'completion', 'target', 'reference'];
    const autoInput =
      cols.find((column) => preferredInput.includes(column.toLowerCase())) ||
      cols[0] ||
      '';
    const autoExpected =
      cols.find((column) => preferredExpected.includes(column.toLowerCase())) || '';

    setHfInputColumn((current) =>
      current && cols.includes(current) ? current : autoInput
    );
    setHfExpectedColumn((current) => {
      if (!current) return autoExpected;
      return cols.includes(current) ? current : autoExpected;
    });
  };

  const handleConfigExport = (format: 'yaml' | 'json', includeSamples: boolean = false) => {
    const url = `/api/config/export?format=${format}&includeSamples=${includeSamples}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exporting configuration as ${format.toUpperCase()}…`);
  };

  const loadProject = useCallback(async () => {
    try {
      const [projectRes, rubricsRes, modelsRes, datasetsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch('/api/rubrics'),
        fetch('/api/models'),
        fetch('/api/datasets'),
      ]);

      if (projectRes.ok) {
        setProject(await projectRes.json());
      } else {
        toast.error('Project not found');
        router.push('/projects');
      }

      if (rubricsRes.ok) {
        setAllRubrics(await rubricsRes.json());
      }

      if (modelsRes.ok) {
        const models = await modelsRes.json();
        const usable = models.filter((m: any) => m.isActive && m.isVerified);
        setAvailableModels(usable);
      }

      if (datasetsRes.ok) {
        const datasets = toList(await datasetsRes.json());
        // Only show datasets that have samples
        setAvailableDatasets(datasets.filter((d: any) => (d._count?.samples ?? d.sampleCount ?? 0) > 0));
      }
    } catch {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  const datasetPickerOptions = useMemo(() => {
    const byFamily = new Map<string, any>();

    availableDatasets.forEach((dataset) => {
      const familyId = dataset.parentId ?? dataset.id;
      const existing = byFamily.get(familyId);

      if (selectedDatasetId && dataset.id === selectedDatasetId) {
        byFamily.set(familyId, dataset);
        return;
      }

      if (!existing) {
        byFamily.set(familyId, dataset);
        return;
      }

      if (selectedDatasetId && existing.id === selectedDatasetId) {
        return;
      }

      const existingVersion = existing.version ?? 1;
      const datasetVersion = dataset.version ?? 1;
      if (datasetVersion > existingVersion) {
        byFamily.set(familyId, dataset);
      }
    });

    return Array.from(byFamily.values()).sort((a, b) =>
      String(a.name ?? '').localeCompare(String(b.name ?? ''))
    );
  }, [availableDatasets, selectedDatasetId]);

  const selectedDatasetForPicker = useMemo(
    () => datasetPickerOptions.find((dataset: any) => dataset.id === selectedDatasetId) ?? null,
    [datasetPickerOptions, selectedDatasetId]
  );

  // Default rubric selection to latest available version
  useEffect(() => {
    if (allRubrics.length === 0) {
      setSelectedRubricVersionId('');
      return;
    }

    const latest = [...allRubrics].sort((a, b) => {
      const av = a.version ?? 1;
      const bv = b.version ?? 1;
      if (av !== bv) return bv - av;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })[0];

    setSelectedRubricVersionId((prev) => prev || latest?.id || '');
  }, [allRubrics]);

  // When opening the create dialog, default rubric selection to latest version
  useEffect(() => {
    if (!createEvalOpen || allRubrics.length === 0) return;
    const latest = [...allRubrics].sort((a, b) => {
      const av = a.version ?? 1;
      const bv = b.version ?? 1;
      if (av !== bv) return bv - av;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })[0];
    setSelectedRubricVersionId((prev) => prev || latest?.id || '');
  }, [createEvalOpen, allRubrics]);

  useEffect(() => {
    if (!createEvalOpen) return;
    setSelectedModelIds((prev) => {
      if (prev.length > 0) return prev;
      return availableModels.slice(0, 10).map((m: any) => m.id);
    });
  }, [createEvalOpen, availableModels]);

  const toggleModelSelection = (modelId: string) => {
    setSelectedModelIds((prev) => {
      if (prev.includes(modelId)) {
        return prev.filter((id) => id !== modelId);
      }
      if (prev.length >= 10) {
        toast.error('You can select up to 10 models');
        return prev;
      }
      return [...prev, modelId];
    });
  };

  const addModelSelection = (modelId: string) => {
    setSelectedModelIds((prev) => {
      if (prev.includes(modelId)) return prev;
      if (prev.length >= 10) {
        toast.error('You can select up to 10 models');
        return prev;
      }
      return [...prev, modelId];
    });
  };

  // ── HuggingFace dataset preview fetch ──
  const handleFetchHfDataset = async () => {
    const rawId = hfIdInput.trim();
    if (!rawId) return;

    setHfFetching(true);
    setHfFetchError('');
    setHfPreviewError('');
    setHfMeta(null);
    setHfPreview(null);
    setHfColumns([]);
    setHfPreviewRows([]);
    setHfInputColumn('');
    setHfExpectedColumn('');
    setHfConfig('');
    setHfSplit('');

    try {
      // Support both direct IDs (org/name) and full URLs — single fetch
      const isUrl = rawId.startsWith('http');
      const params = new URLSearchParams(
        isUrl ? { url: rawId } : { id: rawId }
      );
      const metaRes = await fetch(`/api/datasets/huggingface/preview?${params}`);
      if (!metaRes.ok) {
        const err = await metaRes.json().catch(() => ({}));
        const message = err.error || 'Dataset not found on HuggingFace';
        setHfFetchError(message);
        toast.error(message);
        return;
      }
      const meta = await metaRes.json();
      setHfMeta(meta);

      if (meta.serverCapabilities && !meta.serverCapabilities.viewer) {
        setHfPreviewError(
          'This HuggingFace dataset cannot be used for remote evaluation because row access is unavailable. It likely has the dataset viewer disabled or requires a custom loading script. Import it as a local dataset instead.'
        );
        return;
      }

      // Determine available configs and pick the first config
      const configs = getHfConfigOptions(meta);
      const defaultConfig = (configs.length ? configs : ['default'])[0];
      setHfConfig(defaultConfig);

      // Determine splits for the selected config
      const splitsForConfig = getHfSplitOptions(meta, defaultConfig);
      const defaultSplit = splitsForConfig[0] || 'train';
      setHfSplit(defaultSplit);

      // Fetch preview rows to discover columns
      const rowsParams = new URLSearchParams({
        id: meta.id,
        config: defaultConfig,
        split: defaultSplit,
        preview: 'true',
      });
      const rowsRes = await fetch(`/api/datasets/huggingface/rows?${rowsParams}`);
      if (rowsRes.ok) {
        const rowsData = await rowsRes.json();
        applyHfPreviewData(rowsData);
      } else {
        const err = await rowsRes.json().catch(() => ({}));
        setHfPreviewError(
          err.error ||
            'Could not fetch preview rows automatically. You can still provide config, split, and column names manually.'
        );
      }
    } catch {
      const message = 'Failed to fetch HuggingFace dataset';
      setHfFetchError(message);
      toast.error(message);
    } finally {
      setHfFetching(false);
    }
  };

  // Refetch preview rows when config/split changes
  const handleRefetchPreview = async (config: string, split: string) => {
    if (!hfMeta?.id || !config || !split) return;
    if (hfMeta?.serverCapabilities && !hfMeta.serverCapabilities.viewer) {
      setHfPreviewError(
        'Preview is unavailable because this dataset does not support HuggingFace row access.'
      );
      return;
    }
    setHfFetching(true);
    setHfPreviewError('');
    try {
      const params = new URLSearchParams({
        id: hfMeta.id,
        config,
        split,
        preview: 'true',
      });
      const res = await fetch(`/api/datasets/huggingface/rows?${params}`);
      if (res.ok) {
        const data = await res.json();
        applyHfPreviewData(data);
      } else {
        const err = await res.json().catch(() => ({}));
        const message =
          err.error ||
          `Could not load preview rows for config "${config}" and split "${split}".`;
        setHfPreviewError(message);
        toast.error(message);
      }
    } catch {
      const message = 'Failed to refresh preview';
      setHfPreviewError(message);
      toast.error(message);
    } finally {
      setHfFetching(false);
    }
  };

  const handleCreateEvaluation = async (
    runMode: 'create' | 'create_and_run'
  ) => {
    if (evalMode === 'text') {
      if (textEvalFormat === 'respond' && !respondInputText.trim()) return;
      if (textEvalFormat === 'judge' && (!judgePromptText.trim() || !judgeResponseText.trim())) return;
    }
    if (evalMode === 'dataset' && datasetSource === 'local' && !selectedDatasetId) return;
    if (evalMode === 'dataset' && datasetSource === 'remote' && (!hfMeta?.id || !hfConfig || !hfSplit || !hfInputColumn)) return;
    if (evalMode === 'dataset' && datasetSource === 'remote' && hfRemoteUnavailable) {
      toast.error(
        'This HuggingFace dataset does not expose rows through the datasets server. Import it as a local dataset to evaluate it.'
      );
      return;
    }

    setSubmitMode(runMode);
    setSubmitting(true);
    try {
      let payload: any;

      if (evalMode === 'text') {
        payload = {
          mode: 'single',
          evaluationMode: textEvalFormat,
          runMode,
          projectId,
          title: evalTitle || undefined,
          ...(textEvalFormat === 'respond'
            ? { promptText: respondInputText }
            : { promptText: judgePromptText, responseText: judgeResponseText }),
          ...(selectedRubricVersionId && { rubricId: selectedRubricVersionId }),
          modelConfigIds: selectedModelIds,
        };
      } else if (datasetSource === 'remote') {
        payload = {
          mode: 'remote-dataset',
          runMode,
          projectId,
          huggingFaceId: hfMeta.id,
          config: hfConfig,
          split: hfSplit,
          sampleCount: hfSampleCount,
          inputColumn: hfInputColumn,
          expectedColumn: hfExpectedColumn || undefined,
          inputType: hfExpectedColumn ? 'query-response' : 'query',
          ...(selectedRubricVersionId && { rubricId: selectedRubricVersionId }),
          modelConfigIds: selectedModelIds,
        };
      } else {
        payload = {
          mode: 'dataset',
          runMode,
          projectId,
          datasetId: selectedDatasetId,
          ...(selectedRubricVersionId && { rubricId: selectedRubricVersionId }),
          modelConfigIds: selectedModelIds,
        };
      }

      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const result = await res.json();
        setCreateEvalOpen(false);
        setEvalTitle('');
        setTextEvalFormat('respond');
        setRespondInputText('');
        setJudgePromptText('');
        setJudgeResponseText('');
        setSelectedModelIds([]);
        setSelectedDatasetId('');
        setEvalMode('text');
        setDatasetSource('local');
        setHfIdInput('');
        setHfMeta(null);
        setHfPreview(null);
        setHfColumns([]);
        setHfPreviewRows([]);
        setHfInputColumn('');
        setHfExpectedColumn('');
        setHfConfig('');
        setHfSplit('');
        setHfSampleCount(10);

        if (result.mode === 'dataset') {
          if (runMode === 'create_and_run') {
            toast.success(
              `Created ${result.evaluationsCreated} evaluations and queued ${result.runsQueued ?? result.evaluationsCreated} run${(result.runsQueued ?? result.evaluationsCreated) === 1 ? '' : 's'} from dataset "${result.datasetName}"`
            );
          } else {
            toast.success(`Created ${result.evaluationsCreated} evaluations from dataset "${result.datasetName}"`);
          }
          // Reload project to show new evaluations
          loadProject();
        } else {
          if (runMode === 'create_and_run') {
            toast.success('Evaluation created and run queued');
            if (result.runId) {
              router.push(`/evaluate/${result.id}/runs/${result.runId}`);
            } else {
              router.push(`/evaluate/${result.id}`);
            }
          } else {
            toast.success('Evaluation created');
            router.push(`/evaluate/${result.id}`);
          }
        }
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create evaluation');
      }
    } catch {
      toast.error('Failed to create evaluation');
    } finally {
      setSubmitting(false);
      setSubmitMode(null);
    }
  };

  if (loading) {
    return (
      <div>
        <Skeleton className="h-20 w-full" />
        <div className="p-6 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!project) return null;

  const normalizedSearch = modelSearch.trim().toLowerCase();
  const filteredAvailableModels = availableModels.filter((model: any) => {
    if (!normalizedSearch) return true;
    return (
      model.name.toLowerCase().includes(normalizedSearch) ||
      model.provider.toLowerCase().includes(normalizedSearch) ||
      model.modelId.toLowerCase().includes(normalizedSearch)
    );
  });

  const quickAddOptions = [
    { value: '', label: 'Quick add model...' },
    ...filteredAvailableModels
      .filter((model: any) => !selectedModelIds.includes(model.id))
      .map((model: any) => ({
        value: model.id,
        label: `${model.name} (${model.provider})`,
      })),
  ];

  const latestVersionByFamily = new Map<string, number>();
  for (const rubric of allRubrics) {
    const familyId = rubric.parentId ?? rubric.id;
    const version = rubric.version ?? 1;
    const current = latestVersionByFamily.get(familyId) ?? 0;
    if (version > current) latestVersionByFamily.set(familyId, version);
  }

  const datasetRunGroups = buildDatasetRunGroups(
    project.evaluations ?? [],
    project.datasets ?? []
  );
  const standaloneEvaluations = (project.evaluations ?? []).filter(
    (evaluation: any) => !evaluation.datasetId
  );

  return (
    <div>
      <Header
        title={project.name}
        description={project.description}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: project.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {/* Export dropdown */}
            {(project.evaluations ?? []).length > 0 && (
              <div className="relative" ref={exportMenuRef}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setExportMenuOpen((prev) => !prev)}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export
                </Button>
                {exportMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1 shadow-lg">
                    <p className="px-3 py-1.5 text-2xs font-semibold text-surface-400 uppercase tracking-wide">Evaluations</p>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleProjectExport('csv', 'evaluations'); setExportMenuOpen(false); }}
                    >
                      📄 Evaluations as CSV
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleProjectExport('jsonl', 'evaluations'); setExportMenuOpen(false); }}
                    >
                      📋 Evaluations as JSONL
                    </button>
                    <div className="my-1 border-t border-surface-100 dark:border-surface-700" />
                    <p className="px-3 py-1.5 text-2xs font-semibold text-surface-400 uppercase tracking-wide">Full Export</p>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleProjectExport('csv', 'all'); setExportMenuOpen(false); }}
                    >
                      📄 All data as CSV
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleProjectExport('jsonl', 'all'); setExportMenuOpen(false); }}
                    >
                      📋 All data as JSONL
                    </button>
                    <div className="my-1 border-t border-surface-100 dark:border-surface-700" />
                    <p className="px-3 py-1.5 text-2xs font-semibold text-surface-400 uppercase tracking-wide">Configuration</p>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleConfigExport('yaml'); setExportMenuOpen(false); }}
                    >
                      ⚙️ Config as YAML
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors"
                      onClick={() => { handleConfigExport('yaml', true); setExportMenuOpen(false); }}
                    >
                      ⚙️ Config + Data as YAML
                    </button>
                  </div>
                )}
              </div>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateEvalOpen(true)}
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
              New Evaluation
            </Button>
          </div>
        }
      />

      <div className="p-6">
        {/* Evaluations List */}
        {(project.evaluations ?? []).length === 0 ? (
          <EmptyState
            icon={
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            }
            title="No evaluations yet"
            description="Submit your first text for evaluation. Models will grade it using the rubric."
            action={
              <Button
                variant="primary"
                onClick={() => setCreateEvalOpen(true)}
              >
                Create Evaluation
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                Evaluations ({(project.evaluations ?? []).length})
              </h2>
            </div>

            {datasetRunGroups.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 dark:text-surface-400">
                  Dataset Runs ({datasetRunGroups.length})
                </h3>
                <div className="space-y-2">
                  {datasetRunGroups.map((group) => {
                    const summary = summarizeDatasetRunGroup(group);
                    const status = summary.aggregateStatus;
                    const needsBestSelectionCount = group.evaluations.filter((evaluation) => {
                      const latestRun = getLatestRun(evaluation);
                      return latestRun?.status === 'needs_human' && !evaluation.responseText;
                    }).length;
                    const needsFeedbackCount = group.evaluations.filter((evaluation) => {
                      const latestRun = getLatestRun(evaluation);
                      return latestRun?.status === 'needs_human' && !!evaluation.responseText;
                    }).length;
                    const statusVariant =
                      status === 'completed'
                        ? 'success'
                        : status === 'error'
                          ? 'error'
                          : status === 'judging'
                            ? 'info'
                            : 'warning';

                    return (
                      <Link
                        key={group.key}
                        href={`/projects/${projectId}/dataset-runs/${encodeURIComponent(group.key)}`}
                        className="block"
                      >
                        <Card className="hover:border-brand-300 dark:hover:border-brand-600 hover:shadow-sm transition-all cursor-pointer">
                          <CardContent className="p-4">
                            <div className="flex items-center gap-4">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 mb-1">
                                  <p className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                                    Dataset {group.datasetName}
                                  </p>
                                  <Badge variant="info" size="sm">Dataset Run</Badge>
                                  <Badge variant={statusVariant as any} size="sm">
                                    {status === 'needs_human' ? 'Needs Human Action' : status}
                                  </Badge>
                                  <Badge variant="default" size="sm">
                                    {summary.sampleCount} sample{summary.sampleCount === 1 ? '' : 's'}
                                  </Badge>
                                  {needsBestSelectionCount > 0 && (
                                    <Badge variant="warning" size="sm">
                                      {needsBestSelectionCount} select best response
                                    </Badge>
                                  )}
                                  {needsFeedbackCount > 0 && (
                                    <Badge variant="warning" size="sm">
                                      {needsFeedbackCount} need human feedback
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
                                  <span className="truncate">Started {formatDateTime(group.startedAt)}</span>
                                  <span className="inline-flex items-center rounded-full border border-surface-200 dark:border-surface-700 bg-surface-100 dark:bg-surface-700 px-2 py-0.5 text-2xs text-surface-600 dark:text-surface-400">
                                    {group.datasetId}
                                  </span>
                                </div>
                              </div>

                              <div className="flex items-center gap-3 shrink-0">
                                {summary.modelAverageAcrossSamples !== null && (
                                  <div className="text-center">
                                    <div className="text-base font-bold font-mono text-surface-800 dark:text-surface-200">
                                      {summary.modelAverageAcrossSamples.toFixed(1)}
                                    </div>
                                    <div className="text-2xs text-surface-400">Model Avg</div>
                                  </div>
                                )}
                                {summary.humanAverageAcrossSamples !== null && (
                                  <div className="text-center">
                                    <div className="text-base font-bold font-mono text-surface-800 dark:text-surface-200">
                                      {summary.humanAverageAcrossSamples.toFixed(1)}
                                    </div>
                                    <div className="text-2xs text-surface-400">Human Avg</div>
                                  </div>
                                )}
                                <svg
                                  width="16"
                                  height="16"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  className="text-surface-300"
                                >
                                  <path d="M9 18l6-6-6-6" />
                                </svg>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-surface-500 dark:text-surface-400">
                Individual Evaluations ({standaloneEvaluations.length})
              </h3>
              <div className="divide-y divide-surface-100 dark:divide-surface-700 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800">
              {standaloneEvaluations.map((evaluation: any) => (
                <Link
                  key={evaluation.id}
                  href={`/evaluate/${evaluation.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">
                        {evaluation.title || 'Untitled Evaluation'}
                      </p>
                      <Badge variant="default" size="sm">
                        {evaluation.responseText ? 'Judge' : 'Respond'}
                      </Badge>
                      {evaluation.datasetId && (
                        <Badge variant="info" size="sm">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-0.5" aria-hidden="true">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                          </svg>
                          Dataset
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-surface-400 truncate mt-0.5">
                      {formatDateTime(evaluation.createdAt)} · {evaluation.inputText?.length?.toLocaleString()} chars
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {evaluation.rubric && (
                      <Badge variant="info" size="sm">
                        {evaluation.rubric.name} v{evaluation.rubric.version ?? 1}
                        {(latestVersionByFamily.get(
                          evaluation.rubric.parentId ?? evaluation.rubric.id
                        ) ?? (evaluation.rubric.version ?? 1)) ===
                        (evaluation.rubric.version ?? 1)
                          ? ' (latest)'
                          : ''}
                      </Badge>
                    )}
                    {(() => {
                      const latestRun = getLatestRun(evaluation);
                      const runCount = getEvaluationRunCount(evaluation);
                      const mode: 'respond' | 'judge' = evaluation.responseText ? 'judge' : 'respond';
                      const statusLabel = latestRun
                        ? latestRun.status === 'needs_human'
                          ? mode === 'respond'
                            ? 'Select Best Response'
                            : 'Needs Human Feedback'
                          : latestRun.status
                        : null;
                      return (
                        <>
                          <Badge variant="default" size="sm">
                            {runCount} run{runCount === 1 ? '' : 's'}
                          </Badge>
                          {latestRun && (
                            <Badge
                              variant={
                                latestRun.status === 'completed'
                                  ? 'success'
                                  : latestRun.status === 'error'
                                    ? 'error'
                                    : latestRun.status === 'judging'
                                      ? 'info'
                                      : latestRun.status === 'needs_human'
                                        ? 'warning'
                                        : 'warning'
                              }
                              size="sm"
                            >
                              {statusLabel}
                            </Badge>
                          )}
                        </>
                      );
                    })()}
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-surface-300"
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </div>
                </Link>
              ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Create Evaluation Dialog */}
      <Dialog open={createEvalOpen} onOpenChange={setCreateEvalOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>New Evaluation</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-4">
              {/* ── Source toggle: Text vs Dataset ── */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-surface-700 dark:text-surface-300">Evaluation Source</label>
                <div className="flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setEvalMode('text')}
                    className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                      evalMode === 'text'
                        ? 'bg-brand-600 text-white'
                        : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                    }`}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                      </svg>
                      Text to Evaluate
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEvalMode('dataset')}
                    className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors border-l border-surface-200 dark:border-surface-700 ${
                      evalMode === 'dataset'
                        ? 'bg-brand-600 text-white'
                        : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                    }`}
                  >
                    <span className="flex items-center justify-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                        <ellipse cx="12" cy="5" rx="9" ry="3" />
                        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                      </svg>
                      Dataset to Evaluate
                    </span>
                  </button>
                </div>
              </div>

              {/* ── Text-mode: title + textarea ── */}
              {evalMode === 'text' && (
                <>
                  <Input
                    label="Title (optional)"
                    value={evalTitle}
                    onChange={(e) => setEvalTitle(e.target.value)}
                    placeholder="e.g., PR #42 Code Review"
                    autoFocus
                  />

                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300">Evaluation Format</label>
                    <div className="flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setTextEvalFormat('respond')}
                        className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                          textEvalFormat === 'respond'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                        }`}
                      >
                        Respond + Human Judgment
                      </button>
                      <button
                        type="button"
                        onClick={() => setTextEvalFormat('judge')}
                        className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors border-l border-surface-200 dark:border-surface-700 ${
                          textEvalFormat === 'judge'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                        }`}
                      >
                        Judge Existing Response
                      </button>
                    </div>
                    <p className="text-xs text-surface-500 dark:text-surface-400">
                      Respond mode: models generate answers and humans pick the best one. Judge mode: models score an existing response against the rubric.
                    </p>
                  </div>
                </>
              )}

              {/* ── Dataset-mode: local vs remote sub-toggle + pickers ── */}
              {evalMode === 'dataset' && (
                <div className="space-y-3">
                  {/* Sub-toggle: Local vs Remote */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300">Dataset Source</label>
                    <div className="flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setDatasetSource('local')}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors ${
                          datasetSource === 'local'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                        }`}
                      >
                        <span className="flex items-center justify-center gap-1.5">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                          </svg>
                          Local Dataset
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDatasetSource('remote')}
                        className={`flex-1 px-3 py-2 text-sm font-medium transition-colors border-l border-surface-200 dark:border-surface-700 ${
                          datasetSource === 'remote'
                            ? 'bg-brand-600 text-white'
                            : 'bg-white dark:bg-surface-800 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:hover:bg-surface-700'
                        }`}
                      >
                        <span className="flex items-center justify-center gap-1.5">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
                            <path d="M3.6 9h16.8" />
                            <path d="M3.6 15h16.8" />
                            <path d="M12 3a15.3 15.3 0 0 1 4 9 15.3 15.3 0 0 1-4 9 15.3 15.3 0 0 1-4-9 15.3 15.3 0 0 1 4-9z" />
                          </svg>
                          HuggingFace
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* ── Local dataset picker ── */}
                  {datasetSource === 'local' && (
                    <>
                      <Select
                        label="Dataset"
                        value={selectedDatasetId}
                        onChange={(e) => setSelectedDatasetId(e.target.value)}
                        options={[
                          { value: '', label: 'Select a dataset...' },
                          ...datasetPickerOptions.map((d: any) => ({
                            value: d.id,
                            label: `${d.name} (${d._count?.samples ?? d.sampleCount ?? '?'} samples)${d.version ? ` · v${d.version}` : ''}`,
                          })),
                        ]}
                        hint="Each sample in the dataset will become a separate evaluation"
                      />
                      {selectedDatasetId && (() => {
                        const ds = selectedDatasetForPicker;
                        if (!ds) return null;
                        const count = ds._count?.samples ?? ds.sampleCount ?? 0;
                        return (
                          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
                            <p className="font-medium mb-1">Dataset: {ds.name}{ds.version ? ` (v${ds.version})` : ''}</p>
                            {ds.description && <p className="text-blue-700 dark:text-blue-400 mb-1">{ds.description}</p>}
                            <p>
                              This will create <span className="font-bold">{count} evaluation{count !== 1 ? 's' : ''}</span>
                              {' '}— one per dataset sample.
                            </p>
                          </div>
                        );
                      })()}
                      {datasetPickerOptions.length === 0 && (
                        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
                          No datasets with samples available.{' '}
                          <a href="/datasets" className="underline font-medium hover:text-amber-900 dark:hover:text-amber-200">
                            Create a dataset first
                          </a>.
                        </div>
                      )}
                    </>
                  )}

                  {/* ── Remote (HuggingFace) dataset ── */}
                  {datasetSource === 'remote' && (
                    <div className="space-y-3">
                      {/* HF Dataset ID input */}
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                          HuggingFace Dataset
                        </label>
                        <div className="flex gap-2">
                          <div className="flex-1">
                            <Input
                              value={hfIdInput}
                              onChange={(e) => setHfIdInput(e.target.value)}
                              placeholder="e.g. tatsu-lab/alpaca or https://huggingface.co/datasets/..."
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleFetchHfDataset();
                                }
                              }}
                            />
                          </div>
                          <Button
                            variant="secondary"
                            onClick={handleFetchHfDataset}
                            loading={hfFetching}
                            disabled={!hfIdInput.trim() || hfFetching}
                          >
                            {hfFetching ? 'Fetching...' : 'Fetch'}
                          </Button>
                        </div>
                        <p className="text-xs text-surface-500 dark:text-surface-400">
                          Enter a HuggingFace dataset ID (org/name) or full URL
                        </p>
                      </div>

                      {/* Dataset metadata preview */}
                      {hfMeta && (
                        <div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20 p-3 space-y-3">
                          <div>
                            <p className="text-sm font-semibold text-purple-900 dark:text-purple-200">
                              {hfMeta.id}
                            </p>
                            {hfMeta.description && (
                              <p className="text-xs text-purple-700 dark:text-purple-400 mt-0.5 line-clamp-2">
                                {hfMeta.description}
                              </p>
                            )}
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {hfMeta.sampleCount != null && (
                                <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-800/50 px-2 py-0.5 text-2xs font-medium text-purple-700 dark:text-purple-300">
                                  {hfMeta.sampleCount.toLocaleString()} total samples
                                </span>
                              )}
                              <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-800/50 px-2 py-0.5 text-2xs font-medium text-purple-700 dark:text-purple-300">
                                {hfMeta.downloads?.toLocaleString()} downloads
                              </span>
                              <span className="inline-flex items-center rounded-full bg-purple-100 dark:bg-purple-800/50 px-2 py-0.5 text-2xs font-medium text-purple-700 dark:text-purple-300">
                                {hfMeta.likes?.toLocaleString()} likes
                              </span>
                              {hfMeta.serverCapabilities && !hfMeta.serverCapabilities.viewer && (
                                <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-2xs font-medium text-amber-800 dark:text-amber-300">
                                  Viewer disabled
                                </span>
                              )}
                              {hfMeta.hasDatasetScript && (
                                <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 px-2 py-0.5 text-2xs font-medium text-amber-800 dark:text-amber-300">
                                  Uses dataset script
                                </span>
                              )}
                            </div>
                          </div>

                          {hfFetchError && (
                            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
                              {hfFetchError}
                            </div>
                          )}

                          {/* Config + Split selectors */}
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {getHfConfigOptions(hfMeta).length > 0 ? (
                              <Select
                                label="Config"
                                value={hfConfig}
                                onChange={(e) => {
                                  const newConfig = e.target.value;
                                  const nextSplits = getHfSplitOptions(hfMeta, newConfig);
                                  const newSplit = nextSplits.includes(hfSplit)
                                    ? hfSplit
                                    : nextSplits[0] || '';
                                  setHfConfig(newConfig);
                                  setHfSplit(newSplit);
                                  if (newConfig && newSplit) {
                                    handleRefetchPreview(newConfig, newSplit);
                                  }
                                }}
                                options={getHfConfigOptions(hfMeta).map((c) => ({
                                  value: c,
                                  label: c,
                                }))}
                                hint="Auto-detected from HuggingFace"
                              />
                            ) : (
                              <Input
                                label="Config"
                                value={hfConfig}
                                onChange={(e) => setHfConfig(e.target.value)}
                                placeholder="Enter config manually (for example: default)"
                              />
                            )}

                            {getHfSplitOptions(hfMeta, hfConfig).length > 0 ? (
                              <Select
                                label="Split"
                                value={hfSplit}
                                onChange={(e) => {
                                  const newSplit = e.target.value;
                                  setHfSplit(newSplit);
                                  if (hfConfig && newSplit) {
                                    handleRefetchPreview(hfConfig, newSplit);
                                  }
                                }}
                                options={getHfSplitOptions(hfMeta, hfConfig).map((s) => ({
                                  value: s,
                                  label: s,
                                }))}
                                hint="Filtered to the selected config when available"
                              />
                            ) : (
                              <Input
                                label="Split"
                                value={hfSplit}
                                onChange={(e) => setHfSplit(e.target.value)}
                                placeholder="Enter split manually (for example: train)"
                              />
                            )}
                          </div>

                          <div className="flex items-center justify-between gap-3 rounded-md border border-surface-200 bg-white/70 px-3 py-2 text-xs text-surface-600 dark:border-surface-700 dark:bg-surface-900/30 dark:text-surface-300">
                            <span>
                              If config or split detection is incomplete, enter them manually and refresh the preview.
                            </span>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleRefetchPreview(hfConfig, hfSplit)}
                              disabled={!hfConfig || !hfSplit || hfFetching || hfRemoteUnavailable}
                            >
                              Refresh Preview
                            </Button>
                          </div>

                          {hfPreviewError && (
                            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                              {hfPreviewError}
                            </div>
                          )}

                          {/* Sample count */}
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                              Number of Samples
                            </label>
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min={1}
                                max={Math.min(hfMeta.sampleCount || 500, 500)}
                                value={hfSampleCount}
                                onChange={(e) => setHfSampleCount(parseInt(e.target.value, 10))}
                                className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-surface-200 dark:bg-surface-700 accent-brand-600"
                              />
                              <input
                                type="number"
                                min={1}
                                max={Math.min(hfMeta.sampleCount || 500, 500)}
                                value={hfSampleCount}
                                onChange={(e) => {
                                  const v = parseInt(e.target.value, 10);
                                  if (!isNaN(v) && v >= 1 && v <= 500) setHfSampleCount(v);
                                }}
                                className="w-20 rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 px-2 py-1 text-sm text-center text-surface-900 dark:text-surface-100"
                              />
                            </div>
                            <p className="text-xs text-surface-500 dark:text-surface-400">
                              {hfSampleCount} sample{hfSampleCount !== 1 ? 's' : ''} will be fetched and evaluated
                              {hfMeta.sampleCount ? ` (out of ${hfMeta.sampleCount.toLocaleString()} available)` : ''}
                            </p>
                          </div>

                          {/* Column mapping */}
                          <div className="space-y-2">
                            <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                              Column Mapping
                            </label>
                            {hfColumns.length > 0 ? (
                              <div className="grid grid-cols-2 gap-2">
                                <Select
                                  label="Input Column"
                                  value={hfInputColumn}
                                  onChange={(e) => setHfInputColumn(e.target.value)}
                                  options={hfColumns.map((c: string) => ({
                                    value: c,
                                    label: c,
                                  }))}
                                  hint="Column used as the evaluation input or prompt"
                                />
                                <Select
                                  label="Expected Column (optional)"
                                  value={hfExpectedColumn}
                                  onChange={(e) => setHfExpectedColumn(e.target.value)}
                                  options={[
                                    { value: '', label: 'None (respond mode)' },
                                    ...hfColumns.map((c: string) => ({
                                      value: c,
                                      label: c,
                                    })),
                                  ]}
                                  hint="Reference answer for judge mode"
                                />
                              </div>
                            ) : (
                              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                <Input
                                  label="Input Column"
                                  value={hfInputColumn}
                                  onChange={(e) => setHfInputColumn(e.target.value)}
                                  placeholder="Enter the prompt/input column"
                                />
                                <Input
                                  label="Expected Column (optional)"
                                  value={hfExpectedColumn}
                                  onChange={(e) => setHfExpectedColumn(e.target.value)}
                                  placeholder="Enter the reference/expected column"
                                />
                              </div>
                            )}
                            <p className="text-xs text-surface-500 dark:text-surface-400">
                              {hfExpectedColumn
                                ? 'Judge mode: models will score the expected output against the rubric.'
                                : 'Respond mode: models will generate responses, then humans pick the best one.'}
                            </p>
                          </div>

                          {/* Preview table */}
                          {hfPreviewRows.length > 0 && hfInputColumn && (
                            <div className="space-y-1.5">
                              <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                                Sample Preview
                              </label>
                              <div className="max-h-36 overflow-auto rounded-md border border-surface-200 dark:border-surface-700">
                                <table className="w-full text-xs">
                                  <thead className="bg-surface-50 dark:bg-surface-800 sticky top-0">
                                    <tr>
                                      <th className="px-2 py-1.5 text-left font-medium text-surface-600 dark:text-surface-400">#</th>
                                      <th className="px-2 py-1.5 text-left font-medium text-surface-600 dark:text-surface-400">
                                        {hfInputColumn}
                                      </th>
                                      {hfExpectedColumn && (
                                        <th className="px-2 py-1.5 text-left font-medium text-surface-600 dark:text-surface-400">
                                          {hfExpectedColumn}
                                        </th>
                                      )}
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-surface-100 dark:divide-surface-700">
                                    {hfPreviewRows.slice(0, 3).map((row: any, idx: number) => (
                                      <tr key={idx} className="hover:bg-surface-50 dark:hover:bg-surface-700/50">
                                        <td className="px-2 py-1 text-surface-400 whitespace-nowrap">{idx + 1}</td>
                                        <td className="px-2 py-1 text-surface-800 dark:text-surface-200 max-w-xs truncate">
                                          {String(row[hfInputColumn] ?? '').slice(0, 200)}
                                        </td>
                                        {hfExpectedColumn && (
                                          <td className="px-2 py-1 text-surface-800 dark:text-surface-200 max-w-xs truncate">
                                            {String(row[hfExpectedColumn] ?? '').slice(0, 200)}
                                          </td>
                                        )}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <Select
                label="Rubric Version"
                value={selectedRubricVersionId}
                onChange={(e) => setSelectedRubricVersionId(e.target.value)}
                options={[
                  { value: '', label: 'No rubric (human-only evaluation)' },
                  ...buildRubricVersionOptions(allRubrics),
                ]}
                hint="Choose which rubric version to use for this evaluation"
              />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                    Models for this Evaluation
                  </label>
                  <span className="text-xs text-surface-500 dark:text-surface-400">
                    {selectedModelIds.length}/10 selected
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <Input
                    label="Search models"
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="Search by name, provider, or model ID"
                  />
                  <Select
                    label="Quick add"
                    value={quickAddModelId}
                    onChange={(e) => {
                      const modelId = e.target.value;
                      if (!modelId) return;
                      addModelSelection(modelId);
                      setQuickAddModelId('');
                    }}
                    options={quickAddOptions}
                  />
                </div>

                {availableModels.length === 0 ? (
                  <div className="rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-3 py-2 text-xs text-surface-500 dark:text-surface-400">
                    No verified active models available. You can still create a human-only evaluation.
                  </div>
                ) : (
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 divide-y divide-surface-100 dark:divide-surface-700">
                    {filteredAvailableModels.map((model: any) => {
                      const selected = selectedModelIds.includes(model.id);
                      return (
                        <label
                          key={model.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-surface-800 dark:text-surface-200 truncate">
                              {model.name}
                            </p>
                            <p className="text-xs text-surface-500 dark:text-surface-400 truncate">
                              {model.provider} · {model.modelId}
                            </p>
                          </div>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleModelSelection(model.id)}
                            className="rounded border-surface-300 dark:border-surface-600 text-brand-600 focus:ring-brand-500"
                          />
                        </label>
                      );
                    })}
                    {filteredAvailableModels.length === 0 && (
                      <div className="px-3 py-2 text-xs text-surface-500 dark:text-surface-400">
                        No models match your search.
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-surface-500 dark:text-surface-400">
                  Select 0 models for human-only evaluation, or up to 10 models.
                </p>
              </div>

              {/* ── Text input (only in text mode) ── */}
              {evalMode === 'text' && (
                <>
                  {textEvalFormat === 'respond' ? (
                    <Textarea
                      label="Input Prompt"
                      value={respondInputText}
                      onChange={(e) => setRespondInputText(e.target.value)}
                      placeholder="Enter the prompt/input. Models will generate responses, then humans select the best one."
                      rows={10}
                      required
                      hint="Models generate responses in run mode; human judges choose the best response."
                    />
                  ) : (
                    <div className="space-y-3">
                      <Textarea
                        label="Prompt (Input)"
                        value={judgePromptText}
                        onChange={(e) => setJudgePromptText(e.target.value)}
                        placeholder="Enter the original prompt/input..."
                        rows={6}
                        required
                      />
                      <Textarea
                        label="Response to Judge (Output)"
                        value={judgeResponseText}
                        onChange={(e) => setJudgeResponseText(e.target.value)}
                        placeholder="Enter the response/output to be scored against the rubric..."
                        rows={8}
                        required
                        hint="Models score this response against the selected rubric; human can add feedback."
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setCreateEvalOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => handleCreateEvaluation('create')}
              loading={submitting && submitMode === 'create'}
              disabled={
                submitting ||
                (evalMode === 'text'
                  ? (textEvalFormat === 'respond'
                      ? !respondInputText.trim()
                      : !judgePromptText.trim() || !judgeResponseText.trim())
                  : datasetSource === 'remote'
                    ? !hfMeta?.id || !hfConfig || !hfSplit || !hfInputColumn || hfRemoteUnavailable
                    : !selectedDatasetId)
              }
            >
              {evalMode === 'dataset' && datasetSource === 'remote'
                ? `Create ${hfSampleCount} Evaluation${hfSampleCount !== 1 ? 's' : ''}`
                : evalMode === 'dataset'
                  ? `Create ${
                      selectedDatasetId
                        ? `${availableDatasets.find((d: any) => d.id === selectedDatasetId)?._count?.samples ?? availableDatasets.find((d: any) => d.id === selectedDatasetId)?.sampleCount ?? ''} `
                        : ''
                    }Evaluation${selectedDatasetId && (availableDatasets.find((d: any) => d.id === selectedDatasetId)?._count?.samples ?? 0) !== 1 ? 's' : ''}`
                  : 'Create'}
            </Button>
            <Button
              variant="primary"
              onClick={() => handleCreateEvaluation('create_and_run')}
              loading={submitting && submitMode === 'create_and_run'}
              disabled={
                submitting ||
                (evalMode === 'text'
                  ? (textEvalFormat === 'respond'
                      ? !respondInputText.trim()
                      : !judgePromptText.trim() || !judgeResponseText.trim())
                  : datasetSource === 'remote'
                    ? !hfMeta?.id || !hfConfig || !hfSplit || !hfInputColumn || hfRemoteUnavailable
                    : !selectedDatasetId)
              }
            >
              {evalMode === 'dataset' && datasetSource === 'remote'
                ? `Create & Run ${hfSampleCount} Evaluation${hfSampleCount !== 1 ? 's' : ''}`
                : evalMode === 'dataset'
                  ? `Create & Run ${
                      selectedDatasetId
                        ? `${availableDatasets.find((d: any) => d.id === selectedDatasetId)?._count?.samples ?? availableDatasets.find((d: any) => d.id === selectedDatasetId)?.sampleCount ?? ''} `
                        : ''
                    }Evaluation${selectedDatasetId && (availableDatasets.find((d: any) => d.id === selectedDatasetId)?._count?.samples ?? 0) !== 1 ? 's' : ''}`
                  : 'Create & Run'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
