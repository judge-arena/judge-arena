/**
 * Bundle entrypoint for the admin invite CLI (Phase 1c — deploy readiness).
 *
 * `create-user.ts` decides whether to execute via an `import.meta.url` ===
 * `process.argv[1]` guard, which is correct under `tsx` but cannot survive
 * esbuild's CJS output (`import.meta` is not available in that format, so
 * the guard silently evaluates false and the CLI would do nothing). The
 * runner image ships no TypeScript toolchain, so the CLI has to be bundled
 * the same way `src/worker/main.ts` already is — hence this explicit entry
 * that calls `main()` directly instead of depending on the guard.
 *
 * Built into `.next/standalone/admin-create-user.js` by the Dockerfile's
 * builder stage; invoked in-cluster as:
 *   node admin-create-user.js --email=you@example.com --admin --password=...
 *
 * This is the break-glass account path: self-service registration is
 * retired, so if Authentik OIDC is misconfigured this CLI is the ONLY way
 * to get an account. It must ship in the image — see .dockerignore, which
 * un-ignores `scripts/admin/` for exactly this reason.
 */
import { main } from './create-user';

main().catch((e) => {
  console.error('create-user failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
