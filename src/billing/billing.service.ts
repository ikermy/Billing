import { HttpException, Injectable, Logger } from '@nestjs/common';
import { SubscriptionObjectExtended } from 'lago-javascript-client';
import { CreditOperation, CreditType } from '@prisma/client';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { LagoService } from 'src/shared/services/lago.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { RedisService } from 'src/shared/services/redis.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';
import {
  CachedCoupon,
  CachedPlan,
  ProductWithPackages,
} from 'src/shared/types/billing.types';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { BuyBarcodesDto, BuyType } from './dto/buy-barcodes.dto';
import { CalculatePriceDto } from './dto/calculate-price.dto';
import { TopUpWalletDto } from './dto/topup-wallet.dto';

type PurchaseKind = 'credits' | 'package' | 'subscription';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lago: LagoService,
    private readonly producer: BillingProducer,
    private readonly redis: RedisService,
    private readonly creditLedger: CreditLedgerService,
    private readonly wallet: WalletBalanceService,
    private readonly subscriptions: SubscriptionService,
    private readonly billingConfig: BillingConfigService,
    private readonly paymentLedger: PaymentLedgerService,
  ) {}

  async buyBarcodes(data: BuyBarcodesDto) {
    let credits: number | null = null;
    let price: number | null = null;
    let purchaseType: PurchaseKind | null = null;
    let currency = 'USD';
    let sub: SubscriptionObjectExtended | null = null;
    let accountId: string | null = null;
    let walletBlockId: string | null = null;
    const rollbackActions: Array<() => Promise<void>> = [];

    try {
      const account = await this.prisma.account.findUnique({
        where: { userId: data.userId },
      });
      const product = await this.prisma.product.findFirst({
        orderBy: { createdAt: 'asc' },
      });

      if (!product) {
        this.logger.error('Product with name barcode was not found');
        throw new HttpException('Product not found', 404);
      }

      const { packages } = await this.prisma.extractPackages(product);
      const packageIndex = data.index;
      if (
        data.type === BuyType.PACKAGE &&
        (packageIndex === undefined ||
          packageIndex < 0 ||
          packageIndex >= packages.length)
      ) {
        throw new HttpException('Invalid package index is out of scope', 400);
      }

      if (!account) {
        this.logger.debug(
          `Account for user with id: ${data.userId} was not found!`,
        );
        throw new HttpException('Account not found', 404);
      }

      accountId = account.id;

      if (data.type === BuyType.SINGLE) {
        const basePackage = packages[0];
        if (!basePackage) {
          throw new HttpException('Base package not found', 500);
        }

        credits = basePackage.credits;
        price = Number(basePackage.price);
        purchaseType = 'credits';
        walletBlockId = await this.blockPurchaseFunds({
          userId: account.userId,
          amount: price,
          reason: 'barcode_single_purchase',
          metadata: {
            accountId: account.id,
            productId: product.id,
            purchaseType,
            credits,
          },
        });
        await this.paymentLedger.createPending({
          accountId: account.id,
          amount: price,
          currency,
          operation: 'credits_purchase',
          source: 'wallet',
          walletBlockId: walletBlockId ?? undefined,
          metadata: {
            purchaseType: 'single',
            credits,
            productId: product.id,
          },
        });

        // Confirm payment BEFORE granting credits (MINOR-1 fix)
        if (walletBlockId) {
          await this.wallet.confirmBlock(walletBlockId);
          await this.tryMarkPaymentCompleted(walletBlockId);
          walletBlockId = null; // prevent double-handling in finally block
        }

        await this.creditLedger.addCredits({
          accountId: account.id,
          creditType: CreditType.BARCODE,
          amount: credits,
          operation: CreditOperation.PURCHASE,
          metadata: {
            purchaseType: 'single',
            productId: product.id,
            price,
          },
        });
        const grantedAmount = credits;
        rollbackActions.push(async () => {
          await this.tryRollbackCredits(account.id, grantedAmount);
        });
      } else if (data.type === BuyType.PACKAGE) {
        const selectedPackage = packages[packageIndex];
        if (!selectedPackage) {
          throw new HttpException('Invalid package index is out of scope', 400);
        }

        credits = selectedPackage.credits;
        price = Number(selectedPackage.price);
        purchaseType = 'package';
        walletBlockId = await this.blockPurchaseFunds({
          userId: account.userId,
          amount: price,
          reason: 'barcode_package_purchase',
          metadata: {
            accountId: account.id,
            productId: product.id,
            packageIndex,
            purchaseType,
            credits,
          },
        });
        await this.paymentLedger.createPending({
          accountId: account.id,
          amount: price,
          currency,
          operation: 'package_purchase',
          source: 'wallet',
          walletBlockId: walletBlockId ?? undefined,
          metadata: {
            purchaseType: 'package',
            credits,
            productId: product.id,
            packageIndex,
          },
        });

        // Confirm payment BEFORE granting credits (MINOR-1 fix)
        if (walletBlockId) {
          await this.wallet.confirmBlock(walletBlockId);
          await this.tryMarkPaymentCompleted(walletBlockId);
          walletBlockId = null; // prevent double-handling in finally block
        }

        await this.creditLedger.addCredits({
          accountId: account.id,
          creditType: CreditType.BARCODE,
          amount: credits,
          operation: CreditOperation.PURCHASE,
          metadata: {
            purchaseType: 'package',
            productId: product.id,
            packageIndex,
            price,
          },
        });
        const grantedAmount = credits;
        rollbackActions.push(async () => {
          await this.tryRollbackCredits(account.id, grantedAmount);
        });
      } else {
        if (!data.code) {
          throw new HttpException('Subscription code is required', 400);
        }

        const plan = await this.subscriptions.requireActivePlan(data.code);
        price = Number(plan.priceMonthly);
        currency = plan.currency;
        purchaseType = 'subscription';
        walletBlockId = await this.blockPurchaseFunds({
          userId: account.userId,
          amount: price,
          currency,
          reason: 'subscription_purchase',
          metadata: {
            accountId: account.id,
            purchaseType,
            planCode: data.code,
            monthlyCredits: plan.monthlyCredits,
          },
        });
        await this.paymentLedger.createPending({
          accountId: account.id,
          amount: price,
          currency,
          operation: 'subscription_purchase',
          source: 'wallet',
          walletBlockId: walletBlockId ?? undefined,
          metadata: {
            purchaseType: 'subscription',
            planCode: data.code,
            monthlyCredits: plan.monthlyCredits,
          },
        });

        const subscription = await this.lago.subscriptionPlan(
          data.code,
          account,
        );
        const activated = await this.subscriptions.activateSubscription(
          account.id,
          subscription,
        );
        sub = subscription;
        const subscriptionExternalId = subscription.external_id;
        if (subscriptionExternalId) {
          rollbackActions.push(async () => {
            await this.tryRollbackSubscription(subscriptionExternalId);
          });
        }
        try {
          await this.producer.subscriptionRenewed({
            userId: account.userId,
            subscriptionId: activated.id,
            planCode: activated.plan.lagoPlanCode,
            creditsAllocated: activated.creditsAllocated,
            periodStart: activated.currentPeriodStart.toISOString(),
            periodEnd: activated.currentPeriodEnd.toISOString(),
          });
        } catch (emitErr) {
          this.logger.warn(
            `Failed to emit subscriptionRenewed for accountId=${account.id}: ${getErrorMessage(emitErr)}`,
          );
        }
      }

      // For subscription purchases, confirmBlock happens here (after subscription creation)
      if (walletBlockId) {
        await this.wallet.confirmBlock(walletBlockId);
        await this.tryMarkPaymentCompleted(walletBlockId);
      }

      if (credits !== null) {
        credits = Number(credits);
      }
      if (price !== null) {
        price = Number(Number(price).toFixed(2));
      }

      await this.emitSuccessfulPurchase({
        userId: account.userId,
        purchaseType,
        credits,
        price,
        currency,
        subscription: sub,
        referrerId: data.referrerId,
        planCode: data.code,
      });

      return { message: 'Successfully initialized barcodes buy' };
    } catch (error) {
      for (const rollback of [...rollbackActions].reverse()) {
        await rollback();
      }
      await this.handleFailedPurchasePayment({
        walletBlockId,
        accountId,
        price,
        currency,
        purchaseType,
        reason:
          error instanceof Error
            ? error.message
            : 'purchase_initialization_failed',
      });

      try {
        await this.producer.purchaseFailed({
          userId: data.userId,
          credits,
          price,
          subscription: sub,
        });
        await this.producer.paymentFailed({
          userId: data.userId,
          amount: price,
          currency,
          operation: purchaseType ? `${purchaseType}_purchase` : 'purchase',
          reason:
            error instanceof Error
              ? error.message
              : 'purchase_initialization_failed',
        });
      } catch (producerError) {
        this.logger.error(
          'Kafka emitting purchaseFailed failed in buy barcodes',
          producerError,
        );
      }

      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error('Error occured in buy barcodes:', error);
      throw new HttpException('Something went wrong', 500);
    }
  }

  async checkCredits(userId: string) {
    const account = await this.prisma.account.findUnique({
      where: { userId },
    });
    if (!account) {
      this.logger.debug(`Account for user with id: ${userId} was not found!`);
      throw new HttpException('Account not found', 404);
    }

    const balances = await this.creditLedger.getAllBalances(account.id);

    return {
      barcode: Math.max(
        0,
        balances[CreditType.BARCODE].balance -
          (balances[CreditType.BARCODE].reserved ?? 0),
      ),
      ai: Math.max(
        0,
        balances[CreditType.AI].balance -
          (balances[CreditType.AI].reserved ?? 0),
      ),
    };
  }

  async checkSubscription(userId: string) {
    const account = await this.prisma.account.findUnique({
      where: { userId },
    });
    if (!account) {
      this.logger.debug(`Account for user with id: ${userId} was not found!`);
      throw new HttpException('Account not found', 404);
    }
    return await this.subscriptions.getSummary(account.id);
  }

  async getBalance(userId: string) {
    const account = await this.prisma.account.findUnique({
      where: { userId },
    });
    if (!account) {
      this.logger.debug(`Account for user with id: ${userId} was not found!`);
      throw new HttpException('Account not found', 404);
    }

    const credits = await this.creditLedger.getAllBalances(account.id);
    const subscription = await this.subscriptions.getSummary(account.id);
    const wallet = this.wallet.isEnabled()
      ? await this.wallet.getBalance(userId)
      : {
          available: 0,
          currency: 'USD',
        };

    return {
      subscription,
      credits: {
        barcode: Math.max(
          0,
          credits[CreditType.BARCODE].balance -
            (credits[CreditType.BARCODE].reserved ?? 0),
        ),
        ai: Math.max(
          0,
          credits[CreditType.AI].balance -
            (credits[CreditType.AI].reserved ?? 0),
        ),
      },
      wallet,
    };
  }

  async topUpWallet(userId: string, data: TopUpWalletDto) {
    const account = await this.prisma.account.findUnique({
      where: { userId },
    });
    if (!account) {
      this.logger.debug(`Account for user with id: ${userId} was not found!`);
      throw new HttpException('Account not found', 404);
    }
    if (!this.wallet.isEnabled()) {
      throw new HttpException('Wallet service is not configured', 503);
    }

    const bonusPercent =
      process.env.ENABLE_TOPUP_BONUS === 'true'
        ? await this.billingConfig.getTopUpBonusPercent(data.amount)
        : 0;

    try {
      const result = await this.wallet.topUpWithBonus({
        userId,
        amount: data.amount,
        bonusPercent,
        currency: 'USD',
        metadata: {
          accountId: account.id,
          ...(data.metadata ?? {}),
        },
      });

      await this.tryRecordCompletedPayment({
        accountId: account.id,
        amount: data.amount,
        currency: result.currency,
        operation: 'wallet_topup',
        source: 'wallet',
        metadata: {
          bonusPercent,
          bonusAmount: result.bonusAmount,
          creditedAmount: result.creditedAmount,
          ...(data.metadata ?? {}),
        },
      });
      try {
        await this.producer.paymentCompleted({
          userId,
          amount: data.amount,
          currency: result.currency,
          operation: 'wallet_topup',
          metadata: {
            bonusPercent,
            bonusAmount: result.bonusAmount,
            creditedAmount: result.creditedAmount,
          },
        });
      } catch (producerError) {
        this.logger.error(
          'Kafka emitting paymentCompleted failed in top up wallet',
          producerError,
        );
      }

      return {
        ...result,
        bonusPercent,
      };
    } catch (error) {
      await this.tryRecordFailedPayment({
        accountId: account.id,
        amount: data.amount,
        currency: 'USD',
        operation: 'wallet_topup',
        source: 'wallet',
        reason: error instanceof Error ? error.message : 'wallet_topup_failed',
        metadata: data.metadata,
      });
      try {
        await this.producer.paymentFailed({
          userId,
          amount: data.amount,
          currency: 'USD',
          operation: 'wallet_topup',
          reason:
            error instanceof Error ? error.message : 'wallet_topup_failed',
        });
      } catch (producerError) {
        this.logger.error(
          'Kafka emitting paymentFailed failed in top up wallet',
          producerError,
        );
      }

      throw error;
    }
  }

  async checkCoupon(code: string) {
    return await this.lago.checkCoupon(code);
  }

  async calculatePrice(data: CalculatePriceDto) {
    try {
      let product: ProductWithPackages | null;
      try {
        product = await this.redis.getProductById(data.productId);
      } catch {
        product = await this.prisma.product.findUnique({
          where: { id: data.productId },
        });
      }
      if (!product) {
        throw new HttpException('Product not found', 404);
      }
      // ── All calculations in integer cents to avoid float precision loss ──────
      let basePriceCents = 0;
      if (data.packageIndex !== undefined && data.packageIndex !== null) {
        const { packages } = await this.prisma.extractPackages(product);
        if (data.packageIndex < 0 || data.packageIndex >= packages.length) {
          throw new HttpException(
            'Invalid package packageIndex is out of scope',
            400,
          );
        }

        basePriceCents += Math.round(packages[data.packageIndex].price * 100);
      }
      let appliedPlan: CachedPlan | null = null;
      if (data.planCode) {
        let plan: CachedPlan;
        try {
          plan = await this.redis.getPlanByCode(data.planCode);
        } catch {
          const { plan: lagoPlan } = await this.lago.checkPlan(data.planCode);
          plan = lagoPlan;
        }
        basePriceCents += plan.amountCents; // already in cents
        appliedPlan = plan;
      }

      let totalPriceCents = basePriceCents;
      let appliedCoupon: CachedCoupon | null = null;
      if (data.couponCode) {
        let coupon: CachedCoupon;
        try {
          coupon = await this.redis.getCouponByCode(data.couponCode);
        } catch {
          const { coupon: lagoCoupon } = await this.lago.checkCoupon(
            data.couponCode,
          );
          coupon = lagoCoupon;
        }
        const couponAmountCents =
          typeof coupon.amountCents === 'number' ? coupon.amountCents : 0;
        if (coupon.type === 'fixed_amount') {
          totalPriceCents = Math.max(0, basePriceCents - couponAmountCents);
        } else {
          const percentageRate = Number.parseFloat(
            coupon.percentageRate ?? '0',
          );
          totalPriceCents = Math.round(
            basePriceCents * (1 - percentageRate / 100),
          );
        }
        appliedCoupon = coupon;
      }

      // ── Convert to dollars only for the response ──────────────────────────
      const totalPrice = totalPriceCents / 100;
      const basePrice = basePriceCents / 100;

      const discountAmount =
        appliedCoupon !== null
          ? Math.max(0, basePriceCents - totalPriceCents) / 100
          : null;
      const planAmount = appliedPlan ? appliedPlan.amountCents / 100 : null;

      return {
        totalPrice,
        basePrice,
        discount: {
          amount: discountAmount,
          rate: appliedCoupon?.percentageRate ?? null,
          description: appliedCoupon?.description ?? null,
        },
        breakdown: [
          { product: product.name },
          {
            coupon: appliedCoupon?.name ?? null,
            price: discountAmount,
            rate: appliedCoupon?.percentageRate ?? null,
          },
          {
            subscription: appliedPlan?.name ?? null,
            price: planAmount,
          },
        ],
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('Error occured in calculate price:', error);
      throw new HttpException('Something went wrong', 500);
    }
  }

  private async emitSuccessfulPurchase(input: {
    userId: string;
    purchaseType: PurchaseKind | null;
    credits: number | null;
    price: number | null;
    currency: string;
    subscription: SubscriptionObjectExtended | null;
    referrerId?: string;
    planCode?: string;
  }): Promise<void> {
    try {
      await this.producer.purchaseSuccess({
        userId: input.userId,
        credits: input.credits,
        price: input.price,
        subscription: input.subscription ?? undefined,
      });

      if (input.price !== null) {
        await this.producer.paymentCompleted({
          userId: input.userId,
          amount: input.price,
          currency: input.currency,
          operation: input.purchaseType
            ? `${input.purchaseType}_purchase`
            : 'purchase',
          metadata: {
            units: input.credits,
            planCode: input.planCode,
          },
        });
      }

      if (input.purchaseType && input.price !== null) {
        await this.producer.purchaseRecorded({
          userId: input.userId,
          purchaseType: input.purchaseType,
          amount: input.price,
          currency: input.currency,
          units: input.credits,
          planCode: input.planCode,
          referrerId: input.referrerId,
        });
      }
    } catch (error) {
      this.logger.error(
        `Kafka emitting success events failed: ${getErrorMessage(error)}`,
      );
    }
  }

  private async blockPurchaseFunds(input: {
    userId: string;
    amount: number;
    currency?: string;
    reason: string;
    metadata?: Record<string, unknown>;
  }): Promise<string | null> {
    if (!Number.isFinite(input.amount) || input.amount <= 0) {
      return null;
    }
    if (!this.wallet.isEnabled()) {
      throw new HttpException('Wallet service is not configured', 503);
    }

    const block = await this.wallet.blockFunds({
      userId: input.userId,
      amount: Number(input.amount.toFixed(2)),
      currency: input.currency ?? 'USD',
      reason: input.reason,
      metadata: input.metadata,
    });

    return block.blockId;
  }

  private async tryCancelWalletBlock(blockId: string): Promise<void> {
    try {
      await this.wallet.cancelBlock(blockId);
    } catch (error) {
      this.logger.error(
        `Failed to rollback wallet blockId=${blockId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryRollbackCredits(
    accountId: string,
    amount: number,
  ): Promise<void> {
    try {
      const rolledBack = await this.creditLedger.refundGrantedCredits({
        accountId,
        creditType: CreditType.BARCODE,
        amount,
        metadata: {
          source: 'purchase.rollback',
          reason: 'wallet_payment_failed',
        },
      });

      if (!rolledBack) {
        this.logger.error(
          `Critical rollback failure: unable to refund granted credits for accountId=${accountId}, amount=${amount}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to rollback granted credits for accountId=${accountId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryRollbackSubscription(externalId: string): Promise<void> {
    try {
      await this.lago.cancelSubscription(externalId, 'skip');
    } catch (error) {
      this.logger.error(
        `Failed to rollback remote subscription externalId=${externalId}: ${getErrorMessage(error)}`,
      );
    }

    try {
      const result =
        await this.subscriptions.cancelLocalSubscription(externalId);
      for (const sub of result.items) {
        try {
          await this.producer.subscriptionCancelled({
            userId: sub.userId,
            subscriptionId: sub.id,
            planCode: sub.planCode,
            reason: 'purchase_rollback',
          });
        } catch (err) {
          this.logger.error(
            `Failed to emit subscriptionCancelled for id=${sub.id}: ${getErrorMessage(err)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to rollback local subscription externalId=${externalId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async handleFailedPurchasePayment(input: {
    walletBlockId: string | null;
    accountId: string | null;
    price: number | null;
    currency: string;
    purchaseType: PurchaseKind | null;
    reason: string;
  }): Promise<void> {
    if (input.walletBlockId) {
      await this.tryCancelWalletBlock(input.walletBlockId);
      await this.tryMarkPaymentCancelled(input.walletBlockId, input.reason);
      return;
    }

    if (!input.accountId || input.price === null || !input.purchaseType) {
      return;
    }

    await this.tryRecordFailedPayment({
      accountId: input.accountId,
      amount: input.price,
      currency: input.currency,
      operation: `${input.purchaseType}_purchase`,
      source: 'wallet',
      reason: input.reason,
    });
  }

  private async tryRecordFailedPayment(
    input: Parameters<PaymentLedgerService['createFailed']>[0],
  ): Promise<void> {
    try {
      await this.paymentLedger.createFailed(input);
    } catch (error) {
      this.logger.error(
        `Failed to persist failed payment audit: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryRecordCompletedPayment(
    input: Parameters<PaymentLedgerService['createCompleted']>[0],
  ): Promise<void> {
    try {
      await this.paymentLedger.createCompleted(input);
    } catch (error) {
      this.logger.error(
        `Failed to persist completed payment audit: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryMarkPaymentCompleted(walletBlockId: string): Promise<void> {
    try {
      await this.paymentLedger.markCompletedByWalletBlock(walletBlockId);
    } catch (error) {
      this.logger.error(
        `Failed to finalize payment ledger for walletBlockId=${walletBlockId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryMarkPaymentCancelled(
    walletBlockId: string,
    reason?: string,
  ): Promise<void> {
    try {
      await this.paymentLedger.markCancelledByWalletBlock(
        walletBlockId,
        reason,
      );
    } catch (error) {
      this.logger.error(
        `Failed to cancel payment ledger for walletBlockId=${walletBlockId}: ${getErrorMessage(error)}`,
      );
    }
  }
}
