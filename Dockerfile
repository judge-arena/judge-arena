# ─── Stage 1: Dependencies ─────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install libc6-compat for Alpine (needed by some native modules)
RUN apk add --no-cache libc6-compat

# Copy dependency files
COPY package.json package-lock.json* ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --ignore-scripts
RUN npx prisma generate

# ─── Stage 2: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY public ./public  

# Set build-time environment
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Generate Prisma client and build Next.js
RUN npx prisma generate
RUN npm run build

# ─── Stage 3: Production Runner ───────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Copy necessary files from builder
COPY --from=builder /app/public ./public/
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# Copy Next.js standalone output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy node_modules for Prisma (client + CLI for deploy-time migrations)
COPY --from=deps /app/node_modules ./node_modules

USER nextjs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Run migrations then start the application
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma 2>&1 && node server.js"]
