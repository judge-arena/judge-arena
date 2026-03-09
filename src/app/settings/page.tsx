'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import {
  PERMISSION_SCOPES,
  SCOPE_GROUPS,
  SCOPE_PRESETS,
  type PermissionScope,
} from '@/lib/permissions';

type DiffAction = 'create' | 'update' | 'skip';

interface DiffItem {
  type: 'project' | 'rubric' | 'model' | 'dataset';
  slug: string;
  name: string;
  action: DiffAction;
  changes?: string[];
}

interface ImportReport {
  dryRun: boolean;
  items: DiffItem[];
  summary: { create: number; update: number; skip: number };
  message: string;
}

interface ApiKeyData {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  user?: { email: string };
}

/* ─── Scope Checkbox Grid ─── */
function ScopeSelector({
  selectedScopes,
  onToggle,
}: {
  selectedScopes: PermissionScope[];
  onToggle: (scope: PermissionScope) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="text-xs font-medium text-surface-700 dark:text-surface-300">Permissions</label>
      {SCOPE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <p className="text-xs font-semibold text-surface-600 dark:text-surface-400">{group.label}</p>
          <div className="flex flex-wrap gap-2">
            {group.scopes.map((scope) => {
              const description = PERMISSION_SCOPES[scope];
              return (
                <label
                  key={scope}
                  className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none"
                  title={description}
                >
                  <input
                    type="checkbox"
                    checked={selectedScopes.includes(scope)}
                    onChange={() => onToggle(scope)}
                    className="rounded border-surface-300 dark:border-surface-600 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-surface-800 dark:text-surface-200">{scope}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Inline Scope Editor (for existing keys) ─── */
function EditableScopeSelector({
  currentScopes,
  onSave,
  onCancel,
}: {
  currentScopes: PermissionScope[];
  onSave: (scopes: PermissionScope[]) => void;
  onCancel: () => void;
}) {
  const [scopes, setScopes] = React.useState<PermissionScope[]>(currentScopes);

  const toggle = (scope: PermissionScope) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        {SCOPE_PRESETS.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="sm"
            onClick={() => setScopes([...preset.scopes])}
          >
            {preset.label}
          </Button>
        ))}
      </div>

      <ScopeSelector selectedScopes={scopes} onToggle={toggle} />

      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={scopes.length === 0}
          onClick={() => onSave(scopes)}
        >
          Save ({scopes.length} scope{scopes.length !== 1 ? 's' : ''})
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [configText, setConfigText] = useState<string>('');
  const [showPreview, setShowPreview] = useState(false);

  // ── API Key State ──
  const [apiKeys, setApiKeys] = useState<ApiKeyData[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyScopes, setNewKeyScopes] = useState<PermissionScope[]>([]);
  const [newKeyExpiry, setNewKeyExpiry] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);

  const fetchApiKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/api-keys');
      if (res.ok) {
        setApiKeys(await res.json());
      }
    } catch {
      // Ignore
    } finally {
      setLoadingKeys(false);
    }
  }, []);

  useEffect(() => {
    fetchApiKeys();
  }, [fetchApiKeys]);

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) {
      toast.error('Please enter a key name');
      return;
    }
    if (newKeyScopes.length === 0) {
      toast.error('Please select at least one permission scope');
      return;
    }

    setCreatingKey(true);
    try {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newKeyName.trim(),
          scopes: newKeyScopes,
          expiresAt: newKeyExpiry || undefined,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setRevealedKey(data.key);
        setNewKeyName('');
        setNewKeyScopes([]);
        setNewKeyExpiry('');
        toast.success('API key created');
        fetchApiKeys();
      } else {
        const err = await res.json();
        toast.error(err.error || 'Failed to create key');
      }
    } catch {
      toast.error('Failed to connect');
    } finally {
      setCreatingKey(false);
    }
  };

  const handleToggleKey = async (id: string, isActive: boolean) => {
    try {
      const res = await fetch(`/api/api-keys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !isActive }),
      });
      if (res.ok) {
        setApiKeys((prev) =>
          prev.map((k) => (k.id === id ? { ...k, isActive: !isActive } : k))
        );
        toast.success(isActive ? 'Key deactivated' : 'Key activated');
      }
    } catch {
      toast.error('Failed to update key');
    }
  };

  const handleRevokeKey = async (id: string, name: string) => {
    if (!confirm(`Permanently revoke API key "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/api-keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setApiKeys((prev) => prev.filter((k) => k.id !== id));
        toast.success(`Key "${name}" revoked`);
      }
    } catch {
      toast.error('Failed to revoke key');
    }
  };

  const handleUpdateScopes = async (id: string, scopes: string[]) => {
    try {
      const res = await fetch(`/api/api-keys/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
      });
      if (res.ok) {
        setApiKeys((prev) =>
          prev.map((k) => (k.id === id ? { ...k, scopes } : k))
        );
        setEditingKeyId(null);
        toast.success('Scopes updated');
      }
    } catch {
      toast.error('Failed to update scopes');
    }
  };

  const toggleScope = (scope: PermissionScope, list: PermissionScope[], setter: (s: PermissionScope[]) => void) => {
    if (list.includes(scope)) {
      setter(list.filter((s) => s !== scope));
    } else {
      setter([...list, scope]);
    }
  };

  const applyPreset = (presetScopes: PermissionScope[], setter: (s: PermissionScope[]) => void) => {
    setter([...presetScopes]);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setConfigText(text);
      // Run dry-run preview
      await runPreview(text);
    } catch {
      toast.error('Failed to read file');
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const runPreview = async (text: string) => {
    setImporting(true);
    try {
      const res = await fetch('/api/config/import?dryRun=true', {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body: text,
      });

      if (res.ok) {
        const report: ImportReport = await res.json();
        setPreview(report);
        setShowPreview(true);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to preview config');
      }
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setImporting(false);
    }
  };

  const executeImport = async () => {
    setImporting(true);
    try {
      const res = await fetch('/api/config/import', {
        method: 'POST',
        headers: { 'Content-Type': 'text/yaml' },
        body: configText,
      });

      if (res.ok) {
        const report: ImportReport = await res.json();
        setShowPreview(false);
        setPreview(null);
        setConfigText('');
        toast.success(report.message);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Import failed');
      }
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setImporting(false);
    }
  };

  const handleConfigExport = (format: 'yaml' | 'json', includeSamples: boolean = false) => {
    const url = `/api/config/export?format=${format}&includeSamples=${includeSamples}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`Exporting configuration as ${format.toUpperCase()}…`);
  };

  const actionVariant: Record<DiffAction, 'success' | 'info' | 'default'> = {
    create: 'success',
    update: 'info',
    skip: 'default',
  };

  const typeIcon: Record<string, string> = {
    project: '📁',
    rubric: '✅',
    model: '🧠',
    dataset: '📊',
  };

  return (
    <div>
      <Header
        title="Settings"
        description="Export and import your evaluation harness configuration."
      />

      <div className="p-6 space-y-6">
        {/* ── Config Export ── */}
        <Card>
          <CardHeader>
            <CardTitle>Export Configuration</CardTitle>
            <CardDescription>
              Download your projects, rubrics, models, and datasets as a portable YAML
              configuration file. This captures your evaluation <em>harness</em> setup
              — complementary to data exports (CSV/JSONL) which capture evaluation <em>results</em>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleConfigExport('yaml')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                Config as YAML
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleConfigExport('yaml', true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                Config + Data as YAML
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => handleConfigExport('json')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                Config as JSON
              </Button>
            </div>
            <p className="mt-3 text-xs text-surface-500 dark:text-surface-400">
              API keys and secrets are <strong>never</strong> included in exports.
              Dataset sample data is only included when using &quot;Config + Data&quot;.
            </p>
          </CardContent>
        </Card>

        {/* ── Config Import ── */}
        <Card>
          <CardHeader>
            <CardTitle>Import Configuration</CardTitle>
            <CardDescription>
              Upload a YAML or JSON configuration file to recreate your evaluation harness.
              Existing entities are matched by slug — new ones are created, existing ones
              are updated if changed, and identical ones are skipped.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".yaml,.yml,.json"
                  onChange={handleFileSelect}
                  className="hidden"
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  loading={importing && !showPreview}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  Upload Config File
                </Button>
                <p className="mt-2 text-xs text-surface-500 dark:text-surface-400">
                  Accepts .yaml, .yml, or .json files. A preview will be shown before any changes are applied.
                </p>
              </div>

              {/* ── Preview Report ── */}
              {showPreview && preview && (
                <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">Import Preview</h3>
                    <div className="flex gap-2">
                      <Badge variant="success" size="sm">{preview.summary.create} to create</Badge>
                      <Badge variant="info" size="sm">{preview.summary.update} to update</Badge>
                      <Badge variant="default" size="sm">{preview.summary.skip} unchanged</Badge>
                    </div>
                  </div>

                  {preview.items.length > 0 ? (
                    <div className="divide-y divide-surface-200 dark:divide-surface-700 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800">
                      {preview.items.map((item, i) => (
                        <div key={`${item.type}-${item.slug}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
                          <span className="text-base shrink-0" aria-hidden="true">{typeIcon[item.type]}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-surface-900 dark:text-surface-100 truncate">{item.name}</span>
                              <Badge variant={actionVariant[item.action]} size="sm">{item.action}</Badge>
                              <span className="text-xs text-surface-400">{item.type}</span>
                            </div>
                            <p className="text-xs text-surface-500 dark:text-surface-400 font-mono">slug: {item.slug}</p>
                            {item.changes && item.changes.length > 0 && (
                              <ul className="mt-1 text-xs text-surface-600 dark:text-surface-400 space-y-0.5">
                                {item.changes.map((change, ci) => (
                                  <li key={ci} className="flex items-start gap-1">
                                    <span className="text-amber-500 shrink-0">→</span>
                                    {change}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-surface-500 dark:text-surface-400">No items found in the configuration file.</p>
                  )}

                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => { setShowPreview(false); setPreview(null); setConfigText(''); }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={executeImport}
                      loading={importing}
                      disabled={preview.summary.create === 0 && preview.summary.update === 0}
                    >
                      Apply {preview.summary.create + preview.summary.update} Change{preview.summary.create + preview.summary.update !== 1 ? 's' : ''}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ── Developer API Keys ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Developer API Keys</CardTitle>
                <CardDescription>
                  Create API keys for scoped programmatic access to the platform.
                </CardDescription>
              </div>
              {!showCreateKey && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => { setShowCreateKey(true); setRevealedKey(null); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                  API Key
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Revealed Key (shown after creation) */}
            {revealedKey && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-2">
                <p className="text-sm font-semibold text-amber-900">
                  Save this key now — it will not be shown again
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-white dark:bg-surface-800 px-3 py-2 text-xs font-mono text-surface-900 dark:text-surface-100 border border-amber-200 break-all select-all">
                    {revealedKey}
                  </code>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedKey);
                      toast.success('Copied to clipboard');
                    }}
                  >
                    Copy
                  </Button>
                </div>
                <p className="text-xs text-amber-700">
                  Use as: <code className="font-mono">Authorization: Bearer {revealedKey.slice(0, 12)}...</code>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevealedKey(null)}
                >
                  Dismiss
                </Button>
              </div>
            )}

            {/* Create Key Form */}
            {showCreateKey && !revealedKey && (
              <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-4 space-y-4">
                <h3 className="text-sm font-semibold text-surface-900 dark:text-surface-100">New API Key</h3>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-surface-700 dark:text-surface-300">Name</label>
                  <Input
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    placeholder="e.g. CI Pipeline, Python SDK"
                    className="max-w-sm"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-surface-700 dark:text-surface-300">Expiration (optional)</label>
                  <Input
                    type="datetime-local"
                    value={newKeyExpiry}
                    onChange={(e) => setNewKeyExpiry(e.target.value)}
                    className="max-w-sm"
                  />
                  <p className="text-xs text-surface-500 dark:text-surface-400">Leave blank for no expiration</p>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-surface-700 dark:text-surface-300">Presets</label>
                  <div className="flex flex-wrap gap-2">
                    {SCOPE_PRESETS.map((preset) => (
                      <Button
                        key={preset.label}
                        variant="outline"
                        size="sm"
                        onClick={() => applyPreset(preset.scopes, setNewKeyScopes)}
                        title={preset.description}
                      >
                        {preset.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <ScopeSelector
                  selectedScopes={newKeyScopes}
                  onToggle={(scope) => toggleScope(scope, newKeyScopes, setNewKeyScopes)}
                />

                <div className="flex gap-2 justify-end pt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => { setShowCreateKey(false); setNewKeyName(''); setNewKeyScopes([]); setNewKeyExpiry(''); }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleCreateKey}
                    loading={creatingKey}
                    disabled={!newKeyName.trim() || newKeyScopes.length === 0}
                  >
                    Create Key ({newKeyScopes.length} scope{newKeyScopes.length !== 1 ? 's' : ''})
                  </Button>
                </div>
              </div>
            )}

            {/* Existing Keys List */}
            {loadingKeys ? (
              <p className="text-sm text-surface-500 dark:text-surface-400">Loading API keys...</p>
            ) : apiKeys.length === 0 ? (
              <p className="text-sm text-surface-500 dark:text-surface-400">
                No API keys created yet. Create one to enable programmatic access.
              </p>
            ) : (
              <div className="divide-y divide-surface-200 dark:divide-surface-700 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800">
                {apiKeys.map((key) => (
                  <div key={key.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-surface-900 dark:text-surface-100">
                          {key.name}
                        </span>
                        <code className="text-xs font-mono text-surface-500 dark:text-surface-400 bg-surface-100 dark:bg-surface-700 px-1.5 py-0.5 rounded">
                          {key.prefix}...
                        </code>
                        {key.isActive ? (
                          <Badge variant="success" size="sm">Active</Badge>
                        ) : (
                          <Badge variant="error" size="sm">Inactive</Badge>
                        )}
                        {key.expiresAt && new Date(key.expiresAt) < new Date() && (
                          <Badge variant="warning" size="sm">Expired</Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => setEditingKeyId(editingKeyId === key.id ? null : key.id)}
                        >
                          {editingKeyId === key.id ? 'Hide' : 'Edit Scopes'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleKey(key.id, key.isActive)}
                        >
                          {key.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleRevokeKey(key.id, key.name)}
                        >
                          Revoke
                        </Button>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {key.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" size="sm">
                          {scope}
                        </Badge>
                      ))}
                    </div>

                    <div className="flex gap-4 text-xs text-surface-500 dark:text-surface-400">
                      <span>Created {new Date(key.createdAt).toLocaleDateString()}</span>
                      {key.lastUsedAt && (
                        <span>Last used {new Date(key.lastUsedAt).toLocaleDateString()}</span>
                      )}
                      {key.expiresAt && (
                        <span>Expires {new Date(key.expiresAt).toLocaleDateString()}</span>
                      )}
                    </div>

                    {/* Inline scope editor */}
                    {editingKeyId === key.id && (
                      <EditableScopeSelector
                        currentScopes={key.scopes as PermissionScope[]}
                        onSave={(scopes) => handleUpdateScopes(key.id, scopes)}
                        onCancel={() => setEditingKeyId(null)}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-surface-500 dark:text-surface-400">
              API keys authenticate via the <code className="font-mono">Authorization: Bearer vgk_...</code> header.
              Session-based (browser) users have full access. API keys are scoped to the
              permissions selected at creation time.
            </p>
          </CardContent>
        </Card>

        {/* ── Info ── */}
        <Card>
          <CardHeader>
            <CardTitle>How Config Export/Import Works</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm text-surface-700 dark:text-surface-300">
              <ul className="space-y-2 text-sm">
                <li>
                  <strong>Config export</strong> captures your evaluation harness setup:
                  projects, rubrics (with criteria), model configurations, and dataset metadata.
                </li>
                <li>
                  <strong>Data export</strong> (CSV/JSONL) captures evaluation results:
                  scores, judgments, and run history. Both are complementary.
                </li>
                <li>
                  Entities are identified by <strong>slugs</strong> — human-readable,
                  deterministic identifiers derived from names. This ensures portability
                  across instances.
                </li>
                <li>
                  <strong>API keys are never exported</strong>. After importing model
                  configs, you&apos;ll need to add API keys manually.
                </li>
                <li>
                  Use <strong>&quot;Config + Data&quot;</strong> to include dataset sample data
                  (inputs, expected outputs) in the export. Without it, only dataset
                  metadata is exported.
                </li>
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
