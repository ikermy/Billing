// barcode-events.controller.ts
import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { Barcode } from '../dto/barcode.dto';
import { PrismaService } from 'src/shared/services/prisma.service';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { PricingService } from 'src/shared/services/pricing.service';
import { CreditOperation, CreditType } from '@prisma/client';
import { SubscriptionService } from 'src/shared/services/subscription.service';

@Controller()
export class BarcodeGenConsumer {
  private readonly logger = new Logger(BarcodeGenConsumer.name);
  private readonly legacyBillingEnabled =
    process.env.ENABLE_LEGACY_BARCODE_NEW_BILLING === 'true';

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly creditLedger: CreditLedgerService,
    private readonly wallet: WalletBalanceService,
    private readonly pricing: PricingService,
  ) {}

  @EventPattern('barcode.new')
  async handleGenerated(
    @Payload() data: Barcode,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    if (!this.legacyBillingEnabled) {
      this.logger.debug(
        `[barcode.new] Legacy direct billing disabled, skipping id=${data?.id}`,
      );
      return;
    }

    try {
      const { key, headers } = this.getMeta(context);
      const account = await this.prisma.account.findUnique({
        where: { userId: data.userId },
      });
      if (!account) {
        this.logger.warn(`[barcode.new] No account for userId=${data.userId}`);
        return;
      }

      const chargedWithSubscription =
        await this.subscriptions.consumeIncludedCredits(account.id, 1);
      if (chargedWithSubscription) {
        return;
      }

      const chargedWithCredits = await this.creditLedger.chargeCredits({
        accountId: account.id,
        creditType: CreditType.BARCODE,
        amount: 1,
        operation: CreditOperation.CHARGE,
        buildId: data.id,
        metadata: {
          barcodeType: data.type,
          source: 'barcode.new',
        },
      });

      if (!chargedWithCredits) {
        const amount = await this.pricing.getUnitPriceForBarcodeType(data.type);
        const block = await this.wallet.blockFunds({
          userId: data.userId,
          amount,
          currency: 'USD',
          reason: 'barcode_generation',
          metadata: {
            buildId: data.id,
            barcodeType: data.type,
            source: 'barcode.new',
          },
        });
        await this.wallet.confirmBlock(block.blockId);
      }

      this.logger.log(
        `[barcode.new] key=${key} id=${data?.id} headers=${JSON.stringify(headers)}`,
      );
    } catch (error) {
      this.logger.error(
        `[barcode.new] id=${data?.id} error=${getErrorMessage(error)}`,
      );
    }
  }

  @EventPattern('barcode.edit')
  async handleEdited(
    @Payload() data: Barcode,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    if (!this.legacyBillingEnabled) {
      this.logger.debug(
        `[barcode.edit] Legacy direct billing disabled, skipping id=${data?.id}`,
      );
      return;
    }

    try {
      const { key, headers } = this.getMeta(context);

      const account = await this.prisma.account.findUnique({
        where: { userId: data.userId },
      });

      if (!account) {
        this.logger.warn(`[barcode.edit] No account for userId=${data.userId}`);
        return;
      }

      const isSubscribed = await this.subscriptions.hasCurrentSubscription(
        account.id,
      );
      if (isSubscribed) {
        return;
      } else {
        this.logger.warn(
          `[barcode.edit] User is not subscribed userId=${data.userId}`,
        );
      }

      this.logger.log(
        `[barcode.edit] key=${key} id=${data?.id} headers=${JSON.stringify(headers)}`,
      );
    } catch (error) {
      this.logger.error(
        `[barcode.edit] id=${data?.id} error=${getErrorMessage(error)}`,
      );
    }
  }

  private getMeta(context: KafkaContext): {
    key: string | undefined;
    headers: Record<string, string | undefined>;
  } {
    const message = context.getMessage();
    const key = message.key?.toString();
    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).map(([k, v]) => [k, v?.toString()]),
    );
    return { key, headers };
  }
}
