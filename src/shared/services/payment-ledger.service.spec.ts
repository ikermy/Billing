import { TransactionStatus } from '@prisma/client';
import { PaymentLedgerService } from './payment-ledger.service';
import { PrismaService } from './prisma.service';

describe('PaymentLedgerService', () => {
  let service: PaymentLedgerService;

  const prisma = {
    paymentTransaction: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PaymentLedgerService(prisma);
  });

  it('creates pending wallet-backed payment audit', async () => {
    (prisma.paymentTransaction.create as any).mockResolvedValue({
      id: 'pay-1',
      status: TransactionStatus.PENDING,
    });

    await expect(
      service.createPending({
        accountId: 'acc-1',
        amount: 1.5,
        currency: 'USD',
        operation: 'barcode_generation',
        source: 'wallet',
        walletBlockId: 'wb-1',
      }),
    ).resolves.toEqual({
      id: 'pay-1',
      status: TransactionStatus.PENDING,
    });
  });

  it('marks pending payment as completed by wallet block id', async () => {
    (prisma.paymentTransaction.findUnique as any).mockResolvedValue({
      id: 'pay-1',
      walletBlockId: 'wb-1',
      status: TransactionStatus.PENDING,
    });
    (prisma.paymentTransaction.update as any).mockResolvedValue({
      id: 'pay-1',
      status: TransactionStatus.COMPLETED,
    });

    await expect(service.markCompletedByWalletBlock('wb-1')).resolves.toEqual({
      id: 'pay-1',
      status: TransactionStatus.COMPLETED,
    });
  });

  it('marks pending payment as cancelled with reason', async () => {
    (prisma.paymentTransaction.findUnique as any).mockResolvedValue({
      id: 'pay-1',
      walletBlockId: 'wb-1',
      status: TransactionStatus.PENDING,
      metadata: { source: 'saga.block' },
    });
    (prisma.paymentTransaction.update as any).mockResolvedValue({
      id: 'pay-1',
      status: TransactionStatus.CANCELLED,
    });

    await expect(
      service.markCancelledByWalletBlock('wb-1', 'timeout'),
    ).resolves.toEqual({
      id: 'pay-1',
      status: TransactionStatus.CANCELLED,
    });
  });
});
