/**
 * ─── Structured Logging ───────────────────────────────────────────────────
 *
 * Production-grade structured logging with JSON output.
 * Uses a lightweight custom implementation (no external deps).
 *
 * Features:
 * - JSON structured output in production, pretty-print in development
 * - Request correlation IDs
 * - Log levels: debug, info, warn, error, fatal
 * - Child loggers with bound context
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const MIN_LEVEL = LOG_LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? LOG_LEVELS.info;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface LogEntry {
  level: LogLevel;
  msg: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatEntry(entry: LogEntry): string {
  if (IS_PRODUCTION) {
    return JSON.stringify(entry);
  }

  // Development: pretty print
  const { level, msg, timestamp, ...rest } = entry;
  const prefix = {
    debug: '🔍',
    info: 'ℹ️ ',
    warn: '⚠️ ',
    error: '❌',
    fatal: '💀',
  }[level];

  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${prefix} [${timestamp}] ${msg}${extra}`;
}

function writeLog(entry: LogEntry) {
  const output = formatEntry(entry);
  if (LOG_LEVELS[entry.level] >= LOG_LEVELS.error) {
    console.error(output);
  } else if (entry.level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  fatal(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function createLogMethod(level: LogLevel, bindings: Record<string, unknown>) {
  return (msg: string, data?: Record<string, unknown>) => {
    if (LOG_LEVELS[level] < MIN_LEVEL) return;

    writeLog({
      level,
      msg,
      timestamp: new Date().toISOString(),
      ...bindings,
      ...data,
    });
  };
}

/**
 * Create a logger instance with optional bound context.
 */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: createLogMethod('debug', bindings),
    info: createLogMethod('info', bindings),
    warn: createLogMethod('warn', bindings),
    error: createLogMethod('error', bindings),
    fatal: createLogMethod('fatal', bindings),
    child(childBindings: Record<string, unknown>): Logger {
      return createLogger({ ...bindings, ...childBindings });
    },
  };
}

/** Root logger instance */
export const logger = createLogger({ service: 'judge-arena' });

/**
 * Generate a unique request correlation ID.
 */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
