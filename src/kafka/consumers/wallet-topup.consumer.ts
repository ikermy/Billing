import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { BillingProducer } from '../producers/billing.producer';

type WalletTopupCompletedEvent = {
  userId: string;
  walletId?: string;
  amount: number;
  currency: string;
  bonusAmount?: number;
  source?: string;
  transactionId?: string;
  completedAt?: string;
};

/**
 * Consumer for wallet.topup.completed events (ТЗ 13.3).
 * Forwards the event as billing.payment.completed for audit/History service.
 */
@Controller()
export class WalletTopupConsumer {
  private readonly logger = new Logger(WalletTopupConsumer.name);
  private readonly enabled = process.env.KAFKA_ENABLED === 'true';

  constructor(private readonly billingProducer: BillingProducer) {}

  @EventPattern('wallet.topup.completed')
  async handleWalletTopupCompleted(
    @Payload() data: WalletTopupCompletedEvent,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    if (!this.enabled) return;

    const message = context.getMessage();
    const key = message.key?.toString();

    this.logger.log(
      `[wallet.topup.completed] userId=${data.userId} amount=${data.amount} currency=${data.currency ?? 'USD'} key=${key ?? 'null'}`,
    );

    if (!data.userId || !data.amount) {
      this.logger.warn(
        `[wallet.topup.completed] Skipping: missing userId or amount. key=${key ?? 'null'}`,
      );
      return;
    }

    try {
      await this.billingProducer.paymentCompleted({
        userId: data.userId,
        amount: data.amount,
        currency: data.currency ?? 'USD',
        operation: 'wallet_topup_external',
        metadata: {
          source: data.source ?? 'wallet',
          transactionId: data.transactionId,
          bonusAmount: data.bonusAmount ?? 0,
          completedAt: data.completedAt,
        },
      });
    } catch (error) {
      this.logger.error(
        `[wallet.topup.completed] Failed to forward event for userId=${data.userId}: ${getErrorMessage(error)}`,
      );
    }
  }
}
