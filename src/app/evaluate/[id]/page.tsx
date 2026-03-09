'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SubmissionViewer } from '@/components/evaluation/submission-viewer';
import {
  buildRubricVersionOptions,
  cn,
  formatDateTime,
  getScoreColor,
} from '@/lib/utils';
import { toast } from 'sonner';

const statusConfig: Record<string, { label: string; variant: 'default' | 'success' | 'warning' | 'error' | 'info' }> = {
  pending:     { label: 'Pending',      variant: 'warning' },
  judging:     { label: 'Judging',      variant: 'info' },
  needs_human: { label: 'Needs Human Action',  variant: 'warning' },
  completed:   { label: 'Completed',    variant: 'success' },
  error:       { label: 'Error',        variant: 'error' },
};

export default function EvaluateTemplatePage() {
  const params = useParams();
  const router = useRouter();
  const evaluationId = params.id as string;

  const [evaluation, setEvaluation] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // "New Run" dialog state
  const [newRunOpen, setNewRunOpen] = useState(false);
  const [allRubrics, setAllRubrics] = useState<any[]>([]);
  const [allModels, setAllModels] = useState<any[]>([]);
  const [runRubricId, setRunRubricId] = useState('');
  const [runModelIds, setRunModelIds] = useState<string[]>([]);
  const [runModelSearch, setRunModelSearch] = useState('');
  const [quickAddModel, setQuickAddModel] = useState('');
  const [launching, setLaunching] = useState(false);

  // Edit template defaults
  const [changeRubricOpen, setChangeRubricOpen] = useState(false);
  const [nextRubricId, setNextRubricId] = useState('');
  const [savingRubric, setSavingRubric] = useState(false);

  const loadEvaluation = useCallback(async () => {
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}`);
      if (res.ok) {
        setEvaluation(await res.json());
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
    Promise.all([
      fetch('/api/rubrics').then((r) => r.json()).catch(() => []),
      fetch('/api/models').then((r) => r.json()).catch(() => []),
    ]).then(([rubrics, models]) => {
      setAllRubrics(rubrics ?? []);
      const usable = (models ?? []).filter((m: any) => m.isActive && m.isVerified);
      setAllModels(usable);
    });
  }, []);

  const openNewRun = () => {
    // No default models at template level; run starts with explicit selection
    setRunRubricId(evaluation?.rubric?.id ?? '');
    setRunModelIds([]);
    setRunModelSearch('');
    setQuickAddModel('');
    setNewRunOpen(true);
  };

  const toggleRunModel = (id: string) => {
    setRunModelIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 10) { toast.error('Max 10 models per run'); return prev; }
      return [...prev, id];
    });
  };
  const addRunModel = (id: string) => {
    if (!id) return;
    setRunModelIds((prev) => {
      if (prev.includes(id)) return prev;
      if (prev.length >= 10) { toast.error('Max 10 models per run'); return prev; }
      return [...prev, id];
    });
    setQuickAddModel('');
  };

  const launchRun = async () => {
    const mode: 'respond' | 'judge' = evaluation?.responseText ? 'judge' : 'respond';

    if (mode === 'judge' && !runRubricId) {
      toast.error('Please select a rubric for this run');
      return;
    }
    if (runModelIds.length === 0) {
      toast.error('Please select at least one model');
      return;
    }
    setLaunching(true);
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(runRubricId ? { rubricId: runRubricId } : {}),
          modelConfigIds: runModelIds,
        }),
      });
      if (res.ok) {
        const run = await res.json();
        setNewRunOpen(false);
        router.push(`/evaluate/${evaluationId}/runs/${run.id}`);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to start run');
      }
    } catch {
      toast.error('Failed to start run');
    } finally {
      setLaunching(false);
    }
  };

  const saveDefaultRubric = async () => {
    if (!nextRubricId) return;
    setSavingRubric(true);
    try {
      const res = await fetch(`/api/evaluations/${evaluationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rubricId: nextRubricId }),
      });
      if (res.ok) {
        await loadEvaluation();
        setChangeRubricOpen(false);
        toast.success('Default rubric updated');
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

  if (loading) {
    return (
      <div>
        <Skeleton className="h-20 w-full" />
        <div className="p-6 space-y-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    );
  }
  if (!evaluation) return null;

  const rubric = evaluation.rubric;
  const runs: any[] = evaluation.runs ?? [];
  const evaluationMode: 'respond' | 'judge' = evaluation?.responseText ? 'judge' : 'respond';
  const needsHumanLabel =
    evaluationMode === 'respond' ? 'Select Best Response' : 'Needs Human Feedback';

  // Computed: latest run status for the header badge
  const latestRun = runs[0] ?? null;

  // ── New Run dialog filters ──────────────────────────────────────────────
  const runSearchNorm = runModelSearch.trim().toLowerCase();
  const filteredRunModels = allModels.filter((m: any) => {
    if (!runSearchNorm) return true;
    return (
      m.name.toLowerCase().includes(runSearchNorm) ||
      m.provider.toLowerCase().includes(runSearchNorm) ||
      m.modelId.toLowerCase().includes(runSearchNorm)
    );
  });
  const quickRunOptions = [
    { value: '', label: 'Quick add model...' },
    ...filteredRunModels
      .filter((m: any) => !runModelIds.includes(m.id))
      .map((m: any) => ({ value: m.id, label: `${m.name} (${m.provider})` })),
  ];

  return (
    <div>
      <Header
        title={evaluation.title || 'Untitled Evaluation'}
        description={evaluation.project?.name}
        breadcrumbs={[
          { label: 'Projects', href: '/projects' },
          { label: evaluation.project?.name || 'Project', href: `/projects/${evaluation.project?.id}` },
          { label: evaluation.title || 'Evaluation' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            {latestRun && (
              <Badge
                variant={statusConfig[latestRun.status]?.variant ?? 'default'}
                size="md"
              >
                {latestRun.status === 'needs_human'
                  ? needsHumanLabel
                  : statusConfig[latestRun.status]?.label ?? latestRun.status}
              </Badge>
            )}
            <Button variant="primary" size="sm" onClick={openNewRun}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              New Run
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-6">

        {/* ── Template configuration card ───────────────────────────────── */}
        <Card>
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-4 mb-4">
              <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">Evaluation Template</h2>
              <div className="flex items-center gap-2">
                <Badge variant="default" size="sm">
                  {evaluationMode === 'respond' ? 'Respond + Human Judgment' : 'Judge Existing Response'}
                </Badge>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setNextRubricId(rubric?.id ?? '');
                    setChangeRubricOpen(true);
                  }}
                >
                  Change Rubric
                </Button>
              </div>
            </div>

            <div className="mb-4">
              <div className="space-y-1">
                <p className="text-2xs font-semibold uppercase tracking-wider text-surface-400">
                  Default Rubric
                </p>
                {rubric ? (
                  <p className="text-sm text-surface-800 dark:text-surface-200 font-medium">
                    {rubric.name}
                    <span className="ml-1 text-xs text-surface-400">v{rubric.version}</span>
                  </p>
                ) : (
                  <p className="text-sm text-surface-400 italic">No rubric assigned</p>
                )}
              </div>
            </div>

            {/* Dataset context */}
            {evaluation.dataset && (
              <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-600 shrink-0" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
                <div className="text-xs text-blue-800">
                  <span className="font-medium">From dataset:</span>{' '}
                  <a href={`/datasets/${evaluation.dataset.id}`} className="underline hover:text-blue-900">
                    {evaluation.dataset.name}
                  </a>
                  {evaluation.datasetSample && (
                    <span className="ml-1 text-blue-600">
                      (sample #{evaluation.datasetSample.index + 1})
                    </span>
                  )}
                </div>
              </div>
            )}

            {evaluationMode === 'judge' ? (
              <div className="space-y-4">
                <SubmissionViewer
                  text={evaluation.promptText}
                  title="Prompt (Input)"
                />
                <SubmissionViewer
                  text={evaluation.responseText || evaluation.inputText}
                  title="Response (Output to Judge)"
                />
              </div>
            ) : (
              <SubmissionViewer
                text={evaluation.promptText || evaluation.inputText}
                title="Prompt (Input)"
              />
            )}
          </CardContent>
        </Card>

        {/* ── Runs list ─────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-surface-700 dark:text-surface-300">
              Runs ({runs.length})
            </h2>
          </div>

          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description='Click "New Run" to run models against this evaluation template.'
              action={
                <Button variant="primary" onClick={openNewRun}>
                  Start First Run
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {runs.map((run: any, index: number) => {
                const sc = statusConfig[run.status] ?? statusConfig.pending;
                const runStatusLabel =
                  run.status === 'needs_human' ? needsHumanLabel : sc.label;
                const completedJudgments = (run.modelJudgments ?? []).filter(
                  (j: any) => j.status === 'completed' && j.overallScore !== null
                );
                const avgScore =
                  completedJudgments.length > 0
                    ? completedJudgments.reduce((s: number, j: any) => s + j.overallScore, 0) /
                      completedJudgments.length
                    : null;

                return (
                  <Link
                    key={run.id}
                    href={`/evaluate/${evaluationId}/runs/${run.id}`}
                    className="block"
                  >
                    <Card className="hover:border-brand-300 dark:hover:border-brand-600 hover:shadow-sm transition-all cursor-pointer">
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          {/* Run number + ID */}
                          <div className="shrink-0 hidden sm:flex flex-col items-center w-10">
                            <span className="text-xs font-bold text-surface-500 dark:text-surface-400">#{runs.length - index}</span>
                          </div>

                          {/* Meta */}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <Badge variant={sc.variant} size="sm">{runStatusLabel}</Badge>
                              {run.rubric && (
                                <Badge variant="info" size="sm">
                                  📋 {run.rubric.name} v{run.rubric.version}
                                </Badge>
                              )}
                              <Badge variant="default" size="sm">
                                🤖 {(run.runModelSelections ?? []).length} model{(run.runModelSelections ?? []).length === 1 ? '' : 's'}
                              </Badge>
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-xs text-surface-500 dark:text-surface-400">
                              <span>
                                Triggered by{' '}
                                <span className="font-medium text-surface-700 dark:text-surface-300">
                                  {run.triggeredBy?.name || run.triggeredBy?.email}
                                </span>
                              </span>
                              <span>{formatDateTime(run.createdAt)}</span>
                              <span className="font-mono text-2xs text-surface-300 hidden sm:inline">{run.id}</span>
                            </div>
                          </div>

                          {/* Scores */}
                          <div className="flex items-center gap-3 shrink-0">
                            {avgScore !== null && (
                              <div className="text-center">
                                <div className={cn('text-base font-bold font-mono', getScoreColor(avgScore))}>
                                  {avgScore.toFixed(1)}
                                </div>
                                <div className="text-2xs text-surface-400">Avg</div>
                              </div>
                            )}
                            {run.humanJudgment && (
                              <div className="text-center">
                                <div className={cn('text-base font-bold font-mono', getScoreColor(run.humanJudgment.overallScore))}>
                                  {run.humanJudgment.overallScore.toFixed(1)}
                                </div>
                                <div className="text-2xs text-surface-400">Human</div>
                              </div>
                            )}
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-300 shrink-0">
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
          )}
        </div>
      </div>

      {/* ── New Run Dialog ──────────────────────────────────────────────── */}
      <Dialog open={newRunOpen} onOpenChange={setNewRunOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>New Evaluation Run</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-4">
              <p className="text-sm text-surface-500 dark:text-surface-400">
                {evaluationMode === 'respond'
                  ? 'Configure this run by selecting models. Each model will generate a response to the prompt, then human reviewers choose the best response.'
                  : 'Configure this run by selecting a rubric and one or more models. Models will score the existing response against the rubric.'}
              </p>

              <Select
                label="Rubric"
                value={runRubricId}
                onChange={(e) => setRunRubricId(e.target.value)}
                options={
                  evaluationMode === 'respond'
                    ? [
                        { value: '', label: 'No rubric (response-only review)' },
                        ...buildRubricVersionOptions(allRubrics),
                      ]
                    : buildRubricVersionOptions(allRubrics)
                }
                hint={
                  evaluationMode === 'respond'
                    ? 'Optional in respond mode; required if you want structured scoring criteria during human review.'
                    : 'The rubric version will be pinned for this run.'
                }
              />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-surface-700 dark:text-surface-300">Models</label>
                  <span className="text-xs text-surface-500 dark:text-surface-400">{runModelIds.length}/10</span>
                </div>
                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                  <Input
                    label="Search models"
                    value={runModelSearch}
                    onChange={(e) => setRunModelSearch(e.target.value)}
                    placeholder="Name, provider, or model ID"
                  />
                  <Select
                    label="Quick add"
                    value={quickAddModel}
                    onChange={(e) => addRunModel(e.target.value)}
                    options={quickRunOptions}
                  />
                </div>
                {allModels.length === 0 ? (
                  <div className="rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-3 py-2 text-xs text-surface-500 dark:text-surface-400">
                    No verified active models available.
                  </div>
                ) : (
                  <div className="max-h-52 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 divide-y divide-surface-100 dark:divide-surface-700">
                    {filteredRunModels.map((model: any) => (
                      <label
                        key={model.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700 cursor-pointer"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-surface-800 dark:text-surface-200 truncate">{model.name}</p>
                          <p className="text-xs text-surface-500 dark:text-surface-400 truncate">{model.provider} · {model.modelId}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={runModelIds.includes(model.id)}
                          onChange={() => toggleRunModel(model.id)}
                          className="rounded border-surface-300 dark:border-surface-600 text-brand-600 focus:ring-brand-500"
                        />
                      </label>
                    ))}
                    {filteredRunModels.length === 0 && (
                      <div className="px-3 py-2 text-xs text-surface-500 dark:text-surface-400">No models match your search.</div>
                    )}
                  </div>
                )}
                <p className="text-xs text-surface-500 dark:text-surface-400">Select 1–10 models. Scores and feedback will be recorded per model per run.</p>
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setNewRunOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={launching}
              disabled={runModelIds.length === 0}
              onClick={launchRun}
            >
              Launch Run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Change Default Rubric Dialog ─────────────────────────────────── */}
      <Dialog open={changeRubricOpen} onOpenChange={setChangeRubricOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Default Rubric</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Select
              label="Rubric"
              value={nextRubricId}
              onChange={(e) => setNextRubricId(e.target.value)}
              options={[
                { value: '', label: 'No default rubric' },
                ...buildRubricVersionOptions(allRubrics),
              ]}
              hint="This sets the default rubric for new runs on this evaluation."
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setChangeRubricOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={savingRubric} onClick={saveDefaultRubric}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}









