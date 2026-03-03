'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
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

type SourceFilter = 'all' | 'local' | 'remote';
type VisibilityFilter = 'all' | 'private' | 'public';
type CreateStep = 'type' | 'remote-url' | 'remote-confirm' | 'local-form';

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<DatasetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [visibilityFilter, setVisibilityFilter] =
    useState<VisibilityFilter>('all');
  const [search, setSearch] = useState('');

  // ─── Create dialog ───
  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState<CreateStep>('type');
  const [creating, setCreating] = useState(false);

  // Remote creation
  const [remoteUrl, setRemoteUrl] = useState('');
  const [fetchingPreview, setFetchingPreview] = useState(false);
  const [hfPreview, setHfPreview] = useState<HFPreview | null>(null);
  const [remoteVisibility, setRemoteVisibility] = useState<'public' | 'private'>('public');

  // Local creation
  const [localName, setLocalName] = useState('');
  const [localDescription, setLocalDescription] = useState('');
  const [localFormat, setLocalFormat] = useState<'json' | 'jsonl' | 'csv' | 'text'>('json');
  const [localVisibility, setLocalVisibility] = useState<'private' | 'public'>('private');
  const [localData, setLocalData] = useState('');
  const [localSamples, setLocalSamples] = useState<
    Array<{ input: string; expected: string }>
  >([{ input: '', expected: '' }]);
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
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (visibilityFilter !== 'all')
        params.set('visibility', visibilityFilter);
      const res = await fetch(`/api/datasets?${params}`);
      if (res.ok) setDatasets(await res.json());
    } catch (err) {
      console.error('Failed to load datasets:', err);
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, visibilityFilter]);

  useEffect(() => {
    setLoading(true);
    loadDatasets();
  }, [loadDatasets]);

  /* ─── Filtered datasets ────────────────────────────────────────────────── */

  const filtered = datasets.filter((d) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      d.name.toLowerCase().includes(q) ||
      d.description?.toLowerCase().includes(q) ||
      d.huggingFaceId?.toLowerCase().includes(q)
    );
  });

  /* ─── Create dialog helpers ────────────────────────────────────────────── */

  const resetCreate = () => {
    hasFocusedLocalNameRef.current = false;
    setCreateStep('type');
    setRemoteUrl('');
    setHfPreview(null);
    setRemoteVisibility('public');
    setLocalName('');
    setLocalDescription('');
    setLocalFormat('json');
    setLocalVisibility('private');
    setLocalData('');
    setLocalSamples([{ input: '', expected: '' }]);
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
        setHfPreview(await res.json());
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
          tags: hfPreview.tags,
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
          format: localFormat,
          localData: localMode === 'paste' ? localData : undefined,
          samples,
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

  const parseTags = (tagsJson: string | null): string[] => {
    if (!tagsJson) return [];
    try {
      return JSON.parse(tagsJson);
    } catch {
      return [];
    }
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

  /* ─── Render ───────────────────────────────────────────────────────────── */

  return (
    <div>
      <Header
        title="Datasets"
        description="Manage evaluation datasets — local or from HuggingFace"
        actions={
          <Button variant="primary" size="sm" onClick={openCreate}>
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
        }
      />

      <div className="p-6">
        {/* ─── Filters ─────────────────────────────────────────────────── */}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <Input
            placeholder="Search datasets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 p-0.5">
            {(['all', 'local', 'remote'] as SourceFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setSourceFilter(s)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  sourceFilter === s
                    ? 'bg-brand-600 text-white'
                    : 'text-surface-600 hover:bg-surface-100'
                }`}
              >
                {s === 'all' ? 'All Sources' : s === 'local' ? 'Local' : 'Remote'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 p-0.5">
            {(['all', 'public', 'private'] as VisibilityFilter[]).map((v) => (
              <button
                key={v}
                onClick={() => setVisibilityFilter(v)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  visibilityFilter === v
                    ? 'bg-brand-600 text-white'
                    : 'text-surface-600 hover:bg-surface-100'
                }`}
              >
                {v === 'all' ? 'All' : v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Dataset grid ────────────────────────────────────────────── */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-surface-300"
              >
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            }
            title="No datasets yet"
            description="Add a public HuggingFace dataset or create your own local dataset for evaluation."
            action={
              <Button variant="primary" onClick={openCreate}>
                Add your first dataset
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((dataset) => {
              const tags = parseTags(dataset.tags);
              return (
                <Link key={dataset.id} href={`/datasets/${dataset.id}`}>
                  <Card interactive className="h-full">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <CardTitle className="truncate pr-2">
                          {dataset.name}
                        </CardTitle>
                        <div className="flex items-center gap-1 shrink-0">
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
                        <Badge
                          variant={
                            dataset.source === 'remote'
                              ? 'default'
                              : 'outline'
                          }
                          size="sm"
                        >
                          {dataset.source === 'remote' ? '🌐 Remote' : '💾 Local'}
                        </Badge>
                        <Badge
                          variant={
                            dataset.visibility === 'public'
                              ? 'success'
                              : 'warning'
                          }
                          size="sm"
                        >
                          {dataset.visibility === 'public'
                            ? '🔓 Public'
                            : '🔒 Private'}
                        </Badge>
                        {dataset.sampleCount != null && (
                          <Badge variant="default" size="sm">
                            {dataset.sampleCount.toLocaleString()} samples
                          </Badge>
                        )}
                        {dataset._count.samples > 0 &&
                          dataset.sampleCount == null && (
                            <Badge variant="default" size="sm">
                              {dataset._count.samples} samples
                            </Badge>
                          )}
                      </div>
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-2">
                          {tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="inline-block rounded-full bg-surface-100 px-2 py-0.5 text-2xs text-surface-600"
                            >
                              {tag}
                            </span>
                          ))}
                          {tags.length > 4 && (
                            <span className="text-2xs text-surface-400">
                              +{tags.length - 4} more
                            </span>
                          )}
                        </div>
                      )}
                      {dataset.project && (
                        <p className="text-2xs text-surface-400 mb-1">
                          Project: {dataset.project.name}
                        </p>
                      )}
                      <p className="text-2xs text-surface-400">
                        Updated {formatDate(dataset.updatedAt)}
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
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
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-surface-200 p-6 transition-all hover:border-brand-400 hover:bg-brand-50"
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
                    <p className="text-sm font-semibold text-surface-900">
                      Remote Dataset
                    </p>
                    <p className="mt-1 text-xs text-surface-500">
                      Import from HuggingFace or URL
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => setCreateStep('local-form')}
                  className="flex flex-col items-center gap-3 rounded-xl border-2 border-surface-200 p-6 transition-all hover:border-brand-400 hover:bg-brand-50"
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
                    <p className="text-sm font-semibold text-surface-900">
                      Local Dataset
                    </p>
                    <p className="mt-1 text-xs text-surface-500">
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
                  <label className="text-sm font-medium text-surface-700 mb-1.5 block">
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
                  <label className="text-sm font-medium text-surface-700 mb-1.5 block">
                    Visibility
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRemoteVisibility('public')}
                      className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${
                        remoteVisibility === 'public'
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-surface-200 text-surface-600 hover:bg-surface-50'
                      }`}
                    >
                      🔓 Public
                    </button>
                    <button
                      onClick={() => setRemoteVisibility('private')}
                      className={`flex-1 rounded-lg border-2 px-3 py-2 text-sm font-medium transition-colors ${
                        remoteVisibility === 'private'
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-surface-200 text-surface-600 hover:bg-surface-50'
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
                <div className="rounded-xl border border-surface-200 bg-surface-50 p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="text-sm font-bold text-surface-900">
                        {hfPreview.id}
                      </h3>
                      <p className="text-xs text-surface-500">
                        by {hfPreview.author}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-surface-500">
                      <span>⬇ {hfPreview.downloads?.toLocaleString() ?? 0}</span>
                      <span>❤ {hfPreview.likes ?? 0}</span>
                    </div>
                  </div>
                  <p className="text-xs text-surface-600 line-clamp-3 mb-3">
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
                          className="inline-block rounded-full bg-white px-2 py-0.5 text-2xs text-surface-600 border border-surface-200"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
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
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-sm font-medium text-surface-700 mb-1.5 block">
                      Visibility
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setLocalVisibility('private')}
                        className={`flex-1 rounded-lg border-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                          localVisibility === 'private'
                            ? 'border-brand-500 bg-brand-50 text-brand-700'
                            : 'border-surface-200 text-surface-600 hover:bg-surface-50'
                        }`}
                      >
                        🔒 Private
                      </button>
                      <button
                        onClick={() => setLocalVisibility('public')}
                        className={`flex-1 rounded-lg border-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                          localVisibility === 'public'
                            ? 'border-brand-500 bg-brand-50 text-brand-700'
                            : 'border-surface-200 text-surface-600 hover:bg-surface-50'
                        }`}
                      >
                        🔓 Public
                      </button>
                    </div>
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-medium text-surface-700 mb-1.5 block">
                      Format
                    </label>
                    <select
                      value={localFormat}
                      onChange={(e) =>
                        setLocalFormat(
                          e.target.value as 'json' | 'jsonl' | 'csv' | 'text'
                        )
                      }
                      className="w-full rounded-lg border border-surface-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="json">JSON</option>
                      <option value="jsonl">JSONL</option>
                      <option value="csv">CSV</option>
                      <option value="text">Text</option>
                    </select>
                  </div>
                </div>

                {/* Data entry mode toggle */}
                <div>
                  <label className="text-sm font-medium text-surface-700 mb-1.5 block">
                    Add Samples
                  </label>
                  <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 p-0.5 mb-3">
                    <button
                      onClick={() => setLocalMode('inline')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'inline'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 hover:bg-surface-100'
                      }`}
                    >
                      Inline Editor
                    </button>
                    <button
                      onClick={() => setLocalMode('paste')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'paste'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 hover:bg-surface-100'
                      }`}
                    >
                      Paste JSON
                    </button>
                    <button
                      onClick={() => setLocalMode('upload')}
                      className={`flex-1 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        localMode === 'upload'
                          ? 'bg-brand-600 text-white'
                          : 'text-surface-600 hover:bg-surface-100'
                      }`}
                    >
                      Upload File
                    </button>
                  </div>

                  {localMode === 'inline' ? (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {localSamples.map((sample, i) => (
                        <div
                          key={i}
                          className="flex items-start gap-2 rounded-lg border border-surface-200 p-2"
                        >
                          <span className="shrink-0 mt-1.5 text-2xs text-surface-400 w-5 text-right">
                            {i + 1}.
                          </span>
                          <div className="flex-1 space-y-1.5">
                            <Textarea
                              placeholder="Input / prompt..."
                              value={sample.input}
                              onChange={(e) =>
                                updateInlineSample(i, 'input', e.target.value)
                              }
                              rows={2}
                              className="text-xs"
                            />
                            <Input
                              placeholder="Expected output (optional)"
                              value={sample.expected}
                              onChange={(e) =>
                                updateInlineSample(
                                  i,
                                  'expected',
                                  e.target.value
                                )
                              }
                              className="text-xs"
                            />
                          </div>
                          {localSamples.length > 1 && (
                            <button
                              onClick={() => removeInlineSample(i)}
                              className="shrink-0 rounded p-1 text-surface-400 hover:text-red-500 mt-1"
                            >
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={addInlineSample}
                        className="w-full rounded-lg border border-dashed border-surface-300 py-1.5 text-xs text-surface-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
                      >
                        + Add sample
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
                            ? 'border-brand-500 bg-brand-50'
                            : 'border-surface-300 bg-surface-50'
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
                          className="mx-auto mb-2 text-surface-500"
                        >
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <p className="text-sm font-medium text-surface-700">
                          Drag and drop a dataset file here
                        </p>
                        <p className="mt-1 text-xs text-surface-500">
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
                        <div className="rounded-lg border border-surface-200 p-3">
                          <p className="text-xs text-surface-600">
                            File: <span className="font-medium">{localUploadedFileName}</span>
                          </p>
                          <p className="text-xs text-surface-500 mt-1">
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
