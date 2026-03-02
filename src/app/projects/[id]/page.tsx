'use client';

import React, { useEffect, useState, useCallback } from 'react';
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
import { buildRubricVersionOptions, formatDate, formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [createEvalOpen, setCreateEvalOpen] = useState(false);
  const [evalTitle, setEvalTitle] = useState('');
  const [evalText, setEvalText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [selectedRubricVersionId, setSelectedRubricVersionId] = useState('');
  const [allRubrics, setAllRubrics] = useState<any[]>([]);
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [quickAddModelId, setQuickAddModelId] = useState('');

  const loadProject = useCallback(async () => {
    try {
      const [projectRes, rubricsRes, modelsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`),
        fetch('/api/rubrics'),
        fetch('/api/models'),
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
    } catch {
      toast.error('Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

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

  const handleCreateEvaluation = async () => {
    if (!evalText.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/evaluations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          title: evalTitle || undefined,
          inputText: evalText,
          ...(selectedRubricVersionId && { rubricId: selectedRubricVersionId }),
          modelConfigIds: selectedModelIds,
        }),
      });
      if (res.ok) {
        const evaluation = await res.json();
        toast.success('Evaluation created');
        setCreateEvalOpen(false);
        setEvalTitle('');
        setEvalText('');
        setSelectedModelIds([]);
        router.push(`/evaluate/${evaluation.id}`);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create evaluation');
      }
    } catch {
      toast.error('Failed to create evaluation');
    } finally {
      setSubmitting(false);
    }
  };

  // Ctrl+N to create new evaluation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setCreateEvalOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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
        {project.evaluations?.length === 0 ? (
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
                Submit Text for Evaluation
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-surface-700">
                Evaluations ({project.evaluations.length})
              </h2>
            </div>

            <div className="divide-y divide-surface-100 rounded-xl border border-surface-200 bg-white">
              {project.evaluations.map((evaluation: any) => (
                <Link
                  key={evaluation.id}
                  href={`/evaluate/${evaluation.id}`}
                  className="flex items-center gap-4 px-4 py-3 hover:bg-surface-50 transition-colors first:rounded-t-xl last:rounded-b-xl"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-surface-900 truncate">
                      {evaluation.title || 'Untitled Evaluation'}
                    </p>
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
                    <Badge variant="default" size="sm">
                      {evaluation.modelSelections?.length ?? 0} models
                    </Badge>
                    {evaluation.modelJudgments?.length > 0 && (
                      <span className="text-xs text-surface-500">
                        {evaluation.modelJudgments.filter((j: any) => j.status === 'completed').length}/
                        {evaluation.modelJudgments.length} models
                      </span>
                    )}
                    {evaluation.humanJudgment && (
                      <Badge variant="success" size="sm">
                        Human: {evaluation.humanJudgment.overallScore}/10
                      </Badge>
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
                      size="sm"
                    >
                      {evaluation.status}
                    </Badge>
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
              <Input
                label="Title (optional)"
                value={evalTitle}
                onChange={(e) => setEvalTitle(e.target.value)}
                placeholder="e.g., PR #42 Code Review"
                autoFocus
              />
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
                  <label className="text-sm font-medium text-surface-700">
                    Models for this Evaluation
                  </label>
                  <span className="text-xs text-surface-500">
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
                  <div className="rounded-lg border border-surface-200 bg-surface-50 px-3 py-2 text-xs text-surface-500">
                    No verified active models available. You can still create a human-only evaluation.
                  </div>
                ) : (
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-surface-200 divide-y divide-surface-100">
                    {filteredAvailableModels.map((model: any) => {
                      const selected = selectedModelIds.includes(model.id);
                      return (
                        <label
                          key={model.id}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-50 cursor-pointer"
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-surface-800 truncate">
                              {model.name}
                            </p>
                            <p className="text-xs text-surface-500 truncate">
                              {model.provider} · {model.modelId}
                            </p>
                          </div>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleModelSelection(model.id)}
                            className="rounded border-surface-300 text-brand-600 focus:ring-brand-500"
                          />
                        </label>
                      );
                    })}
                    {filteredAvailableModels.length === 0 && (
                      <div className="px-3 py-2 text-xs text-surface-500">
                        No models match your search.
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs text-surface-500">
                  Select 0 models for human-only evaluation, or up to 10 models.
                </p>
              </div>

              <Textarea
                label="Text to Evaluate"
                value={evalText}
                onChange={(e) => setEvalText(e.target.value)}
                placeholder="Paste the text, code, document, or artifact you want to evaluate..."
                rows={12}
                required
                hint="This text will be sent to all active models for judgment"
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setCreateEvalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateEvaluation}
              loading={submitting}
              disabled={!evalText.trim()}
            >
              Create & Open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
