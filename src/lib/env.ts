/**
 * ─── Environment Variable Validation ──────────────────────────────────────
 *
 * Validates all required and optional environment variables at startup.
 * Fails fast with clear error messages if required vars are missing.
 *
 * Import this module in layout.tsx (server component) to validate on boot.
 */

import { z } from 'zod';

const envSchema = z.object({
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

  // ─── Redis (optional — defaults to in-memory) ──
  REDIS_URL: z.string().url().optional(),
  REALTIME_ADAPTER: z.enum(['memory', 'redis']).optional().default('memory'),
  REALTIME_REDIS_CHANNEL: z.string().optional().default('judge-arena:realtime'),

  // ─── SSE ──
  SSE_KEEP_ALIVE_MS: z.coerce.number().int().positive().optional().default(25000),

  // ─── Evaluation Engine ──
  EVALUATION_RUN_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(32).optional().default(4),
  EVALUATION_MODEL_CONCURRENCY_PER_RUN: z.coerce.number().int().min(1).max(16).optional().default(2),
  EVALUATION_MODEL_TIMEOUT_MS: z.coerce.number().int().min(5000).optional().default(120000),

  // ─── Application ──
  NEXT_PUBLIC_APP_NAME: z.string().optional().default('Judge Arena'),
  NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),

  // ─── Rate Limiting ──
  RATE_LIMIT_ENABLED: z.coerce.boolean().optional().default(true),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().optional().default(5),
  RATE_LIMIT_API_MAX: z.coerce.number().int().positive().optional().default(60),
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
