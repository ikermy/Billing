import { CreditOperation, CreditType, TransactionStatus } from '@prisma/client';
import { CreditLedgerService } from './credit-ledger.service';
import { PrismaService } from './prisma.service';

describe('CreditLedgerService', () => {
  let service: CreditLedgerService;

  const tx = {
    creditBalance: {
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    creditTransaction: {
      create: jest.fn(),
    },
  };

  const prisma = {
    creditBalance: {
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  } as unknown as jest.Mocked<PrismaService>;

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.creditBalance.createMany as any).mockResolvedValue({ count: 0 });
    (prisma.$transaction as any).mockImplementation((callback: any) =>
      callback(tx),
    );
    service = new CreditLedgerService(prisma);
  });

  it('refundGrantedCredits decreases balance without checking reserved and writes REFUND audit', async () => {
    (tx.creditBalance.updateMany as any).mockResolvedValue({ count: 1 });
    (tx.creditBalance.findUniqueOrThrow as any).mockResolvedValue({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      balance: 40,
      reserved: 30,
    });

    const result = await service.refundGrantedCredits({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      amount: 10,
      metadata: {
        source: 'purchase.rollback',
      },
    });

    expect(tx.creditBalance.updateMany).toHaveBeenCalledWith({
      where: {
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        balance: {
          gte: 10,
        },
      },
      data: {
        balance: {
          decrement: 10,
        },
      },
    });
    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: -10,
        balanceAfter: 40,
        operation: CreditOperation.REFUND,
        buildId: undefined,
        batchId: undefined,
        status: TransactionStatus.COMPLETED,
        metadata: {
          source: 'purchase.rollback',
        },
      },
    });
    expect(result).toEqual({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      balance: 40,
      reserved: 30,
    });
  });

  it('refundGrantedCredits returns null when granted credits were already spent', async () => {
    (tx.creditBalance.updateMany as any).mockResolvedValue({ count: 0 });

    await expect(
      service.refundGrantedCredits({
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: 10,
      }),
    ).resolves.toBeNull();

    expect(tx.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('releaseReservedCredits writes positive audit amount for UNBLOCK', async () => {
    (tx.creditBalance.updateMany as any).mockResolvedValue({ count: 1 });
    (tx.creditBalance.findUniqueOrThrow as any).mockResolvedValue({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      balance: 50,
      reserved: 5,
    });

    await expect(
      service.releaseReservedCredits({
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: 10,
        operation: CreditOperation.UNBLOCK,
        metadata: {
          source: 'saga.cancel',
        },
      }),
    ).resolves.toEqual({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      balance: 50,
      reserved: 5,
    });

    expect(tx.creditTransaction.create).toHaveBeenCalledWith({
      data: {
        accountId: 'acc-1',
        creditType: CreditType.BARCODE,
        amount: 10,
        balanceAfter: 50,
        operation: CreditOperation.UNBLOCK,
        buildId: undefined,
        batchId: undefined,
        status: TransactionStatus.CANCELLED,
        metadata: {
          source: 'saga.cancel',
        },
      },
    });
  });
});
