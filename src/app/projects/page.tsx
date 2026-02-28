'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [rubrics, setRubrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newRubricId, setNewRubricId] = useState('');

  const loadData = async () => {
    try {
      const [projectsRes, rubricsRes] = await Promise.all([
        fetch('/api/projects'),
        fetch('/api/rubrics'),
      ]);
      if (projectsRes.ok) setProjects(await projectsRes.json());
      if (rubricsRes.ok) setRubrics(await rubricsRes.json());
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          description: newDescription,
          rubricId: newRubricId || undefined,
        }),
      });
      if (res.ok) {
        toast.success('Project created');
        setCreateOpen(false);
        setNewName('');
        setNewDescription('');
        setNewRubricId('');
        loadData();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create project');
      }
    } catch {
      toast.error('Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this project and all its evaluations?')) return;
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Project deleted');
        loadData();
      }
    } catch {
      toast.error('Failed to delete project');
    }
  };

  // Ctrl+N to create
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setCreateOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div>
      <Header
        title="Projects"
        description="Manage evaluation projects"
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
            New Project
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : projects.length === 0 ? (
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
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            }
            title="No projects yet"
            description="Create a project to start evaluating text submissions with LLM judges."
            action={
              <Button
                variant="primary"
                onClick={() => setCreateOpen(true)}
              >
                Create your first project
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <Link key={project.id} href={`/projects/${project.id}`}>
                <Card interactive className="h-full">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <CardTitle className="truncate pr-2">
                        {project.name}
                      </CardTitle>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDelete(project.id);
                        }}
                        className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                        aria-label="Delete project"
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
                    {project.description && (
                      <CardDescription className="line-clamp-2">
                        {project.description}
                      </CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2 text-xs text-surface-500">
                      <Badge variant="default" size="sm">
                        {project._count?.evaluations ?? 0} evaluations
                      </Badge>
                      {project.rubric && (
                        <Badge variant="info" size="sm">
                          {project.rubric.name}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-2 text-2xs text-surface-400">
                      Updated {formatDate(project.updatedAt)}
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Create Project Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-4">
              <Input
                label="Project Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Q4 Code Review Evaluations"
                required
                autoFocus
              />
              <Textarea
                label="Description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Describe the purpose of this project..."
                rows={3}
              />
              <Select
                label="Rubric"
                options={[
                  { value: '', label: 'No rubric (select later)' },
                  ...rubrics.map((r: any) => ({
                    value: r.id,
                    label: `${r.name} (${r.criteria?.length ?? 0} criteria)`,
                  })),
                ]}
                value={newRubricId}
                onChange={(e) => setNewRubricId(e.target.value)}
                hint="Rubrics define how submissions will be scored"
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={creating}
              disabled={!newName.trim()}
            >
              Create Project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
