/**
 * ─── Environment Variable Validation ──────────────────────────────────────
 *
 * Validates all required and optional environment variables at startup.
 * Fails fast with clear error messages if required vars are missing.
 *
 * Import this module in layout.tsx (server component) to validate on boot.
 *
 * ── WARNING: NOTHING CURRENTLY IMPORTS THIS MODULE. ────────────────────────
 * The line above is an instruction that was never carried out — `getEnv()` has
 * zero callers in `src/`, `scripts/` or `worker.ts` (verified by grep), so
 * every refusal declared below, including the timeout-budget ordering rule
 * added here, is INERT at runtime today. That is why
 * `src/lib/llm/timeout-policy.ts`'s `resolveTimeoutBudgets()` ALSO clamps an
 * inverted pair instead of trusting this schema to have refused it: a policy
 * that depends on a validator nobody runs is not a policy. Wiring `getEnv()`
 * into `src/app/layout.tsx` and `worker.ts` is the real fix and is out of
 * scope here (neither file belongs to this change) — it is reported rather
 * than silently assumed.
 */

import { z } from 'zod';
import {
  DEFAULT_HARD_CAP_MS,
  DEFAULT_INITIAL_BUDGET_MS,
  MAX_HARD_CAP_MS,
  MIN_BUDGET_MS,
  budgetOrderingError,
} from '@/lib/llm/timeout-policy';

const envObject = z.object({
  // ─── Required ──
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required. Set a PostgreSQL connection string.'),
  NEXTAUTH_SECRET: z
    .string()
    .min(16, 'NEXTAUTH_SECRET must be at least 16 characters. Generate with: openssl rand -base64 32'),
  NEXTAUTH_URL: z
    .string()
    .url('NEXTAUTH_URL must be a valid URL (e.g., http://localhost:3000)'),

  // ─── Encryption ──
  ENCRYPTION_KEY: z
    .string()
    .min(16, 'ENCRYPTION_KEY is required for API key encryption. Generate with: openssl rand -hex 32')
    .optional()
    .default(''),

  // ─── LLM API Keys (optional — can be set per-model instead) ──
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),

  // ─── Redis (mandatory in production, optional in dev/test — see redis.ts) ──
  // Also backs the realtime SSE bus (src/lib/realtime/redis-bus.ts), which
  // shares this same client — no separate adapter/channel env vars; see
  // src/lib/realtime/factory.ts for the (env-free) adapter selection.
  REDIS_URL: z.string().url().optional(),

  // ─── RabbitMQ (mandatory in production, optional in dev/test — see connection.ts) ──
  // Backs the judgment-execution and run-create queues (src/lib/queue/**).
  // Required in production: getRabbit() throws RabbitConfigError at first
  // use if unset with NODE_ENV=production. Non-production environments
  // default to amqp://guest:guest@localhost:5672 if unset, so this is
  // optional for local dev — but the queue integration tests obviously
  // need a real RabbitMQ running to exercise.
  RABBITMQ_URL: z.string().url().optional(),

  // ─── SSE ──
  SSE_KEEP_ALIVE_MS: z.coerce.number().int().positive().optional().default(25000),

  // ─── Evaluation Engine ──
  EVALUATION_RUN_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(32).optional().default(4),
  EVALUATION_MODEL_CONCURRENCY_PER_RUN: z.coerce.number().int().min(1).max(16).optional().default(2),
  /**
   * The INITIAL budget of the escalating timeout — the point at which a slow
   * provider call raises the 5-minute alert. Reaching it does NOT abort
   * anything; `EVALUATION_MODEL_HARD_CAP_MS` below is the abort. See
   * `src/lib/llm/timeout-policy.ts`.
   *
   * Default moved 120000 -> 300000 to match the owner's "start at 5min" AND
   * the value both production pods have actually been running with (helmrelease
   * `extraEnv`) for as long as this has mattered. A default that disagrees
   * with every deployment of it is not a default, it is a trap for whoever
   * next runs this locally and gets different timeout behaviour from prod.
   */
  EVALUATION_MODEL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_BUDGET_MS)
    .optional()
    .default(DEFAULT_INITIAL_BUDGET_MS),

  /**
   * The HARD CAP — the owner's "15min which is a hard-cutoff". Reaching this
   * aborts the provider call (`registry.ts`'s `execute()`).
   *
   * The upper bound is derived, not chosen: `MAX_HARD_CAP_MS` is
   * `consumer_timeout (1_800_000) − GATE_WAIT_TIMEOUT_MS (600_000) −
   * POST_CALL_SLACK_MS (30_000)`. Above it, a fallback-queue delivery's
   * unacked window exceeds RabbitMQ's `consumer_timeout` by construction, and
   * that does not fail one message — it closes the CHANNEL and every consumer
   * on it (see src/worker/concurrency.ts's module doc, and src/worker/health.ts
   * for what a worker with no consumers looks like from the outside: 1/1
   * Running, /health 200, five days of silence).
   */
  EVALUATION_MODEL_HARD_CAP_MS: z.coerce
    .number()
    .int()
    .min(MIN_BUDGET_MS)
    .max(MAX_HARD_CAP_MS)
    .optional()
    .default(DEFAULT_HARD_CAP_MS),

  // ─── Application ──
  NEXT_PUBLIC_APP_NAME: z.string().optional().default('Judge Arena'),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),

  // ─── Rate Limiting ──
  // Actual parsing/defaults for these live in src/lib/rate-limit.ts (read
  // directly off process.env, matching this repo's existing convention —
  // see that file's docstring for why). Declared here too so `getEnv()`
  // validates/documents the full env surface.
  RATE_LIMIT_ENABLED: z.coerce.boolean().optional().default(true),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().optional().default(5),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().optional().default(120),
  RATE_LIMIT_JUDGE_MAX: z.coerce.number().int().positive().optional().default(10),
  RATE_LIMIT_HUGGINGFACE_MAX: z.coerce.number().int().positive().optional().default(30),

  // ─── Proxy / Deployment ──
  TRUSTED_PROXY: z.enum(['true', 'false']).optional().default('false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
});

/**
 * The one CROSS-FIELD rule: the hard cap may not precede the initial budget.
 *
 * A config where the cutoff comes before the warning is not "aggressive", it
 * is incoherent — the alert promises "waiting N more minutes" and the abort
 * has already happened. It must fail where a human is reading output (boot),
 * not at 3am inside a 30-item calibration, so it is a schema refusal rather
 * than a runtime log line.
 *
 * The issue is attached to `EVALUATION_MODEL_HARD_CAP_MS` because that is the
 * variable an operator should change: the initial budget is the documented
 * 5-minute alert point, the cap is the knob being widened.
 *
 * The rule itself lives in `timeout-policy.ts` (`budgetOrderingError`) so the
 * schema and the runtime that obeys it cannot drift apart.
 *
 * CAVEAT, and it is the second reason `resolveTimeoutBudgets()` clamps as well
 * as this refusing: zod runs `superRefine` ONLY when the object parse
 * succeeded. Any unrelated invalid field above (and `ENCRYPTION_KEY` is
 * declared `.min(16)` with a `''` default it can never satisfy, so an
 * environment that simply omits it is already invalid) makes this check
 * silently not run at all.
 */
export const envSchema = envObject.superRefine((value, ctx) => {
  const message = budgetOrderingError(value.EVALUATION_MODEL_TIMEOUT_MS, value.EVALUATION_MODEL_HARD_CAP_MS);
  if (message) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EVALUATION_MODEL_HARD_CAP_MS'], message });
  }
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

/**
 * Validate and return parsed environment variables.
 * Caches the result after first successful parse.
 * Throws with detailed error messages if validation fails.
 */
export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ✗ ${i.path.join('.')}: ${i.message}`)
      .join('\n');

    const message = [
      '',
      '╔══════════════════════════════════════════════════════════════╗',
      '║           ENVIRONMENT CONFIGURATION ERROR                  ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      'The following environment variables are missing or invalid:',
      '',
      issues,
      '',
      'Copy .env.example to .env.local and fill in the required values.',
      '',
    ].join('\n');

    // In production, throw hard. In dev, warn but don't crash.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(message);
    } else {
      console.warn(message);
      // Return partial result with defaults for development
      cachedEnv = result.data as unknown as Env;
      return cachedEnv ?? ({} as Env);
    }
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * Check if a specific env var is configured (non-empty).
 */
export function hasEnv(key: keyof Env): boolean {
  const env = getEnv();
  const value = env[key];
  return value !== undefined && value !== '';
}
