/**
 * ─── RabbitMQ Connection ──────────────────────────────────────────────────
 *
 * Lazy singleton AMQP connection + publisher-confirms channel shared by
 * every producer in `src/lib/queue/publish.ts` (and, from Task 7 on, every
 * worker). Mirrors `src/lib/redis.ts`'s contract: a module-level singleton
 * created on first use, a `*ConfigError` that must propagate (never
 * fail-open) when required config is missing in production, and a
 * `*Healthy()` check bounded at 500ms that never throws.
 *
 * amqplib has no automatic reconnect on a plain `connect()` — unlike
 * node-redis's client, which silently reconnects its own socket under the
 * hood (see redis.ts's docstring), a dropped AMQP connection is just a
 * dead `ChannelModel` that emits `'close'` once and does nothing further.
 * This module hand-rolls that reconnect loop: on `'close'`, schedule a
 * reconnect attempt with exponential backoff (1s → 2s → 4s ... capped at
 * 30s), resetting to 1s after every successful (re)connect.
 *
 * A channel is scoped to its underlying TCP connection in the AMQP
 * protocol — a channel-level error (e.g. a bad `assertQueue` argument
 * mismatch) closes just that channel, not the whole connection. `conn` and
 * `confirmChannel` therefore invalidate independently: losing the
 * connection tears down both and reconnects from scratch; losing just the
 * channel recreates a fresh channel on the still-live connection.
 *
 * Fail-fast contract: in production, `getRabbit()` throws `RabbitConfigError`
 * immediately if `RABBITMQ_URL` is not set — RabbitMQ backs judgment
 * execution end-to-end (see `src/lib/queue/publish.ts`), so a
 * silently-missing broker in production would mean silently-missing
 * evaluation runs, not a loud, obvious failure. Non-production environments
 * (dev, test) default to `amqp://guest:guest@localhost:5672` so
 * contributors don't need to set RABBITMQ_URL just to run the app or the
 * test suite locally.
 */

import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

/**
 * Thrown by `getRabbit()` in production when RABBITMQ_URL is not
 * configured. Used to differentiate configuration errors (which must
 * propagate, never fail-open) from transient runtime/connection errors
 * (which callers may choose to fail-open around).
 */
export class RabbitConfigError extends Error {
  override name = 'RabbitConfigError';

  constructor(message: string) {
    super(message);
  }
}

const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let conn: ChannelModel | null = null;
let confirmChannel: ConfirmChannel | null = null;
let connectPromise: Promise<{ conn: ChannelModel; confirmChannel: ConfirmChannel }> | null = null;
let channelPromise: Promise<ConfirmChannel> | null = null;

let reconnectDelayMs = RECONNECT_INITIAL_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Set just before an intentional `conn.close()` (from closeRabbit()) so the
// 'close' handler below can tell "we did this on purpose, shut down clean"
// apart from "the broker/network dropped us, reconnect" — without this, a
// graceful shutdown would immediately schedule a reconnect attempt of its
// own, defeating the shutdown and potentially keeping the process alive.
let intentionalClose = false;

// Test-only counter for tracking connection attempts (incremented on each
// getRabbit() call that initiates a connection).
let connectAttempts = 0;

export function resolveRabbitUrl(): string {
  const url = process.env.RABBITMQ_URL;
  if (url) return url;

  if (process.env.NODE_ENV === 'production') {
    throw new RabbitConfigError(
      'RABBITMQ_URL is not set. RabbitMQ is required in production (judgment ' +
        'execution + run-create queues). Set RABBITMQ_URL=amqp://user:pass@host:5672 ' +
        'in the environment before starting the app.'
    );
  }

  return 'amqp://guest:guest@localhost:5672';
}

function clearState(): void {
  conn = null;
  confirmChannel = null;
  connectPromise = null;
  channelPromise = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // already scheduled

  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Prime the singleton eagerly rather than waiting for the next
    // getRabbit() caller — callers that arrive in the meantime independently
    // trigger the same connectPromise path, so this is just a background
    // head start. A failed attempt reschedules itself via createConnection's
    // rejection -> connectPromise reset -> caller retries -> 'close' never
    // fired (connect itself failed), so we explicitly reschedule here too.
    getRabbit().catch((error) => {
      console.error('RabbitMQ reconnect attempt failed:', error);
      scheduleReconnect();
    });
  }, delay);
}

/**
 * Create (or recreate) the confirm channel on an already-live connection.
 * De-duplicated across concurrent callers via `channelPromise`, same
 * pattern as `connectPromise` for the connection itself.
 */
function ensureChannel(liveConn: ChannelModel): Promise<ConfirmChannel> {
  if (confirmChannel) return Promise.resolve(confirmChannel);

  if (!channelPromise) {
    channelPromise = liveConn
      .createConfirmChannel()
      .then((ch) => {
        ch.on('error', (error) => {
          console.error('RabbitMQ channel error:', error);
        });
        ch.on('close', () => {
          // Only a channel-level failure (e.g. a precondition-failed on a
          // bad assert) — the connection itself is still up. Invalidate
          // just the channel so the next getRabbit() call recreates it
          // without tearing down/reconnecting the whole connection.
          if (confirmChannel === ch) confirmChannel = null;
        });
        confirmChannel = ch;
        channelPromise = null;
        return ch;
      })
      .catch((error) => {
        channelPromise = null;
        throw error;
      });
  }

  return channelPromise;
}

async function createConnection(): Promise<{ conn: ChannelModel; confirmChannel: ConfirmChannel }> {
  connectAttempts++;
  const url = resolveRabbitUrl();
  const newConn = await amqp.connect(url);

  newConn.on('error', (error) => {
    console.error('RabbitMQ connection error:', error);
  });
  newConn.on('close', () => {
    clearState();
    if (intentionalClose) {
      intentionalClose = false;
      return;
    }
    console.error('RabbitMQ connection closed, scheduling reconnect');
    scheduleReconnect();
  });

  conn = newConn;
  const ch = await ensureChannel(newConn);

  // Reset backoff after a successful (re)connect, and cancel any reconnect
  // timer left over from the failure that preceded this success (relevant
  // when a caller's own getRabbit() races the background retry scheduled
  // by scheduleReconnect()).
  reconnectDelayMs = RECONNECT_INITIAL_MS;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  return { conn: newConn, confirmChannel: ch };
}

/**
 * Resolve the singleton `{ conn, confirmChannel }`, connecting (once,
 * de-duplicated across concurrent callers) if necessary. Throws
 * `RabbitConfigError` in production if RABBITMQ_URL is unset — see module
 * docstring.
 */
export async function getRabbit(): Promise<{ conn: ChannelModel; confirmChannel: ConfirmChannel }> {
  if (conn && confirmChannel) {
    return { conn, confirmChannel };
  }

  if (conn) {
    // Connection is fine; only the channel needs recreating.
    const ch = await ensureChannel(conn);
    return { conn, confirmChannel: ch };
  }

  if (!connectPromise) {
    connectPromise = createConnection().catch((error) => {
      connectPromise = null;
      throw error;
    });
  }

  return connectPromise;
}

/**
 * Lightweight connectivity check with a 500ms timeout. Never throws —
 * returns false for any failure, including connection errors, timeouts, or
 * `getRabbit()` itself throwing in production without RABBITMQ_URL
 * configured. Used by `/api/health`.
 *
 * Checks `amq.direct` — an AMQP-spec-mandated default exchange present on
 * every vhost — rather than the app's own `judge.direct` exchange, so this
 * stays a pure connectivity probe independent of whether
 * `assertTopology()` has run yet.
 */
export async function rabbitHealthy(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const checkPromise = (async () => {
      const { confirmChannel: ch } = await getRabbit();
      await ch.checkExchange('amq.direct');
      return true;
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('rabbitmq health check timed out')), 500);
    });

    return await Promise.race([checkPromise, timeoutPromise]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Close the singleton connection. Used by integration tests (so `vitest
 * run` can exit cleanly) and available for graceful shutdown hooks. Safe to
 * call even if the connection was never established.
 */
export async function closeRabbit(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (conn) {
      intentionalClose = true;
      await conn.close();
    }
  } catch {
    // Best-effort — the connection may already be dead.
  } finally {
    intentionalClose = false; // in case conn.close() resolved without ever firing 'close' (already-dead conn)
  }

  clearState();
  reconnectDelayMs = RECONNECT_INITIAL_MS;
  // Note: connectAttempts is NOT reset on intentional close, so the test
  // can verify that no new attempts were scheduled/made after close.
}

/**
 * Test-only probe into the connection state machine. Returns internal state
 * to verify reconnect behavior in regression tests.
 */
export function getConnectionState(): {
  connected: boolean;
  reconnectScheduled: boolean;
  connectAttempts: number;
} {
  return {
    connected: conn !== null && confirmChannel !== null,
    reconnectScheduled: reconnectTimer !== null,
    connectAttempts,
  };
}
