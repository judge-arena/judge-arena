import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
