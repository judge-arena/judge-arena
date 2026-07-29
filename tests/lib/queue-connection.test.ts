import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RabbitConfigError, resolveRabbitUrl } from '@/lib/queue/connection';

describe('queue connection', () => {
  describe('resolveRabbitUrl', () => {
    beforeEach(() => {
      // Clear all stubbed env vars before each test
      vi.unstubAllEnvs();
    });

    describe('in non-production environments', () => {
      beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'test');
      });

      it('defaults to amqp://guest:guest@localhost:5672 when RABBITMQ_URL is not set', () => {
        // Ensure RABBITMQ_URL is not set
        delete process.env.RABBITMQ_URL;
        expect(resolveRabbitUrl()).toBe('amqp://guest:guest@localhost:5672');
      });

      it('uses RABBITMQ_URL when it is set', () => {
        vi.stubEnv('RABBITMQ_URL', 'amqp://user:pass@broker:5672');
        expect(resolveRabbitUrl()).toBe('amqp://user:pass@broker:5672');
      });
    });

    describe('in production', () => {
      beforeEach(() => {
        vi.stubEnv('NODE_ENV', 'production');
        // Ensure RABBITMQ_URL is not set
        delete process.env.RABBITMQ_URL;
      });

      it('throws RabbitConfigError when RABBITMQ_URL is not set', () => {
        expect(() => resolveRabbitUrl()).toThrow(RabbitConfigError);
      });

      it('throws RabbitConfigError with correct name property', () => {
        try {
          resolveRabbitUrl();
          expect.fail('should have thrown');
        } catch (error) {
          expect(error).toBeInstanceOf(RabbitConfigError);
          expect((error as Error).name).toBe('RabbitConfigError');
        }
      });

      it('uses RABBITMQ_URL when it is set in production', () => {
        vi.stubEnv('RABBITMQ_URL', 'amqp://prod-user:prod-pass@prod-broker:5672');
        expect(resolveRabbitUrl()).toBe('amqp://prod-user:prod-pass@prod-broker:5672');
      });
    });
  });

  describe('getRabbit() fail-fast in production', () => {
    it('rejects with RabbitConfigError when RABBITMQ_URL is unset in production', async () => {
      // Reset modules and set NODE_ENV=production BEFORE importing
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      delete process.env.RABBITMQ_URL;

      // Dynamically import getRabbit so it reads the production env
      const dynamicModule = await import('@/lib/queue/connection');
      const { getRabbit, RabbitConfigError: DynamicRabbitConfigError } = dynamicModule;

      await expect(getRabbit()).rejects.toThrow(DynamicRabbitConfigError);
    });

    it('rejects with RabbitConfigError instanceof and name check', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      delete process.env.RABBITMQ_URL;

      const dynamicModule = await import('@/lib/queue/connection');
      const { getRabbit, RabbitConfigError: DynamicRabbitConfigError } = dynamicModule;

      try {
        await getRabbit();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DynamicRabbitConfigError);
        expect((error as Error).name).toBe('RabbitConfigError');
      }
    });
  });

  // ── Task 9 review finding #3: getRabbit() topology-assertion regression ──
  // coverage. getRabbit() (see connection.ts's module doc, "Web-side lazy
  // topology assertion") is supposed to assert the queue topology exactly
  // once per live channel — not once per call — de-duplicated by the
  // `topologyAsserted`/`topologyAssertPromise` guards, and reset on
  // `clearState()` (driven by `closeRabbit()` or a connection-level
  // `'close'` event) so a fresh connection/channel epoch re-asserts. Nothing
  // in the existing suite pinned that invariant down; a regression here
  // (e.g. someone removing the `topologyAsserted` guard, or calling
  // `assertTopology` per-getRabbit() instead of per-epoch) would only show
  // up as excess `assertQueue`/`assertExchange` traffic against a live
  // broker, not a functional test failure — hence this dedicated mock-based
  // unit test.
  //
  // Both `amqplib` and `./topology` (imported by connection.ts as
  // `@/lib/queue/topology`, same resolved file) are mocked via `vi.doMock`
  // (not the hoisted `vi.mock`) so the mocks apply ONLY to the dynamically
  // re-imported `connection.ts` below, the same `vi.resetModules()` +
  // dynamic `import()` pattern the fail-fast tests above already use — the
  // rest of this file's tests (and the static top-of-file import) keep
  // using the real modules. No live broker needed: `amqp.connect()` and
  // `channel.createConfirmChannel()` are faked with no-op stand-ins, and
  // `assertTopology` is a bare `vi.fn()` whose call count is asserted
  // directly rather than inspecting real queue declarations.
  describe('getRabbit() topology assertion (regression — Task 9 review finding #3)', () => {
    afterEach(() => {
      vi.doUnmock('amqplib');
      vi.doUnmock('@/lib/queue/topology');
      vi.unstubAllEnvs();
    });

    it('asserts topology exactly once per connection epoch: two getRabbit() calls -> one assertTopology call; after closeRabbit(), the next getRabbit() call asserts again', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'test');
      delete process.env.RABBITMQ_URL;

      const assertTopologyMock = vi.fn(async () => {});
      vi.doMock('@/lib/queue/topology', () => ({
        assertTopology: assertTopologyMock,
      }));

      const fakeChannel = { on: vi.fn() };
      const fakeConn = {
        on: vi.fn(),
        createConfirmChannel: vi.fn(async () => fakeChannel),
        close: vi.fn(async () => {}),
      };
      const connectMock = vi.fn(async () => fakeConn);
      // Cover both default-import interop shapes (see this block's doc) —
      // whichever one the bundler's CJS interop resolves `import amqp from
      // 'amqplib'` to, `amqp.connect` lands on `connectMock`.
      vi.doMock('amqplib', () => ({ default: { connect: connectMock }, connect: connectMock }));

      const { getRabbit, closeRabbit } = await import('@/lib/queue/connection');

      await getRabbit();
      await getRabbit();
      expect(assertTopologyMock).toHaveBeenCalledTimes(1);
      expect(connectMock).toHaveBeenCalledTimes(1); // second getRabbit() reused the live connection+channel

      await closeRabbit();
      await getRabbit();
      expect(assertTopologyMock).toHaveBeenCalledTimes(2); // fresh epoch -> re-asserted
      expect(connectMock).toHaveBeenCalledTimes(2);
    });
  });
});
