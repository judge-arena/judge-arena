'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, formatDateTime, getScoreColor } from '@/lib/utils';
import {
  buildDatasetRunGroups,
  getEvaluationRunCount,
  getLatestModelAverage,
  getLatestRun,
  summarizeDatasetRunGroup,
} from '@/lib/dataset-run-groups';
import { toast } from 'sonner';

const statusVariantMap: Record<string, 'default' | 'success' | 'warning' | 'error' | 'info'> = {
  pending: 'warning',
  judging: 'info',
  needs_human: 'warning',
  completed: 'success',
  error: 'error',
};

export default function DatasetRunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const groupKey = decodeURIComponent(params.groupKey as string);

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const loadProject = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}`);
      if (!response.ok) {
        toast.error('Project not found');
        router.push('/projects');
        return;
      }

      const data = await response.json();
      setProject(data);
    } catch {
      toast.error('Failed to load dataset run');
      router.push(`/projects/${projectId}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  if (loading) {
    return (
      <div>
        <Skeleton className="h-20 w-full" />
        <div className="p-6 space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!project) return null;

  const groups = buildDatasetRunGroups(project.evaluations ?? [], project.datasets ?? []);
  const group = groups.find((item) => item.key === groupKey);

  if (!group) {
    return (
      <div>
        <Header
          title="Dataset Run Not Found"
          breadcrumbs={[
            { label: 'Projects', href: '/projects' },
            { label: project.name, href: `/projects/${projectId}` },
            { label: 'Dataset Runs' },
          ]}
        />
        <div className="p-6">
          <EmptyState
            title="Dataset run not found"
            description="This dataset run may have been removed or the link is outdated."
            action={
              <Link href={`/projects/${projectId}`} className="inline-flex">
                <span className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white">
                  Back to Project
                </span>
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const summary = summarizeDatasetRunGroup(group);
  const aggregateStatus = summary.aggregateStatus;

  return (
    <div>
      <Header
        title={`Dataset ${group.datasetName} Run`}
        description={`${group.evaluations.length} samples`}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: project.name, href: `/projects/${projectId}` },
          { label: `Dataset ${group.datasetName} Run` },
        ]}
      />

      <div className="p-6 space-y-6">
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <Badge variant="info" size="sm">Dataset Run</Badge>
              <Badge variant="outline" size="sm">{group.datasetId}</Badge>
              <Badge variant={statusVariantMap[aggregateStatus] ?? 'default'} size="sm">
                {aggregateStatus === 'needs_human' ? 'Needs Human' : aggregateStatus}
              </Badge>
              <Badge variant="default" size="sm">
                {group.evaluations.length} sample{group.evaluations.length === 1 ? '' : 's'}
              </Badge>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-surface-200 p-3">
                <p className="text-2xs uppercase tracking-wide text-surface-500">Model Avg</p>
                <p className={cn('text-xl font-bold font-mono', getScoreColor(summary.modelAverageAcrossSamples ?? 0))}>
                  {summary.modelAverageAcrossSamples !== null ? summary.modelAverageAcrossSamples.toFixed(1) : '—'}
                </p>
                <p className="text-2xs text-surface-400">
                  {summary.samplesWithModelScores}/{group.evaluations.length} samples
                </p>
              </div>

              <div className="rounded-lg border border-surface-200 p-3">
                <p className="text-2xs uppercase tracking-wide text-surface-500">Human Avg</p>
                <p className={cn('text-xl font-bold font-mono', getScoreColor(summary.humanAverageAcrossSamples ?? 0))}>
                  {summary.humanAverageAcrossSamples !== null ? summary.humanAverageAcrossSamples.toFixed(1) : '—'}
                </p>
                <p className="text-2xs text-surface-400">
                  {summary.samplesWithHumanScores}/{group.evaluations.length} samples
                </p>
              </div>

              <div className="rounded-lg border border-surface-200 p-3">
                <p className="text-2xs uppercase tracking-wide text-surface-500">Started</p>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-surface-800">{formatDateTime(group.startedAt)}</p>
                  <span className="inline-flex items-center rounded-full border border-surface-200 bg-surface-100 px-2 py-0.5 text-2xs text-surface-600">
                    {group.datasetId}
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-surface-200 p-3">
                <p className="text-2xs uppercase tracking-wide text-surface-500">Ended</p>
                <p className="text-sm font-medium text-surface-800">{formatDateTime(group.endedAt)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-surface-700">
            Samples ({group.evaluations.length})
          </h2>

          <div className="divide-y divide-surface-100 rounded-xl border border-surface-200 bg-white">
            {group.evaluations.map((evaluation) => {
              const latestRun = getLatestRun(evaluation);
              const runCount = getEvaluationRunCount(evaluation);
              const modelAverage = getLatestModelAverage(evaluation);

              return (
                <Link
                  key={evaluation.id}
                  href={latestRun ? `/evaluate/${evaluation.id}/runs/${latestRun.id}` : `/evaluate/${evaluation.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-surface-50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-surface-900 truncate">
                        Sample #{(evaluation.datasetSample?.index ?? 0) + 1}
                      </p>
                      {latestRun && (
                        <Badge variant={statusVariantMap[latestRun.status] ?? 'default'} size="sm">
                          {latestRun.status === 'needs_human' ? 'Needs Human' : latestRun.status}
                        </Badge>
                      )}
                      <Badge variant="default" size="sm">
                        {runCount} run{runCount === 1 ? '' : 's'}
                      </Badge>
                    </div>
                    <p className="text-xs text-surface-400 truncate mt-0.5">
                      {formatDateTime(evaluation.createdAt)} · {(evaluation.inputText?.length ?? 0).toLocaleString()} chars
                    </p>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {modelAverage !== null && (
                      <div className="text-center">
                        <div className={cn('text-base font-bold font-mono', getScoreColor(modelAverage))}>
                          {modelAverage.toFixed(1)}
                        </div>
                        <div className="text-2xs text-surface-400">Model Avg</div>
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
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
