'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ModelJudgmentCard } from '@/components/evaluation/model-judgment-card';
import { HumanJudgmentForm } from '@/components/evaluation/human-judgment-form';
import { SubmissionViewer } from '@/components/evaluation/submission-viewer';
import { safeParseJSON, getScoreColor, cn, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import type { CriteriaScore } from '@/types';

const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  pending:     { label: 'Pending',      variant: 'warning' },
  judging:     { label: 'Judging…',    variant: 'info' },
  needs_human: { label: 'Needs Human',  variant: 'warning' },
  completed:   { label: 'Completed',    variant: 'success' },
  error:       { label: 'Error',        variant: 'error' },
};

export default function RunDetailPage() {
  const params = useParams();
  const router = useRouter();
  const evaluationId = params.id as string;
  const runId = params.runId as string;

  const [run, setRun] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submittingHuman, setSubmittingHuman] = useState(false);
  const [selectedBestModelId, setSelectedBestModelId] = useState<string | null>(null);

  const loadRun = useCallback(async (silent = false) => {
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setRun(data);
        if (data.humanJudgment?.selectedBestModelId) {
          setSelectedBestModelId(data.humanJudgment.selectedBestModelId);
        }
      } else {
        if (!silent) {
          toast.error('Run not found');
          router.push(`/evaluate/${evaluationId}`);
        }
      }
    } catch {
      if (!silent) toast.error('Failed to load run');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [evaluationId, runId, router]);

  useEffect(() => { loadRun(); }, [loadRun]);

  // Poll while judging
  useEffect(() => {
    if (run?.status !== 'judging') return;
    const interval = setInterval(() => loadRun(true), 2500);
    return () => clearInterval(interval);
  }, [run?.status, loadRun]);

  const submitHumanJudgment = async (data: {
    overallScore: number;
    reasoning: string;
    criteriaScores: CriteriaScore[];
    selectedBestModelId: string | null;
  }) => {
    setSubmittingHuman(true);
    try {
      const res = await fetch(
        `/api/evaluations/${evaluationId}/runs/${runId}/human-judgment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
      );
      if (res.ok) {
        toast.success('Human judgment saved');
        loadRun();
      } else {
        const resp = await res.json();
        toast.error(resp.error || 'Failed to save judgment');
      }
    } catch {
      toast.error('Failed to save judgment');
    } finally {
      setSubmittingHuman(false);
    }
  };

  // Keyboard shortcuts for scoring are handled by HumanJudgmentForm

  if (loading) {
    return (
      <div>
        <Skeleton className="h-20 w-full" />
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
            <Skeleton className="h-80 w-full rounded-xl lg:col-span-3" />
            <Skeleton className="h-80 w-full rounded-xl lg:col-span-2" />
          </div>
        </div>
      </div>
    );
  }
  if (!run) return null;

  const evaluation = run.evaluation;
  const rubric = run.rubric ?? null;
  const criteria = rubric?.criteria ?? [];
  const modelJudgments: any[] = run.modelJudgments ?? [];
  const runModelSelections: any[] = run.runModelSelections ?? [];
  const humanJudgment = run.humanJudgment ?? null;

  const completedJudgments = modelJudgments.filter(
    (j) => j.status === 'completed' && j.overallScore !== null
  );
  const avgModelScore =
    completedJudgments.length > 0
      ? completedJudgments.reduce((s: number, j: any) => s + j.overallScore, 0) /
        completedJudgments.length
      : null;

  const sc = statusConfig[run.status] ?? statusConfig.pending;

  return (
    <div>
      <Header
        title={evaluation?.title || 'Evaluation Run'}
        description={evaluation?.project?.name}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: evaluation?.project?.name || 'Project', href: `/projects/${evaluation?.project?.id}` },
          { label: evaluation?.title || 'Evaluation', href: `/evaluate/${evaluationId}` },
          { label: 'Run Detail' },
        ]}
        actions={
          <div className="flex flex-col items-end gap-2">
            {/* Primary status row */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={sc.variant} size="md">{sc.label}</Badge>
              {rubric && (
                <Badge variant="info" size="md">
                  📋 {rubric.name} v{rubric.version}
                </Badge>
              )}
              <Badge variant="default" size="md">
                🤖 {runModelSelections.length} model{runModelSelections.length === 1 ? '' : 's'}
              </Badge>
              {avgModelScore !== null && (
                <div className="px-2 py-1 rounded-md bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-right">
                  <p className="text-2xs text-surface-400">Model Avg</p>
                  <p className={cn('text-sm font-bold font-mono', getScoreColor(avgModelScore))}>
                    {avgModelScore.toFixed(1)}
                  </p>
                </div>
              )}
              {humanJudgment && (
                <div className="px-2 py-1 rounded-md bg-surface-50 dark:bg-surface-800 border border-surface-200 dark:border-surface-700 text-right">
                  <p className="text-2xs text-surface-400">Human</p>
                  <p className={cn('text-sm font-bold font-mono', getScoreColor(humanJudgment.overallScore))}>
                    {humanJudgment.overallScore.toFixed(1)}
                  </p>
                </div>
              )}
            </div>

            {/* Secondary meta row */}
            <div className="flex items-center gap-3 text-xs text-surface-500 dark:text-surface-400">
              <span>
                Run by{' '}
                <span className="font-medium text-surface-700 dark:text-surface-300">
                  {run.triggeredBy?.name || run.triggeredBy?.email}
                </span>
              </span>
              <span>{formatDateTime(run.createdAt)}</span>
              <span className="font-mono text-2xs text-surface-300 hidden md:inline">{run.id}</span>
            </div>
          </div>
        }
      />

      <div className="p-6">
        {/* Warning banners */}
        {!rubric && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            No rubric was assigned to this run. Human-only scoring is still available.
          </div>
        )}
        {run.status === 'judging' && (
          <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800 flex items-center gap-2">
            <svg className="h-4 w-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle className="opacity-25" cx="12" cy="12" r="10" />
              <path className="opacity-75" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" stroke="none" />
            </svg>
            Models are evaluating — results will appear automatically.
          </div>
        )}
        {run.status === 'needs_human' && !humanJudgment && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            Model evaluations complete. Submit your human judgment to finalize this run.
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* ── Left: Submission + Model Judgments ───────────────────────── */}
          <div className="lg:col-span-3 space-y-6">

            {/* Submission */}
            {evaluation?.promptText ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-surface-100 dark:border-surface-700 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Prompt (Input)</h3>
                      {evaluation?.dataset && (
                        <Badge variant="info" size="sm">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-0.5" aria-hidden="true">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                          </svg>
                          {evaluation.dataset.name}
                          {evaluation.datasetSample && ` #${evaluation.datasetSample.index + 1}`}
                        </Badge>
                      )}
                    </div>
                    <span className="text-2xs text-surface-400">
                      {evaluation?.promptText?.length?.toLocaleString()} chars
                    </span>
                  </div>
                  <div className="p-4 overflow-y-auto">
                    <div className="prose prose-sm max-w-none text-surface-700 dark:text-surface-300 whitespace-pre-wrap break-words">
                      {evaluation?.promptText}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-surface-100 dark:border-surface-700 px-4 py-3">
                    <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Response (Output to Judge)</h3>
                    <span className="text-2xs text-surface-400">
                      {(evaluation?.responseText || evaluation?.inputText || '').length.toLocaleString()} chars
                    </span>
                  </div>
                  <div className="p-4 overflow-y-auto">
                    <div className="prose prose-sm max-w-none text-surface-700 dark:text-surface-300 whitespace-pre-wrap break-words">
                      {evaluation?.responseText || evaluation?.inputText}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-hidden">
                <div className="flex items-center justify-between border-b border-surface-100 dark:border-surface-700 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Submission</h3>
                    {evaluation?.dataset && (
                      <Badge variant="info" size="sm">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mr-0.5" aria-hidden="true">
                          <ellipse cx="12" cy="5" rx="9" ry="3" />
                          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                        {evaluation.dataset.name}
                        {evaluation.datasetSample && ` #${evaluation.datasetSample.index + 1}`}
                      </Badge>
                    )}
                  </div>
                  <span className="text-2xs text-surface-400">
                    {evaluation?.inputText?.length?.toLocaleString()} chars
                  </span>
                </div>
                <div className="p-4 overflow-y-auto">
                  <div className="prose prose-sm max-w-none text-surface-700 dark:text-surface-300 whitespace-pre-wrap break-words">
                    {evaluation?.inputText}
                  </div>
                </div>
              </div>
            )}

            {/* Model Judgments */}
            {modelJudgments.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
                    Model Judgments ({modelJudgments.length})
                  </h2>
                  {completedJudgments.length > 0 && (
                    <span className="text-xs text-surface-400">Click to select as best</span>
                  )}
                </div>

                <Tabs defaultValue="grid">
                  <TabsList>
                    <TabsTrigger value="grid">Grid</TabsTrigger>
                    <TabsTrigger value="comparison">Compare</TabsTrigger>
                  </TabsList>

                  <TabsContent value="grid">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      {modelJudgments.map((judgment: any) => (
                        <ModelJudgmentCard
                          key={judgment.id}
                          modelName={judgment.modelConfig.name}
                          provider={judgment.modelConfig.provider}
                          overallScore={judgment.overallScore}
                          reasoning={judgment.reasoning}
                          criteriaScores={judgment.criteriaScores}
                          latencyMs={judgment.latencyMs}
                          tokenCount={judgment.tokenCount}
                          status={judgment.status}
                          error={judgment.error}
                          isSelected={selectedBestModelId === judgment.modelConfig.id}
                          expandedReasoning={true}
                          onSelect={() =>
                            setSelectedBestModelId(
                              selectedBestModelId === judgment.modelConfig.id
                                ? null
                                : judgment.modelConfig.id
                            )
                          }
                        />
                      ))}
                    </div>
                  </TabsContent>

                  <TabsContent value="comparison">
                    <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-surface-100 dark:border-surface-700">
                            <th className="px-4 py-3 text-left text-xs font-semibold text-surface-500 dark:text-surface-400">
                              Criterion
                            </th>
                            {completedJudgments.map((j: any) => (
                              <th key={j.id} className="px-4 py-3 text-center text-xs font-semibold text-surface-500 dark:text-surface-400">
                                {j.modelConfig.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {criteria.map((criterion: any) => (
                            <tr key={criterion.id} className="border-b border-surface-50">
                              <td className="px-4 py-2 text-xs font-medium text-surface-700 dark:text-surface-300">
                                {criterion.name}
                              </td>
                              {completedJudgments.map((j: any) => {
                                const scores = safeParseJSON<CriteriaScore[]>(j.criteriaScores, []);
                                const cs = scores.find(
                                  (s) => s.criterionId === criterion.id || s.criterionName === criterion.name
                                );
                                return (
                                  <td key={j.id} className="px-4 py-2 text-center">
                                    <span className={cn('font-mono text-sm font-semibold', cs ? getScoreColor(cs.score, cs.maxScore) : 'text-surface-300')}>
                                      {cs ? `${cs.score}/${cs.maxScore}` : '—'}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr className="bg-surface-50 dark:bg-surface-800 font-semibold">
                            <td className="px-4 py-2 text-xs text-surface-700 dark:text-surface-300">Overall</td>
                            {completedJudgments.map((j: any) => (
                              <td key={j.id} className="px-4 py-2 text-center">
                                <span className={cn('font-mono text-base', getScoreColor(j.overallScore))}>
                                  {j.overallScore?.toFixed(1)}
                                </span>
                              </td>
                            ))}
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            )}

            {modelJudgments.length === 0 && run.status === 'pending' && (
              <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-8 text-center">
                <p className="text-sm text-surface-500 dark:text-surface-400">
                  No model judgments yet. This run is pending.
                </p>
              </div>
            )}
          </div>

          {/* ── Right: Human Judgment ─────────────────────────────────── */}
          <div className="lg:col-span-2">
            <div className="sticky top-6">
              <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 p-5">
                {rubric ? (
                  <HumanJudgmentForm
                    criteria={criteria}
                    modelJudgmentIds={completedJudgments.map((j: any) => ({
                      id: j.modelConfig.id,
                      name: j.modelConfig.name,
                    }))}
                    existingJudgment={
                      humanJudgment
                        ? {
                            overallScore: humanJudgment.overallScore,
                            reasoning: humanJudgment.reasoning,
                            criteriaScores: safeParseJSON<CriteriaScore[]>(
                              humanJudgment.criteriaScores,
                              []
                            ),
                            selectedBestModelId: humanJudgment.selectedBestModelId,
                          }
                        : undefined
                    }
                    onSubmit={submitHumanJudgment}
                    loading={submittingHuman}
                  />
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-surface-500 dark:text-surface-400">
                      No rubric assigned to this run. Assign a rubric to enable structured scoring.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
