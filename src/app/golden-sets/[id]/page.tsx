'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
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

/** One row from GET /api/golden-sets/[id]/assignments. The API resolves
 *  `annotator`/`assignedBy` to { id, name } so this never renders a cuid. */
interface AssignmentView {
  id: string;
  goldenItemId: string | null;
  round: number;
  assignedAt: string;
  completedAt: string | null;
  revokedAt: string | null;
  annotator: { id: string; name: string | null } | null;
  assignedBy: { id: string; name: string | null } | null;
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
 * GET /api/golden-sets/[id]. Two response shapes, and the difference between
 * them is NARROWER than the allow-list alone suggests: the public branch
 * (the `decision.access === 'owner'` fall-through in
 * `src/app/api/golden-sets/[id]/route.ts`) spreads
 * `toPublicGoldenSet(goldenSet)` and then explicitly re-adds `datasetId`,
 * `protocol`, `slug`, `version`, `parentId` and `items`. So `protocol` and
 * `version` — and therefore the Protocol card and the version badge — render
 * for a public non-owner exactly as they do for the owner.
 *
 * Exactly TWO fields are owner-only:
 *   - `_count` — the public branch carries `itemCount` instead, which is why
 *     the Items card reads through the `??` ladder below.
 *   - `dataset` — `toPublicGoldenSet`'s allow-list drops it and the route
 *     does not re-add it, so the Source-dataset card falls back to '—' for a
 *     public non-owner. That is deliberate rather than an oversight: the
 *     corpus a set annotates is owner-visible provenance, and widening the
 *     public projection to expose it is a serializer decision, not a page's.
 *
 * The remaining fields stay optional as defence against a future projection
 * change, not because this route omits them today.
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
 * a strict `=== 'true'` compare — the detail route and the items route now
 * share ONE, `parseIncludeRetired` in src/lib/golden-sets.ts, as does
 * `parseIncludeTombstoned` beside it. `=1` is therefore
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
  const { data: session } = useSession();
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
        // Surface the server's own message, same as the sibling list page
        // (src/app/golden-sets/page.tsx:174-175) — otherwise 'Forbidden' and
        // a 500 are indistinguishable to whoever is looking at the toast. A
        // non-JSON body throws into the catch below and gets the generic
        // string, which is the correct fallback.
        const data = await res.json();
        toast.error(data.error || 'Failed to load golden set');
      }
    } catch {
      toast.error('Failed to load golden set');
    } finally {
      setLoading(false);
    }
  }, [id]);

  /** Assignments are coordinator-only (owner/admin) at the API, so a 403 here
   *  is expected for a non-owner and must not raise a toast — the panel simply
   *  does not render for them. */
  const loadAssignments = useCallback(async () => {
    try {
      const res = await fetch(`/api/golden-sets/${id}/assignments`);
      if (res.ok) setAssignments((await res.json()).assignments ?? []);
      else setAssignments([]);
    } catch {
      setAssignments([]);
    }
  }, [id]);

  const handleAssignToMe = async () => {
    // Same cast as `viewerId` below: next-auth's default Session type has no
    // `user.id`, and this app puts one there via its jwt/session callbacks.
    const meId = (session?.user as { id?: string } | undefined)?.id;
    if (!meId) return;
    setAssignBusy(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/assignments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ annotatorId: meId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Assigned — the labelling queue will now serve you items');
        await loadAssignments();
      } else {
        // 409 means an active assignment already exists; the server's message
        // says so precisely, and flattening it to "failed" would send someone
        // looking for a bug instead of at the row they already have.
        toast.error(data.error || 'Failed to assign');
      }
    } catch {
      toast.error('Failed to assign');
    } finally {
      setAssignBusy(false);
    }
  };

  const handleRevoke = async (assignmentId: string) => {
    setAssignBusy(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/assignments`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignmentId, reason: 'revoked from the golden-set page' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Revoked — the row is kept as a record of what was asked');
        await loadAssignments();
      } else {
        toast.error(data.error || 'Failed to revoke');
      }
    } finally {
      setAssignBusy(false);
    }
  };

  const loadItems = useCallback(
    async (cursor: string | null) => {
      setLoadingItems(true);
      try {
        // The items route carries the SAME retired guard as the detail route
        // (both spread `goldenSetLifecycleWhere`) and 404s a retired set's
        // items without the flag — so a page that sent it on only one of the
        // two fetches would render a retired set with an error toast where
        // its items should be.
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

  // ─── A1 assignments ───
  // Being the OWNER does not get you items from the queue — an assignment row
  // does (see the queue route). Without this panel there was no way to create
  // one from a browser, so a set could be made and never labelled.
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [assignBusy, setAssignBusy] = useState(false);
  const [retiring, setRetiring] = useState(false);

  const startEditing = (item: GoldenItemView) => {
    setEditingItemId(item.id);
    setExpectedDraft(item.expected ?? '');
  };

  const saveExpected = async (itemId: string) => {
    const expected = expectedDraft.trim() || null;
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
        body: JSON.stringify({ items: [{ id: itemId, expected }] }),
      });
      if (res.ok) {
        toast.success('Label saved');
        setEditingItemId(null);
        // Patch the row in place; do NOT re-run loadItems(null). This list is
        // cursor-paginated in pages of 100 and a reload from the first cursor
        // would throw away every page after it — so on the 620-row corpora
        // this page exists to annotate, labelling item #137 would collapse the
        // list back to #0–#99 and the annotator would have to press "Load more
        // items" and re-scroll after EVERY label. The write is a full
        // overwrite of one column with a value chosen here, and the route
        // applies it verbatim (its PATCH handler), so the value sent is
        // exactly the value stored — there is nothing to read back.
        setItems((previous) =>
          previous.map((item) => (item.id === itemId ? { ...item, expected } : item))
        );
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

  // Fork navigates with router.push to a SIBLING dynamic segment (and so does
  // browser back/forward between two set pages), so this component is
  // reconciled rather than remounted: every state value below outlives the
  // move unless it is cleared here.
  //
  // `loading` alone is NOT enough, because `loadGoldenSet` clears it in its
  // `finally` whether the fetch succeeded or not. If B's detail GET 403s or
  // 404s, a surviving `goldenSet` would render A's name, A's dataset, A's
  // badges and live Fork/Retire buttons under B's URL, and the Not Found
  // panel would never be reached. A surviving `items` is the same lie one
  // level down — the rows would be A's, and the skeleton branch cannot cover
  // it because that branch requires `items.length === 0`. `frozen` is the
  // third: a fresh fork is by definition unmeasured, so carrying the flag
  // over would have the new version claim a calibration run references it.
  //
  // So this clears everything that describes the PREVIOUS set. Nothing
  // flashes: `loading` is set back to true in the same pass, so the skeleton
  // covers the gap rather than the emptied not-found panel.
  useEffect(() => {
    setLoading(true);
    setGoldenSet(null);
    setItems([]);
    setItemsCursor(null);
    setFrozen(false);
    setEditingItemId(null);
  }, [id]);

  useEffect(() => {
    loadGoldenSet();
  }, [loadGoldenSet]);

  useEffect(() => {
    loadAssignments();
  }, [loadAssignments]);

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

  /**
   * Every write this page can issue — fork, retire, item PATCH — runs through
   * `requireOwnership` server-side (src/lib/auth-guard.ts:400-417). This set
   * can be someone ELSE's public set, in which case those routes answer 403,
   * so an ungated Fork/Retire pair would be two prominent header buttons whose
   * only possible outcome is an error toast.
   *
   * `owner.id` rather than `ownerId`: the scalar is on the owner branch's raw
   * row but not on `toPublicGoldenSet`'s output, whereas `owner: { id, name }`
   * is on both. A null owner (User deletion sets it null) belongs to nobody
   * and gates closed.
   *
   * KNOWN NARROWING: `requireOwnership` also admits admins, but the client
   * session carries only id/email/name — `src/lib/auth.ts:191-213` puts no
   * role on it — so an admin viewing another user's set loses the buttons too.
   * Hiding an affordance an admin could still drive through the API is the
   * safe direction of that error; showing one that 403s is not.
   */
  const viewerId = (session?.user as { id?: string } | undefined)?.id;
  const isOwner = !!viewerId && !!goldenSet.owner?.id && goldenSet.owner.id === viewerId;

  // Revoked rows are kept as a record of what was asked, so the panel filters
  // rather than the query — see the assignments route's DELETE.
  const activeAssignments = assignments.filter((a) => !a.revokedAt);
  const assignedToMe = activeAssignments.some((a) => a.annotator?.id === viewerId);

  return (
    <div>
      <Header
        title={goldenSet.name}
        description={goldenSet.description || undefined}
        breadcrumbs={[{ label: 'Golden Sets', href: '/golden-sets' }, { label: goldenSet.name }]}
        actions={
          viewerId ? (
            <div className="flex items-center gap-2">
              {/* A1.5: NOT gated on ownership. An assigned annotator need not
                  own the set, and hiding the entry point from them would make
                  assignment unusable for the multi-annotator case it exists
                  to serve. The queue route does the real gating, and answers
                  an unassigned caller with an explicit "nothing is assigned to
                  you" rather than an error. Retired sets are excluded because
                  they are out of circulation for new work — the queue would
                  404 on one. */}
              {!goldenSet.retiredAt && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => router.push(`/golden-sets/${goldenSet.id}/label`)}
                >
                  Label
                </Button>
              )}
              {isOwner && (
                <Button variant="secondary" size="sm" onClick={handleFork} loading={forking}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="12" cy="18" r="3" />
                    <path d="M6 9v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9" />
                  </svg>
                  Fork
                </Button>
              )}
              {isOwner && !goldenSet.retiredAt && (
                <Button variant="outline" size="sm" onClick={handleRetire} loading={retiring}>
                  Retire
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      <div className="p-6 space-y-6">
        {/* ─── Overview ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-surface-500 dark:text-surface-400 mb-1">Source dataset</p>
              {/* '—' here is a real state, not just a loading guard: `dataset`
                  is one of the two owner-only fields (see GoldenSetDetail
                  above), so a public non-owner sees the dash. */}
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

        {/* ─── Assignments (A1) ────────────────────────────────────────── */}
        {isOwner && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                Annotation assignments
                <span className="ml-2 text-xs font-normal text-surface-500 dark:text-surface-400">
                  ({activeAssignments.length} active)
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-surface-500 dark:text-surface-400">
                Annotation work is handed out deliberately rather than self-selected, so the
                overlap between annotators is designed rather than whatever coincides.{' '}
                <strong>Owning this set is not enough to label it</strong> — the queue serves an
                active assignment, so assign yourself before opening the studio.
              </p>

              {activeAssignments.length === 0 ? (
                <p className="text-sm italic text-surface-500 dark:text-surface-400">
                  Nobody is assigned to this set yet.
                </p>
              ) : (
                <ul className="divide-y divide-surface-100 dark:divide-surface-700">
                  {activeAssignments.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                      <span className="flex-1 text-surface-700 dark:text-surface-200">
                        {a.annotator?.name ?? (a.annotator ? 'Unnamed user' : 'Deleted account')}
                        <span className="ml-2 text-xs text-surface-500">
                          {a.goldenItemId ? 'one item' : 'whole set'} · round {a.round}
                          {a.completedAt ? ' · complete' : ''}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={assignBusy}
                        onClick={() => handleRevoke(a.id)}
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={assignBusy}
                  disabled={assignedToMe || !!goldenSet.retiredAt}
                  onClick={handleAssignToMe}
                >
                  {assignedToMe ? 'Assigned to you' : 'Assign to me'}
                </Button>
                {assignedToMe && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => router.push(`/golden-sets/${goldenSet.id}/label`)}
                  >
                    Open the studio
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
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
                                // the PATCH handler in items/route.ts). A human label is
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
                              {/* Three gates, one affordance. A non-owner's
                                  PATCH 403s; a retired set is out of
                                  circulation; and once a 409 has told us the
                                  set is frozen, every remaining pencil can
                                  only 409 again — the retire path already
                                  hid itself, so the freeze path should too. */}
                              {isOwner && !goldenSet.retiredAt && !frozen && (
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
