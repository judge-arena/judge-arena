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
import { ModelConfigForm } from '@/components/models/model-config-form';
import { getProviderInfo } from '@/lib/utils';
import { toast } from 'sonner';

export default function ModelsPage() {
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<any | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models');
      if (res.ok) setModels(await res.json());
    } catch (err) {
      console.error('Failed to load models:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const handleCreate = async (data: {
    name: string;
    provider: string;
    modelId: string;
    endpoint: string;
    apiKey: string;
    isActive: boolean;
  }) => {
    setCreating(true);
    try {
      const res = await fetch('/api/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const created = await res.json();
        toast.success('Model added. Running connection test...');
        setCreateOpen(false);
        loadModels();

        if (created?.id) {
          setTimeout(() => {
            handleVerify(created.id);
          }, 0);
        }
      } else {
        const responseData = await res.json();
        toast.error(responseData.error || 'Failed to add model');
      }
    } catch {
      toast.error('Failed to add model');
    } finally {
      setCreating(false);
    }
  };

  const handleOpenEdit = (model: any) => {
    setEditingModel(model);
    setEditOpen(true);
  };

  const handleUpdate = async (data: {
    name: string;
    provider: string;
    modelId: string;
    endpoint: string;
    apiKey: string;
    isActive: boolean;
  }) => {
    if (!editingModel) return;

    setSavingEdit(true);
    try {
      const payload: any = {
        name: data.name,
        provider: data.provider,
        modelId: data.modelId,
        endpoint: data.endpoint,
        isActive: data.isActive,
      };

      if (data.apiKey.trim().length > 0) {
        payload.apiKey = data.apiKey;
      }

      const res = await fetch(`/api/models/${editingModel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        toast.success('Model updated');
        setEditOpen(false);
        setEditingModel(null);
        await loadModels();
      } else {
        const responseData = await res.json();
        toast.error(responseData.error || 'Failed to update model');
      }
    } catch {
      toast.error('Failed to update model');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggle = async (id: string, currentlyActive: boolean) => {
    try {
      const res = await fetch(`/api/models/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentlyActive }),
      });
      if (res.ok) {
        setModels(
          models.map((m) =>
            m.id === id ? { ...m, isActive: !currentlyActive } : m
          )
        );
        toast.success(currentlyActive ? 'Model deactivated' : 'Model activated');
      }
    } catch {
      toast.error('Failed to update model');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this model configuration?')) return;
    try {
      const res = await fetch(`/api/models/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Model deleted');
        loadModels();
      }
    } catch {
      toast.error('Failed to delete model');
    }
  };

  const handleVerify = async (id: string) => {
    setVerifyingId(id);
    try {
      const res = await fetch(`/api/models/${id}/verify`, {
        method: 'POST',
      });
      if (res.ok) {
        toast.success('Model verified successfully');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Model verification failed');
      }
    } catch {
      toast.error('Model verification failed');
    } finally {
      await loadModels();
      setVerifyingId(null);
    }
  };

  return (
    <div>
      <Header
        title="Models"
        description="Configure LLM models for evaluations"
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
            Add Model
          </Button>
        }
      />

      <div className="p-6">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-36 w-full rounded-xl" />
            ))}
          </div>
        ) : models.length === 0 ? (
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
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <path d="M8 21h8M12 17v4" />
              </svg>
            }
            title="No models configured"
            description="Add LLM models to use as judges for evaluating submissions."
            action={
              <Button
                variant="primary"
                onClick={() => setCreateOpen(true)}
              >
                Add your first model
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {models.map((model) => {
              const providerInfo = getProviderInfo(model.provider);
              return (
                <Card
                  key={model.id}
                  interactive
                  className={!model.isActive ? 'opacity-60' : ''}
                  onClick={() => handleOpenEdit(model)}
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="min-w-0">
                        <CardTitle className="truncate">{model.name}</CardTitle>
                        <CardDescription className="mt-1">
                          {providerInfo.label}
                        </CardDescription>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={model.isVerified ? 'success' : 'warning'}
                          size="sm"
                        >
                          {model.isVerified ? 'Verified' : 'Unverified'}
                        </Badge>
                        <Badge
                          variant={model.isActive ? 'success' : 'default'}
                          size="sm"
                        >
                          {model.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-surface-500">Model ID</span>
                          <span className="font-mono text-surface-700 truncate ml-2 max-w-[60%] text-right">
                            {model.modelId}
                          </span>
                        </div>
                        {model.endpoint && (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-surface-500">Endpoint</span>
                            <span className="font-mono text-surface-700 truncate ml-2 max-w-[60%] text-right">
                              {model.endpoint}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 pt-2 border-t border-surface-100">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleVerify(model.id);
                          }}
                          loading={verifyingId === model.id}
                          className="flex-1"
                        >
                          Test
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleOpenEdit(model);
                          }}
                          className="flex-1"
                        >
                          Edit
                        </Button>
                        <Button
                          variant={model.isActive ? 'ghost' : 'outline'}
                          size="sm"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleToggle(model.id, model.isActive);
                          }}
                          className="flex-1"
                        >
                          {model.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleDelete(model.id);
                          }}
                          className="rounded p-1.5 text-surface-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                          aria-label="Delete model"
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
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Model Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Add Model</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <ModelConfigForm onSubmit={handleCreate} loading={creating} />
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) setEditingModel(null);
        }}
      >
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Edit Model</DialogTitle>
          </DialogHeader>
          <DialogBody>
            {editingModel && (
              <ModelConfigForm
                initialData={{
                  name: editingModel.name,
                  provider: editingModel.provider,
                  modelId: editingModel.modelId,
                  endpoint: editingModel.endpoint || '',
                  apiKey: '',
                  isActive: editingModel.isActive,
                }}
                onSubmit={handleUpdate}
                loading={savingEdit}
                submitLabel="Save Model"
              />
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
