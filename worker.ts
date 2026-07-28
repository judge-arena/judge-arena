/**
 * Root-level worker entry point.
 *
 * Thin re-export of `src/worker/main.ts`, which does the actual boot (see
 * that file's docstring). Kept at the repo root — parallel to
 * `next.config.js`/`tailwind.config.ts` — so a future build/deploy step
 * (Task 16) has a stable top-level entry path to target, independent of
 * wherever the worker's implementation happens to live under `src/`.
 *
 * Local dev uses `npm run worker` (`tsx src/worker/main.ts`) directly; this
 * file is an alternate entry (`tsx worker.ts` / a bundler target), not a
 * second copy of the boot logic.
 */
import './src/worker/main';
