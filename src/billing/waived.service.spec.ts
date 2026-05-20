import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { BillingMetricsService } from 'src/shared/services/billing-metrics.service';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { RedisService } from 'src/shared/services/redis.service';
import { WaivedService } from './waived.service';

describe('WaivedService', () => {
  let service: WaivedService;

  const redis = {
    checkAndIncrementLimit: jest.fn(),
    decrementIfPositive: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const billingConfig = {
    getWaivedLimit: jest.fn(),
    getWaivedWindowSeconds: jest.fn(),
  } as unknown as jest.Mocked<BillingConfigService>;

  const prisma = {
    account: {
      findUnique: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  const producer = {
    paymentCompleted: jest.fn(),
  } as unknown as jest.Mocked<BillingProducer>;

  const paymentLedger = {
    createCompleted: jest.fn(),
  } as unknown as jest.Mocked<PaymentLedgerService>;

  const metrics = {
    incWaivedOperation: jest.fn(),
    incWaivedLimitExceeded: jest.fn(),
  } as unknown as jest.Mocked<BillingMetricsService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (billingConfig.getWaivedLimit as jest.Mock).mockResolvedValue(5);
    (billingConfig.getWaivedWindowSeconds as jest.Mock).mockResolvedValue(
      86400,
    );
    (redis.checkAndIncrementLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      currentCount: 2,
      ttlSeconds: 3600,
    });
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc-1',
    });

    service = new WaivedService(
      prisma,
      redis,
      billingConfig,
      producer,
      paymentLedger,
      metrics,
    );
  });

  it('returns atomic waived check response with reset time', async () => {
    const result = await service.checkAndReserve({
      userId: 'u1',
      operation: 'ai_generation',
    });

    expect(redis.checkAndIncrementLimit).toHaveBeenCalledWith(
      'billing:waived:ai_generation:u1',
      5,
      86400,
    );
    expect(result.allowed).toBe(true);
    expect(result.currentCount).toBe(2);
    expect(result.limit).toBe(5);
    expect(typeof result.resetsAt).toBe('string');
  });

  it('emits zero-cost payment audit for completed waived operation', async () => {
    await service.complete({
      userId: 'u1',
      operation: 'ai_generation',
      generationId: 'gen-1',
    });

    expect(paymentLedger.createCompleted).toHaveBeenCalledWith({
      accountId: 'acc-1',
      amount: 0,
      currency: 'USD',
      operation: 'ai_generation_waived',
      source: 'waived',
      metadata: {
        waived: true,
        generationId: 'gen-1',
      },
    });
    expect(producer.paymentCompleted).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 0,
      currency: 'USD',
      operation: 'ai_generation_waived',
      metadata: {
        waived: true,
        generationId: 'gen-1',
      },
    });
  });
});
