import type { RealtimeEventBus } from './bus';
import type { RealtimeEnvelope, RealtimeListener } from './types';

interface RedisLikeClient {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  duplicate(): RedisLikeClient;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface RedisModule {
  createClient(options: { url: string }): RedisLikeClient;
}

export class RedisRealtimeEventBus implements RealtimeEventBus {
  readonly name = 'redis';

  private sequence = 0;
  private listeners = new Map<number, RealtimeListener>();

  private initialized = false;
  private initPromise: Promise<void> | null = null;

  private publisherClient: RedisLikeClient | null = null;
  private subscriberClient: RedisLikeClient | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly channelName: string,
    private readonly fallbackEmit: (event: RealtimeEnvelope) => Promise<void>
  ) {}

  subscribe(listener: RealtimeListener): () => void {
    this.sequence += 1;
    const listenerId = this.sequence;
    this.listeners.set(listenerId, listener);

    void this.ensureInitialized();

    return () => {
      this.listeners.delete(listenerId);
    };
  }

  async publish(event: RealtimeEnvelope): Promise<void> {
    await this.ensureInitialized();

    const payload = JSON.stringify(event);

    if (!this.publisherClient) {
      await this.fallbackEmit(event);
      return;
    }

    try {
      await this.publisherClient.publish(this.channelName, payload);
    } catch (error) {
      console.error('Redis publish failed. Falling back to local emit:', error);
      await this.fallbackEmit(event);
    }
  }

  getSubscriberCount(): number {
    return this.listeners.size;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const redisModule = await this.loadRedisModule();
        if (!redisModule) {
          console.warn('Redis module not available. Realtime bus will use local fallback.');
          return;
        }

        this.publisherClient = redisModule.createClient({ url: this.redisUrl });
        this.publisherClient.on('error', (error: unknown) => {
          console.error('Redis publisher error:', error);
        });

        this.subscriberClient = this.publisherClient.duplicate();
        this.subscriberClient.on('error', (error: unknown) => {
          console.error('Redis subscriber error:', error);
        });

        await this.publisherClient.connect();
        await this.subscriberClient.connect();

        await this.subscriberClient.subscribe(this.channelName, (message: string) => {
          try {
            const event = JSON.parse(message) as RealtimeEnvelope;
            this.emitLocal(event);
          } catch (error) {
            console.error('Failed to parse Redis realtime event message:', error);
          }
        });
      } finally {
        this.initialized = true;
      }
    })();

    return this.initPromise;
  }

  private emitLocal(event: RealtimeEnvelope) {
    for (const listener of this.listeners.values()) {
      try {
        listener(event);
      } catch (error) {
        console.error('Redis realtime listener failed:', error);
      }
    }
  }

  private async loadRedisModule(): Promise<RedisModule | null> {
    try {
      const dynamicImporter = new Function('return import("redis")');
      const imported = (await dynamicImporter()) as RedisModule;
      return imported;
    } catch {
      return null;
    }
  }
}
