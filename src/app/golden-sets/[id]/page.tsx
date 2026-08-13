'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/header';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { toast } from 'sonner';

/* ─── Types ──────────────────────────────────────────────────────────────── */

type Protocol = 'pointwise' | 'pairwise' | 'listwise';

interface GoldenCandidateView {
  id: string;
  position: number;
  promptText: string | null;
  responseText: string | null;
  label: string | null;
}

interface GoldenItemView {
  id: string;
  /**
   * `GoldenItem.index` is the item's ORDINAL WITHIN THE SET, not its offset in
   * this array. Tombstoning keeps the row and its ordinal
   * (@@unique([goldenSetId, index]) is deliberately not partial), so after the
   * first tombstone the live items read 0,1,3,4… — unique and
   * insertion-ordered, never dense. It is displayed and never used to index.
   */
  index: number;
  inputText: string;
  promptText: string | null;
  responseText: string | null;
  protocol: Protocol;
  expected: string | null;
  sourceDatasetSampleId: string;
  candidates?: GoldenCandidateView[];
}

/**
 * GET /api/golden-sets/[id]. Owner-only fields are optional because the
 * public branch goes through `toPublicGoldenSet`
 * (src/lib/serializers.ts:260-305), whose allow-list carries neither
 * `protocol` nor `datasetId` nor `_count`.
 */
interface GoldenSetDetail {
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
  slug?: string | null;
  datasetId?: string;
  dataset?: { id: string; name: string } | null;
  owner?: { id: string; name: string | null } | null;
  itemCount?: number;
  _count?: { items: number; calibrationRuns?: number };
}

const PROTOCOL_LABEL: Record<Protocol, string> = {
  pointwise: 'Pointwise',
  pairwise: 'Pairwise',
  listwise: 'Listwise',
};

/**
 * The literal string 'true', not '1'. Every boolean query flag in this repo is
 * a strict `=== 'true'` compare — GET /api/golden-sets/[id]:48 and GET
 * /api/golden-sets/[id]/items:57 both do it, as does
 * `parseIncludeTombstoned` (src/lib/golden-sets.ts:317-323). `=1` is therefore
 * false EVERYWHERE, and sending it here would make the retire button write a
 * row nothing on this page can ever read back.
 */
const INCLUDE_RETIRED = 'true';

/** Unwrap the `{ data, pagination }` envelope paginatedJson returns, and
 * tolerate a bare array — same helper as src/app/golden-sets/page.tsx:117. */
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

function nextCursorOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'pagination' in payload) {
    const pagination = (payload as { pagination?: { nextCursor?: string | null } }).pagination;
    return pagination?.nextCursor ?? null;
  }
  return null;
}

/* ─── Component ──────────────────────────────────────────────────────────── */

export default function GoldenSetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [goldenSet, setGoldenSet] = useState<GoldenSetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<GoldenItemView[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsCursor, setItemsCursor] = useState<string | null>(null);

  const loadGoldenSet = useCallback(async () => {
    try {
      // ?includeRetired=true — every golden-set read path filters
      // `retiredAt: null` server-side, so without this a set you just retired
      // 404s on refresh and the Retired badge below could never render.
      const search = new URLSearchParams({ includeRetired: INCLUDE_RETIRED });
      const res = await fetch(`/api/golden-sets/${id}?${search}`);
      if (res.ok) {
        setGoldenSet(await res.json());
      } else {
        toast.error('Failed to load golden set');
      }
    } catch {
      toast.error('Failed to load golden set');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadItems = useCallback(
    async (cursor: string | null) => {
      setLoadingItems(true);
      try {
        // The items route carries the SAME retired guard as the detail route
        // (items/route.ts:57-60) and 404s a retired set's items without the
        // flag — so a page that sent it on only one of the two fetches would
        // render a retired set with an error toast where its items should be.
        const search = new URLSearchParams({ limit: '100', includeRetired: INCLUDE_RETIRED });
        if (cursor) search.set('cursor', cursor);
        const res = await fetch(`/api/golden-sets/${id}/items?${search}`);
        if (!res.ok) {
          toast.error('Failed to load items');
          return;
        }
        const payload = await res.json();
        const rows = toList<GoldenItemView>(payload);
        setItems((previous) => (cursor ? [...previous, ...rows] : rows));
        setItemsCursor(nextCursorOf(payload));
      } catch {
        toast.error('Failed to load items');
      } finally {
        setLoadingItems(false);
      }
    },
    [id]
  );

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [expectedDraft, setExpectedDraft] = useState('');
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  // Set when a content mutation comes back 409. The freeze predicate lives
  // server-side (`calibrationRun.count({ where: { goldenSetId } }) > 0`, in
  // src/lib/golden-sets.ts, run inside the mutation's transaction) — this is
  // just the client remembering the answer it was given.
  //
  // This is currently the ONLY thing that raises the frozen banner. The
  // `_count.calibrationRuns` arm below is forward-compatible only:
  // `goldenSetDetailInclude._count` selects `items` alone, and its shape is
  // pinned by tests/lib/golden-set-schemas.test.ts:91, so the banner is
  // reactive (it appears the moment an edit is refused) rather than
  // proactive, and does not survive a reload.
  const [frozen, setFrozen] = useState(false);
  const [forking, setForking] = useState(false);
  const [retiring, setRetiring] = useState(false);

  const startEditing = (item: GoldenItemView) => {
    setEditingItemId(item.id);
    setExpectedDraft(item.expected ?? '');
  };

  const saveExpected = async (itemId: string) => {
    setSavingItemId(itemId);
    try {
      const res = await fetch(`/api/golden-sets/${id}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // `updateGoldenItemsSchema` (src/app/api/golden-sets/shared.ts:87-99)
        // is a BATCH shape — `{ items: [{ id, … }] }` — not the flat
        // `{ sampleId, … }` of the dataset-samples route. A body of
        // `{ itemId, expected }` parses to a zod error and 400s, so the one
        // item this page edits is sent as a one-element batch.
        body: JSON.stringify({ items: [{ id: itemId, expected: expectedDraft.trim() || null }] }),
      });
      if (res.ok) {
        toast.success('Label saved');
        setEditingItemId(null);
        await loadItems(null);
      } else {
        if (res.status === 409) setFrozen(true);
        const data = await res.json();
        toast.error(data.error || 'Failed to save label');
      }
    } catch {
      toast.error('Failed to save label');
    } finally {
      setSavingItemId(null);
    }
  };

  const handleFork = async () => {
    setForking(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const forked = await res.json();
        toast.success(`Version ${forked.version} created`);
        router.push(`/golden-sets/${forked.id}`);
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to fork golden set');
      }
    } catch {
      toast.error('Failed to fork golden set');
    } finally {
      setForking(false);
    }
  };

  const handleRetire = async () => {
    if (
      !window.confirm(
        'Retire this golden set? It stays valid ground truth for the calibration runs that pin it, but drops out of the golden-set list.'
      )
    ) {
      return;
    }
    setRetiring(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        toast.success('Golden set retired');
        await loadGoldenSet();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to retire golden set');
      }
    } catch {
      toast.error('Failed to retire golden set');
    } finally {
      setRetiring(false);
    }
  };

  // Fork navigates with router.push to a SIBLING dynamic segment, so this
  // component is reconciled rather than remounted and every piece of state
  // below survives the move. `frozen` surviving it is the one that lies: the
  // fresh fork is by definition unmeasured, and carrying the flag over would
  // have the new version claim a calibration run references it.
  useEffect(() => {
    setLoading(true);
    setFrozen(false);
    setEditingItemId(null);
  }, [id]);

  useEffect(() => {
    loadGoldenSet();
  }, [loadGoldenSet]);

  useEffect(() => {
    loadItems(null);
  }, [loadItems]);

  if (loading) {
    return (
      <div>
        <Header title="Golden Set" />
        <div className="p-6 space-y-4">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!goldenSet) {
    return (
      <div>
        <Header
          title="Golden Set Not Found"
          breadcrumbs={[{ label: 'Golden Sets', href: '/golden-sets' }, { label: 'Not Found' }]}
        />
        <div className="p-6">
          <p className="text-surface-500 dark:text-surface-400">
            This golden set doesn&apos;t exist or you don&apos;t have access.
          </p>
        </div>
      </div>
    );
  }

  const protocol = goldenSet.protocol;
  const totalItems = goldenSet.itemCount ?? goldenSet._count?.items ?? items.length;
  const labelledCount = items.filter((i) => i.expected != null && i.expected.trim() !== '').length;

  return (
    <div>
      <Header
        title={goldenSet.name}
        description={goldenSet.description || undefined}
        breadcrumbs={[{ label: 'Golden Sets', href: '/golden-sets' }, { label: goldenSet.name }]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={handleFork} loading={forking}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="6" cy="6" r="3" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="12" cy="18" r="3" />
                <path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" />
              </svg>
              Fork
            </Button>
            {!goldenSet.retiredAt && (
              <Button variant="outline" size="sm" onClick={handleRetire} loading={retiring}>
                Retire
              </Button>
            )}
          </div>
        }
      />

      <div className="p-6 space-y-6">
        {/* ─── Overview ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Source dataset</p>
              <p className="text-sm font-medium text-surface-800 dark:text-surface-200">
                {goldenSet.dataset?.name ?? '—'}
              </p>
              <p className="text-2xs text-surface-400 mt-0.5">
                Bound at import; a golden set annotates exactly one corpus.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Protocol</p>
              <Badge variant="info">{protocol ? PROTOCOL_LABEL[protocol] : '—'}</Badge>
              <p className="text-2xs text-surface-400 mt-1">
                The set is homogeneous — every item shares it.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Items</p>
              <p className="text-2xl font-bold text-surface-900 dark:text-surface-100">
                {totalItems.toLocaleString()}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Status</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={goldenSet.visibility === 'public' ? 'success' : 'warning'}>
                  {goldenSet.visibility === 'public' ? '🔓 Public' : '🔒 Private'}
                </Badge>
                {goldenSet.version != null && (
                  <Badge variant="outline">v{goldenSet.version}</Badge>
                )}
                {goldenSet.retiredAt && <Badge variant="error">Retired</Badge>}
              </div>
              <p className="text-2xs text-surface-400 mt-1">
                Created {formatDate(goldenSet.createdAt)}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ─── Frozen banner ───────────────────────────────────────────── */}
        {(frozen || (goldenSet._count?.calibrationRuns ?? 0) > 0) && (
          <div className="rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
            <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">
              Frozen — a calibration run references this set
            </p>
            <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
              Item content (items, candidates, protocol, expected and the source dataset) is
              immutable, because a run that already measured this set must stay interpretable.
              Name, description and visibility are still editable. Use <strong>Fork</strong> to
              make a new version you can edit; labels come across except on items the fork changes.
            </p>
          </div>
        )}

        {/* ─── Pointwise ground-truth notice ───────────────────────────── */}
        {protocol === 'pointwise' && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              Pointwise import: no ground truth yet
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              JudgeBench&apos;s label is a <em>preference</em> between two responses, not a score
              for one. A pointwise import therefore arrives with{' '}
              <span className="font-mono">expected = null</span> on every item. This is correct
              rather than broken — but the set is <strong>not calibration-ready until it is
              labelled</strong>. Set each item&apos;s expected value below.
            </p>
            <p className="mt-2 text-xs font-medium text-amber-800 dark:text-amber-300">
              {labelledCount} of {items.length} loaded items labelled ({totalItems.toLocaleString()}{' '}
              in the set).
            </p>
          </div>
        )}

        {/* ─── Items ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Items
              <span className="ml-2 text-xs font-normal text-surface-500 dark:text-surface-400">
                ({items.length.toLocaleString()} of {totalItems.toLocaleString()} loaded)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingItems && items.length === 0 ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : items.length === 0 ? (
              <p className="py-4 text-center text-sm text-surface-500 dark:text-surface-400">
                This golden set has no items.
              </p>
            ) : (
              <>
                <div className="divide-y divide-surface-100 dark:divide-surface-700">
                  {items.map((item) => (
                    <div key={item.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex items-start gap-3">
                        <span className="shrink-0 mt-0.5 rounded-md bg-surface-100 dark:bg-surface-700 px-1.5 py-0.5 text-2xs font-mono text-surface-500 dark:text-surface-400">
                          #{item.index}
                        </span>
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="rounded-md border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800 px-2.5 py-1.5">
                            <p className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-0.5">
                              Input
                            </p>
                            <p className="text-xs text-surface-800 dark:text-surface-200 whitespace-pre-wrap line-clamp-4">
                              {item.inputText}
                            </p>
                          </div>

                          {(item.candidates ?? []).map((candidate) => (
                            <div
                              key={candidate.id}
                              className="rounded-md border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 px-2.5 py-1.5"
                            >
                              <p className="text-2xs font-medium text-surface-500 dark:text-surface-400 mb-0.5">
                                Candidate {String.fromCharCode(65 + candidate.position)} (position{' '}
                                {candidate.position})
                                {candidate.label ? ` — ${candidate.label}` : ''}
                              </p>
                              <p className="text-xs text-surface-700 dark:text-surface-300 whitespace-pre-wrap line-clamp-4">
                                {candidate.responseText ?? candidate.promptText ?? '—'}
                              </p>
                            </div>
                          ))}

                          {editingItemId === item.id ? (
                            <div className="space-y-2">
                              <Textarea
                                label="Expected"
                                value={expectedDraft}
                                onChange={(e) => setExpectedDraft(e.target.value)}
                                placeholder={
                                  item.protocol === 'pairwise'
                                    ? "'A>B' or 'B>A'"
                                    : item.protocol === 'listwise'
                                      ? "'0,1' or '1,0'"
                                      : 'The score or verdict this item should receive'
                                }
                                // Saving a value that differs from the stored
                                // one tombstones this item's GoldenLabel rows
                                // in the same transaction
                                // (`tombstonedReason: 'item-content-edit'`,
                                // items/route.ts:180-190). A human label is
                                // the expensive artifact here, so say so
                                // before the click rather than after it. A
                                // no-op re-save is not a change and leaves
                                // labels alone.
                                hint="Changing this value tombstones any human labels already recorded for this item — they scored text with a different expected answer."
                                rows={2}
                                className="text-xs"
                                autoFocus
                              />
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => saveExpected(item.id)}
                                  loading={savingItemId === item.id}
                                >
                                  Save
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditingItemId(null)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              {item.expected != null && item.expected.trim() !== '' ? (
                                <Badge variant="success" size="sm">
                                  expected: {item.expected}
                                </Badge>
                              ) : (
                                <Badge variant="outline" size="sm">
                                  expected: null — unlabelled
                                </Badge>
                              )}
                              <span className="text-2xs font-mono text-surface-400">
                                source sample {item.sourceDatasetSampleId}
                              </span>
                              {!goldenSet.retiredAt && (
                                <button
                                  onClick={() => startEditing(item)}
                                  className="rounded p-1 text-surface-400 hover:text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-950/30 transition-colors"
                                  aria-label="Edit expected value"
                                >
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {itemsCursor && (
                  <div className="mt-3 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => loadItems(itemsCursor)}
                      loading={loadingItems}
                    >
                      Load more items
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
