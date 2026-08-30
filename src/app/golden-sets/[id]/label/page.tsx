'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Header } from '@/components/layout/header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { toSpanText } from '@/lib/studio/content';
import { StudioShell } from '@/components/studio/StudioShell';
import { SpanTextView } from '@/components/studio/SpanTextView';
import { ProgressionRail, type Stage } from '@/components/studio/ProgressionRail';
import type { PanelKind } from '@/lib/studio/layout';

/**
 * A1.5 Task 5 — the first composition of the studio shell: A1's labelling
 * view.
 *
 * ── THIS PAGE DELIBERATELY KNOWS NOTHING ABOUT THE ROUND ───────────────────
 *
 * The queue does not tell it, and that is the reliability signal working as
 * designed. A retest and a first reading are byte-identical on the wire, so
 * there is nothing here to leak even by accident — no "you saw this before"
 * banner is possible to write against this data, which is the point.
 *
 * ── EVERY NON-ITEM QUEUE STATE RENDERS SOMETHING ───────────────────────────
 *
 * A blank screen is the failure this view exists to avoid. With
 * intervening-items-only eligibility a small set legitimately has nothing to
 * serve right now, and "come back after 12 more" is a completely different
 * message from "you are finished" — which is different again from "nobody has
 * assigned you anything". All three are rendered explicitly.
 */

type Protocol = 'pointwise' | 'pairwise' | 'listwise';

interface QueueCandidate {
  position: number;
  promptText: string | null;
  responseText: string | null;
  label: string | null;
}

interface QueueItem {
  itemId: string;
  inputText: string;
  promptText: string | null;
  responseText: string | null;
  protocol: Protocol;
  candidates: QueueCandidate[];
}

interface QueueResponse {
  next: QueueItem | null;
  reason: 'no-assignment' | 'set-complete' | 'retest-not-yet-eligible' | null;
  labelsUntilRetest?: number;
}

/**
 * The stages this view can speak to. `model` and `answer` are A2's.
 *
 * `retest-not-yet-eligible` counts as WORK DONE, not as work not started —
 * found while walking the manual checklist, where the rail read
 * "Item — not started / Human label — not started" on a set whose only item
 * had just been labelled. The queue returns that reason precisely BECAUSE a
 * reading exists and is too fresh to repeat, so reporting it as nothing having
 * happened contradicts the message rendered directly underneath it.
 */
function stagesFor(queue: QueueResponse | null): Stage[] {
  const item = queue?.next ?? null;
  // Both of these mean "you have done what is currently askable of you".
  const workRecorded =
    queue?.reason === 'set-complete' || queue?.reason === 'retest-not-yet-eligible';
  return [
    { key: 'item', label: 'Item', state: item || workRecorded ? 'done' : 'pending' },
    {
      key: 'human',
      label: 'Human label',
      state: workRecorded ? 'done' : 'pending',
    },
    // EXPLICITLY EMPTY, never omitted. A2 has not run and may never have run
    // for this set; a rail that simply left these out would read as a complete
    // pipeline. See ProgressionRail's doc.
    { key: 'model', label: 'Model judgment', state: 'empty' },
    { key: 'answer', label: 'Agreement', state: 'empty' },
  ];
}

/**
 * The candidate's identity, IN THE VOCABULARY THE VERDICT CONTROL USES.
 *
 * Until this existed the options panel read "Option 1" / "Option 2" while the
 * verdict control asked for `A>B` / `tie` / `B>A`, and NOTHING on the screen
 * said that Option 1 is A. The mapping is deterministic in code — the importer
 * writes `toCandidate(0, responseA)` / `toCandidate(1, responseB)` and the
 * queue selects `orderBy: { position: 'asc' }` — but an annotator can only
 * assume it, and one who assumes the other way round inverts every preference
 * in the session. That corruption is silent and survives every check we have:
 * it is inverted CONSISTENTLY, so test-retest kappa comes out HIGH, and the
 * finished set is indistinguishable from a correct one afterwards.
 *
 * The letter therefore comes from `position`, the same expression the
 * golden-set detail screen already uses (`page.tsx`, "Candidate A").
 *
 * ── WHY A LONE CANDIDATE IS NOT LETTERED ───────────────────────────────────
 *
 * `lettered` is false exactly when the verdict control does not speak in
 * letters — a pointwise item, which legitimately carries exactly one candidate
 * (`mapSampleToGoldenItem` in src/lib/golden-sets.ts) and is answered with a
 * Score box that never mentions A or B. Calling that text "Candidate A"
 * invents a comparison and implies a B that does not exist.
 *
 * The condition is on the CONTROL, not on `candidates.length`, and the
 * difference matters for malformed data: a pairwise item that somehow arrived
 * with one candidate still renders "Candidate A" against an `A>B` control, so
 * the missing B is visible on the screen instead of being smoothed over into a
 * plausible-looking "Response". Loud beats silent here.
 *
 * The MIRROR of that case has to be loud too, which is why the call site ORs
 * in `candidates.length > 1`. `POST /api/config/import` accepts any candidate
 * array against any protocol — `goldenItemSchema` in src/lib/config.ts has no
 * refinement tying the two together, and every item is stamped with the set's
 * protocol — so a pointwise item carrying two candidates is reachable. On the
 * control alone both of its cards would be headed "Response", which is exactly
 * the silent smoothing-over the paragraph above refuses: two responses under
 * one Score box, with nothing on the screen saying there are two.
 *
 * `label` wins when it is set — it is the candidate's own name — but the
 * letter is still rendered beside it, because the letter is what the control
 * is asking about. A label that IS the letter (what a `toCandidate` that
 * stamps 'A'/'B' would store) would otherwise render as "A — A". Blank and
 * whitespace-only labels are treated as absent: `''` is not a name, and
 * `label ?? …` would let one blank the heading and take the mapping with it.
 */
function candidateIdentity(
  candidate: QueueCandidate,
  lettered: boolean
): { letter: string | null; name: string } {
  const letter = lettered ? String.fromCharCode(65 + candidate.position) : null;
  const label = candidate.label?.trim() ? candidate.label.trim() : null;
  if (label && label.toUpperCase() !== letter) return { letter, name: label };
  return { letter, name: letter === null ? 'Response' : `Candidate ${letter}` };
}

/**
 * The one badge, rendered in BOTH the options panel and the verdict radios.
 *
 * Sharing it is the whole point: two letters styled differently still leave
 * the reader inferring that they are the same A, and that inference is the one
 * this component exists to remove. Do not inline a second copy of these
 * classes — a divergence between the two call sites is invisible in review and
 * reintroduces the doubt without changing a single word on the screen.
 */
function CandidateLetter({ letter }: { letter: string }) {
  return (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-surface-300 bg-surface-100 font-mono text-xs font-semibold text-surface-700 dark:border-surface-600 dark:bg-surface-700 dark:text-surface-100">
      {letter}
    </span>
  );
}

export default function LabellingStudioPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === 'string' ? params.id : '';

  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [score, setScore] = useState('');
  const [preference, setPreference] = useState('');
  const [reasoning, setReasoning] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/queue`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || 'Failed to load the labelling queue');
        setQueue(null);
        return;
      }
      setQueue(await res.json());
      // Cleared on every advance, so the previous item's entry can never be
      // submitted against the next one — and so a re-read starts blank rather
      // than pre-filled with what was typed last time.
      setScore('');
      setPreference('');
      setReasoning('');
    } catch {
      toast.error('Failed to load the labelling queue');
      setQueue(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void loadQueue();
  }, [id, loadQueue]);

  const item = queue?.next ?? null;
  const isPointwise = item?.protocol === 'pointwise';

  async function submit() {
    if (!item) return;
    const body: Record<string, unknown> = {};
    if (isPointwise) {
      const parsed = Number(score);
      if (score.trim() === '' || !Number.isFinite(parsed)) {
        toast.error('Enter a score');
        return;
      }
      body.overallScore = parsed;
    } else {
      if (!preference) {
        toast.error('Choose a preference');
        return;
      }
      body.preference = preference;
    }
    if (reasoning.trim() !== '') body.reasoning = reasoning;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/golden-sets/${id}/items/${item.itemId}/labels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's message is shown verbatim: it distinguishes
        // "not yet eligible for a second reading" from "you hold no
        // assignment", and flattening them to one string would hide the
        // difference the annotator needs.
        toast.error(data.error || 'Failed to record the reading');
        return;
      }
      // NOTE the response carries `round`, and it is deliberately not shown.
      toast.success('Reading recorded');
      await loadQueue();
    } catch {
      toast.error('Failed to record the reading');
    } finally {
      setSubmitting(false);
    }
  }

  const emptyReasons: Record<PanelKind, string> = {
    prompt: 'This item has no prompt text.',
    // NOT "pointwise items are scored directly", which is what this said and
    // is false: a pointwise item carries exactly one candidate — the response
    // being scored — and it renders in this panel, unlettered. This reason is
    // for the genuinely empty case, which means the item is incomplete.
    options:
      'This item carries no candidates. Every item built from a dataset sample gets at least one, so an empty panel here means the item itself is incomplete.',
    reasoning:
      'No model reasoning captured. Chain-of-thought is not stored on model calls yet, so this panel is thin by design rather than broken.',
    output: 'No model output for this item yet — a calibration run has not been executed against this set.',
    verdict: 'Nothing to record.',
  };

  const renderers: Partial<Record<PanelKind, React.ReactNode>> = item
    ? {
        prompt: <SpanTextView value={toSpanText(item.promptText ?? item.inputText)} />,
        options:
          item.candidates.length > 0 ? (
            <ol className="flex flex-col gap-3">
              {item.candidates.map((candidate) => {
                // `|| length > 1`: see candidateIdentity's doc. A pointwise
                // item with two candidates must not head both cards "Response".
                const { letter, name } = candidateIdentity(
                  candidate,
                  !isPointwise || item.candidates.length > 1
                );
                return (
                  <li
                    key={candidate.position}
                    className="rounded-lg border border-surface-200 p-3 dark:border-surface-700"
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-surface-500">
                      {letter !== null && <CandidateLetter letter={letter} />}
                      <span>{name}</span>
                    </div>
                    <SpanTextView value={toSpanText(candidate.responseText ?? '')} />
                  </li>
                );
              })}
            </ol>
          ) : undefined,
        // Both empty until A2 exists and until reasoning_content is captured.
        reasoning: undefined,
        output: item.responseText ? <SpanTextView value={toSpanText(item.responseText)} /> : undefined,
        verdict: (
          <div className="flex flex-col gap-3">
            {isPointwise ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-surface-700 dark:text-surface-200">Score</span>
                <input
                  type="number"
                  step="any"
                  value={score}
                  onChange={(e) => setScore(e.target.value)}
                  className="w-32 rounded-md border border-surface-300 px-2 py-1 text-sm dark:border-surface-600 dark:bg-surface-900"
                />
              </label>
            ) : (
              <fieldset className="flex flex-col gap-1 text-sm">
                <legend className="font-medium text-surface-700 dark:text-surface-200">
                  Preference
                </legend>
                <div className="flex gap-4">
                  {['A>B', 'tie', 'B>A'].map((value) => (
                    <label key={value} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name="preference"
                        value={value}
                        checked={preference === value}
                        onChange={() => setPreference(value)}
                      />
                      {/* The submitted value is still the literal 'A>B' — only
                          its A and B are drawn as the SAME badge the options
                          panel puts on each candidate, so the reader matches
                          them by sight instead of by assumption. */}
                      {value === 'tie' ? (
                        <span>tie</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <CandidateLetter letter={value[0]} />
                          <span aria-hidden="true">&gt;</span>
                          <span className="sr-only">is better than</span>
                          <CandidateLetter letter={value[2]} />
                        </span>
                      )}
                    </label>
                  ))}
                </div>
                {/* Panels are independently collapsible and reorderable, so
                    the verdict panel cannot rely on the options panel being
                    on screen next to it — it has to name where the letters
                    come from itself. */}
                <p className="text-xs font-normal text-surface-500 dark:text-surface-400">
                  A and B are the lettered candidates in the Options panel, in that order.
                </p>
              </fieldset>
            )}
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-surface-700 dark:text-surface-200">
                Reasoning <span className="font-normal text-surface-400">(optional)</span>
              </span>
              <Textarea
                value={reasoning}
                onChange={(e) => setReasoning(e.target.value)}
                rows={3}
              />
            </label>
            <div>
              <Button onClick={() => void submit()} disabled={submitting}>
                {submitting ? 'Recording…' : 'Record reading'}
              </Button>
            </div>
          </div>
        ),
      }
    : {};

  return (
    <>
      <Header
        title="Labelling studio"
        description="One item at a time. A re-read is indistinguishable from a first reading — that is the measurement working, not a missing label."
        breadcrumbs={[
          { label: 'Golden Sets', href: '/golden-sets' },
          { label: 'Set', href: `/golden-sets/${id}` },
          { label: 'Label' },
        ]}
        actions={
          <Button variant="ghost" size="sm" onClick={() => router.push(`/golden-sets/${id}`)}>
            Back to golden set
          </Button>
        }
      />
      <main className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-8">
        <ProgressionRail stages={stagesFor(queue)} />

        {loading ? (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : item ? (
          <StudioShell
            view="labelling"
            // Per-set key: an arrangement made for a pairwise set is not
            // necessarily wanted on a pointwise one.
            storageKey={`studio:labelling:${id}`}
            renderers={renderers}
            emptyReasons={emptyReasons}
          />
        ) : (
          <QueueEmptyState queue={queue} goldenSetId={id} onRefresh={() => void loadQueue()} />
        )}
      </main>
    </>
  );
}

/**
 * The three non-item states, each rendered explicitly.
 *
 * `retest-not-yet-eligible` is the one that most looks like a bug and is not:
 * eligibility is intervening-items-only, so a set smaller than K can never
 * produce a retest at all, and the message has to carry the NUMBER or it is
 * just a shrug.
 */
function QueueEmptyState({
  queue,
  goldenSetId,
  onRefresh,
}: {
  queue: QueueResponse | null;
  goldenSetId: string;
  onRefresh: () => void;
}) {
  const shell = (title: string, body: React.ReactNode) => (
    <div className="rounded-xl border border-surface-200 bg-white p-8 text-center dark:border-surface-700 dark:bg-surface-800">
      <h2 className="text-base font-semibold text-surface-800 dark:text-surface-100">{title}</h2>
      <div className="mt-2 text-sm text-surface-600 dark:text-surface-300">{body}</div>
    </div>
  );

  if (queue?.reason === 'retest-not-yet-eligible') {
    const n = queue.labelsUntilRetest;
    return shell(
      'Nothing to read just yet',
      <>
        <p>
          {typeof n === 'number'
            ? `Label ${n} more item${n === 1 ? '' : 's'} before this one comes back.`
            : 'The remaining items need more intervening work before they can be read again.'}
        </p>
        <p className="mt-2 text-surface-500">
          A second reading is only useful once the first has faded, so it is gated on other items
          labelled in between rather than on elapsed time.
        </p>
        <Button className="mt-4" variant="ghost" onClick={onRefresh}>
          Check again
        </Button>
      </>
    );
  }

  if (queue?.reason === 'set-complete') {
    return shell(
      'You have finished this set',
      <>
        <p>Every item assigned to you has been read.</p>
        <Link
          className="mt-4 inline-block text-brand-600 hover:underline"
          href={`/golden-sets/${goldenSetId}`}
        >
          Back to the golden set
        </Link>
      </>
    );
  }

  if (queue?.reason === 'no-assignment') {
    return shell(
      'Nothing is assigned to you here',
      <p>
        Annotation work is handed out deliberately rather than self-selected, so that the overlap
        between annotators is designed. Ask the set&apos;s owner to assign you items or the whole
        set.
      </p>
    );
  }

  return shell('The queue could not be loaded', <p>Try refreshing the page.</p>);
}
