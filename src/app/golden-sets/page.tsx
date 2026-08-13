'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
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

/* ─── Types ──────────────────────────────────────────────────────────────── */

type Protocol = 'pointwise' | 'pairwise' | 'listwise';

/**
 * One row from GET /api/golden-sets.
 *
 * The route hands back the RAW Prisma row for a set the caller owns and
 * `toPublicGoldenSet` (src/lib/serializers.ts:260-305) for someone else's
 * public set — and that allow-list projection carries neither `protocol` nor
 * `version` nor `_count`, it carries `itemCount`. So every owner-only field is
 * optional here and the count is read through the same `??` ladder
 * src/app/datasets/page.tsx:652 uses for samples.
 */
interface GoldenSetListItem {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  protocol?: Protocol;
  version?: number;
  parentId?: string | null;
  datasetId?: string;
  dataset?: { id: string; name: string } | null;
  owner?: { id: string; name: string | null } | null;
  itemCount?: number;
  _count?: { items: number };
}

const PROTOCOL_LABEL: Record<Protocol, string> = {
  pointwise: 'Pointwise',
  pairwise: 'Pairwise',
  listwise: 'Listwise',
};

/**
 * The platform corpus owner (prisma/seed-core.ts:60,72 — email
 * `platform@judgearena.local`, display name `Judge Arena`).
 *
 * A golden set can only be imported from a PUBLIC dataset owned by this
 * account, and POST /api/golden-sets is the authority on that — this predicate
 * only decides what the picker OFFERS. Two handles are needed because the list
 * route strips PII: the caller sees `user.email` only on rows it owns or when
 * it is an admin, and `toPublicDataset` (src/lib/serializers.ts:157) reduces
 * everyone else's to `owner: { id, name }`.
 */
const PLATFORM_OWNER_EMAIL = 'platform@judgearena.local';
const PLATFORM_OWNER_NAME = 'Judge Arena';

interface DatasetOption {
  id: string;
  name: string;
  visibility: string;
  sampleCount: number | null;
  sampleTotal?: number;
  _count?: { samples: number };
  owner?: { id: string; name: string | null } | null;
  user?: { id: string; name: string | null; email: string } | null;
}

function isPlatformDataset(d: DatasetOption): boolean {
  if (d.visibility !== 'public') return false;
  if (d.user?.email === PLATFORM_OWNER_EMAIL) return true;
  return d.owner?.name === PLATFORM_OWNER_NAME;
}

function datasetSampleCount(d: DatasetOption): number {
  return d.sampleCount ?? d.sampleTotal ?? d._count?.samples ?? 0;
}

/** What the protocol selector actually decides — the import mapping, which
 * branches on the TARGET protocol and never on `dataset.inputType`. */
const PROTOCOL_MAPPING: Record<Protocol, string> = {
  pointwise:
    'One candidate per item (response A). expected is NULL — JudgeBench labels a preference between two responses, not a score for one, so a pointwise import has no ground truth until it is labelled.',
  pairwise:
    "Two candidates per item (A and B). expected is the preference label, 'A>B' or 'B>A'. Runnable in A0.",
  listwise:
    "Two candidates per item (A and B). expected is the ranking, '0,1' or '1,0'. Storable and annotatable; listwise execution is not in A0.",
};

/** Unwrap the `{ data, pagination }` envelope paginatedJson returns, and
 * tolerate a bare array — same helper as src/app/datasets/page.tsx:78. */
function toList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload &&
    typeof payload === 'object' &&
    'data' in payload &&
    Array.isArray((payload as { data: unknown }).data)
  ) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

function itemCountOf(set: GoldenSetListItem): number {
  return set.itemCount ?? set._count?.items ?? 0;
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function GoldenSetsPage() {
  const [goldenSets, setGoldenSets] = useState<GoldenSetListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [visibilityFilter, setVisibilityFilter] = useState<'all' | 'private' | 'public'>('all');
  const [includeRetired, setIncludeRetired] = useState(false);

  // ─── Create dialog ───
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [datasetOptions, setDatasetOptions] = useState<DatasetOption[]>([]);
  const [datasetId, setDatasetId] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('pairwise');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [limitSamples, setLimitSamples] = useState(false);
  const [sampleLimit, setSampleLimit] = useState('50');

  const loadGoldenSets = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (visibilityFilter !== 'all') params.set('visibility', visibilityFilter);
      // Every golden-set read path filters `retiredAt: null` server-side; this
      // is the documented escape. Without a reader, the retire button on the
      // detail page would be a no-op nobody can see.
      //
      // The literal string 'true', not '1': every boolean query flag in this
      // repo is a strict `=== 'true'` compare, and that is deliberate, so
      // `=1` is false EVERYWHERE rather than true on some routes. All three
      // golden-set routes now share ONE compare — `parseIncludeRetired` in
      // src/lib/golden-sets.ts, pinned by its own case in
      // tests/lib/golden-sets.test.ts. Sending '1' here would make this
      // checkbox a dead control.
      if (includeRetired) params.set('includeRetired', 'true');
      const res = await fetch(`/api/golden-sets?${params}`);
      if (res.ok) {
        setGoldenSets(toList<GoldenSetListItem>(await res.json()));
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to load golden sets');
      }
    } catch {
      toast.error('Failed to load golden sets');
    } finally {
      setLoading(false);
    }
  }, [visibilityFilter, includeRetired]);

  useEffect(() => {
    setLoading(true);
    loadGoldenSets();
  }, [loadGoldenSets]);

  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/datasets?visibility=public&limit=100');
        if (!res.ok) return;
        const rows = toList<DatasetOption>(await res.json()).filter(isPlatformDataset);
        if (cancelled) return;
        setDatasetOptions(rows);
        setDatasetId((current) => current || rows.find((r) => datasetSampleCount(r) > 0)?.id || '');
      } catch {
        // Picker stays empty; the dialog says so rather than silently
        // offering nothing with no explanation.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createOpen]);

  const resetCreate = () => {
    setName('');
    setDescription('');
    setProtocol('pairwise');
    setLimitSamples(false);
    setSampleLimit('50');
    setCreating(false);
  };

  const handleCreate = async () => {
    if (!datasetId || !name.trim()) return;
    const parsedLimit = Number.parseInt(sampleLimit, 10);
    if (limitSamples && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      toast.error('Sample count must be a positive number');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch('/api/golden-sets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          datasetId,
          protocol,
          name: name.trim(),
          description: description.trim() || undefined,
          // DatasetSample.index is 0-based and contiguous across the whole
          // corpus (prisma/seed-judgebench.ts:187-189), so "the first N" is
          // 0..N-1. Omitted entirely = import every sample; GoldenItem.index
          // is assigned 0..n-1 over the SELECTION, server-side.
          sampleIndices: limitSamples
            ? Array.from({ length: parsedLimit }, (_, i) => i)
            : undefined,
        }),
      });
      if (res.ok) {
        toast.success('Golden set created');
        setCreateOpen(false);
        resetCreate();
        loadGoldenSets();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create golden set');
      }
    } catch {
      toast.error('Failed to create golden set');
    } finally {
      setCreating(false);
    }
  };

  const handleTombstone = async (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      !window.confirm(
        'Tombstone this golden set? Nothing is destroyed — the row is kept so any calibration run that pins it stays interpretable — but it drops out of this list.'
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/golden-sets/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Golden set tombstoned');
        loadGoldenSets();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to tombstone golden set');
      }
    } catch {
      toast.error('Failed to tombstone golden set');
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return goldenSets.filter((s) => {
      // GET /api/golden-sets honours ?protocol and ?datasetId but NOT
      // ?visibility (see its `where` builder, route.ts:41-59), so the param
      // sent above is forward-compatible only and the filter has to bite
      // here or the control does nothing. src/app/datasets/page.tsx:262 runs
      // the same client-side predicate even though its route does support the
      // param, so this is the page-level convention either way.
      const matchesVisibility =
        visibilityFilter === 'all' || s.visibility === visibilityFilter;
      const matchesSearch = q
        ? s.name.toLowerCase().includes(q) ||
          (s.description?.toLowerCase().includes(q) ?? false)
        : true;
      return matchesVisibility && matchesSearch;
    });
  }, [goldenSets, search, visibilityFilter]);

  const renderCard = (set: GoldenSetListItem) => (
    <Link key={set.id} href={`/golden-sets/${set.id}`}>
      <Card interactive className="h-full">
        <CardHeader>
          <div className="flex items-start justify-between">
            <CardTitle className="truncate pr-2">{set.name}</CardTitle>
            <div className="flex items-center gap-1 shrink-0">
              {set.version != null && (
                <Badge variant="outline" size="sm">
                  v{set.version}
                </Badge>
              )}
              <button
                onClick={(e) => handleTombstone(set.id, e)}
                className="rounded p-1 text-surface-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                aria-label="Tombstone golden set"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
          {set.description && (
            <CardDescription className="line-clamp-2">{set.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <Badge variant={set.visibility === 'public' ? 'success' : 'warning'} size="sm">
              {set.visibility === 'public' ? '🔓 Public' : '🔒 Private'}
            </Badge>
            {set.protocol && (
              <Badge variant="info" size="sm">
                {PROTOCOL_LABEL[set.protocol]}
              </Badge>
            )}
            <Badge variant="default" size="sm">
              {itemCountOf(set).toLocaleString()} items
            </Badge>
            {set.retiredAt && (
              <Badge variant="error" size="sm">
                Retired
              </Badge>
            )}
          </div>
          {set.dataset && (
            <p className="text-2xs text-surface-500 dark:text-surface-400">
              from {set.dataset.name}
            </p>
          )}
          <p className="text-2xs text-surface-400">Updated {formatDate(set.updatedAt)}</p>
        </CardContent>
      </Card>
    </Link>
  );

  return (
    <div>
      <Header
        title="Golden Sets"
        description="Annotated platform corpora — the ground truth judges are calibrated against."
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Golden Set
          </Button>
        }
      />

      <div className="p-6 space-y-6">
        {/* ─── Filters ─────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <Input
              placeholder="Search by name or description"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full min-w-[240px] flex-1"
            />
            <div className="w-full sm:w-[220px]">
              <Select
                value={visibilityFilter}
                onChange={(e) =>
                  setVisibilityFilter(e.target.value as 'all' | 'private' | 'public')
                }
                options={[
                  { value: 'all', label: 'Visibility: All' },
                  { value: 'public', label: 'Visibility: Public' },
                  { value: 'private', label: 'Visibility: Private' },
                ]}
              />
            </div>
            <label className="flex items-center gap-2 text-xs font-medium text-surface-600 dark:text-surface-400">
              <input
                type="checkbox"
                checked={includeRetired}
                onChange={(e) => setIncludeRetired(e.target.checked)}
                className="h-4 w-4 rounded border-surface-300 dark:border-surface-600 text-brand-600 focus:ring-brand-500"
              />
              Show retired
            </label>
          </div>
        </div>

        {/* ─── Sets ────────────────────────────────────────────────────── */}
        <div className="rounded-xl border border-surface-200 dark:border-surface-700 p-4 space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-surface-800 dark:text-surface-200">
              Golden Sets
            </h3>
            {!loading && (
              <Badge variant="outline" size="sm">
                {filtered.length}
              </Badge>
            )}
          </div>

          {loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-44 w-full rounded-xl" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-surface-300">
                  <path d="M12 2l2.9 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l7.1-1.01L12 2z" />
                </svg>
              }
              title="No golden sets yet"
              description="A golden set is an annotated platform corpus. Import one from a platform dataset to get started."
              action={
                <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                  New Golden Set
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map(renderCard)}
            </div>
          )}
        </div>
      </div>

      {/* ═════════════════ New Golden Set (import) ═════════════════ */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Golden Set</DialogTitle>
          </DialogHeader>

          <DialogBody>
            <div className="space-y-4">
              <div>
                <Select
                  label="Source dataset"
                  value={datasetId}
                  onChange={(e) => setDatasetId(e.target.value)}
                  placeholder={datasetOptions.length ? undefined : 'No platform datasets available'}
                  hint="A golden set is an annotated platform corpus — only public datasets curated by Judge Arena can be imported."
                  options={datasetOptions.map((d) => {
                    const count = datasetSampleCount(d);
                    return {
                      value: d.id,
                      label: count
                        ? `${d.name} (${count.toLocaleString()} samples)`
                        : `${d.name} (0 samples — nothing to import)`,
                      disabled: count === 0,
                    };
                  })}
                />
              </div>

              <div>
                <label className="text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5 block">
                  Protocol
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['pointwise', 'pairwise', 'listwise'] as Protocol[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setProtocol(p)}
                      className={`rounded-lg border-2 px-3 py-2 text-xs font-semibold transition-colors ${
                        protocol === p
                          ? 'border-brand-500 dark:border-brand-700 bg-brand-50 dark:bg-brand-950/30 text-brand-700 dark:text-brand-300'
                          : 'border-surface-200 dark:border-surface-700 text-surface-600 dark:text-surface-400 hover:bg-surface-50 dark:bg-surface-800 dark:hover:bg-surface-700'
                      }`}
                    >
                      {PROTOCOL_LABEL[p]}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-surface-500 dark:text-surface-400">
                  {PROTOCOL_MAPPING[protocol]}
                </p>
              </div>

              <Input
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., JudgeBench pairwise — full"
                required
              />
              <Textarea
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this set the ground truth for?"
                rows={2}
              />

              <div className="rounded-lg border border-surface-200 dark:border-surface-700 p-3 space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-surface-700 dark:text-surface-300">
                  <input
                    type="checkbox"
                    checked={limitSamples}
                    onChange={(e) => setLimitSamples(e.target.checked)}
                    className="h-4 w-4 rounded border-surface-300 dark:border-surface-600 text-brand-600 focus:ring-brand-500"
                  />
                  Import only the first N samples
                </label>
                {limitSamples ? (
                  <Input
                    type="number"
                    min={1}
                    value={sampleLimit}
                    onChange={(e) => setSampleLimit(e.target.value)}
                    hint="Subsetting is how a labelling session is made finite."
                  />
                ) : (
                  <p className="text-xs text-surface-500 dark:text-surface-400">
                    Every sample in the dataset is imported.
                  </p>
                )}
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={creating}
              disabled={!datasetId || !name.trim()}
            >
              Create Golden Set
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
