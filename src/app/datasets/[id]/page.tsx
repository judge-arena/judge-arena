'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/header';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface DatasetSample {
  id: string;
  index: number;
  input: string;
  expected: string | null;
  metadata: string | null;
  createdAt: string;
}

interface VersionInfo {
  id: string;
  version: number;
  sampleCount: number | null;
  createdAt: string;
  _count?: { samples: number };
}

interface DatasetDetail {
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
  remoteMetadata: string | null;
  format: string | null;
  localData: string | null;
  sampleCount: number | null;
  splits: string | null;
  features: string | null;
  tags: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string | null; email: string };
  project: { id: string; name: string } | null;
  samples: DatasetSample[];
  versions?: VersionInfo[];
  parent?: { id: string; version: number } | null;
  _count: { samples: number };
}

interface RemoteMeta {
  id?: string;
  author?: string;
  description?: string;
  downloads?: number;
  likes?: number;
  splits?: string[];
  sampleCount?: number | null;
  configs?: string[];
  tags?: string[];
  lastModified?: string;
  evaluationSummary?: {
    updatedAt?: string;
    sampleCount?: number;
    samplesWithModelScores?: number;
    samplesWithHumanScores?: number;
    averageModelScore?: number | null;
    averageHumanScore?: number | null;
  };
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function DatasetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = params.id as string;

  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllSamples, setShowAllSamples] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // ─── Editing state ───
  const [editingSampleId, setEditingSampleId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editExpected, setEditExpected] = useState('');
  const [savingSample, setSavingSample] = useState(false);
  const [deletingSampleIds, setDeletingSampleIds] = useState<Set<string>>(new Set());

  // ─── Add sample state ───
  const [addingSample, setAddingSample] = useState(false);
  const [newInput, setNewInput] = useState('');
  const [newExpected, setNewExpected] = useState('');
  const [savingNew, setSavingNew] = useState(false);

  // ─── Versioning state ───
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [creatingVersion, setCreatingVersion] = useState(false);

  const showVersionControl = searchParams.get('vc') === '1';

  const setVersionControlOpen = useCallback(
    (open: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      if (open) {
        params.set('vc', '1');
      } else {
        params.delete('vc');
      }
      const nextQuery = params.toString();
      const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      router.replace(nextUrl, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const getDatasetDetailUrl = useCallback(
    (datasetId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (showVersionControl) {
        params.set('vc', '1');
      } else {
        params.delete('vc');
      }
      const query = params.toString();
      return query ? `/datasets/${datasetId}?${query}` : `/datasets/${datasetId}`;
    },
    [searchParams, showVersionControl]
  );

  // ─── Tag state ───
  const [tagInput, setTagInput] = useState('');
  const [savingTags, setSavingTags] = useState(false);

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

  const handleExport = (format: 'csv' | 'jsonl') => {
    const url = `/api/datasets/${id}/export?format=${format}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exporting dataset as ${format.toUpperCase()}…`);
  };

  const loadDataset = useCallback(async () => {
    try {
      const res = await fetch(`/api/datasets/${id}`);
      if (res.ok) {
        const data = await res.json();
        setDataset(data);
      } else {
        toast.error('Failed to load dataset');
      }
    } catch {
      toast.error('Failed to load dataset');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadDataset();
  }, [loadDataset]);

  const loadVersions = useCallback(async () => {
    setLoadingVersions(true);
    try {
      const res = await fetch(`/api/datasets/${id}/versions`);
      if (res.ok) {
        setVersions(await res.json());
      }
    } catch {
      // silent
    } finally {
      setLoadingVersions(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) loadVersions();
  }, [id, loadVersions]);

  useEffect(() => {
    if (!id) return;
    const eventSource = new EventSource(
      `/api/events?topic=datasets&datasetId=${encodeURIComponent(id)}`
    );
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
        if (payload.datasetId !== id) return;
        setDataset((previous) => {
          if (!previous) return previous;
          const existingMeta = (() => {
            if (!previous.remoteMetadata) return {} as Record<string, unknown>;
            try {
              const parsed = JSON.parse(previous.remoteMetadata);
              return parsed && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : {};
            } catch {
              return {};
            }
          })();
          return {
            ...previous,
            remoteMetadata: JSON.stringify({
              ...existingMeta,
              evaluationSummary: payload.summary,
            }),
          };
        });
      } catch {
        // ignore
      }
    };
    eventSource.addEventListener('dataset.summary.updated', onDatasetSummaryUpdated);
    return () => {
      eventSource.removeEventListener('dataset.summary.updated', onDatasetSummaryUpdated);
      eventSource.close();
    };
  }, [id]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/datasets/${id}/refresh`, { method: 'POST' });
      if (res.ok) {
        const updated = await res.json();
        setDataset((prev) => (prev ? { ...prev, ...updated } : prev));
        toast.success('Metadata refreshed');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to refresh');
      }
    } catch {
      toast.error('Failed to refresh metadata');
    } finally {
      setRefreshing(false);
    }
  };

  /* ─── Sample editing handlers ──────────────────────────────────────────── */

  const startEditing = (sample: DatasetSample) => {
    setEditingSampleId(sample.id);
    setEditInput(sample.input);
    setEditExpected(sample.expected || '');
  };

  const cancelEditing = () => {
    setEditingSampleId(null);
    setEditInput('');
    setEditExpected('');
  };

  const saveEdit = async () => {
    if (!editingSampleId || !editInput.trim()) return;
    setSavingSample(true);
    try {
      const res = await fetch(`/api/datasets/${id}/samples`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sampleId: editingSampleId,
          input: editInput,
          expected: editExpected || null,
        }),
      });
      if (res.ok) {
        toast.success('Sample updated');
        cancelEditing();
        await loadDataset();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to update sample');
      }
    } catch {
      toast.error('Failed to update sample');
    } finally {
      setSavingSample(false);
    }
  };

  const deleteSample = async (sampleId: string) => {
    if (!confirm('Delete this sample?')) return;
    setDeletingSampleIds((prev) => new Set(prev).add(sampleId));
    try {
      const res = await fetch(`/api/datasets/${id}/samples`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sampleIds: [sampleId] }),
      });
      if (res.ok) {
        toast.success('Sample deleted');
        await loadDataset();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to delete sample');
      }
    } catch {
      toast.error('Failed to delete sample');
    } finally {
      setDeletingSampleIds((prev) => {
        const next = new Set(prev);
        next.delete(sampleId);
        return next;
      });
    }
  };

  const addSample = async () => {
    if (!newInput.trim()) return;
    setSavingNew(true);
    try {
      const res = await fetch(`/api/datasets/${id}/samples`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          samples: [{
            input: newInput,
            expected: newExpected || undefined,
          }],
        }),
      });
      if (res.ok) {
        toast.success('Sample added');
        setAddingSample(false);
        setNewInput('');
        setNewExpected('');
        await loadDataset();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to add sample');
      }
    } catch {
      toast.error('Failed to add sample');
    } finally {
      setSavingNew(false);
    }
  };

  /* ─── Versioning handlers ──────────────────────────────────────────────── */

  const createNewVersion = async () => {
    if (!dataset) return;
    setCreatingVersion(true);
    try {
      const res = await fetch(`/api/datasets/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const newVersion = await res.json();
        toast.success(`Version ${newVersion.version} created`);
        router.push(getDatasetDetailUrl(newVersion.id));
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create version');
      }
    } catch {
      toast.error('Failed to create version');
    } finally {
      setCreatingVersion(false);
    }
  };

  const revertToVersion = async (versionId: string) => {
    if (!confirm('Revert current samples to this version? Current samples will be replaced.')) return;
    try {
      // Fetch the target version's samples
      const vRes = await fetch(`/api/datasets/${versionId}`);
      if (!vRes.ok) { toast.error('Failed to load version'); return; }
      const versionData = await vRes.json();

      // Replace current dataset's samples with those from the target version
      const res = await fetch(`/api/datasets/${id}/samples`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          samples: versionData.samples.map((s: DatasetSample) => ({
            input: s.input,
            expected: s.expected,
            metadata: s.metadata,
          })),
        }),
      });
      if (res.ok) {
        toast.success('Reverted to selected version');
        await loadDataset();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to revert');
      }
    } catch {
      toast.error('Failed to revert');
    }
  };

  /* ─── Tag handlers ─────────────────────────────────────────────────────── */

  const persistTags = async (nextTags: string[]) => {
    if (!dataset) return;
    const previousTags = dataset.tags;

    setDataset((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tags: JSON.stringify(nextTags),
      };
    });

    setSavingTags(true);
    try {
      const res = await fetch(`/api/datasets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: nextTags }),
      });
      if (res.ok) {
        toast.success('Tag updated');
        router.refresh();
      } else {
        const data = await res.json();
        setDataset((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            tags: previousTags,
          };
        });
        toast.error(data.error || 'Failed to update tag');
      }
    } catch {
      setDataset((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tags: previousTags,
        };
      });
      toast.error('Failed to update tag');
    } finally {
      setSavingTags(false);
    }
  };

  const addTag = async () => {
    const normalized = tagInput.trim();
    if (!normalized || !dataset) return;

    const currentTags = parseJson<string[]>(dataset.tags, []);
    if (currentTags.includes(normalized)) {
      setTagInput('');
      return;
    }

    setTagInput('');
    await persistTags([...currentTags, normalized]);
  };

  const removeTag = async (tag: string) => {
    if (!dataset) return;
    const currentTags = parseJson<string[]>(dataset.tags, []);
    await persistTags(currentTags.filter((t) => t !== tag));
  };

  /* ─── Parse helpers ────────────────────────────────────────────────────── */

  const parseJson = <T,>(json: string | null, fallback: T): T => {
    if (!json) return fallback;
    try {
      return JSON.parse(json);
    } catch {
      return fallback;
    }
  };

  /* ─── Loading / Not found ──────────────────────────────────────────────── */

  if (loading) {
    return (
      <div>
        <Header title="Dataset" />
        <div className="p-6 space-y-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!dataset) {
    return (
      <div>
        <Header
          title="Dataset Not Found"
          breadcrumbs={[
            { label: 'Datasets', href: '/datasets' },
            { label: 'Not Found' },
          ]}
        />
        <div className="p-6">
          <p className="text-surface-500 dark:text-surface-400">
            This dataset doesn&apos;t exist or you don&apos;t have access.
          </p>
        </div>
      </div>
    );
  }

  const tags = parseJson<string[]>(dataset.tags, []);
  const splits = parseJson<string[]>(dataset.splits, []);
  const features = parseJson<any[]>(dataset.features, []);
  const remoteMeta = parseJson<RemoteMeta>(dataset.remoteMetadata, {});
  const evaluationSummary = remoteMeta.evaluationSummary;
  const isLocal = dataset.source === 'local';
  const isQueryOnly = dataset.inputType === 'query';

  const visibleSamples = showAllSamples
    ? dataset.samples
    : dataset.samples.slice(0, 20);

  return (
    <div>
      <Header
        title={dataset.name}
        description={dataset.description || undefined}
        breadcrumbs={[
          { label: 'Datasets', href: '/datasets' },
          { label: dataset.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {/* Version badge */}
            <Badge variant="outline" size="sm">
              v{dataset.version}
            </Badge>

            {/* Export buttons */}
            {dataset.samples.length > 0 && (
              <div className="relative" ref={exportMenuRef}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setExportMenuOpen((prev) => !prev)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export
                </Button>
                {exportMenuOpen && (
                  <div className="absolute right-0 top-full mt-1 z-20 w-48 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 py-1 shadow-lg">
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 dark:bg-surface-800 transition-colors"
                      onClick={() => { handleExport('csv'); setExportMenuOpen(false); }}
                    >
                      📄 Export as CSV
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-sm text-surface-700 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800 dark:bg-surface-800 transition-colors"
                      onClick={() => { handleExport('jsonl'); setExportMenuOpen(false); }}
                    >
                      📋 Export as JSONL
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* New version button for local datasets */}
            {isLocal && (
              <Button
                variant="secondary"
                size="sm"
                onClick={createNewVersion}
                loading={creatingVersion}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                New Version
              </Button>
            )}

            {dataset.source === 'remote' && dataset.huggingFaceId && (
              <>
                <Button variant="secondary" size="sm" onClick={handleRefresh} loading={refreshing}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M23 4v6h-6" /><path d="M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  Refresh
                </Button>
                <a
                  href={dataset.sourceUrl || `https://huggingface.co/datasets/${dataset.huggingFaceId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button variant="outline" size="sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                    View on HuggingFace
                  </Button>
                </a>
              </>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* ─── Overview cards ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Source</p>
              <div className="flex items-center gap-2">
                <Badge variant={dataset.source === 'remote' ? 'default' : 'outline'}>
                  {dataset.source === 'remote' ? '🌐 Remote' : '💾 Local'}
                </Badge>
                <Badge variant={dataset.visibility === 'public' ? 'success' : 'warning'}>
                  {dataset.visibility === 'public' ? '🔓 Public' : '🔒 Private'}
                </Badge>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Input Type</p>
              <Badge variant="outline">
                {isQueryOnly ? '📝 Query Only' : '📝 Query + Response'}
              </Badge>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Samples</p>
              <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {(dataset.sampleCount ?? dataset._count.samples ?? 0).toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Created</p>
              <p className="text-sm font-medium text-surface-700 dark:text-surface-300">
                {formatDate(dataset.createdAt)}
              </p>
              <p className="text-2xs text-surface-400 mt-0.5">
                by {dataset.user.name || dataset.user.email}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ─── Version History ────────────────────────────────────────── */}
        {isLocal && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">
                  Latest Version
                </CardTitle>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setVersionControlOpen(!showVersionControl)}
                >
                  Version Control
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-3 py-2.5 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="default" size="sm">
                    v{versions[0]?.version ?? dataset.version}
                  </Badge>
                  <span className="text-xs text-surface-600 dark:text-surface-400">
                    {(versions[0]?.sampleCount ?? versions[0]?._count?.samples ?? dataset._count?.samples ?? 0)} samples
                  </span>
                  <span className="text-2xs text-surface-400">
                    {formatDate(versions[0]?.createdAt ?? dataset.createdAt)}
                  </span>
                  <span className="text-2xs font-medium text-brand-600">latest</span>
                </div>
              </div>

              {showVersionControl && (
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between px-1">
                    <p className="text-xs font-medium text-surface-600 dark:text-surface-400">
                      Version History
                      <span className="ml-1 text-2xs text-surface-500 dark:text-surface-400">({versions.length} versions)</span>
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setVersionControlOpen(false)}
                    >
                      Hide
                    </Button>
                  </div>

                  {loadingVersions ? (
                    <p className="px-1 py-2 text-xs text-surface-500 dark:text-surface-400">Loading versions…</p>
                  ) : (
                    versions.map((v) => {
                      const isCurrent = v.id === dataset.id;
                      const sampleCount = v.sampleCount ?? v._count?.samples ?? 0;
                      return (
                        <div
                          key={v.id}
                          className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
                            isCurrent
                              ? 'bg-brand-50 border border-brand-200'
                              : 'bg-surface-50 dark:bg-surface-800 border border-surface-100 dark:border-surface-700 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <Badge variant={isCurrent ? 'default' : 'outline'} size="sm">
                              v{v.version}
                            </Badge>
                            <span className="text-xs text-surface-600 dark:text-surface-400">
                              {sampleCount} samples
                            </span>
                            <span className="text-2xs text-surface-400">
                              {formatDate(v.createdAt)}
                            </span>
                            {isCurrent && (
                              <span className="text-2xs font-medium text-brand-600">current</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {!isCurrent && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => router.push(getDatasetDetailUrl(v.id))}
                                >
                                  View
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => revertToVersion(v.id)}
                                >
                                  Revert to this
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ─── Remote metadata panel ─────────────────────────────────── */}
        {dataset.source === 'remote' && dataset.huggingFaceId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">HuggingFace Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-surface-500 dark:text-surface-400">Dataset ID</p>
                  <p className="font-mono text-xs text-surface-800">{dataset.huggingFaceId}</p>
                </div>
                {remoteMeta.author && (
                  <div>
                    <p className="text-xs text-surface-500 dark:text-surface-400">Author</p>
                    <p className="text-surface-800">{remoteMeta.author}</p>
                  </div>
                )}
                {remoteMeta.downloads != null && (
                  <div>
                    <p className="text-xs text-surface-500 dark:text-surface-400">Downloads</p>
                    <p className="text-surface-800">{remoteMeta.downloads.toLocaleString()}</p>
                  </div>
                )}
                {remoteMeta.likes != null && (
                  <div>
                    <p className="text-xs text-surface-500 dark:text-surface-400">Likes</p>
                    <p className="text-surface-800">{remoteMeta.likes}</p>
                  </div>
                )}
                {remoteMeta.lastModified && (
                  <div>
                    <p className="text-xs text-surface-500 dark:text-surface-400">Last Modified</p>
                    <p className="text-surface-800">{formatDate(remoteMeta.lastModified)}</p>
                  </div>
                )}
              </div>
              {splits.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-surface-500 dark:text-surface-400 mb-1.5">Splits</p>
                  <div className="flex flex-wrap gap-1.5">
                    {splits.map((split) => (
                      <Badge key={split} variant="default" size="sm">{split}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {remoteMeta.configs && remoteMeta.configs.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-surface-500 dark:text-surface-400 mb-1.5">Configs</p>
                  <div className="flex flex-wrap gap-1.5">
                    {remoteMeta.configs.map((config) => (
                      <Badge key={config} variant="outline" size="sm">{config}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ─── Local dataset specifics ─────────────────────────────── */}
        {isLocal && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Local Dataset</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" size="sm">
                  Format: {(dataset.format || 'unknown').toUpperCase()}
                </Badge>
                <Badge variant="outline" size="sm">
                  {isQueryOnly ? 'Query Only' : 'Query + Response'}
                </Badge>
                <Badge variant="outline" size="sm">
                  {(dataset.sampleCount ?? dataset._count?.samples ?? 0).toLocaleString()} stored samples
                </Badge>
                <Badge variant="outline" size="sm">
                  v{dataset.version}
                </Badge>
              </div>
              <p className="text-surface-600 dark:text-surface-400 text-xs">
                Local datasets are managed independently from projects. Edit samples inline, then optionally create a new version to snapshot changes.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ─── Tags ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Tags</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ',') && !savingTags) {
                      e.preventDefault();
                      void addTag();
                    }
                  }}
                  placeholder="Add a tag"
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void addTag()}
                  loading={savingTags}
                  disabled={!tagInput.trim()}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add
                </Button>
              </div>

              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => void removeTag(tag)}
                      disabled={savingTags}
                      className="inline-flex items-center gap-1 rounded-full border border-surface-200 dark:border-surface-700 bg-surface-100 dark:bg-surface-700 px-2.5 py-0.5 text-xs text-surface-700 dark:text-surface-300 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                      aria-label={`Remove tag ${tag}`}
                    >
                      {tag}
                      <span className="text-surface-400">×</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-surface-400">No tags yet.</p>
              )}
            </div>
          </CardContent>
        </Card>

        {evaluationSummary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Evaluation Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-surface-500 dark:text-surface-400">Model Avg</p>
                  <p className="text-base font-semibold text-surface-800">
                    {evaluationSummary.averageModelScore != null
                      ? evaluationSummary.averageModelScore.toFixed(1)
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500 dark:text-surface-400">Human Avg</p>
                  <p className="text-base font-semibold text-surface-800">
                    {evaluationSummary.averageHumanScore != null
                      ? evaluationSummary.averageHumanScore.toFixed(1)
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500 dark:text-surface-400">Model Samples</p>
                  <p className="text-base font-semibold text-surface-800">
                    {(evaluationSummary.samplesWithModelScores ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500 dark:text-surface-400">Human Samples</p>
                  <p className="text-base font-semibold text-surface-800">
                    {(evaluationSummary.samplesWithHumanScores ?? 0).toLocaleString()}
                  </p>
                </div>
              </div>
              {evaluationSummary.updatedAt && (
                <p className="mt-3 text-2xs text-surface-400">
                  Updated {formatDate(evaluationSummary.updatedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* ─── Features / Schema ─────────────────────────────────────── */}
        {features.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Features / Schema</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-200 dark:border-surface-700 text-left">
                      <th className="pb-2 pr-4 text-xs font-medium text-surface-500 dark:text-surface-400">Name</th>
                      <th className="pb-2 text-xs font-medium text-surface-500 dark:text-surface-400">Type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f: any, i: number) => (
                      <tr key={i} className="border-b border-surface-100 dark:border-surface-700 last:border-0">
                        <td className="py-1.5 pr-4 font-mono text-xs text-surface-800">{f.name}</td>
                        <td className="py-1.5 text-xs text-surface-600 dark:text-surface-400">{f.type || JSON.stringify(f)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ─── Samples (editable) ────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">
                Samples
                {dataset._count.samples > 0 && (
                  <span className="ml-2 text-xs font-normal text-surface-500 dark:text-surface-400">
                    ({dataset._count.samples.toLocaleString()} total)
                  </span>
                )}
              </CardTitle>
              {isLocal && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setAddingSample(true); setNewInput(''); setNewExpected(''); }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add Sample
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {/* ─── Add new sample inline ─── */}
            {addingSample && (
              <div className="mb-4 rounded-lg border-2 border-dashed border-brand-300 bg-brand-50/30 p-4 space-y-3">
                <p className="text-xs font-semibold text-brand-700">New Sample</p>
                <div>
                  <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                    {isQueryOnly ? 'Query / Input' : 'Input / Prompt'}
                  </label>
                  <Textarea
                    value={newInput}
                    onChange={(e) => setNewInput(e.target.value)}
                    placeholder={isQueryOnly ? 'Enter query text...' : 'Enter input prompt...'}
                    rows={3}
                    className="text-xs"
                    autoFocus
                  />
                </div>
                {!isQueryOnly && (
                  <div>
                    <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                      Expected Output / Response
                    </label>
                    <Textarea
                      value={newExpected}
                      onChange={(e) => setNewExpected(e.target.value)}
                      placeholder="Enter expected response..."
                      rows={3}
                      className="text-xs"
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={addSample} loading={savingNew} disabled={!newInput.trim()}>
                    Add Sample
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setAddingSample(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {dataset.samples.length === 0 && !addingSample ? (
              <p className="text-sm text-surface-500 dark:text-surface-400 py-4 text-center">
                {dataset.source === 'remote'
                  ? 'Samples are hosted remotely. Import them to preview here.'
                  : 'No samples in this dataset yet. Click "Add Sample" to get started.'}
              </p>
            ) : (
              <>
                <div className="divide-y divide-surface-100 dark:divide-surface-700">
                  {visibleSamples.map((sample) => {
                    const isEditing = editingSampleId === sample.id;
                    const isDeleting = deletingSampleIds.has(sample.id);

                    return (
                      <div key={sample.id} className={`py-3 first:pt-0 last:pb-0 ${isDeleting ? 'opacity-50' : ''}`}>
                        {isEditing ? (
                          /* ─── Editing view ─── */
                          <div className="rounded-lg border border-brand-200 bg-brand-50/20 p-3 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="rounded-md bg-brand-100 px-1.5 py-0.5 text-2xs font-mono text-brand-700">
                                #{sample.index + 1}
                              </span>
                              <span className="text-2xs text-brand-600 font-medium">Editing</span>
                            </div>
                            <div>
                              <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                                {isQueryOnly ? 'Query / Input' : 'Input / Prompt'}
                              </label>
                              <Textarea
                                value={editInput}
                                onChange={(e) => setEditInput(e.target.value)}
                                rows={3}
                                className="text-xs"
                                autoFocus
                              />
                            </div>
                            {!isQueryOnly && (
                              <div>
                                <label className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-1 block">
                                  Expected Output
                                </label>
                                <Textarea
                                  value={editExpected}
                                  onChange={(e) => setEditExpected(e.target.value)}
                                  rows={3}
                                  className="text-xs"
                                />
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <Button variant="primary" size="sm" onClick={saveEdit} loading={savingSample} disabled={!editInput.trim()}>
                                Save
                              </Button>
                              <Button variant="ghost" size="sm" onClick={cancelEditing}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          /* ─── Display view ─── */
                          <div className="flex items-start gap-3 group">
                            <span className="shrink-0 mt-0.5 rounded-md bg-surface-100 dark:bg-surface-700 px-1.5 py-0.5 text-2xs font-mono text-surface-500 dark:text-surface-400">
                              #{sample.index + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-surface-800 whitespace-pre-wrap line-clamp-4">
                                {sample.input}
                              </p>
                              {sample.expected && (
                                <div className="mt-1.5 rounded-md bg-green-50 border border-green-200 px-2.5 py-1.5">
                                  <p className="text-2xs text-green-700 font-medium mb-0.5">Expected:</p>
                                  <p className="text-xs text-green-800 whitespace-pre-wrap line-clamp-3">
                                    {sample.expected}
                                  </p>
                                </div>
                              )}
                            </div>
                            {isLocal && (
                              <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  onClick={() => startEditing(sample)}
                                  className="rounded p-1 text-surface-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950/30 transition-colors"
                                  aria-label="Edit sample"
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => deleteSample(sample.id)}
                                  className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                                  aria-label="Delete sample"
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {dataset.samples.length > 20 && (
                  <div className="mt-3 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowAllSamples(!showAllSamples)}
                    >
                      {showAllSamples
                        ? 'Show fewer'
                        : `Show all ${dataset.samples.length} samples`}
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
