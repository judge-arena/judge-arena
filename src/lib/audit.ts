/**
 * ─── Audit Logging ────────────────────────────────────────────────────────
 *
 * Records security-critical operations for compliance and debugging.
 * Uses fire-and-forget writes to avoid blocking request processing.
 */

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';

export type AuditAction =
  | 'user.register'
  | 'user.login'
  | 'user.login.failed'
  | 'apikey.create'
  | 'apikey.update'
  | 'apikey.delete'
  | 'evaluation.run'
  | 'evaluation.create'
  | 'evaluation.delete'
  | 'model.create'
  | 'model.update'
  | 'model.delete'
  | 'rubric.create'
  | 'rubric.update'
  | 'rubric.delete'
  | 'dataset.create'
  | 'dataset.update'
  | 'dataset.delete'
  | 'project.create'
  | 'project.update'
  | 'project.delete'
  | 'config.export'
  | 'config.import';

export interface AuditEntry {
  userId?: string;
  action: AuditAction;
  resource?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/**
 * Record an audit log entry. Fire-and-forget — does not throw.
 */
export function audit(entry: AuditEntry): void {
  prisma.auditLog
    .create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        resource: entry.resource ?? null,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
    })
    .catch((error) => {
      logger.error('Failed to write audit log', {
        action: entry.action,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Extract client IP and user agent from request headers.
 */
export function getRequestContext(request: Request): { ip: string; userAgent: string } {
  const forwarded = request.headers.get('x-forwarded-for');
  const ip = forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? 'unknown';
  const userAgent = request.headers.get('user-agent') ?? 'unknown';
  return { ip, userAgent };
}
