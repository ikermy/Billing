import { HttpException, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';

export interface ICircuitBreakerOptions {
  name: string;
  /** % of failures to open circuit (default 50) */
  errorThresholdPercentage?: number;
  /** ms to wait before half-opening (default 10_000) */
  resetTimeout?: number;
  /** ms before a call times out (default 5_000) */
  timeout?: number;
  /** min calls before stats are evaluated (default 5) */
  volumeThreshold?: number;
}

const logger = new Logger('CircuitBreakerFactory');

/**
 * Creates a typed opossum CircuitBreaker wrapping an async function.
 * Logs state transitions (open / half-open / close).
 */
export function createCircuitBreaker<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: ICircuitBreakerOptions,
): CircuitBreaker<TArgs, TResult> {
  const cb = new CircuitBreaker(fn, {
    name: options.name,
    errorThresholdPercentage: options.errorThresholdPercentage ?? 50,
    resetTimeout: options.resetTimeout ?? 10_000,
    timeout: options.timeout ?? 5_000,
    volumeThreshold: options.volumeThreshold ?? 5,
    // Клиентские ошибки (4xx) — не признак отказа инфраструктуры.
    // Возвращаем true = CB игнорирует эту ошибку при подсчёте отказов.
    errorFilter: (error: unknown): boolean => {
      if (error instanceof HttpException) {
        const status = error.getStatus();
        return status >= 400 && status < 500;
      }
      return false;
    },
  });

  cb.on('open', () =>
    logger.warn(
      `[CircuitBreaker:${options.name}] OPEN – requests will fail fast`,
    ),
  );
  cb.on('halfOpen', () =>
    logger.log(`[CircuitBreaker:${options.name}] HALF-OPEN – testing recovery`),
  );
  cb.on('close', () =>
    logger.log(`[CircuitBreaker:${options.name}] CLOSED – recovered`),
  );
  cb.on('fallback', () =>
    logger.warn(`[CircuitBreaker:${options.name}] fallback triggered`),
  );

  return cb;
}
