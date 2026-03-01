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
import { formatDate } from '@/lib/utils';
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
  // State for "new version" dialog — holds the latest rubric of the family being edited
  const [newVersionTarget, setNewVersionTarget] = useState<RubricShape | null>(null);
  const [newVersionCreating, setNewVersionCreating] = useState(false);

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

  const handleNewVersion = async (data: {
    name: string;
    description: string;
    criteria: CriterionShape[];
  }) => {
    if (!newVersionTarget) return;
    setNewVersionCreating(true);
    try {
      const res = await fetch(`/api/rubrics/${newVersionTarget.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const newRubric = await res.json();
        toast.success(`Saved as v${newRubric.version}`);
        setNewVersionTarget(null);
        loadRubrics();
      } else {
        const d = await res.json();
        toast.error(d.error || 'Failed to create version');
      }
    } catch {
      toast.error('Failed to create version');
    } finally {
      setNewVersionCreating(false);
    }
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
                onNewVersion={(rubric) => setNewVersionTarget(rubric)}
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

      {/* New Version Dialog */}
      <Dialog
        open={!!newVersionTarget}
        onOpenChange={(open) => !open && setNewVersionTarget(null)}
      >
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>
              New Version —{' '}
              <span className="font-normal">{newVersionTarget?.name}</span>
              <span className="ml-2 text-sm font-normal text-surface-400">
                v{newVersionTarget?.version} → v{(newVersionTarget?.version ?? 0) + 1}
              </span>
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            {newVersionTarget && (
              <RubricBuilder
                initialName={newVersionTarget.name}
                initialDescription={newVersionTarget.description ?? ''}
                initialCriteria={newVersionTarget.criteria?.map((c) => ({
                  name: c.name,
                  description: c.description,
                  maxScore: c.maxScore,
                  weight: c.weight,
                }))}
                onSubmit={handleNewVersion}
                loading={newVersionCreating}
                submitLabel={`Save as v${(newVersionTarget?.version ?? 0) + 1}`}
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
  onNewVersion,
  onDelete,
}: {
  family: RubricFamily;
  onNewVersion: (rubric: RubricShape) => void;
  onDelete: (id: string) => void;
}) {
  const { latest, versions } = family;
  const hasHistory = versions.length > 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="truncate">{latest.name}</CardTitle>
              <Badge variant="info" size="sm">v{latest.version}</Badge>
            </div>
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
            <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-1.5">
              Criteria ({latest.criteria?.length ?? 0})
            </h4>
            <div className="space-y-1">
              {latest.criteria?.map((criterion, i) => (
                <div
                  key={criterion.id ?? i}
                  className="flex items-center justify-between rounded-lg bg-surface-50 px-3 py-1.5"
                >
                  <span className="text-xs font-medium text-surface-700 truncate">
                    {criterion.name}
                  </span>
                  <span className="text-2xs text-surface-400 font-mono shrink-0 ml-2">
                    max {criterion.maxScore} · ×{criterion.weight}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Version history timeline */}
          {hasHistory && (
            <div>
              <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider mb-1.5">
                Version History
              </h4>
              <div className="flex flex-wrap items-center gap-1">
                {versions.map((v, i) => (
                  <React.Fragment key={v.id}>
                    <span
                      title={`v${v.version} · saved ${formatDate(v.createdAt)}`}
                      className={
                        v.id === latest.id
                          ? 'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold bg-brand-100 text-brand-700'
                          : 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-surface-100 text-surface-500'
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

          {/* Footer */}
          <div className="flex items-center gap-2 pt-2 border-t border-surface-100">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNewVersion(latest)}
              className="flex-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New Version
            </Button>
            <button
              onClick={() => onDelete(latest.id)}
              className="rounded p-1.5 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
              aria-label="Delete latest version"
              title="Delete this version"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
            <span className="text-2xs text-surface-400 ml-auto shrink-0">
              {formatDate(latest.updatedAt)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}