'use client';

import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface DatasetListItem {
  id: string;
  name: string;
  description: string | null;
  source: string;
  visibility: string;
  inputType: string;
  version: number;
  parentId: string | null;
  sourceUrl: string | null;
  huggingFaceId: string | null;
  sampleCount: number | null;
  format?: string | null;
  tags: string | null;
  splits: string | null;
  remoteMetadata?: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string | null; email: string };
  _count: { samples: number };
}

interface DatasetEvaluationSummaryView {
  updatedAt?: string;
  sampleCount?: number;
  samplesWithModelScores?: number;
  samplesWithHumanScores?: number;
  averageModelScore?: number | null;
  averageHumanScore?: number | null;
}

interface HFPreview {
  id: string;
  name: string;
  author: string;
  description: string;
  downloads: number;
  likes: number;
  tags: string[];
  splits: string[];
  sampleCount: number | null;
  configs: string[];
}

interface LocalSamplePayload {
  input: string;
  expected?: string;
  metadata?: Record<string, unknown>;
}

type VisibilityFilter = 'all' | 'private' | 'public';
type CreateStep = 'type' | 'remote-url' | 'remote-confirm' | 'local-form';
type DatasetTab = 'remote' | 'local';

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<DatasetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<DatasetTab>('remote');

  // ─── Create dialog ───
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<CreateStep>('type');
  const [creating, setCreating] = useState(false);

  // Remote creation
  const [remoteUrl, setRemoteUrl] = useState('');
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const [hfPreview, setHfPreview] = useState<HFPreview | null>(null);
  const [remoteVisibility, setRemoteVisibility] = useState<'public' | 'private'>('public');
  const [remoteTags, setRemoteTags] = useState<string[]>([]);
  const [remoteTagInput, setRemoteTagInput] = useState('');

  // Local creation
  const [localName, setLocalName] = useState('');
  const [localDescription, setLocalDescription] = useState('');
  const [localFormat, setLocalFormat] = useState<'json' | 'jsonl' | 'csv' | 'text'>('json');
  const [localVisibility, setLocalVisibility] = useState<'private' | 'public'>('private');
  const [localInputType, setLocalInputType] = useState<'query' | 'query-response'>('query-response');
  const [localData, setLocalData] = useState('');
  const [localTags, setLocalTags] = useState<string[]>([]);
  const [localTagInput, setLocalTagInput] = useState('');
  const [localSamples, setLocalSamples] = useState<
    Array<{ input: string; expected: string }>
  >([{ input: '', expected: '' }]);
  const [editingSampleIndex, setEditingSampleIndex] = useState<number | null>(null);
  const [localMode, setLocalMode] = useState<'inline' | 'paste' | 'upload'>(
    'inline'
  );
  const [localUploadedSamples, setLocalUploadedSamples] = useState<
    LocalSamplePayload[]
  >([]);
  const [localUploadedFileName, setLocalUploadedFileName] = useState('');
  const [localUploadError, setLocalUploadError] = useState<string | null>(
    null
  );
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const uploadFileInputRef = useRef<HTMLInputElement>(null);
  const localNameInputRef = useRef<HTMLInputElement>(null);
  const hasFocusedLocalNameRef = useRef(false);

  useEffect(() => {
    if (!createOpen || createStep !== 'local-form') return;
    if (hasFocusedLocalNameRef.current) return;

    localNameInputRef.current?.focus();
    hasFocusedLocalNameRef.current = true;
  }, [createOpen, createStep]);

  /* ─── Data loading ─────────────────────────────────────────────────────── */

  const loadDatasets = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (visibilityFilter !== 'all')
        params.set('visibility', visibilityFilter);
      const res = await fetch(`/api/datasets?${params}`);
      if (res.ok) setDatasets(await res.json());
    } catch (err) {
      console.error('Failed to load datasets:', err);
    } finally {
      setLoading(false);
    }
  }, [visibilityFilter]);

  useEffect(() => {
    setLoading(true);
    loadDatasets();
  }, [loadDatasets]);

  useEffect(() => {
    const eventSource = new EventSource('/api/events?topic=datasets');

    const onDatasetSummaryUpdated = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(event.data) as {
          datasetId: string;
          summary: {
            updatedAt: string;
            sampleCount: number;
            samplesWithModelScores: number;
            samplesWithHumanScores: number;
            averageModelScore: number | null;
            averageHumanScore: number | null;
          };
        };

        setDatasets((previous) =>
          previous.map((dataset) => {
            if (dataset.id !== payload.datasetId) return dataset;

            const existingMeta = (() => {
              if (!dataset.remoteMetadata) return {} as Record<string, unknown>;
              try {
                const parsed = JSON.parse(dataset.remoteMetadata);
                return parsed && typeof parsed === 'object'
                  ? (parsed as Record<string, unknown>)
                  : {};
              } catch {
                return {};
              }
            })();

            return {
              ...dataset,
              remoteMetadata: JSON.stringify({
                ...existingMeta,
                evaluationSummary: payload.summary,
              }),
            };
          })
        );
      } catch {
        // ignore malformed events to keep stream resilient
      }
    };

    eventSource.addEventListener('dataset.summary.updated', onDatasetSummaryUpdated);

    return () => {
      eventSource.removeEventListener(
        'dataset.summary.updated',
        onDatasetSummaryUpdated
      );
      eventSource.close();
    };
  }, []);

  /* ─── Derived tags / filters ───────────────────────────────────────────── */

  const allTags = useMemo(() => {
    const set = new Set<string>();
    const latestByFamily = new Map<string, DatasetListItem>();
    datasets.forEach((d) => {
      const familyId = d.parentId ?? d.id;
      const existing = latestByFamily.get(familyId);
      if (!existing || d.version > existing.version) {
        latestByFamily.set(familyId, d);
      }
    });

    latestByFamily.forEach((d) => {
      parseTags(d.tags).forEach((tag) => set.add(tag));
    });

    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [datasets]);

  const latestDatasets = useMemo(() => {
    const byFamily = new Map<string, DatasetListItem>();
    datasets.forEach((dataset) => {
      const familyId = dataset.parentId ?? dataset.id;
      const existing = byFamily.get(familyId);
      if (!existing || dataset.version > existing.version) {
        byFamily.set(familyId, dataset);
      }
    });
    return Array.from(byFamily.values());
  }, [datasets]);

  const filtered = latestDatasets.filter((d) => {
    const q = search.trim().toLowerCase();
    const tags = parseTags(d.tags).map((t) => t.toLowerCase());

    const matchesVisibility =
      visibilityFilter === 'all' || d.visibility === visibilityFilter;

    const matchesTags =
      selectedTags.length === 0 ||
      selectedTags.every((t) => tags.includes(t.toLowerCase()));

    const matchesSearch = q
      ? d.name.toLowerCase().includes(q) ||
        d.description?.toLowerCase().includes(q) ||
        d.huggingFaceId?.toLowerCase().includes(q) ||
        tags.some((t) => t.includes(q))
      : true;

    return matchesVisibility && matchesTags && matchesSearch;
  });

  const localDatasets = filtered.filter((d) => d.source === 'local');
  const remoteDatasets = filtered.filter((d) => d.source === 'remote');
  const tabDatasets = activeTab === 'remote' ? remoteDatasets : localDatasets;
  const activeTabLabel = activeTab === 'remote' ? 'Remote' : 'Local';
  const selectedTagValue = selectedTags[0] ?? 'all';
  const activeFilterCount =
    (visibilityFilter !== 'all' ? 1 : 0) + (selectedTags.length > 0 ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;
  const tagFilterOptions = useMemo(
    () => [
      { value: 'all', label: 'All Tags' },
      ...allTags.map((tag) => ({ value: tag, label: tag })),
    ],
    [allTags]
  );

  /* ─── Create dialog helpers ────────────────────────────────────────────── */

  const resetCreate = () => {
    hasFocusedLocalNameRef.current = false;
    setCreateStep('type');
    setRemoteUrl('');
    setHfPreview(null);
    setRemoteVisibility('public');
    setRemoteTags([]);
    setRemoteTagInput('');
    setLocalName('');
    setLocalDescription('');
    setLocalFormat('json');
    setLocalVisibility('private');
    setLocalInputType('query-response');
    setLocalData('');
    setLocalTags([]);
    setLocalTagInput('');
    setLocalSamples([{ input: '', expected: '' }]);
    setEditingSampleIndex(null);
    setLocalUploadedSamples([]);
    setLocalUploadedFileName('');
    setLocalUploadError(null);
    setIsDraggingFile(false);
    setLocalMode('inline');
    setCreating(false);
    setFetchingPreview(false);
  };

  const openCreate = () => {
    resetCreate();
    setCreateOpen(true);
  };

  const handleFetchPreview = async () => {
    if (!remoteUrl.trim()) return;
    setFetchingPreview(true);
    try {
      const res = await fetch(
        `/api/datasets/huggingface/preview?url=${encodeURIComponent(
          remoteUrl.trim()
        )}`
      );
      if (res.ok) {
        const preview = await res.json();
        setHfPreview(preview);
        setRemoteTags(preview.tags ?? []);
        setCreateStep('remote-confirm');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Could not fetch dataset metadata');
      }
    } catch {
      toast.error('Failed to fetch dataset preview');
    } finally {
      setFetchingPreview(false);
    }
  };

  const handleCreateRemote = async () => {
    if (!hfPreview) return;
    setCreating(true);
    try {
      const res = await fetch('/api/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: hfPreview.name,
          description: hfPreview.description,
          source: 'remote',
          visibility: remoteVisibility,
          sourceUrl: remoteUrl.trim(),
          huggingFaceId: hfPreview.id,
          tags: remoteTags,
        }),
      });
      if (res.ok) {
        toast.success('Dataset added');
        setCreateOpen(false);
        resetCreate();
        loadDatasets();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create dataset');
      }
    } catch {
      toast.error('Failed to create dataset');
    } finally {
      setCreating(false);
    }
  };

  const handleCreateLocal = async () => {
    if (!localName.trim()) return;
    setCreating(true);
    try {
      // Build samples from inline entries or parsed paste data
      let samples: LocalSamplePayload[] | undefined;
      if (localMode === 'inline') {
        samples = localSamples
          .filter((s) => s.input.trim())
          .map((s) => ({
            input: s.input,
            expected: s.expected || undefined,
          }));
      } else if (localMode === 'paste' && localData.trim()) {
        try {
          samples = parseRecordsFromJson(localData).map(recordToSample);
        } catch {
          toast.error('Could not parse pasted data as JSON array');
          setCreating(false);
          return;
        }
      } else if (localMode === 'upload') {
        samples = localUploadedSamples;
      }

      if (!samples?.length) {
        toast.error('Add at least one sample before creating the dataset');
        setCreating(false);
        return;
      }

      const res = await fetch('/api/datasets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: localName,
          description: localDescription || undefined,
          source: 'local',
          visibility: localVisibility,
          inputType: localInputType,
          format: localFormat,
          localData: localMode === 'paste' ? localData : undefined,
          samples,
          tags: localTags,
        }),
      });
      if (res.ok) {
        toast.success('Dataset created');
        setCreateOpen(false);
        resetCreate();
        loadDatasets();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create dataset');
      }
    } catch {
      toast.error('Failed to create dataset');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm('Delete this dataset and all its samples?')) return;
    try {
      const res = await fetch(`/api/datasets/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Dataset deleted');
        loadDatasets();
      }
    } catch {
      toast.error('Failed to delete dataset');
    }
  };

  /* ─── Helpers ──────────────────────────────────────────────────────────── */

  function parseTags(tagsJson: string | null): string[] {
    if (!tagsJson) return [];
    try {
      const parsed = JSON.parse(tagsJson);
      if (Array.isArray(parsed)) {
        return parsed
          .map((tag) => (tag != null ? String(tag).trim() : ''))
          .filter(Boolean);
      }
    } catch {
      const fallback = tagsJson
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (fallback.length) return fallback;
    }
    return [];
  }

  const toggleTagFilter = (tag: string) => {
    const normalized = tag.trim();
    if (!normalized) return;
    setSelectedTags((prev) =>
      prev.includes(normalized)
        ? prev.filter((t) => t !== normalized)
        : [...prev, normalized]
    );
  };

  const handleVisibilityFilterChange = (value: string) => {
    setVisibilityFilter(value as VisibilityFilter);
  };

  const handleTagFilterChange = (value: string) => {
    if (value === 'all') {
      setSelectedTags([]);
      return;
    }
    setSelectedTags([value]);
  };

  const clearAllFilters = () => {
    setVisibilityFilter('all');
    setSelectedTags([]);
  };

  const addRemoteTag = () => {
    const normalized = remoteTagInput.trim();
    if (!normalized) return;
    setRemoteTags((prev) =>
      prev.includes(normalized) ? prev : [...prev, normalized]
    );
    setRemoteTagInput('');
  };

  const addLocalTag = () => {
    const normalized = localTagInput.trim();
    if (!normalized) return;
    setLocalTags((prev) => (prev.includes(normalized) ? prev : [...prev, normalized]));
    setLocalTagInput('');
  };

  const removeRemoteTag = (tag: string) => {
    setRemoteTags((prev) => prev.filter((t) => t !== tag));
  };

  const removeLocalTag = (tag: string) => {
    setLocalTags((prev) => prev.filter((t) => t !== tag));
  };

  const addInlineSample = () => {
    setLocalSamples((prev) => [...prev, { input: '', expected: '' }]);
  };

  const updateInlineSample = (
    index: number,
    field: 'input' | 'expected',
    value: string
  ) => {
    setLocalSamples((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [field]: value } : s))
    );
  };

  const removeInlineSample = (index: number) => {
    setLocalSamples((prev) => prev.filter((_, i) => i !== index));
  };

  const parseCsvRow = (row: string): string[] => {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const char = row[i];
      if (char === '"') {
        if (inQuotes && row[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  };

  const parseRecordsFromCsv = (text: string): Record<string, unknown>[] => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length < 2) {
      throw new Error('CSV must include a header row and at least one data row');
    }

    const headers = parseCsvRow(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseCsvRow(line);
      const record: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        record[header] = values[index] ?? '';
      });
      return record;
    });
  };

  const parseRecordsFromJson = (text: string): Record<string, unknown>[] => {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((item) =>
        typeof item === 'object' && item !== null
          ? (item as Record<string, unknown>)
          : { value: item }
      );
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.records)) {
        return obj.records.map((item) =>
          typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>)
            : { value: item }
        );
      }
      if (Array.isArray(obj.data)) {
        return obj.data.map((item) =>
          typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>)
            : { value: item }
        );
      }
    }

    throw new Error('JSON must be an array of records (or { records: [...] })');
  };

  const recordToSample = (record: Record<string, unknown>): LocalSamplePayload => {
    const getString = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = record[key];
        if (value != null && String(value).trim()) return String(value);
      }
      return undefined;
    };

    const input =
      getString(['input', 'prompt', 'question', 'text', 'query', 'instruction']) ||
      JSON.stringify(record);
    const expected = getString([
      'expected',
      'answer',
      'output',
      'target',
      'label',
      'ground_truth',
    ]);

    const metadata: Record<string, unknown> = { ...record };
    [
      'input',
      'prompt',
      'question',
      'text',
      'query',
      'instruction',
      'expected',
      'answer',
      'output',
      'target',
      'label',
      'ground_truth',
    ].forEach((key) => {
      delete metadata[key];
    });

    return {
      input,
      expected,
      metadata: Object.keys(metadata).length ? metadata : undefined,
    };
  };

  const handleUploadFile = async (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (!extension || !['csv', 'json', 'jsonl'].includes(extension)) {
      setLocalUploadError('Please upload a CSV, JSON, or JSONL file.');
      return;
    }

    try {
      const text = await file.text();
      let records: Record<string, unknown>[] = [];

      if (extension === 'csv') {
        records = parseRecordsFromCsv(text);
      } else if (extension === 'json') {
        records = parseRecordsFromJson(text);
      } else {
        records = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const parsed = JSON.parse(line);
            return typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)
              : { value: parsed };
          });
      }

      const samples = records.map(recordToSample).filter((sample) => sample.input.trim());
      if (!samples.length) {
        setLocalUploadError('No valid records found in file.');
        return;
      }

      setLocalUploadedSamples(samples);
      setLocalUploadedFileName(file.name);
      setLocalUploadError(null);
      setLocalFormat(extension === 'csv' ? 'csv' : extension === 'jsonl' ? 'jsonl' : 'json');
      toast.success(`Loaded ${samples.length} records from ${file.name}`);
    } catch {
      setLocalUploadError('Failed to parse uploaded file. Check the format and try again.');
    }
  };

  const handleFileInputChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await handleUploadFile(file);
    event.target.value = '';
  };

  const handleDropUpload = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFile(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    await handleUploadFile(file);
  };

  const handleAddDatasetForActiveTab = () => {
    openCreate();
    setCreateStep(activeTab === 'remote' ? 'remote-url' : 'local-form');
  };

  const handleSwapTab = () => {
    setActiveTab((prev) => (prev === 'remote' ? 'local' : 'remote'));
  };

  /* ─── Render ───────────────────────────────────────────────────────────── */

  const renderDatasetCard = (dataset: DatasetListItem) => {
    const tags = parseTags(dataset.tags);
    const splits = parseTags(dataset.splits);
    const sampleCount = dataset.sampleCount ?? dataset._count.samples ?? 0;
    const isRemote = dataset.source === 'remote';
    const parsedMeta = (() => {
      if (!dataset.remoteMetadata) return null;
      try {
        const parsed = JSON.parse(dataset.remoteMetadata);
        return parsed && typeof parsed === 'object'
          ? (parsed as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })();
    const evaluationSummary: DatasetEvaluationSummaryView | null =
      parsedMeta && typeof parsedMeta === 'object' && 'evaluationSummary' in parsedMeta
        ? ((parsedMeta as Record<string, any>).evaluationSummary as DatasetEvaluationSummaryView)
        : null;

    return (
      <Link key={dataset.id} href={`/datasets/${dataset.id}`}>
        <Card interactive className="h-full">
          <CardHeader>
            <div className="flex items-start justify-between">
              <CardTitle className="truncate pr-2">{dataset.name}</CardTitle>
              <div className="flex items-center gap-1 shrink-0">
                {!isRemote && (
                  <Badge variant="outline" size="sm">
                    Latest v{dataset.version}
                  </Badge>
                )}
                <button
                  onClick={(e) => handleDelete(dataset.id, e)}
                  className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  aria-label="Delete dataset"
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
                  >
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>
            {dataset.description && (
              <CardDescription className="line-clamp-2">
                {dataset.description}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              <Badge variant={isRemote ? 'default' : 'outline'} size="sm">
                {isRemote ? '🌐 Remote' : '💾 Local'}
              </Badge>
              <Badge
                variant={
                  dataset.visibility === 'public' ? 'success' : 'warning'
                }
                size="sm"
              >
                {dataset.visibility === 'public' ? '🔓 Public' : '🔒 Private'}
              </Badge>
              {sampleCount > 0 && (
                <Badge variant="default" size="sm">
                  {sampleCount.toLocaleString()} samples
                </Badge>
              )}
              {isRemote && splits.length > 0 && (
                <Badge variant="outline" size="sm">
                  {splits.length} splits
                </Badge>
              )}
              {!isRemote && dataset.format && (
                <Badge variant="outline" size="sm">
                  Format: {dataset.format.toUpperCase()}
                </Badge>
              )}
              {!isRemote && dataset.inputType && (
                <Badge variant="outline" size="sm">
                  {dataset.inputType === 'query' ? '📝 Query' : '📝 Q+R'}
                </Badge>
              )}
              {evaluationSummary?.averageModelScore != null && (
                <Badge variant="outline" size="sm">
                  Model Avg: {evaluationSummary.averageModelScore.toFixed(1)}
                </Badge>
              )}
              {evaluationSummary?.averageHumanScore != null && (
                <Badge variant="outline" size="sm">
                  Human Avg: {evaluationSummary.averageHumanScore.toFixed(1)}
                </Badge>
              )}
            </div>

            {isRemote ? (
              <p className="text-2xs text-surface-500 dark:text-surface-400 mb-1">
                HuggingFace ID: {dataset.huggingFaceId || 'Provided URL'}
              </p>
            ) : (
              <p className="text-2xs text-surface-500 dark:text-surface-400 mb-1">
                Local dataset managed independently from projects.
              </p>
            )}

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {tags.slice(0, 6).map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-full bg-surface-100 dark:bg-surface-700 px-2 py-0.5 text-2xs text-surface-700 dark:text-surface-200 border border-surface-200 dark:border-blue-200"
                  >
                    {tag}
                  </span>
                ))}
                {tags.length > 6 && (
                  <span className="text-2xs text-surface-400">
                    +{tags.length - 6} more
                  </span>
                )}
              </div>
            )}

            <p className="text-2xs text-surface-400">
              Updated {formatDate(dataset.updatedAt)}
            </p>
          </CardContent>
        </Card>
      </Link>
    );
  };

  return (
    <div>
      <Header
        title={`${activeTabLabel} Datasets`}
        description="Manage datasets independently of projects — both local and remote sources."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 p-0.5">
              <button
                onClick={() => setActiveTab('remote')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'remote'
                    ? 'bg-brand-600 text-white'
                    : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                }`}
              >
                Remote
              </button>
              <button
                onClick={() => setActiveTab('local')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab === 'local'
                    ? 'bg-brand-600 text-white'
                    : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                }`}
              >
                Local
              </button>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleSwapTab}
              aria-label={`Swap to ${activeTab === 'remote' ? 'Local' : 'Remote'}`}
              title={`Swap to ${activeTab === 'remote' ? 'Local' : 'Remote'}`}
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
                <path d="M17 3l4 4-4 4" />
                <path d="M3 7h18" />
                <path d="M7 21l-4-4 4-4" />
                <path d="M21 17H3" />
              </svg>
            </Button>
            <Button variant="primary" size="sm" onClick={handleAddDatasetForActiveTab}>
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
              New Dataset
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* ─── Filters ─────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-4">
          <div className="flex flex-wrap items-end gap-3">
          <Input
            placeholder="Search by name, tag, or id"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full min-w-[240px] flex-1"
          />
          <div className="flex items-center gap-2">
            <Badge variant={hasActiveFilters ? 'default' : 'outline'} size="sm">
              {hasActiveFilters
                ? `${activeFilterCount} active filter${activeFilterCount > 1 ? 's' : ''}`
                : 'No active filters'}
            </Badge>
            {hasActiveFilters && (
              <Button variant="ghost" size="sm" onClick={clearAllFilters}>
                Clear
              </Button>
            )}
          </div>
          <div className="w-full sm:w-[430px]">
            <p className="mb-1.5 text-xs font-medium text-surface-600 dark:text-surface-400">Filters</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <Select
                value={visibilityFilter}
                onChange={(e) => handleVisibilityFilterChange(e.target.value)}
                options={[
                  { value: 'all', label: 'Visibility: All' },
                  { value: 'public', label: 'Visibility: Public' },
                  { value: 'private', label: 'Visibility: Private' },
                ]}
              />
              <Select
                value={selectedTagValue}
                onChange={(e) => handleTagFilterChange(e.target.value)}
                options={tagFilterOptions}
              />
            </div>
          </div>
        </div>
        </div>

        {/* ─── Tabbed datasets ────────────────────────────────────────── */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">Datasets</h3>
              {!loading && (
                <Badge variant="outline" size="sm">
                  {tabDatasets.length}
                </Badge>
              )}
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-44 w-full rounded-xl" />
              ))}
            </div>
          ) : tabDatasets.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-surface-300"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 12h8M12 8v8" />
                </svg>
              }
              title={`No ${activeTabLabel.toLowerCase()} datasets yet`}
              description={
                activeTab === 'remote'
                  ? 'Import HuggingFace or other remote datasets and we will track their metadata separately.'
                  : 'Create or upload datasets that live independently of projects and evaluations.'
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {tabDatasets.map(renderDatasetCard)}
            </div>
          )}
        </div>
      </div>

      {/* ═════════════════ Create Dataset Dialog ═════════════════ */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {createStep === 'type' && 'New Dataset'}
              {createStep === 'remote-url' && 'Add Remote Dataset'}
              {createStep === 'remote-confirm' && 'Confirm Dataset'}
              {createStep === 'local-form' && 'Create Local Dataset'}
            </DialogTitle>
          </DialogHeader>

          <DialogBody>
            {/* ─── Step: Choose type ─────────────────────── */}
            {createStep === 'type' && (
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setCreateStep('remote-url')}
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-surface-200 dark:border-surface-700 p-6 transition-all hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/30"
                >
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-brand-600"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                      Remote Dataset
                    </p>
                    <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                      Import from HuggingFace or URL
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => setCreateStep('local-form')}
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-surface-200 dark:border-surface-700 p-6 transition-all hover:border-brand-400 hover:bg-brand-50 dark:hover:bg-brand-950/30"
                >
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-brand-600"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="12" y1="18" x2="12" y2="12" />
                    <line x1="9" y1="15" x2="15" y2="15" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-surface-900 dark:text-surface-100">
                      Local Dataset
                    </p>
                    <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                      Create inline or paste data
                    </p>
                  </div>
                </button>
              </div>
            )}

            {/* ─── Step: Remote URL ──────────────────────── */}
            {createStep === 'remote-url' && (
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                    HuggingFace Dataset URL
                  </label>
                  <Input
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder="https://huggingface.co/datasets/livecodebench/code_generation_lite"
                    autoFocus
                  />
                  <p className="mt-1.5 text-xs text-surface-400">
                    Paste a HuggingFace dataset URL and we&apos;ll fetch its
                    metadata automatically.
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                    Visibility
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRemoteVisibility('public')}
                      className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${
                        remoteVisibility === 'public'
                          ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                          : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                      }`}
                    >
                      🔓 Public
                    </button>
                    <button
                      onClick={() => setRemoteVisibility('private')}
                      className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${
                        remoteVisibility === 'private'
                          ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                          : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                      }`}
                    >
                      🔒 Private
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ─── Step: Remote Confirm ──────────────────── */}
            {createStep === 'remote-confirm' && hfPreview && (
              <div className="space-y-4">
                <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="text-sm font-bold text-surface-900 dark:text-surface-100">
                        {hfPreview.id}
                      </h3>
                      <p className="text-xs text-surface-500 dark:text-surface-400">
                        by {hfPreview.author}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-surface-500 dark:text-surface-400">
                      <span>⬇ {hfPreview.downloads?.toLocaleString() ?? 0}</span>
                      <span>❤ {hfPreview.likes ?? 0}</span>
                    </div>
                  </div>
                  <p className="text-xs text-surface-600 dark:text-surface-400 line-clamp-3 mb-3">
                    {hfPreview.description}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {hfPreview.splits.length > 0 && (
                      <Badge variant="default" size="sm">
                        {hfPreview.splits.length} split
                        {hfPreview.splits.length !== 1 ? 's' : ''}
                      </Badge>
                    )}
                    {hfPreview.sampleCount != null && (
                      <Badge variant="default" size="sm">
                        {hfPreview.sampleCount.toLocaleString()} samples
                      </Badge>
                    )}
                    {hfPreview.configs.length > 1 && (
                      <Badge variant="outline" size="sm">
                        {hfPreview.configs.length} configs
                      </Badge>
                    )}
                  </div>
                  {hfPreview.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {hfPreview.tags.slice(0, 8).map((tag) => (
                        <span
                          key={tag}
                          className="inline-block rounded-full bg-white dark:bg-surface-800 px-2 py-0.5 text-2xs text-surface-700 dark:text-surface-200 border border-surface-200 dark:border-blue-200"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300 block">
                    Tags (used for filtering)
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={remoteTagInput}
                      onChange={(e) => setRemoteTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          addRemoteTag();
                        }
                      }}
                      placeholder="Add a tag and press Enter"
                    />
                    <Button variant="primary" onClick={addRemoteTag}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {remoteTags.length === 0 && (
                      <p className="text-2xs text-surface-400">No tags yet.</p>
                    )}
                    {remoteTags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-100 dark:bg-surface-700 px-2 py-0.5 text-2xs text-surface-800 dark:text-surface-200 border border-surface-200 dark:border-blue-200"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeRemoteTag(tag)}
                          className="text-surface-400 hover:text-red-500"
                          aria-label={`Remove tag ${tag}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <p className="text-2xs text-surface-400">
                    Visibility stays separate; tags only affect search and filtering.
                  </p>
                </div>
              </div>
            )}

            {/* ─── Step: Local Form ──────────────────────── */}
            {createStep === 'local-form' && (
              <div className="space-y-4">
                <Input
                  ref={localNameInputRef}
                  label="Dataset Name"
                  value={localName}
                  onChange={(e) => setLocalName(e.target.value)}
                  placeholder="e.g., Customer Support Prompts"
                  required
                />
                <Textarea
                  label="Description"
                  value={localDescription}
                  onChange={(e) => setLocalDescription(e.target.value)}
                  placeholder="What does this dataset evaluate?"
                  rows={2}
                />

                {/* ─── Input Type Selector ──────────────────── */}
                <div>
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                    Input Type
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setLocalInputType('query')}
                      className={`rounded-lg border-2 px-3 py-2.5 text-left transition-colors ${
                        localInputType === 'query'
                          ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30'
                          : 'border-surface-200 dark:border-surface-700 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                      }`}
                    >
                      <p className={`text-xs font-semibold ${localInputType === 'query' ? 'text-brand-700 dark:text-brand-300' : 'text-surface-700 dark:text-surface-300'}`}>
                        Query Only
                      </p>
                      <p className="text-2xs text-surface-500 dark:text-surface-400 mt-0.5">
                        Single input per sample (prompt, question, etc.)
                      </p>
                    </button>
                    <button
                      onClick={() => setLocalInputType('query-response')}
                      className={`rounded-lg border-2 px-3 py-2.5 text-left transition-colors ${
                        localInputType === 'query-response'
                          ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30'
                          : 'border-surface-200 dark:border-surface-700 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                      }`}
                    >
                      <p className={`text-xs font-semibold ${localInputType === 'query-response' ? 'text-brand-700 dark:text-brand-300' : 'text-surface-700 dark:text-surface-300'}`}>
                        Query + Response
                      </p>
                      <p className="text-2xs text-surface-500 dark:text-surface-400 mt-0.5">
                        Input paired with expected output
                      </p>
                    </button>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                      Visibility
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setLocalVisibility('private')}
                        className={`flex-1 rounded-lg border-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                          localVisibility === 'private'
                            ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                            : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                        }`}
                      >
                        🔒 Private
                      </button>
                      <button
                        onClick={() => setLocalVisibility('public')}
                        className={`flex-1 rounded-lg border-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                          localVisibility === 'public'
                            ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                            : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                        }`}
                      >
                        🔓 Public
                      </button>
                    </div>
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                      Format
                    </label>
                    <select
                      value={localFormat}
                      onChange={(e) =>
                        setLocalFormat(
                          e.target.value as 'json' | 'jsonl' | 'csv' | 'text'
                        )
                      }
                      className="w-full rounded-lg border border-surface-300 dark:border-surface-600 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="json">JSON</option>
                      <option value="jsonl">JSONL</option>
                      <option value="csv">CSV</option>
                      <option value="text">Text</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300 block">
                    Tags (optional)
                  </label>
                  <div className="flex gap-2">
                    <Input
                      value={localTagInput}
                      onChange={(e) => setLocalTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          addLocalTag();
                        }
                      }}
                      placeholder="Add a tag and press Enter"
                    />
                    <Button variant="primary" onClick={addLocalTag}>
                      Add
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {localTags.length === 0 && (
                      <p className="text-2xs text-surface-400">Use tags to organize and search datasets.</p>
                    )}
                    {localTags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 rounded-full bg-surface-100 dark:bg-surface-700 px-2 py-0.5 text-2xs text-surface-800 dark:text-surface-200 border border-surface-200 dark:border-blue-200"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => removeLocalTag(tag)}
                          className="text-surface-400 hover:text-red-500"
                          aria-label={`Remove tag ${tag}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>

                {/* ─── Sample Editor ──────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm font-medium text-surface-700 dark:text-surface-300">
                      Samples
                    </label>
                    <span className="text-2xs text-surface-400">
                      {localMode === 'inline'
                        ? `${localSamples.filter((s) => s.input.trim()).length} sample${localSamples.filter((s) => s.input.trim()).length !== 1 ? 's' : ''}`
                        : localMode === 'upload'
                          ? `${localUploadedSamples.length} loaded`
                          : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 dark:border-surface-700 p-0.5 mb-3">
                    <button
                      onClick={() => setLocalMode('inline')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'inline'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                      }`}
                    >
                      Inline Editor
                    </button>
                    <button
                      onClick={() => setLocalMode('paste')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'paste'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                      }`}
                    >
                      Paste JSON
                    </button>
                    <button
                      onClick={() => setLocalMode('upload')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'upload'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 dark:text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                      }`}
                    >
                      Upload File
                    </button>
                  </div>

                  {localMode === 'inline' ? (
                    <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                      {localSamples.map((sample, i) => {
                        const isExpanded = editingSampleIndex === i;
                        const hasContent = sample.input.trim().length > 0;

                        return (
                          <div
                            key={i}
                            className={`rounded-lg border transition-colors ${
                              isExpanded
                                ? 'border-brand-300 dark:border-brand-700 bg-brand-50/30 dark:bg-brand-950/30 shadow-sm'
                                : hasContent
                                  ? 'border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800'
                                  : 'border-dashed border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-800'
                            }`}
                          >
                            {/* Collapsed header — click to expand */}
                            <div
                              className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
                              onClick={() => setEditingSampleIndex(isExpanded ? null : i)}
                            >
                              <span className="shrink-0 text-2xs text-surface-400 w-5 text-right font-mono">
                                {i + 1}.
                              </span>
                              <div className="flex-1 min-w-0">
                                {hasContent ? (
                                  <p className="text-xs text-surface-700 dark:text-surface-300 truncate">
                                    {sample.input}
                                  </p>
                                ) : (
                                  <p className="text-xs text-surface-400 italic">
                                    Empty sample — click to edit
                                  </p>
                                )}
                              </div>
                              {localInputType === 'query-response' && sample.expected.trim() && (
                                <Badge variant="success" size="sm" className="shrink-0">
                                  has expected
                                </Badge>
                              )}
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className={`shrink-0 text-surface-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              >
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                              {localSamples.length > 1 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); removeInlineSample(i); }}
                                  className="shrink-0 rounded p-0.5 text-surface-400 hover:text-red-500 transition-colors"
                                  aria-label="Remove sample"
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                  </svg>
                                </button>
                              )}
                            </div>

                            {/* Expanded editor */}
                            {isExpanded && (
                              <div className="px-3 pb-3 space-y-2 border-t border-surface-100 dark:border-surface-700">
                                <div className="pt-2">
                                  <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                                    {localInputType === 'query' ? 'Query / Input' : 'Input / Prompt'}
                                  </label>
                                  <Textarea
                                    placeholder={localInputType === 'query'
                                      ? 'Enter the query or prompt text...'
                                      : 'Enter the input prompt...'}
                                    value={sample.input}
                                    onChange={(e) =>
                                      updateInlineSample(i, 'input', e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                      // Ctrl/Cmd+Enter to collapse and move to next
                                      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                        e.preventDefault();
                                        if (i === localSamples.length - 1) {
                                          addInlineSample();
                                          setEditingSampleIndex(i + 1);
                                        } else {
                                          setEditingSampleIndex(i + 1);
                                        }
                                      }
                                    }}
                                    rows={3}
                                    className="text-xs"
                                    autoFocus
                                  />
                                </div>
                                {localInputType === 'query-response' && (
                                  <div>
                                    <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                                      Expected Output / Response
                                    </label>
                                    <Textarea
                                      placeholder="Enter the expected response..."
                                      value={sample.expected}
                                      onChange={(e) =>
                                        updateInlineSample(i, 'expected', e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                                          e.preventDefault();
                                          if (i === localSamples.length - 1) {
                                            addInlineSample();
                                            setEditingSampleIndex(i + 1);
                                          } else {
                                            setEditingSampleIndex(i + 1);
                                          }
                                        }
                                      }}
                                      rows={3}
                                      className="text-xs"
                                    />
                                  </div>
                                )}
                                <div className="flex items-center justify-between pt-1">
                                  <p className="text-2xs text-surface-400">
                                    {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter → next sample
                                  </p>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditingSampleIndex(null)}
                                  >
                                    Collapse
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      <button
                        onClick={() => {
                          addInlineSample();
                          setEditingSampleIndex(localSamples.length);
                        }}
                        className="w-full rounded-lg border border-dashed border-surface-300 dark:border-surface-600 py-2 text-xs text-surface-500 dark:text-surface-400 hover:border-brand-400 hover:text-brand-600 transition-colors flex items-center justify-center gap-1.5"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        Add sample
                      </button>
                    </div>
                  ) : localMode === 'paste' ? (
                    <Textarea
                      value={localData}
                      onChange={(e) => setLocalData(e.target.value)}
                      placeholder={`Paste a JSON array:\n[\n  { "input": "prompt text", "expected": "answer" },\n  ...\n]`}
                      rows={8}
                      className="font-mono text-xs"
                    />
                  ) : (
                    <div className="space-y-3">
                      <input
                        ref={uploadFileInputRef}
                        type="file"
                        accept=".csv,.json,.jsonl"
                        className="hidden"
                        onChange={handleFileInputChange}
                      />
                      <div
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setIsDraggingFile(true);
                        }}
                        onDragLeave={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setIsDraggingFile(false);
                        }}
                        onDrop={handleDropUpload}
                        className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
                          isDraggingFile
                            ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30'
                            : 'border-surface-300 dark:border-surface-600 bg-surface-50 dark:bg-surface-800'
                        }`}
                      >
                        <svg
                          width="28"
                          height="28"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="mx-auto mb-2 text-surface-500 dark:text-surface-400"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                          Drag and drop a dataset file here
                        </p>
                        <p className="mt-1 text-xs text-surface-500 dark:text-surface-400">
                          Supports CSV, JSON, JSONL
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => uploadFileInputRef.current?.click()}
                        >
                          Choose File
                        </Button>
                      </div>

                      {localUploadedFileName && (
                        <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3">
                          <p className="text-xs text-surface-600 dark:text-surface-400">
                            File: <span className="font-medium">{localUploadedFileName}</span>
                          </p>
                          <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">
                            Parsed {localUploadedSamples.length} records
                          </p>
                          <div className="mt-2 flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setLocalUploadedFileName('');
                                setLocalUploadedSamples([]);
                                setLocalUploadError(null);
                              }}
                            >
                              Clear
                            </Button>
                          </div>
                        </div>
                      )}

                      {localUploadError && (
                        <p className="text-xs text-red-600">{localUploadError}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </DialogBody>

          <DialogFooter>
            {createStep !== 'type' && (
              <Button
                variant="secondary"
                onClick={() => {
                  if (createStep === 'remote-confirm')
                    setCreateStep('remote-url');
                  else setCreateStep('type');
                }}
              >
                Back
              </Button>
            )}
            {createStep === 'type' && (
              <Button variant="secondary" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
            )}
            {createStep === 'remote-url' && (
              <Button
                variant="primary"
                onClick={handleFetchPreview}
                loading={fetchingPreview}
                disabled={!remoteUrl.trim()}
              >
                Fetch Metadata
              </Button>
            )}
            {createStep === 'remote-confirm' && (
              <Button
                variant="primary"
                onClick={handleCreateRemote}
                loading={creating}
              >
                Add Dataset
              </Button>
            )}
            {createStep === 'local-form' && (
              <Button
                variant="primary"
                onClick={handleCreateLocal}
                loading={creating}
                disabled={
                  !localName.trim() ||
                  (localMode === 'upload' && localUploadedSamples.length === 0)
                }
              >
                Create Dataset
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
