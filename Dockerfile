# ─── Judge Arena — Multi-stage Image (Task 16) ─────────────────────────────
#
# Three stages: deps -> builder -> runner. `runner` is the default final
# target (what `docker build .` / the `app`/`worker` compose services use);
# `builder` is ALSO used directly by the compose `migrate` one-shot service
# (`build: { target: builder }`) because it's the only stage with the full
# Prisma CLI + prisma/migrations available — see that service's comment in
# docker-compose.yml for why this is the right split rather than hand-
# copying a `prisma`-CLI-shaped subset of node_modules into `runner`.
#
# One image, two long-running entrypoints: `runner` ships BOTH
# `server.js` (web, the default CMD) and `worker.js` (queue consumer) —
# the compose `worker` service just overrides `command:`.

# ─── Stage 1: Dependencies ─────────────────────────────────────────────────
# Full tree (deps + devDeps — `next build` needs typescript/tailwindcss/
# postcss, and `builder` needs the `prisma` CLI package for `migrate
# deploy`). `--ignore-scripts` skips Prisma's postinstall `generate` so the
# single `prisma generate` below (inside `npm run build`) is the ONLY one
# that runs — the pre-Task-16 image ran it 3x (deps postinstall + an
# explicit builder-stage call + `npm run build`'s own call).
FROM node:22-alpine AS deps

WORKDIR /app

# libc6-compat: some native-addon npm packages expect glibc symbols during
# their own install/postinstall step even on Alpine/musl. Only needed here,
# at install time — the resulting node_modules is just copied (not
# reinstalled) into `builder`/`runner`, so neither of those stages needs it.
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ─── Stage 2: Build ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# `npm run build` = `npx prisma generate && next build` (see package.json).
# `next.config.js` sets `output: 'standalone'`, so this produces
# `.next/standalone/server.js` + a pruned `node_modules` (webpack-bundles
# most deps into the compiled server chunks; only genuinely native/
# "serverExternalPackages" deps — just `@prisma/client` here — get
# file-traced into `.next/standalone/node_modules` as real files).
RUN npm run build

# Worker bundle: compile src/worker/main.ts + its whole import graph
# (queue/connection, queue/topology, redis, db, the LLM provider backends,
# etc.) into ONE self-contained CommonJS file written directly into
# `.next/standalone/`, alongside `server.js` — so the runner stage's single
# `COPY .../.next/standalone` picks up both entrypoints in one shot.
#
# Only `@prisma/client` is left external/unbundled: it ships a native
# query-engine binary that must resolve from node_modules at runtime, and
# the standalone output already carries `node_modules/@prisma` +
# `node_modules/.prisma` (copied above by `next build`'s own tracer), so no
# extra COPY is needed for it.
#
# Deliberately narrower than a blanket `--packages=external`: that flag was
# tried first and left amqplib/redis/openai/@anthropic-ai/sdk unresolved in
# the runner. Next's standalone tracer only file-traces packages it treats
# as "external" (via `serverExternalPackages` in next.config.js, which
# lists just `@prisma/client`) — every other dependency gets webpack-
# bundled straight into the *web* server's compiled chunks instead of
# being left as a loose node_modules package, so a worker build that marks
# them external too would hit `Cannot find module 'amqplib'` etc. at
# runtime (verified locally: `node_modules/amqplib` is absent from
# `.next/standalone/node_modules`, `@prisma/client` is present). None of
# those packages have native bindings (verified: no `.node`/`binding.gyp`
# under any of them), so bundling them directly is both correct and safer
# than depending on Next's file-tracing behavior for a target it doesn't
# know exists.
RUN npx esbuild src/worker/main.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/worker.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning

# Admin CLI bundle (Phase 1c): same treatment as the worker above, for the
# same reason — the runner ships no TypeScript toolchain, so `tsx` is not
# available to run `scripts/admin/create-user.ts` in-cluster. This is the
# break-glass account path: self-service registration is retired, so if
# Authentik OIDC is misconfigured this CLI is the ONLY way in. It is
# bundled via `create-user-entry.ts` rather than the script itself because
# that script's `import.meta.url` direct-run guard cannot work under CJS
# output (see that file's header).
RUN npx esbuild scripts/admin/create-user-entry.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --outfile=.next/standalone/admin-create-user.js \
      --external:@prisma/client \
      --tsconfig=tsconfig.json \
      --log-level=warning

# ─── Stage 2b: Prisma CLI (isolated) ──────────────────────────────────────
# A clean, self-consistent install of JUST the Prisma CLI, at a prefix that
# cannot collide with the app's node_modules. The runner needs `migrate
# deploy` (the chart runs it from a Helm hook Job), but the CLI's dependency
# closure spans several @prisma/* packages, and lifting them piecemeal out
# of `deps` both misses transitive deps and risks clobbering the GENERATED
# @prisma/client that `next build` traced into the standalone output.
#
# Pinned to the exact version of `prisma`/`@prisma/client` in package.json —
# the migration engine and the client must not drift apart.
FROM node:22-alpine AS prisma-cli

WORKDIR /opt/prisma-cli

RUN npm init -y > /dev/null \
 && npm install --no-audit --no-fund --save-exact prisma@6.19.2

# ─── Stage 3: Production Runner ───────────────────────────────────────────
# Standalone output, plus exactly two additions beyond it (Phase 1c):
#   1. the Prisma CLI + `prisma/` (schema + migrations), so the SAME image
#      can run `migrate deploy` from the chart's post-install/post-upgrade
#      hook Job. The shared kaniko build template passes no `--target`, so
#      only this final stage is ever published — a `builder`-stage migrate
#      image (what docker-compose.yml uses) is unbuildable in-cluster.
#   2. `admin-create-user.js`, the break-glass account CLI (see above).
# Still no dev toolchain: no typescript, eslint, vitest or tailwindcss.
FROM node:22-alpine AS runner

WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

COPY --from=builder /app/public ./public

# Next's standalone output already includes its own pruned package.json —
# no separate copy of the repo-root one needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Migration toolchain (Phase 1c). `prisma/` supplies schema.prisma and the
# checked-in migrations; the CLI itself comes from the isolated
# `prisma-cli` stage at /opt/prisma-cli.
#
# Why a separate tree instead of copying into ./node_modules: the CLI's
# real dependency closure is wider than it looks (@prisma/debug, config,
# get-platform, fetch-engine, engines-version — a hand-picked subset fails
# at runtime with "Cannot find module '@prisma/debug'", verified), and
# copying the whole @prisma scope from `deps` would OVERWRITE
# node_modules/@prisma/client with the un-generated copy that `npm ci
# --ignore-scripts` left behind, breaking the app at runtime. An isolated
# prefix cannot collide with the standalone output's generated client.
#
# Two migrations contain hand-written SQL that Prisma's DSL cannot express
# (a NULLS NOT DISTINCT unique index and a partial unique index), so they
# exist ONLY as migration files — `db push` would silently drop them.
# Applying migrations, not pushing the schema, is therefore load-bearing
# for correctness, not just for history.
COPY --from=prisma-cli --chown=nextjs:nodejs /opt/prisma-cli /opt/prisma-cli
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Numeric UID, not `USER nextjs`: kubelet resolves `runAsNonRoot: true` by
# inspecting the image's configured user, and it cannot verify a NAME —
# a named user makes the pod fail to start with
# "container has runAsNonRoot and image has non-numeric user".
USER 1001

EXPOSE 3000

# Web healthcheck (default). The compose `worker` service overrides this
# with its own check against WORKER_HEALTH_PORT (see docker-compose.yml) —
# worker.js has no HTTP server on :3000/api/health.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Web is the default entrypoint; the compose `worker` service overrides
# `command: ["node", "worker.js"]`. NO migrations here — moved to the
# dedicated `migrate` one-shot compose service.
CMD ["node", "server.js"]
