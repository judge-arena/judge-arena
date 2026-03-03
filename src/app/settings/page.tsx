'use client';

import React, { useEffect, useState, useRef } from 'react';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

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

export default function SettingsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [configText, setConfigText] = useState<string>('');
  const [showPreview, setShowPreview] = useState(false);

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

      <div className="p-6 space-y-6 max-w-3xl">
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
            <p className="mt-3 text-xs text-surface-500">
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
                <p className="mt-2 text-xs text-surface-500">
                  Accepts .yaml, .yml, or .json files. A preview will be shown before any changes are applied.
                </p>
              </div>

              {/* ── Preview Report ── */}
              {showPreview && preview && (
                <div className="rounded-xl border border-surface-200 bg-surface-50 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-surface-900">Import Preview</h3>
                    <div className="flex gap-2">
                      <Badge variant="success" size="sm">{preview.summary.create} to create</Badge>
                      <Badge variant="info" size="sm">{preview.summary.update} to update</Badge>
                      <Badge variant="default" size="sm">{preview.summary.skip} unchanged</Badge>
                    </div>
                  </div>

                  {preview.items.length > 0 ? (
                    <div className="divide-y divide-surface-200 rounded-lg border border-surface-200 bg-white">
                      {preview.items.map((item, i) => (
                        <div key={`${item.type}-${item.slug}-${i}`} className="flex items-start gap-3 px-3 py-2.5">
                          <span className="text-base shrink-0" aria-hidden="true">{typeIcon[item.type]}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-surface-900 truncate">{item.name}</span>
                              <Badge variant={actionVariant[item.action]} size="sm">{item.action}</Badge>
                              <span className="text-xs text-surface-400">{item.type}</span>
                            </div>
                            <p className="text-xs text-surface-500 font-mono">slug: {item.slug}</p>
                            {item.changes && item.changes.length > 0 && (
                              <ul className="mt-1 text-xs text-surface-600 space-y-0.5">
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
                    <p className="text-sm text-surface-500">No items found in the configuration file.</p>
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

        {/* ── Info ── */}
        <Card>
          <CardHeader>
            <CardTitle>How Config Export/Import Works</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm text-surface-700">
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
