'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface LeaderboardModel {
  modelId: string;
  modelName: string;
  provider: string;
  providerModelId: string;
  avgScore: number;
  medianScore: number;
  minScore: number;
  maxScore: number;
  evaluationCount: number;
}

interface LeaderboardData {
  project: { id: string; name: string; description: string | null } | null;
  models: LeaderboardModel[];
  totalEvaluations: number;
  totalJudgments: number;
  lastUpdated: string | null;
}

type SortKey = 'avgScore' | 'medianScore' | 'evaluationCount' | 'modelName';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const providerColors: Record<string, string> = {
  anthropic: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  openai: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  local: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
};

function scoreColor(score: number): string {
  if (score >= 8) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 6) return 'text-amber-600 dark:text-amber-400';
  if (score >= 4) return 'text-orange-600 dark:text-orange-400';
  return 'text-red-600 dark:text-red-400';
}

function scoreBar(score: number): string {
  if (score >= 8) return 'bg-emerald-500';
  if (score >= 6) return 'bg-amber-500';
  if (score >= 4) return 'bg-orange-500';
  return 'bg-red-500';
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const { status } = useSession();
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('avgScore');
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    fetch('/api/leaderboard')
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(key === 'modelName'); }
  };

  const sorted = data?.models
    ? [...data.models].sort((a, b) => {
        let c = 0;
        if (sortKey === 'avgScore') c = a.avgScore - b.avgScore;
        else if (sortKey === 'medianScore') c = a.medianScore - b.medianScore;
        else if (sortKey === 'evaluationCount') c = a.evaluationCount - b.evaluationCount;
        else c = a.modelName.localeCompare(b.modelName);
        return sortAsc ? c : -c;
      })
    : [];

  const isAuth = status === 'authenticated';

  const SortBtn = ({ label, id, className }: { label: string; id: SortKey; className?: string }) => (
    <button onClick={() => handleSort(id)} className={cn(
      'flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-surface-400 hover:text-surface-200 transition-colors',
      className
    )}>
      {label}
      {sortKey === id && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={cn('transition-transform', sortAsc && 'rotate-180')}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-surface-900 text-surface-100">

      {/* ── Nav bar ─────────────────────────────────────────────────────── */}
      <nav className="border-b border-surface-800 bg-surface-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white font-bold text-sm">
              JA
            </div>
            <span className="font-bold text-surface-100 text-sm tracking-tight">Judge Arena</span>
          </Link>
          <div className="flex items-center gap-3">
            {isAuth ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                Dashboard
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </Link>
            ) : (
              <>
                <Link
                  href="/login"
                  className="rounded-lg px-4 py-2 text-sm font-medium text-surface-300 hover:text-white transition-colors"
                >
                  Sign In
                </Link>
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
                >
                  Get Started
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </Link>
              </>
            )}
          </div>
        </div>
      </nav>

      {/* ── Hero section ────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-600/[0.07] via-transparent to-violet-600/[0.04] pointer-events-none" />

        <div className="relative max-w-6xl mx-auto px-6 pt-20 pb-14 text-center">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-white max-w-3xl mx-auto leading-[1.1]">
            Your data, your rubrics,
            <span className="bg-gradient-to-r from-brand-400 to-violet-400 bg-clip-text text-transparent"> your insight</span>
          </h1>

          <p className="mt-5 text-lg text-surface-400 max-w-2xl mx-auto leading-relaxed">
            Reproducible LLM evaluation that runs on your infrastructure.
            Prompts, rubrics, and judgments stay under your roof &mdash; nothing hits the cloud.
          </p>

          <div className="mt-8 flex items-center justify-center gap-3">
            {isAuth ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 transition-colors shadow-lg shadow-brand-600/25"
              >
                Go to Dashboard
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </Link>
            ) : (
              <>
                <Link
                  href="/register"
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 transition-colors shadow-lg shadow-brand-600/25"
                >
                  Deploy Your Instance
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
                </Link>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-lg border border-white/10 backdrop-blur-md bg-white/[0.04] px-6 py-2.5 text-sm font-medium text-surface-300 hover:text-white hover:bg-white/[0.08] transition-all"
                >
                  Sign In
                </Link>
              </>
            )}
          </div>

          {/* Feature cards — glassmorphism */}
          <div className="mt-12 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-3xl mx-auto">
            {[
              { emoji: '\u{1F512}', title: 'Self-Hosted', desc: 'Your infra, your rules' },
              { emoji: '\u{1F4CB}', title: 'Versioned Rubrics', desc: 'Pin criteria to each eval' },
              { emoji: '\u{2696}\u{FE0F}', title: 'Multi-Model', desc: 'Side-by-side judging' },
              { emoji: '\u{1F9D1}\u{200D}\u{1F4BB}', title: 'Human Review', desc: 'Layer expert oversight' },
            ].map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-white/[0.08] backdrop-blur-md bg-white/[0.03] px-4 py-4 text-left hover:bg-white/[0.06] hover:border-white/[0.14] transition-all"
              >
                <span className="text-lg leading-none">{f.emoji}</span>
                <p className="mt-2 text-[13px] font-semibold text-surface-200">{f.title}</p>
                <p className="mt-0.5 text-[11px] text-surface-500 leading-snug">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      {data && sorted.length > 0 && (
        <div className="border-y border-surface-800 bg-surface-800/30">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-8">
              {[
                { label: 'Models Ranked', value: data.models.length },
                { label: 'Evaluations', value: data.totalEvaluations },
                { label: 'Judgments', value: data.totalJudgments },
              ].map((s) => (
                <div key={s.label} className="text-sm">
                  <span className="font-bold text-white tabular-nums">{s.value.toLocaleString()}</span>
                  <span className="text-surface-500 ml-1.5">{s.label}</span>
                </div>
              ))}
            </div>
            {data.lastUpdated && (
              <div className="text-xs text-surface-500">
                Updated {new Date(data.lastUpdated).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Leaderboard table ───────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 py-10">
        <div className="flex items-end justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-white">Model Rankings</h2>
            <p className="text-sm text-surface-400 mt-1">
              Aggregate scores from rubric-pinned evaluations on this instance
            </p>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-14 rounded-lg bg-surface-800 animate-pulse" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-700 bg-surface-800/30 py-20 text-center">
            <div className="text-surface-500 text-sm">No model evaluations yet.</div>
            <p className="text-surface-600 text-xs mt-2 max-w-sm mx-auto">
              Once evaluations are run against the public leaderboard project, model rankings will appear here.
            </p>
            {!isAuth && (
              <Link
                href="/register"
                className="inline-flex items-center gap-2 mt-6 rounded-lg bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 transition-colors"
              >
                Get Started
              </Link>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-surface-700 bg-surface-800/50 overflow-hidden">
            {/* Header */}
            <div className="grid grid-cols-[3rem_1fr_6.5rem_5.5rem_5rem_5rem] gap-3 px-4 py-2.5 border-b border-surface-700/60 bg-surface-800/80 text-surface-500">
              <span className="text-[11px] font-semibold uppercase tracking-wider">#</span>
              <SortBtn label="Model" id="modelName" />
              <span className="text-[11px] font-semibold uppercase tracking-wider">Provider</span>
              <SortBtn label="Avg Score" id="avgScore" />
              <SortBtn label="Median" id="medianScore" />
              <SortBtn label="Evals" id="evaluationCount" />
            </div>

            {/* Rows */}
            {sorted.map((model, i) => {
              const rank = sortKey === 'avgScore' && !sortAsc ? i + 1 : i + 1;
              const isTop = sortKey === 'avgScore' && !sortAsc && i === 0;
              return (
                <div
                  key={model.modelId}
                  className={cn(
                    'grid grid-cols-[3rem_1fr_6.5rem_5.5rem_5rem_5rem] gap-3 px-4 py-3 items-center transition-colors',
                    'hover:bg-surface-700/20',
                    i > 0 && 'border-t border-surface-700/30',
                    isTop && 'bg-brand-600/5 border-l-2 border-l-brand-500'
                  )}
                >
                  {/* Rank */}
                  <div className="flex justify-center">
                    {rank <= 3 && sortKey === 'avgScore' && !sortAsc ? (
                      <span className={cn(
                        'inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold',
                        rank === 1 && 'bg-amber-500/20 text-amber-400',
                        rank === 2 && 'bg-surface-600/30 text-surface-300',
                        rank === 3 && 'bg-orange-500/20 text-orange-400',
                      )}>{rank}</span>
                    ) : (
                      <span className="text-sm text-surface-500 tabular-nums">{rank}</span>
                    )}
                  </div>

                  {/* Model */}
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-surface-100 truncate">{model.modelName}</div>
                    <div className="text-[11px] text-surface-500 truncate font-mono">{model.providerModelId}</div>
                  </div>

                  {/* Provider */}
                  <span className={cn(
                    'inline-flex items-center justify-center px-2 py-0.5 rounded-md text-[11px] font-medium capitalize w-fit',
                    providerColors[model.provider] || 'bg-surface-700 text-surface-300'
                  )}>
                    {model.provider}
                  </span>

                  {/* Avg Score + bar */}
                  <div className="space-y-1">
                    <span className={cn('text-sm font-bold tabular-nums', scoreColor(model.avgScore))}>
                      {model.avgScore.toFixed(2)}
                    </span>
                    <div className="h-1 w-full rounded-full bg-surface-700">
                      <div
                        className={cn('h-full rounded-full transition-all', scoreBar(model.avgScore))}
                        style={{ width: `${(model.avgScore / 10) * 100}%` }}
                      />
                    </div>
                  </div>

                  {/* Median */}
                  <span className={cn('text-sm tabular-nums', scoreColor(model.medianScore))}>
                    {model.medianScore.toFixed(2)}
                  </span>

                  {/* Evals */}
                  <span className="text-sm tabular-nums text-surface-400">{model.evaluationCount}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Legend */}
        {sorted.length > 0 && (
          <div className="flex items-center gap-5 mt-4 text-[11px] text-surface-500">
            <span>Score scale: 0 &ndash; 10</span>
            {[
              { color: 'bg-emerald-500', label: '8-10 Excellent' },
              { color: 'bg-amber-500', label: '6-8 Good' },
              { color: 'bg-orange-500', label: '4-6 Fair' },
              { color: 'bg-red-500', label: '0-4 Poor' },
            ].map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span className={cn('w-1.5 h-1.5 rounded-full', l.color)} />{l.label}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section className="border-t border-white/[0.04]">
        <div className="max-w-6xl mx-auto px-6 py-16">
          <h2 className="text-xl font-bold text-white text-center mb-2">Reproducible by Design</h2>
          <p className="text-sm text-surface-500 text-center mb-10 max-w-lg mx-auto">
            Every evaluation is pinned to a rubric version, a prompt, and a model config. Re-run it next month &mdash; get the same setup.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                step: '1',
                title: 'Version Your Rubrics',
                desc: 'Define weighted scoring criteria and lock them to a version. When your rubric evolves, past evaluations stay pinned to the original.',
              },
              {
                step: '2',
                title: 'Run Models Side-by-Side',
                desc: 'Send the same prompt to multiple LLMs in parallel. Compare scores, latency, and reasoning on your own hardware or cloud.',
              },
              {
                step: '3',
                title: 'Layer Human Review',
                desc: 'Optionally add expert judgment over model outputs. Spot disagreements, pick the best response, and build gold-standard datasets.',
              },
            ].map((s) => (
              <div key={s.step} className="rounded-xl border border-white/[0.06] backdrop-blur-md bg-white/[0.02] p-6 hover:bg-white/[0.04] transition-all">
                <div className="flex items-center gap-3 mb-4">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600/20 text-brand-400 text-sm font-bold">{s.step}</span>
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{s.title}</h3>
                <p className="text-sm text-surface-400 leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA footer ──────────────────────────────────────────────────── */}
      {!isAuth && (
        <section className="border-t border-white/[0.04]">
          <div className="max-w-6xl mx-auto px-6 py-16 text-center">
            <h2 className="text-2xl font-bold text-white">Ship evaluations that stay on your terms</h2>
            <p className="mt-3 text-surface-400 max-w-lg mx-auto">
              Self-host on any VPS, connect your own API keys, and keep every prompt, rubric, and judgment under your roof.
            </p>
            <div className="mt-6 flex items-center justify-center gap-3">
              <Link
                href="/register"
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-500 transition-colors shadow-lg shadow-brand-600/25"
              >
                Get Started
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.04] bg-surface-900">
        <div className="max-w-6xl mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-surface-500">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-brand-600 text-white font-bold text-[9px]">JA</div>
            Judge Arena
          </div>
          <div className="text-xs text-surface-600">
            Reproducible LLM evaluation &middot; Self-hosted
          </div>
        </div>
      </footer>
    </div>
  );
}
