'use client';

import React, { useEffect, useState } from 'react';
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

export default function RubricsPage() {
  const [rubrics, setRubrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadRubrics = async () => {
    try {
      const res = await fetch('/api/rubrics');
      if (res.ok) setRubrics(await res.json());
    } catch (err) {
      console.error('Failed to load rubrics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRubrics();
  }, []);

  const handleCreate = async (data: {
    name: string;
    description: string;
    criteria: Array<{
      name: string;
      description: string;
      maxScore: number;
      weight: number;
    }>;
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
        const responseData = await res.json();
        toast.error(responseData.error || 'Failed to create rubric');
      }
    } catch {
      toast.error('Failed to create rubric');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this rubric?')) return;
    try {
      const res = await fetch(`/api/rubrics/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Rubric deleted');
        loadRubrics();
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
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
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
            New Rubric
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-48 w-full rounded-xl" />
            ))}
          </div>
        ) : rubrics.length === 0 ? (
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
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            }
            title="No rubrics yet"
            description="Create a rubric to define how submissions should be evaluated and scored."
            action={
              <Button
                variant="primary"
                onClick={() => setCreateOpen(true)}
              >
                Create your first rubric
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {rubrics.map((rubric) => (
              <Card key={rubric.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div>
                      <CardTitle>{rubric.name}</CardTitle>
                      {rubric.description && (
                        <CardDescription className="mt-1">
                          {rubric.description}
                        </CardDescription>
                      )}
                    </div>
                    <button
                      onClick={() => handleDelete(rubric.id)}
                      className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                      aria-label="Delete rubric"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold text-surface-500 uppercase tracking-wider">
                      Criteria ({rubric.criteria?.length ?? 0})
                    </h4>
                    <div className="space-y-1">
                      {rubric.criteria?.map((criterion: any) => (
                        <div
                          key={criterion.id}
                          className="flex items-center justify-between rounded-lg bg-surface-50 px-3 py-1.5"
                        >
                          <span className="text-xs font-medium text-surface-700">
                            {criterion.name}
                          </span>
                          <span className="text-2xs text-surface-400 font-mono">
                            max {criterion.maxScore} · ×{criterion.weight}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 mt-3 pt-2 border-t border-surface-100">
                      <Badge variant="default" size="sm">
                        {rubric._count?.projects ?? 0} projects
                      </Badge>
                      <span className="text-2xs text-surface-400">
                        Updated {formatDate(rubric.updatedAt)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
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
    </div>
  );
}
