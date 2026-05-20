import { QuoteService } from './quote.service';
import { CreditType, QuoteRequestDto, QuoteSource } from './dto/quote.dto';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { PricingService } from 'src/shared/services/pricing.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

describe('QuoteService', () => {
  let service: QuoteService;

  const wallet = {
    getBalance: jest.fn(),
  } as unknown as jest.Mocked<WalletBalanceService>;

  const creditLedger = {
    getAvailableCredits: jest.fn(),
  } as unknown as jest.Mocked<CreditLedgerService>;

  const prisma = {
    account: {
      findUnique: jest.fn(),
    },
  } as unknown as jest.Mocked<PrismaService>;

  const pricing = {
    getPricing: jest.fn(),
  } as unknown as jest.Mocked<PricingService>;

  const subscriptions = {
    getRemainingCredits: jest.fn(),
  } as unknown as jest.Mocked<SubscriptionService>;

  const request: QuoteRequestDto = {
    userId: 'u1',
    count: 7,
    creditType: CreditType.BARCODE,
    context: {
      product: 'barcode_pdf417',
      revision: 'US_CA_08292017',
      source: QuoteSource.SINGLE,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_WATERFALL_WALLET;
    (pricing.getPricing as any).mockResolvedValue({
      unitPrice: 0.5,
      baseUnitPrice: 0.5,
      currency: 'USD',
      discountPercent: 0,
      volumeDiscount: null,
    });
    (subscriptions.getRemainingCredits as any).mockResolvedValue({
      subscription: null,
      remaining: 0,
    });
    service = new QuoteService(
      wallet,
      creditLedger,
      pricing,
      prisma,
      subscriptions,
    );
  });

  it('returns zero wallet usage when wallet feature is disabled', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue(null);

    const result = await service.quote(request);

    expect(pricing.getPricing).toHaveBeenCalledWith(
      'barcode_pdf417',
      7,
      'US_CA_08292017',
    );
    expect(wallet.getBalance).not.toHaveBeenCalled();
    expect(creditLedger.getAvailableCredits).not.toHaveBeenCalled();
    expect(result).toEqual({
      canProcess: false,
      partial: false,
      requested: 7,
      allowedTotal: 0,
      unitPrice: 0.5,
      bySource: {
        subscription: { units: 0, remaining: 0 },
        credits: { units: 0, remaining: 0 },
        wallet: { units: 0, amount: 0 },
      },
      shortfall: { units: 7, amountRequired: 3.5 },
      currency: 'USD',
      totalWalletCost: 0,
    });
  });

  it('uses wallet balance for barcode quote when feature flag is enabled', async () => {
    process.env.ENABLE_WATERFALL_WALLET = 'true';
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc1' });
    (creditLedger.getAvailableCredits as any).mockResolvedValue(2);
    (wallet.getBalance as any).mockResolvedValue({
      available: 10,
      currency: 'USD',
    });

    const result = await service.quote(request);

    expect(wallet.getBalance).toHaveBeenCalledWith('u1');
    expect(creditLedger.getAvailableCredits).toHaveBeenCalledWith(
      'acc1',
      CreditType.BARCODE,
    );
    expect(result).toEqual({
      canProcess: true,
      partial: false,
      requested: 7,
      allowedTotal: 7,
      unitPrice: 0.5,
      bySource: {
        subscription: { units: 0, remaining: 0 },
        credits: { units: 2, remaining: 0 },
        wallet: { units: 5, amount: 2.5 },
      },
      shortfall: undefined,
      currency: 'USD',
      totalWalletCost: 2.5,
    });
  });

  it('does not use wallet for AI quotes', async () => {
    process.env.ENABLE_WATERFALL_WALLET = 'true';
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc2' });
    (creditLedger.getAvailableCredits as any).mockResolvedValue(4);

    const result = await service.quote({
      ...request,
      creditType: CreditType.AI,
    });

    expect(wallet.getBalance).not.toHaveBeenCalled();
    expect(result.bySource.credits.units).toBe(4);
    expect(result.bySource.wallet.units).toBe(0);
    expect(result.totalWalletCost).toBe(0);
    expect(result.allowedTotal).toBe(4);
    expect(result.shortfall?.units).toBe(3);
  });

  it('uses subscription allowance before credits and wallet', async () => {
    process.env.ENABLE_WATERFALL_WALLET = 'true';
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({ id: 'acc3' });
    (subscriptions.getRemainingCredits as any).mockResolvedValue({
      subscription: { id: 'sub-1' },
      remaining: 3,
    });
    (creditLedger.getAvailableCredits as any).mockResolvedValue(2);
    (wallet.getBalance as any).mockResolvedValue({
      available: 5,
      currency: 'USD',
    });

    const result = await service.quote(request);

    expect(result.bySource.subscription.units).toBe(3);
    expect(result.bySource.credits.units).toBe(2);
    expect(result.bySource.wallet.units).toBe(2);
    expect(result.allowedTotal).toBe(7);
    expect(result.totalWalletCost).toBe(1);
  });
});
