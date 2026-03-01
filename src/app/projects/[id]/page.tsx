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
import { formatDate, formatDateTime } from '@/lib/utils';
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
  const [rubricVersions, setRubricVersions] = useState<any[]>([]);
  const [selectedRubricVersionId, setSelectedRubricVersionId] = useState('');

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (res.ok) {
        setProject(await res.json());
      } else {
        toast.error('Project not found');
        router.push('/projects');
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

  // When the dialog opens, fetch all versions of the project's rubric
  useEffect(() => {
    if (!createEvalOpen || !project?.rubricId) {
      setRubricVersions([]);
      setSelectedRubricVersionId('');
      return;
    }
    fetch(`/api/rubrics/${project.rubricId}/versions`)
      .then((r) => r.json())
      .then((versions: any[]) => {
        setRubricVersions(versions);
        // Default to the highest (latest) version
        if (versions.length > 0) {
          const latest = versions.reduce((a, b) =>
            a.version > b.version ? a : b
          );
          setSelectedRubricVersionId(latest.id);
        }
      })
      .catch(() => {});
  }, [createEvalOpen, project?.rubricId]);

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
        }),
      });
      if (res.ok) {
        const evaluation = await res.json();
        toast.success('Evaluation created');
        setCreateEvalOpen(false);
        setEvalTitle('');
        setEvalText('');
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
            {project.rubric && (
              <Badge variant="info" size="md">
                📋 {project.rubric.name}
              </Badge>
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
        {/* Rubric warning */}
        {!project.rubric && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardContent className="pt-4">
              <div className="flex items-center gap-3">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-amber-600 shrink-0"
                >
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-800">
                    No rubric assigned
                  </p>
                  <p className="text-xs text-amber-600">
                    Assign a rubric to enable model evaluations.{' '}
                    <Link
                      href="/rubrics"
                      className="underline hover:text-amber-800"
                    >
                      Create a rubric →
                    </Link>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

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
              {rubricVersions.length > 1 && (
                <Select
                  label="Rubric Version"
                  value={selectedRubricVersionId}
                  onChange={(e) => setSelectedRubricVersionId(e.target.value)}
                  options={rubricVersions
                    .slice()
                    .sort((a, b) => b.version - a.version)
                    .map((v) => ({
                      value: v.id,
                      label: `v${v.version} — ${v.criteria?.length ?? 0} criteria${
                        v.id === rubricVersions.reduce((a: any, b: any) => (a.version > b.version ? a : b)).id
                          ? ' (latest)'
                          : ''
                      }`,
                    }))}
                  hint="Choose which version of this project's rubric to use for grading"
                />
              )}
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
