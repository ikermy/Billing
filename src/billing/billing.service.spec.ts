import { HttpException } from '@nestjs/common';
import { CreditType } from '@prisma/client';
import { BillingService } from './billing.service';
import { LagoService } from 'src/shared/services/lago.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BuyType } from './dto/buy-barcodes.dto';
import { RedisService } from 'src/shared/services/redis.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';

describe('BillingService', () => {
  let service: BillingService;

  // ---- Mocks ----
  const prisma = {
    $transaction: jest.fn(),
    account: { findUnique: jest.fn() },
    product: { findFirst: jest.fn(), findUnique: jest.fn() },
    getBarcodePackages: jest.fn(),
    extractPackages: jest.fn(),
  } as unknown as jest.Mocked<PrismaService>;

  const lago = {
    subscriptionPlan: jest.fn(),
    checkCoupon: jest.fn(),
    checkPlan: jest.fn(),
  } as unknown as jest.Mocked<LagoService>;

  const producer = {
    purchaseSuccess: jest.fn(),
    purchaseFailed: jest.fn(),
    paymentCompleted: jest.fn(),
    paymentFailed: jest.fn(),
    purchaseRecorded: jest.fn(),
  } as unknown as jest.Mocked<BillingProducer>;

  const redis = {
    getProductById: jest.fn(),
    getPlanByCode: jest.fn(),
    getCouponByCode: jest.fn(),
  } as unknown as jest.Mocked<RedisService>;

  const creditLedger = {
    addCredits: jest.fn(),
    chargeCredits: jest.fn(),
    refundGrantedCredits: jest.fn(),
    getAllBalances: jest.fn(),
  } as unknown as jest.Mocked<CreditLedgerService>;

  const wallet = {
    isEnabled: jest.fn(),
    getBalance: jest.fn(),
    blockFunds: jest.fn(),
    confirmBlock: jest.fn(),
    cancelBlock: jest.fn(),
    topUpWithBonus: jest.fn(),
  } as unknown as jest.Mocked<WalletBalanceService>;

  const subscriptions = {
    requireActivePlan: jest.fn(),
    activateSubscription: jest.fn(),
    getSummary: jest.fn(),
    cancelLocalSubscription: jest.fn(),
  } as unknown as jest.Mocked<SubscriptionService>;

  const billingConfig = {
    getTopUpBonusPercent: jest.fn(),
  } as unknown as jest.Mocked<BillingConfigService>;

  const paymentLedger = {
    createPending: jest.fn(),
    createCompleted: jest.fn(),
    createFailed: jest.fn(),
    markCompletedByWalletBlock: jest.fn(),
    markCancelledByWalletBlock: jest.fn(),
  } as unknown as jest.Mocked<PaymentLedgerService>;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLE_TOPUP_BONUS;
    (redis.getProductById as jest.Mock).mockRejectedValue(
      new Error('cache miss'),
    );
    (redis.getPlanByCode as jest.Mock).mockRejectedValue(
      new Error('cache miss'),
    );
    (redis.getCouponByCode as jest.Mock).mockRejectedValue(
      new Error('cache miss'),
    );
    (wallet.isEnabled as jest.Mock).mockReturnValue(true);
    (wallet.blockFunds as jest.Mock).mockResolvedValue({
      blockId: 'wb-1',
      amount: 5,
      currency: 'USD',
    });
    (wallet.confirmBlock as jest.Mock).mockResolvedValue(undefined);
    (wallet.cancelBlock as jest.Mock).mockResolvedValue(undefined);
    (wallet.topUpWithBonus as jest.Mock).mockResolvedValue({
      balance: 115,
      creditedAmount: 115,
      bonusAmount: 15,
      currency: 'USD',
    });
    (billingConfig.getTopUpBonusPercent as jest.Mock).mockResolvedValue(15);
    (creditLedger.refundGrantedCredits as jest.Mock).mockResolvedValue({
      id: 'refund-1',
    });
    service = new BillingService(
      prisma,
      lago,
      producer,
      redis,
      creditLedger,
      wallet,
      subscriptions,
      billingConfig,
      paymentLedger,
    );
  });

  // ---------- buyBarcodes ----------
  it('buyBarcodes: SINGLE — успех', async () => {
    const data = { userId: 'u1', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [
        { credits: 10, price: 5 },
        { credits: 25, price: 10 },
      ],
    });

    await expect(service.buyBarcodes(data)).resolves.toEqual({
      message: 'Successfully initialized barcodes buy',
    });

    expect(creditLedger.addCredits).toHaveBeenCalledWith({
      accountId: 'acc1',
      creditType: CreditType.BARCODE,
      amount: 10,
      operation: 'PURCHASE',
      metadata: {
        purchaseType: 'single',
        productId: 'p1',
        price: 5,
      },
    });
    expect(wallet.blockFunds).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 5,
      currency: 'USD',
      reason: 'barcode_single_purchase',
      metadata: {
        accountId: 'acc1',
        productId: 'p1',
        purchaseType: 'credits',
        credits: 10,
      },
    });
    expect(paymentLedger.createPending).toHaveBeenCalledWith({
      accountId: 'acc1',
      amount: 5,
      currency: 'USD',
      operation: 'credits_purchase',
      source: 'wallet',
      walletBlockId: 'wb-1',
      metadata: {
        purchaseType: 'single',
        credits: 10,
        productId: 'p1',
      },
    });
    expect(wallet.confirmBlock).toHaveBeenCalledWith('wb-1');
    expect(paymentLedger.markCompletedByWalletBlock).toHaveBeenCalledWith(
      'wb-1',
    );
    expect(producer.purchaseSuccess).toHaveBeenCalledWith({
      userId: 'u1',
      credits: 10,
      price: 5,
    });
    expect(producer.paymentCompleted).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 5,
      currency: 'USD',
      operation: 'credits_purchase',
      metadata: {
        units: 10,
        planCode: undefined,
      },
    });
    expect(producer.purchaseRecorded).toHaveBeenCalledWith({
      userId: 'u1',
      purchaseType: 'credits',
      amount: 5,
      currency: 'USD',
      units: 10,
      planCode: undefined,
      referrerId: undefined,
    });
  });

  it('buyBarcodes: PACKAGE — успех с index', async () => {
    const data = { userId: 'u2', index: 1, type: BuyType.PACKAGE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc2',
      userId: 'u2',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [
        { credits: 10, price: 5 },
        { credits: 50, price: 20 },
      ],
    });

    await service.buyBarcodes(data);

    expect(creditLedger.addCredits).toHaveBeenCalledWith({
      accountId: 'acc2',
      creditType: CreditType.BARCODE,
      amount: 50,
      operation: 'PURCHASE',
      metadata: {
        purchaseType: 'package',
        productId: 'p1',
        packageIndex: 1,
        price: 20,
      },
    });
    expect(wallet.blockFunds).toHaveBeenCalledWith({
      userId: 'u2',
      amount: 20,
      currency: 'USD',
      reason: 'barcode_package_purchase',
      metadata: {
        accountId: 'acc2',
        productId: 'p1',
        packageIndex: 1,
        purchaseType: 'package',
        credits: 50,
      },
    });
    expect(paymentLedger.createPending).toHaveBeenCalledWith({
      accountId: 'acc2',
      amount: 20,
      currency: 'USD',
      operation: 'package_purchase',
      source: 'wallet',
      walletBlockId: 'wb-1',
      metadata: {
        purchaseType: 'package',
        credits: 50,
        productId: 'p1',
        packageIndex: 1,
      },
    });
    expect(wallet.confirmBlock).toHaveBeenCalledWith('wb-1');
    expect(paymentLedger.markCompletedByWalletBlock).toHaveBeenCalledWith(
      'wb-1',
    );
    expect(producer.purchaseSuccess).toHaveBeenCalledWith({
      userId: 'u2',
      credits: 50,
      price: 20,
    });
  });

  it('buyBarcodes: SUBSCRIPTION — успех', async () => {
    const data = {
      userId: 'u3',
      index: 0,
      type: 'SUBSCRIPTION',
      code: 'plan_basic',
    } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc3',
      userId: 'u3',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ credits: 10, price: 5 }],
    });
    (subscriptions.requireActivePlan as jest.Mock).mockResolvedValue({
      id: 'plan_local_1',
      priceMonthly: 29.99,
      currency: 'USD',
      monthlyCredits: 200,
    });
    (lago.subscriptionPlan as jest.Mock).mockResolvedValue({
      id: 'sub_123',
      external_id: 'plan_basic-acc3',
    });

    await service.buyBarcodes(data);

    expect(subscriptions.requireActivePlan).toHaveBeenCalledWith('plan_basic');
    expect(wallet.blockFunds).toHaveBeenCalledWith({
      userId: 'u3',
      amount: 29.99,
      currency: 'USD',
      reason: 'subscription_purchase',
      metadata: {
        accountId: 'acc3',
        purchaseType: 'subscription',
        planCode: 'plan_basic',
        monthlyCredits: 200,
      },
    });
    expect(paymentLedger.createPending).toHaveBeenCalledWith({
      accountId: 'acc3',
      amount: 29.99,
      currency: 'USD',
      operation: 'subscription_purchase',
      source: 'wallet',
      walletBlockId: 'wb-1',
      metadata: {
        purchaseType: 'subscription',
        planCode: 'plan_basic',
        monthlyCredits: 200,
      },
    });
    expect(lago.subscriptionPlan).toHaveBeenCalledWith('plan_basic', {
      id: 'acc3',
      userId: 'u3',
    });
    expect(subscriptions.activateSubscription).toHaveBeenCalledWith('acc3', {
      id: 'sub_123',
      external_id: 'plan_basic-acc3',
    });
    expect(producer.purchaseSuccess).toHaveBeenCalledWith({
      userId: 'u3',
      credits: null,
      price: 29.99,
      subscription: { id: 'sub_123', external_id: 'plan_basic-acc3' },
    });
  });

  it('buyBarcodes: cancels wallet block when confirmation fails (credits not yet granted)', async () => {
    /**
     * MINOR-1: confirmBlock now runs BEFORE addCredits.
     * If confirmBlock fails, credits were never added → no credit rollback needed.
     * Only the wallet block should be cancelled.
     */
    const data = { userId: 'u1', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ credits: 10, price: 5 }],
    });
    (wallet.confirmBlock as jest.Mock).mockRejectedValue(
      new HttpException('bad', 503),
    );

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );

    // Credits were never added, so refundGrantedCredits must NOT be called
    expect(creditLedger.refundGrantedCredits).not.toHaveBeenCalled();
    // Wallet block must be cancelled
    expect(wallet.cancelBlock).toHaveBeenCalledWith('wb-1');
    expect(paymentLedger.markCancelledByWalletBlock).toHaveBeenCalledWith(
      'wb-1',
      'bad',
    );
  });

  it('buyBarcodes: propagates error and does not leak wallet block when addCredits fails', async () => {
    /**
     * confirmBlock succeeds (walletBlockId reset to null), then addCredits throws.
     * Since walletBlockId is null, handleFailedPurchasePayment cannot cancel the block.
     * The error must be re-thrown and refundGrantedCredits must NOT be called
     * (rollbackActions were never pushed because push happens AFTER addCredits).
     */
    const data = { userId: 'u1', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ credits: 10, price: 5 }],
    });
    (wallet.confirmBlock as jest.Mock).mockResolvedValue(undefined);
    (creditLedger.addCredits as jest.Mock).mockRejectedValue(
      new HttpException('credit store down', 503),
    );

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );

    expect(creditLedger.refundGrantedCredits).not.toHaveBeenCalled();
  });

  it('buyBarcodes: product not found -> HttpException(404) бросается', async () => {
    const data = { userId: 'u1', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.buyBarcodes(data)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('buyBarcodes: invalid index -> 400', async () => {
    const data = { userId: 'u1', index: 10, type: BuyType.PACKAGE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ credits: 10, price: 5 }],
    });

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.buyBarcodes(data)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('buyBarcodes: account not found -> 404', async () => {
    const data = { userId: 'u404', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.product.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ credits: 10, price: 5 }],
    });

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.buyBarcodes(data)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('buyBarcodes: non-Http error -> 500', async () => {
    const data = { userId: 'u1', index: 0, type: BuyType.SINGLE } as any;

    (prisma.account.findUnique as jest.Mock).mockRejectedValue(
      new Error('boom'),
    );

    await expect(service.buyBarcodes(data)).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.buyBarcodes(data)).rejects.toMatchObject({
      status: 500,
    });
  });

  // ---------- checkCredits ----------
  it('checkCredits: success', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (creditLedger.getAllBalances as jest.Mock).mockResolvedValue({
      [CreditType.BARCODE]: { balance: 123, reserved: 23 },
      [CreditType.AI]: { balance: 7, reserved: 2 },
    });

    await expect(service.checkCredits('u1')).resolves.toEqual({
      barcode: 100,
      ai: 5,
    });
    expect(creditLedger.getAllBalances).toHaveBeenCalledWith('acc1');
  });

  it('checkCredits: account not found -> 404', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(service.checkCredits('u404')).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(service.checkCredits('u404')).rejects.toMatchObject({
      status: 404,
    });
  });

  // ---------- checkCoupon ----------
  it('checkCoupon: delegates to lago', async () => {
    (lago.checkCoupon as jest.Mock).mockResolvedValue({
      coupon: { code: 'SAVE10' },
    });

    await expect(service.checkCoupon('SAVE10')).resolves.toEqual({
      coupon: { code: 'SAVE10' },
    });
    expect(lago.checkCoupon).toHaveBeenCalledWith('SAVE10');
  });

  it('checkSubscription: returns local subscription summary', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (subscriptions.getSummary as jest.Mock).mockResolvedValue({
      active: true,
      plan: 'Pro',
      remaining: 120,
    });

    await expect(service.checkSubscription('u1')).resolves.toEqual({
      active: true,
      plan: 'Pro',
      remaining: 120,
    });
    expect(subscriptions.getSummary).toHaveBeenCalledWith('acc1');
  });

  it('getBalance: returns subscription, credits and wallet summary', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (subscriptions.getSummary as jest.Mock).mockResolvedValue({
      active: true,
      plan: 'Pro',
      remaining: 120,
    });
    (creditLedger.getAllBalances as jest.Mock).mockResolvedValue({
      [CreditType.BARCODE]: { balance: 123 },
      [CreditType.AI]: { balance: 7 },
    });
    (wallet.isEnabled as jest.Mock).mockReturnValue(true);
    (wallet.getBalance as jest.Mock).mockResolvedValue({
      available: 45,
      currency: 'USD',
    });

    await expect(service.getBalance('u1')).resolves.toEqual({
      subscription: {
        active: true,
        plan: 'Pro',
        remaining: 120,
      },
      credits: {
        barcode: 123,
        ai: 7,
      },
      wallet: {
        available: 45,
        currency: 'USD',
      },
    });
  });

  it('topUpWallet: applies configured bonus tiers via wallet-balance service', async () => {
    process.env.ENABLE_TOPUP_BONUS = 'true';
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });

    await expect(
      service.topUpWallet('u1', {
        amount: 100,
        metadata: { source: 'settings' },
      }),
    ).resolves.toEqual({
      balance: 115,
      creditedAmount: 115,
      bonusAmount: 15,
      currency: 'USD',
      bonusPercent: 15,
    });

    expect(billingConfig.getTopUpBonusPercent).toHaveBeenCalledWith(100);
    expect(wallet.topUpWithBonus).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 100,
      bonusPercent: 15,
      currency: 'USD',
      metadata: {
        accountId: 'acc1',
        source: 'settings',
      },
    });
    expect(paymentLedger.createCompleted).toHaveBeenCalledWith({
      accountId: 'acc1',
      amount: 100,
      currency: 'USD',
      operation: 'wallet_topup',
      source: 'wallet',
      metadata: {
        bonusPercent: 15,
        bonusAmount: 15,
        creditedAmount: 115,
        source: 'settings',
      },
    });
    expect(producer.paymentCompleted).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 100,
      currency: 'USD',
      operation: 'wallet_topup',
      metadata: {
        bonusPercent: 15,
        bonusAmount: 15,
        creditedAmount: 115,
      },
    });
  });

  it('topUpWallet: disables bonus tiers when feature flag is off', async () => {
    (prisma.account.findUnique as jest.Mock).mockResolvedValue({
      id: 'acc1',
      userId: 'u1',
    });
    (wallet.topUpWithBonus as jest.Mock).mockResolvedValue({
      balance: 100,
      creditedAmount: 100,
      bonusAmount: 0,
      currency: 'USD',
    });

    await expect(
      service.topUpWallet('u1', {
        amount: 100,
      }),
    ).resolves.toEqual({
      balance: 100,
      creditedAmount: 100,
      bonusAmount: 0,
      currency: 'USD',
      bonusPercent: 0,
    });

    expect(billingConfig.getTopUpBonusPercent).not.toHaveBeenCalled();
    expect(wallet.topUpWithBonus).toHaveBeenCalledWith({
      userId: 'u1',
      amount: 100,
      bonusPercent: 0,
      currency: 'USD',
      metadata: {
        accountId: 'acc1',
      },
    });
  });

  // ---------- calculatePrice ----------
  it('calculatePrice: only packageIndex', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ price: 5 }, { price: 20 }],
    });

    const res = await service.calculatePrice({
      productId: 'p1',
      packageIndex: 1,
    } as any);
    expect(res).toEqual({
      totalPrice: 20,
      basePrice: 20,
      discount: {
        amount: null,
        rate: null,
        description: null,
      },
      breakdown: [
        { product: undefined },
        { coupon: null, price: null, rate: null },
        { subscription: null, price: null },
      ],
    });
  });

  it('calculatePrice: planCode adds amount', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p1' });
    (lago.checkPlan as jest.Mock).mockResolvedValue({
      plan: { amountCents: 999 },
    });

    const res = await service.calculatePrice({
      productId: 'p1',
      planCode: 'pro',
    } as any);
    expect(res).toEqual({
      totalPrice: 9.99,
      basePrice: 9.99,
      discount: {
        amount: null,
        rate: null,
        description: null,
      },
      breakdown: [
        { product: undefined },
        { coupon: null, price: null, rate: null },
        { subscription: null, price: 9.99 },
      ],
    });
  });

  it('calculatePrice: fixed coupon clamps to zero', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ price: 10 }],
    });
    (lago.checkCoupon as jest.Mock).mockResolvedValue({
      coupon: { type: 'fixed_amount', amountCents: 1500 },
    });

    const res = await service.calculatePrice({
      productId: 'p1',
      packageIndex: 0,
      couponCode: 'FREE',
    } as any);

    expect(res.totalPrice).toBe(0);
    expect(res.basePrice).toBe(10);
    expect(res.discount).toEqual({
      amount: 10,
      rate: null,
      description: null,
    });
    expect(res.breakdown[1]).toEqual({
      coupon: null,
      price: 10,
      rate: null,
    });
  });

  it('calculatePrice: percentage coupon', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ price: 100 }],
    });
    (lago.checkCoupon as jest.Mock).mockResolvedValue({
      coupon: { type: 'percentage', percentageRate: '25' },
    });

    const res = await service.calculatePrice({
      productId: 'p1',
      packageIndex: 0,
      couponCode: 'OFF25',
    } as any);

    expect(res.totalPrice).toBeCloseTo(75);
    expect(res.basePrice).toBe(100);
    expect(res.discount).toEqual({
      amount: 25,
      rate: '25',
      description: null,
    });
    expect(res.breakdown[1]).toEqual({
      coupon: null,
      price: 25,
      rate: '25',
    });
  });

  it('calculatePrice: invalid packageIndex -> 400', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.extractPackages as jest.Mock).mockResolvedValue({
      packages: [{ price: 10 }],
    });

    await expect(
      service.calculatePrice({ productId: 'p1', packageIndex: 2 } as any),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('calculatePrice: product not found -> 404', async () => {
    (prisma.product.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(
      service.calculatePrice({ productId: 'nope' } as any),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('calculatePrice: non-Http error -> 500', async () => {
    (prisma.product.findUnique as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );

    await expect(
      service.calculatePrice({ productId: 'p1' } as any),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
