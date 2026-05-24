import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis, { Redis as RedisClient } from 'ioredis';
import {
  CachedCoupon,
  CachedPlan,
  ProductWithPackages,
} from 'src/shared/types/billing.types';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client?: RedisClient;
  private readonly logger = new Logger(RedisService.name);

  onModuleInit(): void {
    this.client = new Redis({
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      retryStrategy: (times) => {
        if (times >= 10) {
          return null;
        }
        return Math.min(times * 50, 1000);
      },
    });

    this.client.on('connect', () => {
      this.logger.log('[Redis] Connected');
    });

    this.client.on('error', (err) => {
      this.logger.error('[Redis] Error', err);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.status !== 'end') {
      await this.client.quit();
    }
  }

  async getProductById(id: string): Promise<ProductWithPackages> {
    return this.getAndParse(`product:${id}`, 'product');
  }

  async getPlanByCode(code: string): Promise<CachedPlan> {
    return this.getAndParse(`lago:plan:${code}`, 'plan');
  }

  async getCouponByCode(code: string): Promise<CachedCoupon> {
    return this.getAndParse(`lago:coupon:${code}`, 'coupon');
  }

  async getJson<T>(key: string): Promise<T | null> {
    const data = await this.getClient().get(key);
    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data) as T;
    } catch {
      this.logger.error(`[Redis] Invalid JSON for key=${key}`);
      throw new Error(`Invalid cached payload for key=${key}`);
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const client = this.getClient();

    if (ttlSeconds) {
      await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } else {
      await client.set(key, JSON.stringify(value));
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }

    return await this.getClient().del(...keys);
  }

  async acquireLock(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.getClient().set(
      key,
      value,
      'EX',
      ttlSeconds,
      'NX',
    );

    return result === 'OK';
  }

  /**
   * Atomic SET NX with TTL. Returns true if key was set (did not exist before).
   * Use instead of getJson + set to avoid TOCTOU race conditions.
   */
  async setNx(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.getClient().set(
      key,
      JSON.stringify(value),
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  async releaseLock(key: string, value: string): Promise<boolean> {
    const released = await this.getClient().eval(
      `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `,
      1,
      key,
      value,
    );

    return Number(released) === 1;
  }

  async checkAndIncrementLimit(
    key: string,
    limit: number,
    ttlSeconds: number,
  ): Promise<{
    allowed: boolean;
    currentCount: number;
    ttlSeconds: number;
  }> {
    const result = await this.getClient().eval(
      `
        local ttl = tonumber(ARGV[1])
        local limit = tonumber(ARGV[2])
        local current = redis.call("INCR", KEYS[1])
        if current == 1 then
          redis.call("EXPIRE", KEYS[1], ttl)
        end
        local currentTtl = redis.call("TTL", KEYS[1])
        if current > limit then
          redis.call("DECR", KEYS[1])
          return {0, current - 1, currentTtl}
        end
        return {1, current, currentTtl}
      `,
      1,
      key,
      String(ttlSeconds),
      String(limit),
    );

    const parsedResult: Array<number | string> = Array.isArray(result)
      ? (result as Array<number | string>)
      : [0, 0, ttlSeconds];
    const [allowed, currentCount, currentTtl] = parsedResult;

    return {
      allowed: Number(allowed) === 1,
      currentCount: Number(currentCount) || 0,
      ttlSeconds:
        Number(currentTtl) > 0 ? Number(currentTtl) : Math.max(ttlSeconds, 1),
    };
  }

  async decrementIfPositive(key: string): Promise<number> {
    const result = await this.getClient().eval(
      `
        local current = tonumber(redis.call("get", KEYS[1]) or "0")
        if current <= 0 then
          return 0
        end
        local next = redis.call("DECR", KEYS[1])
        if next <= 0 then
          redis.call("DEL", KEYS[1])
          return 0
        end
        return next
      `,
      1,
      key,
    );

    return Number(result) || 0;
  }

  private async getAndParse<T>(key: string, entityName: string): Promise<T> {
    const data = await this.getJson<T>(key);
    if (!data) {
      throw new Error(`No ${entityName} found`);
    }

    return data;
  }

  private getClient(): RedisClient {
    if (!this.client) {
      throw new Error('Redis client is not initialized');
    }

    return this.client;
  }
}
