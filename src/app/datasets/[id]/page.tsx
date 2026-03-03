'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { Header } from '@/components/layout/header';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

interface DatasetDetail {
  id: string;
  name: string;
  description: string | null;
  source: string;
  visibility: string;
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
  const id = params.id as string;

  const [dataset, setDataset] = useState<DatasetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAllSamples, setShowAllSamples] = useState(false);

  const loadDataset = useCallback(async () => {
    try {
      const res = await fetch(`/api/datasets/${id}`);
      if (res.ok) {
        setDataset(await res.json());
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
  }, [id]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/datasets/${id}/refresh`, {
        method: 'POST',
      });
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
          <p className="text-surface-500">
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

  const visibleSamples = showAllSamples
    ? dataset.samples
    : dataset.samples.slice(0, 10);

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
            {dataset.source === 'remote' && dataset.huggingFaceId && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRefresh}
                  loading={refreshing}
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
                    <path d="M23 4v6h-6" />
                    <path d="M1 20v-6h6" />
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
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 mb-1">Source</p>
              <div className="flex items-center gap-2">
                <Badge
                  variant={dataset.source === 'remote' ? 'default' : 'outline'}
                >
                  {dataset.source === 'remote' ? '🌐 Remote' : '💾 Local'}
                </Badge>
                <Badge
                  variant={
                    dataset.visibility === 'public' ? 'success' : 'warning'
                  }
                >
                  {dataset.visibility === 'public' ? '🔓 Public' : '🔒 Private'}
                </Badge>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 mb-1">Samples</p>
              <p className="text-2xl font-bold text-surface-900">
                {(
                  dataset.sampleCount ??
                  dataset._count.samples ??
                  0
                ).toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 mb-1">Created</p>
              <p className="text-sm font-medium text-surface-700">
                {formatDate(dataset.createdAt)}
              </p>
              <p className="text-2xs text-surface-400 mt-0.5">
                by {dataset.user.name || dataset.user.email}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ─── Remote metadata panel ─────────────────────────────────── */}
        {dataset.source === 'remote' && dataset.huggingFaceId && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">HuggingFace Metadata</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-surface-500">Dataset ID</p>
                  <p className="font-mono text-xs text-surface-800">
                    {dataset.huggingFaceId}
                  </p>
                </div>
                {remoteMeta.author && (
                  <div>
                    <p className="text-xs text-surface-500">Author</p>
                    <p className="text-surface-800">{remoteMeta.author}</p>
                  </div>
                )}
                {remoteMeta.downloads != null && (
                  <div>
                    <p className="text-xs text-surface-500">Downloads</p>
                    <p className="text-surface-800">
                      {remoteMeta.downloads.toLocaleString()}
                    </p>
                  </div>
                )}
                {remoteMeta.likes != null && (
                  <div>
                    <p className="text-xs text-surface-500">Likes</p>
                    <p className="text-surface-800">{remoteMeta.likes}</p>
                  </div>
                )}
                {remoteMeta.lastModified && (
                  <div>
                    <p className="text-xs text-surface-500">Last Modified</p>
                    <p className="text-surface-800">
                      {formatDate(remoteMeta.lastModified)}
                    </p>
                  </div>
                )}
              </div>

              {splits.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs text-surface-500 mb-1.5">Splits</p>
                  <div className="flex flex-wrap gap-1.5">
                    {splits.map((split) => (
                      <Badge key={split} variant="default" size="sm">
                        {split}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {remoteMeta.configs && remoteMeta.configs.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-surface-500 mb-1.5">Configs</p>
                  <div className="flex flex-wrap gap-1.5">
                    {remoteMeta.configs.map((config) => (
                      <Badge key={config} variant="outline" size="sm">
                        {config}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ─── Local dataset specifics ─────────────────────────────── */}
        {dataset.source === 'local' && (
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
                  {(dataset.sampleCount ?? dataset._count?.samples ?? 0).toLocaleString()} stored samples
                </Badge>
              </div>
              <p className="text-surface-600 text-xs">
                Local datasets are managed independently from projects and evaluations. Use tags and visibility to organize access.
              </p>
            </CardContent>
          </Card>
        )}

        {/* ─── Tags ──────────────────────────────────────────────────── */}
        {tags.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-block rounded-full bg-surface-100 px-2.5 py-0.5 text-xs text-surface-700"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {evaluationSummary && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Evaluation Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs text-surface-500">Model Avg</p>
                  <p className="text-base font-semibold text-surface-800">
                    {evaluationSummary.averageModelScore != null
                      ? evaluationSummary.averageModelScore.toFixed(1)
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500">Human Avg</p>
                  <p className="text-base font-semibold text-surface-800">
                    {evaluationSummary.averageHumanScore != null
                      ? evaluationSummary.averageHumanScore.toFixed(1)
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500">Model Samples</p>
                  <p className="text-base font-semibold text-surface-800">
                    {(evaluationSummary.samplesWithModelScores ?? 0).toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-surface-500">Human Samples</p>
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
                    <tr className="border-b border-surface-200 text-left">
                      <th className="pb-2 pr-4 text-xs font-medium text-surface-500">
                        Name
                      </th>
                      <th className="pb-2 text-xs font-medium text-surface-500">
                        Type
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f: any, i: number) => (
                      <tr
                        key={i}
                        className="border-b border-surface-100 last:border-0"
                      >
                        <td className="py-1.5 pr-4 font-mono text-xs text-surface-800">
                          {f.name}
                        </td>
                        <td className="py-1.5 text-xs text-surface-600">
                          {f.type || JSON.stringify(f)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ─── Samples preview table ─────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">
                Samples
                {dataset._count.samples > 0 && (
                  <span className="ml-2 text-xs font-normal text-surface-500">
                    ({dataset._count.samples.toLocaleString()} total)
                  </span>
                )}
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {dataset.samples.length === 0 ? (
              <p className="text-sm text-surface-500 py-4 text-center">
                {dataset.source === 'remote'
                  ? 'Samples are hosted remotely. Import them to preview here.'
                  : 'No samples in this dataset yet.'}
              </p>
            ) : (
              <>
                <div className="divide-y divide-surface-100">
                  {visibleSamples.map((sample) => (
                    <div key={sample.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <span className="shrink-0 mt-0.5 rounded-md bg-surface-100 px-1.5 py-0.5 text-2xs font-mono text-surface-500">
                          #{sample.index + 1}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-surface-800 whitespace-pre-wrap line-clamp-4">
                            {sample.input}
                          </p>
                          {sample.expected && (
                            <div className="mt-1.5 rounded-md bg-green-50 border border-green-200 px-2.5 py-1.5">
                              <p className="text-2xs text-green-700 font-medium mb-0.5">
                                Expected:
                              </p>
                              <p className="text-xs text-green-800 whitespace-pre-wrap line-clamp-3">
                                {sample.expected}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {dataset.samples.length > 10 && (
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
