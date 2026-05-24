import { CreditType, SagaStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/services/prisma.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { RedisService } from 'src/shared/services/redis.service';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BillingMetricsService } from 'src/shared/services/billing-metrics.service';
import { QuoteService } from './quote.service';
import { SagaService } from './saga.service';
import { WaivedService } from './waived.service';
import { QuoteSource } from './dto/quote.dto';

describe('SagaService', () => {
  let service: SagaService;

  const tx = {
    subscription: {
      findFirst: jest.fn(),
    },
    creditBalance: {
      createMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    creditTransaction: {
      create: jest.fn(),
    },
    billingSaga: {
      create: jest.fn(),
    },
    $executeRaw: jest.fn(),
  };

  const prisma = {
    $transaction: jest.fn(),
    account: {
      findUnique: jest.fn(),
    },
    billingSaga: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  const quoteService = {
    quote: jest.fn(),
  } as unknown as jest.Mocked<QuoteService>;

  const creditLedger = {
    reserveCredits: jest.fn(),
    commitReservedCredits: jest.fn(),
    releaseReservedCredits: jest.fn(),
  } as unknown as jest.Mocked<CreditLedgerService>;

  const wallet = {
    blockFunds: jest.fn(),
    confirmBlock: jest.fn(),
    cancelBlock: jest.fn(),
  } as unknown as jest.Mocked<WalletBalanceService>;

  const redis = {
    acquireLock: jest.fn(),
    releaseLock: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const billingConfig = {
    getNumber: jest.fn(),
  } as unknown as jest.Mocked<BillingConfigService>;

  const subscriptions = {
    reserveGenerations: jest.fn(),
    releaseGenerations: jest.fn(),
  } as unknown as jest.Mocked<SubscriptionService>;

  const paymentLedger = {
    createPending: jest.fn(),
    markCompletedByWalletBlock: jest.fn(),
    markCancelledByWalletBlock: jest.fn(),
  } as unknown as jest.Mocked<PaymentLedgerService>;

  const waivedService = {
    release: jest.fn(),
    complete: jest.fn(),
    checkAndReserve: jest.fn(),
  } as unknown as jest.Mocked<WaivedService>;

  const billingProducer = {
    sagaCompleted: jest.fn(),
    sagaCancelled: jest.fn(),
    creditsCharged: jest.fn(),
    subscriptionCreditsUsed: jest.fn(),
  } as unknown as jest.Mocked<BillingProducer>;

  const metrics = {
    incSagaBlock: jest.fn(),
    incSagaConfirm: jest.fn(),
    incSagaCancel: jest.fn(),
    incSagaExpired: jest.fn(),
  } as unknown as jest.Mocked<BillingMetricsService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (redis.acquireLock as jest.Mock).mockResolvedValue(true);
    (redis.releaseLock as jest.Mock).mockResolvedValue(true);
    (billingConfig.getNumber as jest.Mock).mockResolvedValue(5);
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: (client: typeof tx) => Promise<unknown>) =>
        await callback(tx),
    );
    tx.creditBalance.createMany.mockResolvedValue({ count: 0 });
    tx.creditTransaction.create.mockResolvedValue({
      id: 'ctx-1',
    });
    service = new SagaService(
      prisma,
      quoteService,
      creditLedger,
      wallet,
      redis,
      billingConfig,
      subscriptions,
      paymentLedger,
      billingProducer,
      metrics,
    );
  });

  it('blocks credits and wallet funds into pending saga', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc-1' });
    (prisma.billingSaga.findFirst as jest.Mock).mockResolvedValue(null);
    (quoteService.quote as jest.Mock).mockResolvedValue({
      canProcess: true,
      partial: false,
      requested: 5,
      allowedTotal: 5,
      bySource: {
        subscription: { units: 0, remaining: 0 },
        credits: { units: 2, remaining: 0 },
        wallet: { units: 3, amount: 1.5 },
      },
      unitPrice: 0.5,
      currency: 'USD',
      totalWalletCost: 1.5,
    });
    (wallet.blockFunds as jest.Mock).mockResolvedValue({ blockId: 'wb-1' });
    tx.$executeRaw.mockResolvedValue(1);
    tx.creditBalance.findUniqueOrThrow.mockResolvedValue({
      balance: 10,
    });
    tx.billingSaga.create.mockResolvedValue({
      id: 'saga-1',
      subscriptionId: null,
      subscriptionAmount: 0,
      creditsAmount: 2,
      walletAmount: 1.5,
      expiresAt: new Date('2026-03-15T00:00:00.000Z'),
    });

    const result = await service.block({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      units: 5,
      creditType: CreditType.BARCODE,
      operation: 'barcode_generation',
      buildId: 'build-1',
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
      },
      ttl: 300,
    });

    expect(quoteService.quote).toHaveBeenCalledWith({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      units: 5,
      creditType: CreditType.BARCODE,
      revision: 'US_CA_08292017',
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
        source: QuoteSource.SINGLE,
        batchId: undefined,
      },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId: 'acc-1',
          creditType: CreditType.BARCODE,
          amount: 2,
          operation: 'BLOCK',
        }),
      }),
    );
    expect(wallet.blockFunds).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        amount: 1.5,
        currency: 'USD',
      }),
    );
    expect(paymentLedger.createPending).toHaveBeenCalledWith({
      accountId: 'acc-1',
      amount: 1.5,
      currency: 'USD',
      operation: 'barcode_generation',
      source: 'wallet',
      walletBlockId: 'wb-1',
      sagaId: 'saga-1',
      buildId: 'build-1',
      batchId: undefined,
      metadata: {
        requestAmount: 5,
        source: 'saga.block',
      },
    });
    expect(result).toEqual({
      sagaId: 'saga-1',
      blocked: {
        subscription: 0,
        credits: 2,
        wallet: 1.5,
      },
      expiresAt: '2026-03-15T00:00:00.000Z',
    });
  });

  it('reserves subscription usage before credits and wallet', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc-1' });
    (prisma.billingSaga.findFirst as jest.Mock).mockResolvedValue(null);
    (quoteService.quote as jest.Mock).mockResolvedValue({
      canProcess: true,
      partial: false,
      requested: 5,
      allowedTotal: 5,
      bySource: {
        subscription: { units: 2, remaining: 0 },
        credits: { units: 1, remaining: 0 },
        wallet: { units: 2, amount: 1 },
      },
      unitPrice: 0.5,
      currency: 'USD',
      totalWalletCost: 1,
    });
    (wallet.blockFunds as jest.Mock).mockResolvedValue({ blockId: 'wb-1' });
    tx.subscription.findFirst.mockResolvedValue({
      id: 'sub-local-1',
      accountId: 'acc-1',
    });
    tx.$executeRaw.mockResolvedValue(1);
    tx.creditBalance.findUniqueOrThrow.mockResolvedValue({
      balance: 10,
    });
    tx.billingSaga.create.mockResolvedValue({
      id: 'saga-1',
      subscriptionId: 'sub-local-1',
      subscriptionAmount: 2,
      creditsAmount: 1,
      walletAmount: 1,
      expiresAt: new Date('2026-03-15T00:00:00.000Z'),
    });

    await service.block({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      units: 5,
      creditType: CreditType.BARCODE,
      operation: 'barcode_generation',
      buildId: 'build-1',
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
      },
    });

    expect(tx.subscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ accountId: 'acc-1' }),
      }),
    );
    expect(tx.billingSaga.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId: 'sub-local-1',
          subscriptionAmount: 2,
        }),
      }),
    );
  });

  it('returns 402 when quote cannot cover requested amount', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc-1' });
    (prisma.billingSaga.findFirst as jest.Mock).mockResolvedValue(null);
    (quoteService.quote as jest.Mock).mockResolvedValue({
      canProcess: true,
      partial: true,
      requested: 5,
      allowedTotal: 2,
      bySource: {
        subscription: { units: 0, remaining: 0 },
        credits: { units: 1, remaining: 0 },
        wallet: { units: 1, amount: 0.5 },
      },
      unitPrice: 0.5,
      currency: 'USD',
      totalWalletCost: 0.5,
    });

    await expect(
      service.block({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        units: 5,
        creditType: CreditType.BARCODE,
        operation: 'barcode_generation',
        context: {
          product: 'barcode_pdf417',
          revision: 'US_CA_08292017',
        },
      }),
    ).rejects.toMatchObject({
      status: 402,
    });
  });

  it('completes pending saga', async () => {
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      accountId: 'acc-1',
      creditsAmount: 2,
      creditType: CreditType.BARCODE,
      walletBlockId: 'wb-1',
      operation: 'barcode_generation',
      buildId: 'build-1',
      batchId: null,
      status: SagaStatus.PENDING,
    });
    (wallet.confirmBlock as jest.Mock).mockResolvedValue(undefined);
    (creditLedger.commitReservedCredits as jest.Mock).mockResolvedValue({
      id: 'cb-1',
    });
    (prisma.billingSaga.update as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.COMPLETED,
    });

    const result = await service.completeSaga('saga-1');

    expect(wallet.confirmBlock).toHaveBeenCalledWith('wb-1');
    expect(paymentLedger.markCompletedByWalletBlock).toHaveBeenCalledWith(
      'wb-1',
    );
    expect(creditLedger.commitReservedCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: 2,
        operation: 'CHARGE',
      }),
    );
    expect(result).toEqual({
      id: 'saga-1',
      status: SagaStatus.COMPLETED,
    });
  });

  it('cancels pending saga and releases reserves', async () => {
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      accountId: 'acc-1',
      subscriptionId: 'sub-local-1',
      subscriptionAmount: 1,
      creditsAmount: 2,
      creditType: CreditType.BARCODE,
      walletBlockId: 'wb-1',
      operation: 'barcode_generation',
      buildId: 'build-1',
      batchId: null,
      status: SagaStatus.PENDING,
    });
    (wallet.cancelBlock as jest.Mock).mockResolvedValue(undefined);
    (subscriptions.releaseGenerations as jest.Mock).mockResolvedValue({
      id: 'sub-local-1',
    });
    (creditLedger.releaseReservedCredits as jest.Mock).mockResolvedValue({
      id: 'cb-1',
    });
    (prisma.billingSaga.update as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.CANCELLED,
    });

    const result = await service.cancelSaga('saga-1');
    expect(wallet.cancelBlock).toHaveBeenCalledWith('wb-1');
    expect(paymentLedger.markCancelledByWalletBlock).toHaveBeenCalledWith(
      'wb-1',
      undefined,
    );
    expect(subscriptions.releaseGenerations).toHaveBeenCalledWith(
      'sub-local-1',
      1,
    );
    expect(creditLedger.releaseReservedCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: 2,
        operation: 'UNBLOCK',
      }),
    );
    expect(result).toEqual({
      id: 'saga-1',
      status: SagaStatus.CANCELLED,
    });
  });

  it('expires overdue sagas', async () => {
    (prisma.billingSaga.findMany as jest.Mock).mockResolvedValue([
      { id: 'saga-1' },
    ]);
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      accountId: 'acc-1',
      subscriptionId: 'sub-local-1',
      subscriptionAmount: 1,
      creditsAmount: 2,
      creditType: CreditType.BARCODE,
      walletBlockId: 'wb-1',
      operation: 'barcode_generation',
      buildId: 'build-1',
      batchId: null,
      status: SagaStatus.PENDING,
    });
    (wallet.cancelBlock as jest.Mock).mockResolvedValue(undefined);
    (subscriptions.releaseGenerations as jest.Mock).mockResolvedValue({
      id: 'sub-local-1',
    });
    (creditLedger.releaseReservedCredits as jest.Mock).mockResolvedValue({
      id: 'cb-1',
    });
    (prisma.billingSaga.update as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.EXPIRED,
    });

    const count = await service.expirePendingSagas();

    expect(prisma.billingSaga.update).toHaveBeenCalledWith({
      where: { id: 'saga-1' },
      data: {
        status: SagaStatus.EXPIRED,
        cancelledAt: expect.any(Date),
      },
    });
    expect(count).toBe(1);
  });

  it('rejects non-pending saga completion', async () => {
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.CANCELLED,
    });

    await expect(service.completeSaga('saga-1')).resolves.toEqual({
      id: 'saga-1',
      status: SagaStatus.CANCELLED,
    });
    expect(wallet.confirmBlock).not.toHaveBeenCalled();
  });

  it('treats completed saga as idempotent completion', async () => {
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.COMPLETED,
    });

    await expect(service.completeSaga('saga-1')).resolves.toEqual({
      id: 'saga-1',
      status: SagaStatus.COMPLETED,
    });
    expect(creditLedger.commitReservedCredits).not.toHaveBeenCalled();
  });

  it('returns conflict when saga finalization lock is already held', async () => {
    (redis.acquireLock as jest.Mock).mockResolvedValue(false);
    (prisma.billingSaga.findUnique as jest.Mock).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.PENDING,
    });

    await expect(service.completeSaga('saga-1')).rejects.toMatchObject({
      status: 409,
    });
  });
});
