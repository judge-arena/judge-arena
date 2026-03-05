'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { RubricBuilder } from '@/components/rubric/rubric-builder';
import { toast } from 'sonner';

// ── Helpers ──────────────────────────────────────────────────────────────────

type CriterionShape = {
  id?: string;
  name: string;
  description: string;
  maxScore: number;
  weight: number;
};

type RubricShape = {
  id: string;
  name: string;
  description?: string;
  version: number;
  parentId?: string | null;
  criteria?: CriterionShape[];
  _count?: { projects?: number };
  createdAt: string;
  updatedAt: string;
};

type RubricFamily = {
  rootId: string;
  versions: RubricShape[];
  latest: RubricShape;
};

type RubricSubmitData = {
  name: string;
  description: string;
  criteria: CriterionShape[];
};

function normalizeRubricData(data: RubricSubmitData) {
  return {
    name: data.name.trim(),
    description: (data.description ?? '').trim(),
    criteria: data.criteria.map((criterion) => ({
      name: criterion.name.trim(),
      description: criterion.description.trim(),
      maxScore: Number(criterion.maxScore),
      weight: Number(criterion.weight),
    })),
  };
}

function groupRubricsByFamily(rubrics: RubricShape[]): RubricFamily[] {
  const familyMap = new Map<string, RubricShape[]>();
  for (const r of rubrics) {
    const key = r.parentId ?? r.id;
    if (!familyMap.has(key)) familyMap.set(key, []);
    familyMap.get(key)!.push(r);
  }
  return Array.from(familyMap.values())
    .map((versions) => {
      const sorted = [...versions].sort((a, b) => a.version - b.version);
      return { rootId: sorted[0].id, versions: sorted, latest: sorted[sorted.length - 1] };
    })
    .sort(
      (a, b) =>
        new Date(b.latest.updatedAt).getTime() -
        new Date(a.latest.updatedAt).getTime()
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RubricsPage() {
  const [rubrics, setRubrics] = useState<RubricShape[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<RubricShape | null>(null);
  const [savingCurrent, setSavingCurrent] = useState(false);
  const [savingAsVersion, setSavingAsVersion] = useState(false);

  const families = useMemo(() => groupRubricsByFamily(rubrics), [rubrics]);

  const loadRubrics = async () => {
    try {
      const res = await fetch('/api/rubrics');
      if (res.ok) setRubrics(await res.json());
    } catch {
      console.error('Failed to load rubrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRubrics(); }, []);

  const handleCreate = async (data: {
    name: string;
    description: string;
    criteria: CriterionShape[];
  }) => {
    setCreating(true);
    try {
      const res = await fetch('/api/rubrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        toast.success('Rubric created');
        setCreateOpen(false);
        loadRubrics();
      } else {
        const d = await res.json();
        toast.error(d.error || 'Failed to create rubric');
      }
    } catch {
      toast.error('Failed to create rubric');
    } finally {
      setCreating(false);
    }
  };

  const saveEditAsCurrent = async (targetId: string, payload: RubricSubmitData) => {
    setSavingCurrent(true);
    try {
      const res = await fetch(`/api/rubrics/${targetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          description: payload.description,
          criteria: payload.criteria.map((criterion, index) => ({
            ...criterion,
            order: index,
          })),
        }),
      });

      if (res.ok) {
        toast.success('Rubric updated');
        setEditTarget(null);
        loadRubrics();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error((data as any).error || 'Failed to update rubric');
      }
    } catch {
      toast.error('Failed to update rubric');
    } finally {
      setSavingCurrent(false);
    }
  };

  const saveEditAsNewVersion = async (targetId: string, payload: RubricSubmitData) => {
    setSavingAsVersion(true);
    try {
      const res = await fetch(`/api/rubrics/${targetId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          description: payload.description,
          criteria: payload.criteria.map((criterion, index) => ({
            ...criterion,
            order: index,
          })),
        }),
      });

      if (res.ok) {
        const created = await res.json();
        toast.success(`Saved as v${created.version}`);
        setEditTarget(null);
        loadRubrics();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error((data as any).error || 'Failed to create new version');
      }
    } catch {
      toast.error('Failed to create new version');
    } finally {
      setSavingAsVersion(false);
    }
  };

  const handleEditSubmit = async (data: RubricSubmitData, intent: string) => {
    if (!editTarget) return;

    const baseline = normalizeRubricData({
      name: editTarget.name,
      description: editTarget.description ?? '',
      criteria:
        editTarget.criteria?.map((criterion) => ({
          name: criterion.name,
          description: criterion.description,
          maxScore: criterion.maxScore,
          weight: criterion.weight,
        })) ?? [],
    });

    const next = normalizeRubricData(data);
    const changed = JSON.stringify(baseline) !== JSON.stringify(next);

    if (!changed) {
      toast.info('No changes detected');
      return;
    }

    if (intent === 'save-as-new-version') {
      await saveEditAsNewVersion(editTarget.id, data);
      return;
    }

    await saveEditAsCurrent(editTarget.id, data);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this rubric version? Projects using it will lose their rubric link.')) return;
    try {
      const res = await fetch(`/api/rubrics/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Rubric deleted');
        loadRubrics();
      } else {
        const d = await res.json().catch(() => ({}));
        toast.error((d as any).error || 'Cannot delete: rubric is in use');
      }
    } catch {
      toast.error('Failed to delete rubric');
    }
  };

  return (
    <div>
      <Header
        title="Rubrics"
        description="Define grading criteria for evaluations"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Rubric
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {[1, 2].map((i) => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
          </div>
        ) : families.length === 0 ? (
          <EmptyState
            icon={
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            }
            title="No rubrics yet"
            description="Create a rubric to define how submissions should be evaluated and scored."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create your first rubric
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {families.map((family) => (
              <RubricFamilyCard
                key={family.rootId}
                family={family}
                onEdit={(rubric) => setEditTarget(rubric)}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Rubric Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>New Rubric</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <RubricBuilder onSubmit={handleCreate} loading={creating} />
          </DialogBody>
        </DialogContent>
      </Dialog>

      {/* Edit Rubric Dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => !open && setEditTarget(null)}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Edit Rubric</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editTarget && (
              <RubricBuilder
                initialName={editTarget.name}
                initialDescription={editTarget.description ?? ''}
                initialCriteria={editTarget.criteria?.map((c) => ({
                  name: c.name,
                  description: c.description,
                  maxScore: c.maxScore,
                  weight: c.weight,
                }))}
                onSubmit={() => {}}
                onSubmitIntent={handleEditSubmit}
                onCancel={() => setEditTarget(null)}
                loading={savingCurrent}
                secondaryLoading={savingAsVersion}
                submitLabel="Save Current Version"
                submitIntent="save-current-version"
                secondarySubmitLabel="Save as New Version"
                secondarySubmitIntent="save-as-new-version"
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── RubricFamilyCard ──────────────────────────────────────────────────────────

function RubricFamilyCard({
  family,
  onEdit,
  onDelete,
}: {
  family: RubricFamily;
  onEdit: (rubric: RubricShape) => void;
  onDelete: (id: string) => void;
}) {
  const { latest, versions } = family;
  const hasHistory = versions.length > 1;
  const [showVersions, setShowVersions] = useState(false);
  const visibleCriteria = (latest.criteria ?? []).slice(0, 10);

  return (
    <Card>
      <CardHeader className="relative">
        <Badge variant="info" size="sm" className="absolute right-5 top-5">
          v{latest.version}
        </Badge>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate pr-12">{latest.name}</CardTitle>
            {latest.description && (
              <CardDescription className="mt-1">{latest.description}</CardDescription>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="space-y-3">
          {/* Criteria list */}
          <div>
            <div className="flex flex-wrap gap-1">
              {visibleCriteria.map((criterion, i) => (
                <Badge key={criterion.id ?? i} variant="default" size="sm">
                  {criterion.name}
                </Badge>
              ))}
              {(latest.criteria?.length ?? 0) > 10 && (
                <Badge variant="default" size="sm">+{(latest.criteria?.length ?? 0) - 10} more</Badge>
              )}
              {visibleCriteria.length === 0 && (
                <p className="text-xs text-surface-400 italic">No criteria</p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-1 pt-2 border-t border-surface-100 dark:border-surface-700">
            {hasHistory && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowVersions((prev) => !prev)}
                className="text-surface-400 hover:text-surface-700 dark:hover:text-surface-300 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-700 dark:bg-surface-700 mr-auto"
                aria-label="Toggle version history"
                title="Toggle version history"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M3 3v5h5" />
                  <path d="M3.05 13a9 9 0 1 0 .5-4" />
                  <path d="M12 7v5l3 3" />
                </svg>
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onEdit(latest)}
              className="text-surface-400 hover:text-brand-700 hover:bg-brand-50 dark:hover:bg-brand-950/30"
              aria-label="Edit rubric"
              title="Edit rubric"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(latest.id)}
              className="text-surface-400 hover:text-red-600 hover:bg-red-50"
              aria-label="Delete latest version"
              title="Delete this version"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </Button>
          </div>

          {hasHistory && showVersions && (
            <div className="pt-2 border-t border-surface-100 dark:border-surface-700">
              <div className="flex flex-wrap items-center gap-1">
                {versions.map((v, i) => (
                  <React.Fragment key={v.id}>
                    <span
                      title={`v${v.version}`}
                      className={
                        v.id === latest.id
                          ? 'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold bg-brand-100 text-brand-700'
                          : 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-surface-100 dark:bg-surface-700 text-surface-500 dark:text-surface-400'
                      }
                    >
                      v{v.version}
                      {v.id === latest.id && (
                        <span className="text-brand-400 font-normal">current</span>
                      )}
                    </span>
                    {i < versions.length - 1 && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-surface-300 shrink-0">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}