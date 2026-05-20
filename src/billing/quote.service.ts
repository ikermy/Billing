import { Injectable } from '@nestjs/common';
import { CreditType } from '@prisma/client';
import {
  QuoteRequestDto,
  QuoteResponseDto,
  ShortfallDto,
} from './dto/quote.dto';
import {
  WalletBalance,
  WalletBalanceService,
} from 'src/shared/services/wallet-balance.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { PricingService } from 'src/shared/services/pricing.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

/** Normalised internal result – extended with wallet/currency meta for SagaService */
export interface IQuoteResult extends QuoteResponseDto {
  /** wallet currency from WalletBalance */
  currency: string;
  /** total wallet cost in currency units */
  totalWalletCost: number;
}

@Injectable()
export class QuoteService {
  constructor(
    private readonly wallet: WalletBalanceService,
    private readonly creditLedger: CreditLedgerService,
    private readonly pricing: PricingService,
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async quote(request: QuoteRequestDto): Promise<IQuoteResult> {
    // Resolve effective count (BFF sends `units`; legacy callers use `count`)
    const requestedUnits: number = request.units ?? request.count ?? 1;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const creditType: CreditType = request.creditType ?? CreditType.BARCODE;
    const product = request.context?.product ?? 'default';
    const revision = request.context?.revision ?? request.revision ?? '';

    const pricing = await this.pricing.getPricing(
      product,
      requestedUnits,
      revision,
    );

    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    const account = request.userId
      ? await this.prisma.account.findUnique({
          where: { userId: request.userId },
        })
      : null;
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

    let subscriptionUsed = 0;
    let subscriptionRemaining = 0;
    let creditsUsed = 0;
    let creditsRemaining = 0;
    let remaining = requestedUnits;

    if (account) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
      const accountId = account.id;
      const subResult = await this.resolveSubscriptionUsage(
        accountId,
        creditType,
        remaining,
      );
      subscriptionUsed = subResult.used;
      subscriptionRemaining = subResult.remaining;
      remaining -= subscriptionUsed;

      const credResult = await this.resolveCreditUsage(
        accountId,
        creditType,
        remaining,
      );
      creditsUsed = credResult.used;
      creditsRemaining = credResult.remaining;
      remaining -= creditsUsed;
    }

    const walletUsage = await this.resolveWalletUsage(
      request,
      creditType,
      pricing.unitPrice,
      pricing.currency,
      remaining,
    );
    remaining -= walletUsage.units;

    const allowedTotal = subscriptionUsed + creditsUsed + walletUsage.units;
    const insufficientUnits = Math.max(0, remaining);

    const shortfall: ShortfallDto | undefined =
      insufficientUnits > 0
        ? {
            units: insufficientUnits,
            amountRequired: Number(
              (insufficientUnits * pricing.unitPrice).toFixed(2),
            ),
          }
        : undefined;

    return {
      canProcess: allowedTotal > 0,
      partial: allowedTotal < requestedUnits && allowedTotal > 0,
      requested: requestedUnits,
      allowedTotal,
      unitPrice: pricing.unitPrice,
      bySource: {
        subscription: {
          units: subscriptionUsed,
          remaining: subscriptionRemaining,
        },
        credits: {
          units: creditsUsed,
          remaining: creditsRemaining,
        },
        wallet: {
          units: walletUsage.units,
          amount: walletUsage.totalCost,
        },
      },
      shortfall,
      // Extended internal meta
      currency: walletUsage.currency,
      totalWalletCost: walletUsage.totalCost,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async resolveSubscriptionUsage(
    accountId: string,
    creditType: CreditType,
    remaining: number,
  ): Promise<{ used: number; remaining: number }> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (creditType !== CreditType.BARCODE || remaining <= 0) {
      return { used: 0, remaining: 0 };
    }

    const availability =
      await this.subscriptions.getRemainingCredits(accountId);
    if (!availability.subscription) {
      return { used: 0, remaining: 0 };
    }

    const used = Math.min(remaining, availability.remaining);
    return { used, remaining: availability.remaining - used };
  }

  private async resolveCreditUsage(
    accountId: string,
    creditType: CreditType,
    remaining: number,
  ): Promise<{ used: number; remaining: number }> {
    if (remaining <= 0) {
      return { used: 0, remaining: 0 };
    }

    const available = await this.creditLedger.getAvailableCredits(
      accountId,
      creditType,
    );
    const used = Math.min(remaining, available);
    return { used, remaining: available - used };
  }

  private async resolveWalletUsage(
    request: QuoteRequestDto,
    creditType: CreditType,
    unitPrice: number,
    defaultCurrency: string,
    remaining: number,
  ): Promise<{ units: number; totalCost: number; currency: string }> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (creditType !== CreditType.BARCODE) {
      return { units: 0, totalCost: 0, currency: defaultCurrency };
    }
    if (process.env.ENABLE_WATERFALL_WALLET !== 'true') {
      return { units: 0, totalCost: 0, currency: defaultCurrency };
    }
    if (!request.userId || remaining <= 0) {
      return { units: 0, totalCost: 0, currency: defaultCurrency };
    }

    const balance = await this.wallet.getBalance(request.userId);
    const affordableUnits = this.getAffordableWalletUnits(balance, unitPrice);
    const walletUnits = Math.min(remaining, affordableUnits);

    return {
      units: walletUnits,
      totalCost: Number((walletUnits * unitPrice).toFixed(2)),
      currency: balance.currency,
    };
  }

  private getAffordableWalletUnits(
    balance: WalletBalance,
    unitPrice: number,
  ): number {
    if (unitPrice <= 0) return 0;
    return Math.max(0, Math.floor(balance.available / unitPrice));
  }
}
