import { CreditOperation, CreditType } from '@prisma/client';
import { BarcodeGenConsumer } from './barcode-gen.consumer';
import { PrismaService } from 'src/shared/services/prisma.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { PricingService } from 'src/shared/services/pricing.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

describe('BarcodeGenConsumer', () => {
  let consumer: BarcodeGenConsumer;

  const prisma = {
    account: {
      findUnique: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  const subscriptions = {
    consumeIncludedCredits: jest.fn(),
    hasCurrentSubscription: jest.fn(),
  } as unknown as jest.Mocked<SubscriptionService>;

  const creditLedger = {
    chargeCredits: jest.fn(),
  } as unknown as jest.Mocked<CreditLedgerService>;

  const wallet = {
    blockFunds: jest.fn(),
    confirmBlock: jest.fn(),
  } as unknown as jest.Mocked<WalletBalanceService>;

  const pricing = {
    getUnitPriceForBarcodeType: jest.fn(),
  } as unknown as jest.Mocked<PricingService>;

  const context = {
    getMessage: () => ({
      key: Buffer.from('key-1'),
      headers: {
        'x-request-id': Buffer.from('req-1'),
      },
    }),
  };

  const payload = {
    id: 'build-1',
    url: 'https://example.com/barcode.png',
    type: 'PDF417' as const,
    data: '123456',
    userId: 'user-1',
    editFlag: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ENABLE_LEGACY_BARCODE_NEW_BILLING = 'true';
    consumer = new BarcodeGenConsumer(
      prisma,
      subscriptions,
      creditLedger,
      wallet,
      pricing,
    );
  });

  afterEach(() => {
    delete process.env.ENABLE_LEGACY_BARCODE_NEW_BILLING;
  });

  it('skips legacy direct billing when feature flag is disabled', async () => {
    process.env.ENABLE_LEGACY_BARCODE_NEW_BILLING = 'false';
    consumer = new BarcodeGenConsumer(
      prisma,
      subscriptions,
      creditLedger,
      wallet,
      pricing,
    );

    await consumer.handleGenerated(payload, context as any);

    expect(prisma.account.findUnique).not.toHaveBeenCalled();
    expect(subscriptions.consumeIncludedCredits).not.toHaveBeenCalled();
    expect(creditLedger.chargeCredits).not.toHaveBeenCalled();
    expect(wallet.blockFunds).not.toHaveBeenCalled();
  });

  it('charges one local credit before wallet', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc-1',
      userId: 'user-1',
    });
    (subscriptions.consumeIncludedCredits as jest.Mock).mockResolvedValue(null);
    (creditLedger.chargeCredits as jest.Mock).mockResolvedValue({ balance: 9 });

    await consumer.handleGenerated(payload, context as any);

    expect(creditLedger.chargeCredits).toHaveBeenCalledWith({
      accountId: 'acc-1',
      creditType: CreditType.BARCODE,
      amount: 1,
      operation: CreditOperation.CHARGE,
      buildId: 'build-1',
      metadata: {
        barcodeType: 'PDF417',
        source: 'barcode.new',
      },
    });
    expect(wallet.blockFunds).not.toHaveBeenCalled();
  });

  it('uses subscription allowance before credits and wallet', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc-1',
      userId: 'user-1',
    });
    (subscriptions.consumeIncludedCredits as jest.Mock).mockResolvedValue({
      id: 'sub-1',
    });

    await consumer.handleGenerated(payload, context as any);

    expect(subscriptions.consumeIncludedCredits).toHaveBeenCalledWith(
      'acc-1',
      1,
    );
    expect(creditLedger.chargeCredits).not.toHaveBeenCalled();
    expect(wallet.blockFunds).not.toHaveBeenCalled();
  });

  it('falls back to wallet pay-as-you-go when credits are empty', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc-1',
      userId: 'user-1',
    });
    (subscriptions.consumeIncludedCredits as jest.Mock).mockResolvedValue(null);
    (creditLedger.chargeCredits as jest.Mock).mockResolvedValue(null);
    (pricing.getUnitPriceForBarcodeType as jest.Mock).mockResolvedValue(0.5);
    (wallet.blockFunds as jest.Mock).mockResolvedValue({ blockId: 'blk-1' });

    await consumer.handleGenerated(payload, context as any);

    expect(wallet.blockFunds).toHaveBeenCalledWith({
      userId: 'user-1',
      amount: 0.5,
      currency: 'USD',
      reason: 'barcode_generation',
      metadata: {
        buildId: 'build-1',
        barcodeType: 'PDF417',
        source: 'barcode.new',
      },
    });
    expect(wallet.confirmBlock).toHaveBeenCalledWith('blk-1');
  });
});
