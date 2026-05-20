import { Injectable } from '@nestjs/common';
import { InjectMetric, makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';

// ── Counter definitions (export for module registration) ──────────────────────
export const BILLING_METRICS_PROVIDERS = [
  makeCounterProvider({
    name: 'billing_saga_blocks_total',
    help: 'Total number of billing saga block operations',
    labelNames: ['status'] as const,
  }),
  makeCounterProvider({
    name: 'billing_saga_confirms_total',
    help: 'Total number of billing saga capture/complete operations',
    labelNames: ['partial'] as const,
  }),
  makeCounterProvider({
    name: 'billing_saga_cancels_total',
    help: 'Total number of billing saga release/cancel operations',
    labelNames: ['reason'] as const,
  }),
  makeCounterProvider({
    name: 'billing_saga_expired_total',
    help: 'Total number of billing sagas expired by cron',
  }),
  makeCounterProvider({
    name: 'billing_waived_operations_total',
    help: 'Total number of waived (free-tier) operations',
    labelNames: ['operation'] as const,
  }),
  makeCounterProvider({
    name: 'billing_waived_limit_exceeded_total',
    help: 'Total number of waived operations rejected due to daily limit',
    labelNames: ['operation'] as const,
  }),
];

@Injectable()
export class BillingMetricsService {
  constructor(
    @InjectMetric('billing_saga_blocks_total')
    private readonly sagaBlocksTotal: Counter<string>,

    @InjectMetric('billing_saga_confirms_total')
    private readonly sagaConfirmsTotal: Counter<string>,

    @InjectMetric('billing_saga_cancels_total')
    private readonly sagaCancelsTotal: Counter<string>,

    @InjectMetric('billing_saga_expired_total')
    private readonly sagaExpiredTotal: Counter<string>,

    @InjectMetric('billing_waived_operations_total')
    private readonly waivedOperationsTotal: Counter<string>,

    @InjectMetric('billing_waived_limit_exceeded_total')
    private readonly waivedLimitExceededTotal: Counter<string>,
  ) {}

  incSagaBlock(status: 'success' | 'failed' | 'free'): void {
    this.sagaBlocksTotal.inc({ status });
  }

  incSagaConfirm(partial: boolean): void {
    this.sagaConfirmsTotal.inc({ partial: partial ? 'true' : 'false' });
  }

  incSagaCancel(reason: string): void {
    this.sagaCancelsTotal.inc({ reason });
  }

  incSagaExpired(count = 1): void {
    this.sagaExpiredTotal.inc(count);
  }

  incWaivedOperation(operation: string): void {
    this.waivedOperationsTotal.inc({ operation });
  }

  incWaivedLimitExceeded(operation: string): void {
    this.waivedLimitExceededTotal.inc({ operation });
  }
}
