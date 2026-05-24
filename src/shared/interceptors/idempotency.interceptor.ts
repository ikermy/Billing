import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable, from, of } from 'rxjs';
import { switchMap, tap } from 'rxjs/operators';
import { RedisService } from '../services/redis.service';

/**
 * Idempotency Interceptor
 *
 * Guards write endpoints against duplicate requests from BFF retries.
 * Reads X-Idempotency-Key header; caches 2xx response in Redis for 24h.
 * On repeat – returns cached response with code=DUPLICATE_REQUEST.
 * Activate via ENABLE_IDEMPOTENCY=true.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  private readonly CACHE_TTL_SECONDS = 24 * 60 * 60;
  private readonly IN_FLIGHT_TTL_SECONDS = 30;
  private readonly enabled = process.env.ENABLE_IDEMPOTENCY === 'true';

  constructor(private readonly redis: RedisService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled) {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<Request & { headers: Record<string, string> }>();
    const idempotencyKey = request.headers['x-idempotency-key'];

    if (!idempotencyKey) {
      return next.handle();
    }

    const cacheKey = `billing:idempotency:${idempotencyKey}`;
    const inflightKey = `billing:idempotency:inflight:${idempotencyKey}`;

    return from(this.checkCache(cacheKey, inflightKey)).pipe(
      switchMap((cached) => {
        if (cached !== null) {
          this.logger.debug(`Idempotency cache hit for key=${idempotencyKey}`);
          return of({ code: 'DUPLICATE_REQUEST', ...cached });
        }

        return next.handle().pipe(
          tap((response: unknown) => {
            void (async () => {
              try {
                await this.redis.set(
                  cacheKey,
                  response,
                  this.CACHE_TTL_SECONDS,
                );
                await this.redis.del(inflightKey);
              } catch (err) {
                this.logger.error(
                  `Failed to cache idempotency response for key=${idempotencyKey}`,
                  err,
                );
              }
            })();
          }),
        );
      }),
    );
  }

  private async checkCache(
    cacheKey: string,
    inflightKey: string,
  ): Promise<Record<string, unknown> | null> {
    const cached = await this.redis.getJson<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    // Atomic SET NX — eliminates TOCTOU race between check and set.
    // If two concurrent requests arrive simultaneously, only one wins the NX lock.
    const acquired = await this.redis.setNx(
      inflightKey,
      '1',
      this.IN_FLIGHT_TTL_SECONDS,
    );
    if (!acquired) {
      // Another request is already in-flight with the same idempotency key
      throw new HttpException(
        {
          code: 'REQUEST_IN_FLIGHT',
          message:
            'A request with the same idempotency key is already being processed',
        },
        HttpStatus.CONFLICT,
      );
    }

    return null;
  }
}
