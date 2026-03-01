'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ModelJudgmentCard } from '@/components/evaluation/model-judgment-card';
import { HumanJudgmentForm } from '@/components/evaluation/human-judgment-form';
import { SubmissionViewer } from '@/components/evaluation/submission-viewer';
import {
  safeParseJSON,
  getScoreColor,
  cn,
  buildRubricVersionOptions,
} from '@/lib/utils';
import { toast } from 'sonner';
import type { CriteriaScore } from '@/types';

export default function EvaluatePage() {
  const params = useParams();
  const router = useRouter();
  const evaluationId = params.id as string;

  const [evaluation, setEvaluation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [judging, setJudging] = useState(false);
  const [submittingHuman, setSubmittingHuman] = useState(false);
  const [selectedBestModelId, setSelectedBestModelId] = useState<string | null>(
    null
  );
  const [allRubrics, setAllRubrics] = useState<any[]>([]);
  const [changeRubricOpen, setChangeRubricOpen] = useState(false);
  const [nextRubricId, setNextRubricId] = useState('');
  const [savingRubric, setSavingRubric] = useState(false);

  const loadEvaluation = useCallback(async () => {
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}`);
      if (res.ok) {
        const data = await res.json();
        setEvaluation(data);
        if (data.humanJudgment?.selectedBestModelId) {
          setSelectedBestModelId(data.humanJudgment.selectedBestModelId);
        }
      } else {
        toast.error('Evaluation not found');
        router.push('/projects');
      }
    } catch {
      toast.error('Failed to load evaluation');
    } finally {
      setLoading(false);
    }
  }, [evaluationId, router]);

  useEffect(() => {
    loadEvaluation();
  }, [loadEvaluation]);

  useEffect(() => {
    fetch('/api/rubrics')
      .then((res) => res.json())
      .then((data) => setAllRubrics(data))
      .catch(() => {});
  }, []);

  // Poll while judging
  useEffect(() => {
    if (evaluation?.status !== 'judging') return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/evaluations/${evaluationId}`);
      if (res.ok) {
        const data = await res.json();
        setEvaluation(data);
        if (data.status !== 'judging') {
          clearInterval(interval);
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [evaluation?.status, evaluationId]);

  const runJudgment = async () => {
    setJudging(true);
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}/judge`, {
        method: 'POST',
      });

      if (res.ok) {
        const data = await res.json();
        setEvaluation(data.evaluation);
        if (data.summary.errors > 0) {
          toast.warning(
            `${data.summary.completed}/${data.summary.total} models completed. ${data.summary.errors} had errors.`
          );
        } else {
          toast.success(
            `All ${data.summary.total} models completed evaluation`
          );
        }
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to run evaluation');
        // Reload to get updated status
        loadEvaluation();
      }
    } catch {
      toast.error('Failed to run evaluation');
      loadEvaluation();
    } finally {
      setJudging(false);
    }
  };

  const submitHumanJudgment = async (data: {
    overallScore: number;
    reasoning: string;
    criteriaScores: CriteriaScore[];
    selectedBestModelId: string | null;
  }) => {
    setSubmittingHuman(true);
    try {
      const res = await fetch(
        `/api/evaluations/${evaluationId}/human-judgment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }
      );

      if (res.ok) {
        toast.success('Human judgment saved');
        loadEvaluation();
      } else {
        const responseData = await res.json();
        toast.error(responseData.error || 'Failed to save judgment');
      }
    } catch {
      toast.error('Failed to save judgment');
    } finally {
      setSubmittingHuman(false);
    }
  };

  const saveEvaluationRubric = async () => {
    if (!nextRubricId) return;

    const currentRubricId =
      evaluation?.rubric?.id ?? evaluation?.project?.rubric?.id ?? '';
    const isRubricChanging = !!nextRubricId && nextRubricId !== currentRubricId;

    if (!isRubricChanging) {
      setChangeRubricOpen(false);
      return;
    }

    const hasModelJudgments = (evaluation?.modelJudgments?.length ?? 0) > 0;
    const shouldClearModelJudgments = hasModelJudgments
      ? window.confirm(
          'Changing the rubric will clear existing model judgments for this evaluation. Continue?'
        )
      : false;

    if (hasModelJudgments && !shouldClearModelJudgments) {
      return;
    }

    setSavingRubric(true);
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rubricId: nextRubricId,
          clearModelJudgments: shouldClearModelJudgments,
        }),
      });

      if (res.ok) {
        setLoading(true);
        await loadEvaluation();
        setChangeRubricOpen(false);
        toast.success('Evaluation rubric updated');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to update rubric');
      }
    } catch {
      toast.error('Failed to update rubric');
    } finally {
      setSavingRubric(false);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT';

      // Ctrl+E to run evaluation
      if ((e.ctrlKey || e.metaKey) && e.key === 'e' && !isInput) {
        e.preventDefault();
        if (!judging) runJudgment();
      }

      // Ctrl+Enter to submit (handled in form)
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // Form submission handled by the HumanJudgmentForm
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [judging]);

  if (loading) {
    return (
      <div>
        <Skeleton className="h-20 w-full" />
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Skeleton className="h-80 w-full rounded-xl" />
            <Skeleton className="h-80 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (!evaluation) return null;

  const rubric = evaluation.rubric ?? evaluation.project?.rubric;
  const criteria = rubric?.criteria ?? [];
  const modelJudgments = evaluation.modelJudgments ?? [];
  const humanJudgment = evaluation.humanJudgment;

  const latestVersionByFamily = new Map<string, number>();
  for (const r of allRubrics) {
    const familyId = r.parentId ?? r.id;
    const version = r.version ?? 1;
    const current = latestVersionByFamily.get(familyId) ?? 0;
    if (version > current) latestVersionByFamily.set(familyId, version);
  }

  const currentRubricVersion = rubric?.version ?? 1;
  const currentRubricFamilyId = rubric ? rubric.parentId ?? rubric.id : null;
  const currentRubricIsLatest = currentRubricFamilyId
    ? (latestVersionByFamily.get(currentRubricFamilyId) ?? currentRubricVersion) ===
      currentRubricVersion
    : false;

  // Compute average model score
  const completedJudgments = modelJudgments.filter(
    (j: any) => j.status === 'completed' && j.overallScore !== null
  );
  const avgModelScore =
    completedJudgments.length > 0
      ? completedJudgments.reduce(
          (sum: number, j: any) => sum + j.overallScore,
          0
        ) / completedJudgments.length
      : null;

  return (
    <div>
      <Header
        title={evaluation.title || 'Evaluation'}
        description={evaluation.project?.name}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          {
            label: evaluation.project?.name || 'Project',
            href: `/projects/${evaluation.project?.id}`,
          },
          { label: evaluation.title || 'Evaluation' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {/* Score summary */}
            {avgModelScore !== null && (
              <div className="text-right mr-2">
                <p className="text-2xs text-surface-400">Avg Model Score</p>
                <p
                  className={cn(
                    'text-lg font-bold font-mono',
                    getScoreColor(avgModelScore)
                  )}
                >
                  {avgModelScore.toFixed(1)}
                </p>
              </div>
            )}
            {humanJudgment && (
              <div className="text-right mr-2">
                <p className="text-2xs text-surface-400">Human Score</p>
                <p
                  className={cn(
                    'text-lg font-bold font-mono',
                    getScoreColor(humanJudgment.overallScore)
                  )}
                >
                  {humanJudgment.overallScore.toFixed(1)}
                </p>
              </div>
            )}
            <Badge
              variant={
                evaluation.status === 'completed'
                  ? 'success'
                  : evaluation.status === 'error'
                    ? 'error'
                    : evaluation.status === 'judging'
                      ? 'info'
                      : 'warning'
              }
              size="md"
            >
              {evaluation.status}
            </Badge>
            {rubric && (
              <Badge variant="info" size="md">
                📋 {rubric.name} v{currentRubricVersion}
                {currentRubricIsLatest ? ' (latest)' : ''}
              </Badge>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setNextRubricId(rubric?.id || '');
                setChangeRubricOpen(true);
              }}
            >
              Change Rubric
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={runJudgment}
              loading={judging || evaluation.status === 'judging'}
              disabled={!rubric}
            >
              {modelJudgments.length > 0 ? 'Re-run Models' : 'Run Models'}
            </Button>
          </div>
        }
      />

      <div className="p-6">
        {/* Warning if no rubric */}
        {!rubric && (
          <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            No rubric assigned to this project. Please{' '}
            <a
              href="/rubrics"
              className="underline font-medium hover:text-amber-900"
            >
              create and assign a rubric
            </a>{' '}
            to enable model evaluations.
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* Left Column: Submission + Model Judgments */}
          <div className="lg:col-span-3 space-y-6">
            {/* Submission */}
            <SubmissionViewer
              text={evaluation.inputText}
              title={evaluation.title}
            />

            {/* Model Judgments */}
            {modelJudgments.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-surface-700">
                    Model Judgments ({modelJudgments.length})
                  </h2>
                  {completedJudgments.length > 0 && (
                    <span className="text-xs text-surface-400">
                      Click to select as best
                    </span>
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
                          isSelected={
                            selectedBestModelId === judgment.modelConfig.id
                          }
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
                    <div className="rounded-xl border border-surface-200 bg-white overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-surface-100">
                            <th className="px-4 py-3 text-left text-xs font-semibold text-surface-500">
                              Criterion
                            </th>
                            {completedJudgments.map((j: any) => (
                              <th
                                key={j.id}
                                className="px-4 py-3 text-center text-xs font-semibold text-surface-500"
                              >
                                {j.modelConfig.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {criteria.map((criterion: any) => (
                            <tr
                              key={criterion.id}
                              className="border-b border-surface-50"
                            >
                              <td className="px-4 py-2 text-xs font-medium text-surface-700">
                                {criterion.name}
                              </td>
                              {completedJudgments.map((j: any) => {
                                const scores = safeParseJSON<CriteriaScore[]>(
                                  j.criteriaScores,
                                  []
                                );
                                const cs = scores.find(
                                  (s) =>
                                    s.criterionId === criterion.id ||
                                    s.criterionName === criterion.name
                                );
                                return (
                                  <td
                                    key={j.id}
                                    className="px-4 py-2 text-center"
                                  >
                                    <span
                                      className={cn(
                                        'font-mono text-sm font-semibold',
                                        cs
                                          ? getScoreColor(
                                              cs.score,
                                              cs.maxScore
                                            )
                                          : 'text-surface-300'
                                      )}
                                    >
                                      {cs
                                        ? `${cs.score}/${cs.maxScore}`
                                        : '—'}
                                    </span>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          <tr className="bg-surface-50 font-semibold">
                            <td className="px-4 py-2 text-xs text-surface-700">
                              Overall
                            </td>
                            {completedJudgments.map((j: any) => (
                              <td
                                key={j.id}
                                className="px-4 py-2 text-center"
                              >
                                <span
                                  className={cn(
                                    'font-mono text-base',
                                    getScoreColor(j.overallScore)
                                  )}
                                >
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
          </div>

          {/* Right Column: Human Judgment */}
          <div className="lg:col-span-2">
            <div className="sticky top-6">
              <div className="rounded-xl border border-surface-200 bg-white p-5">
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
                            selectedBestModelId:
                              humanJudgment.selectedBestModelId,
                          }
                        : undefined
                    }
                    onSubmit={submitHumanJudgment}
                    loading={submittingHuman}
                  />
                ) : (
                  <div className="text-center py-8">
                    <p className="text-sm text-surface-500">
                      Assign a rubric to this project to enable scoring.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={changeRubricOpen} onOpenChange={setChangeRubricOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Evaluation Rubric</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Select
              label="Rubric"
              value={nextRubricId}
              onChange={(e) => setNextRubricId(e.target.value)}
              options={buildRubricVersionOptions(allRubrics)}
              hint="This changes only this evaluation. The project rubric is unchanged."
            />
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setChangeRubricOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={savingRubric}
              disabled={!nextRubricId}
              onClick={saveEvaluationRubric}
            >
              Save Rubric
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
