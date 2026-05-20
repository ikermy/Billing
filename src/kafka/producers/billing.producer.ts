import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import {
  CouponObject,
  SubscriptionObject,
  SubscriptionObjectExtended,
} from 'lago-javascript-client';
import { lastValueFrom } from 'rxjs';
import { getErrorMessage } from 'src/shared/utils/error.util';

type BillingEventPayload = object;
type PurchaseKind = 'credits' | 'package' | 'subscription';

@Injectable()
export class BillingProducer implements OnModuleInit {
  private readonly logger = new Logger(BillingProducer.name);
  private readonly enabled = process.env.KAFKA_ENABLED === 'true';
  private connected = false;

  private readonly topics = {
    purchaseSuccess: 'billing.purchase.success',
    purchaseFailed: 'billing.purchase.failed',
    subscriptionTerminated: 'billing.subscription.terminated',
    couponTerminated: 'billing.coupon.terminated',
    paymentCompleted: 'billing.payment.completed',
    paymentFailed: 'billing.payment.failed',
    creditsPurchased: 'billing.credits.purchased',
    packagePurchased: 'billing.package.purchased',
    subscriptionCreated: 'billing.subscription.created',
    referralsPurchase: 'referrals.purchase',
    sagaCompleted: 'billing.saga.completed',
    sagaCancelled: 'billing.saga.cancelled',
    creditsCharged: 'billing.credits.charged',
    creditsEmpty: 'billing.credits.empty',
    subscriptionRenewed: 'billing.subscription.renewed',
    subscriptionCreditsUsed: 'billing.subscription.credits_used',
    subscriptionCancelled: 'billing.subscription.cancelled',
    subscriptionExpired: 'billing.subscription.expired',
  };

  constructor(@Inject('KAFKA_BILLING') private readonly client: ClientKafka) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Kafka producer disabled via KAFKA_ENABLED !== "true"');
      return;
    }
    try {
      await this.client.connect();
      this.connected = true;
      this.logger.log('Kafka billing producer connected');
    } catch (error: unknown) {
      this.connected = false;
      this.logger.error(
        `Kafka producer connect failed: ${getErrorMessage(error)}`,
      );
    }
  }

  private canEmit(): boolean {
    if (!this.enabled) {
      return false;
    }

    return Boolean(this.client && this.connected);
  }

  async purchaseSuccess(data: {
    userId: string;
    credits: number | null;
    price: number | null;
    subscription?: SubscriptionObjectExtended;
  }): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping purchaseSuccess emit because Kafka producer is not ready',
      );
      return;
    }

    await this.emit(this.topics.purchaseSuccess, null, data, {
      eventType: this.topics.purchaseSuccess,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async purchaseFailed(data: {
    userId: string;
    credits: number | null;
    price: number | null;
    subscription?: SubscriptionObjectExtended | null;
  }): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping purchaseFailed emit because Kafka producer is not ready',
      );
      return;
    }

    await this.emit(this.topics.purchaseFailed, null, data, {
      eventType: this.topics.purchaseFailed,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }
  async subscriptionTerminated(
    subscription: SubscriptionObject,
  ): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping subscriptionTerminated emit because Kafka producer is not ready',
      );
      return;
    }
    try {
      await this.emit(
        this.topics.subscriptionTerminated,
        subscription.lago_id,
        subscription,
        {
          eventType: this.topics.subscriptionTerminated,
          source: 'billing-service',
          timestamp: Date.now().toString(),
        },
      );
    } catch (error) {
      this.logger.error(
        `Emit failed for subscription terminated event: ${getErrorMessage(error)}`,
      );
    }
  }

  async couponTerminated(coupon: CouponObject): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping couponTerminated emit because Kafka producer is not ready',
      );
      return;
    }
    try {
      await this.emit(this.topics.couponTerminated, coupon.lago_id, coupon, {
        eventType: this.topics.couponTerminated,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      });
    } catch (error) {
      this.logger.error(
        `Emit failed for coupon terminated event: ${getErrorMessage(error)}`,
      );
    }
  }

  async paymentCompleted(data: {
    userId: string;
    amount: number;
    currency: string;
    operation: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping paymentCompleted emit because Kafka producer is not ready',
      );
      return;
    }

    await this.emit(this.topics.paymentCompleted, null, data, {
      eventType: this.topics.paymentCompleted,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async paymentFailed(data: {
    userId: string;
    amount: number | null;
    currency: string;
    operation: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping paymentFailed emit because Kafka producer is not ready',
      );
      return;
    }

    await this.emit(this.topics.paymentFailed, null, data, {
      eventType: this.topics.paymentFailed,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async purchaseRecorded(data: {
    userId: string;
    purchaseType: PurchaseKind;
    amount: number;
    currency: string;
    units?: number | null;
    planCode?: string;
    referrerId?: string;
  }): Promise<void> {
    const topic =
      data.purchaseType === 'credits'
        ? this.topics.creditsPurchased
        : data.purchaseType === 'package'
          ? this.topics.packagePurchased
          : this.topics.subscriptionCreated;

    if (!this.canEmit()) {
      this.logger.warn(
        `Skipping ${data.purchaseType} purchase emit because Kafka producer is not ready`,
      );
      return;
    }

    await this.emit(topic, null, data, {
      eventType: topic,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });

    await this.emit(this.topics.referralsPurchase, null, data, {
      eventType: this.topics.referralsPurchase,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  // ─── New events (ТЗ 13.2) ────────────────────────────────────────────────

  async sagaCompleted(data: {
    sagaId: string;
    userId: string;
    capturedUnits: number;
    buildId?: string;
    batchId?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(this.topics.sagaCompleted, data.sagaId, data, {
      eventType: this.topics.sagaCompleted,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async sagaCancelled(data: {
    sagaId: string;
    userId: string;
    reason?: string;
    buildId?: string;
    batchId?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(this.topics.sagaCancelled, data.sagaId, data, {
      eventType: this.topics.sagaCancelled,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async creditsCharged(data: {
    userId: string;
    accountId: string;
    creditType: string;
    amount: number;
    operation: string;
    buildId?: string;
    batchId?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(this.topics.creditsCharged, null, data, {
      eventType: this.topics.creditsCharged,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async creditsEmpty(data: {
    userId: string;
    accountId: string;
    creditType: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(this.topics.creditsEmpty, null, data, {
      eventType: this.topics.creditsEmpty,
      source: 'billing-service',
      timestamp: Date.now().toString(),
    });
  }

  async subscriptionRenewed(data: {
    userId: string;
    subscriptionId: string;
    planCode: string;
    creditsAllocated: number;
    periodStart: string;
    periodEnd: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(
      this.topics.subscriptionRenewed,
      data.subscriptionId,
      data,
      {
        eventType: this.topics.subscriptionRenewed,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      },
    );
  }

  async subscriptionCreditsUsed(data: {
    userId: string;
    subscriptionId: string;
    unitsUsed: number;
    creditsRemaining: number;
    buildId?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(
      this.topics.subscriptionCreditsUsed,
      data.subscriptionId,
      data,
      {
        eventType: this.topics.subscriptionCreditsUsed,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      },
    );
  }

  async subscriptionCancelled(data: {
    userId: string;
    subscriptionId: string;
    planCode?: string;
    reason?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(
      this.topics.subscriptionCancelled,
      data.subscriptionId,
      data,
      {
        eventType: this.topics.subscriptionCancelled,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      },
    );
  }

  async subscriptionExpired(data: {
    userId: string;
    subscriptionId: string;
    planCode?: string;
  }): Promise<void> {
    if (!this.canEmit()) return;
    await this.emit(
      this.topics.subscriptionExpired,
      data.subscriptionId,
      data,
      {
        eventType: this.topics.subscriptionExpired,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      },
    );
  }

  // ─────────────────────────────────────────────────────────────────────────

  async emit<T extends BillingEventPayload>(
    topic: string,
    key: string | null,
    payload: T,
    headers: Record<string, string>,
  ): Promise<void> {
    if (!this.canEmit()) {
      return;
    }

    const eventHeaders = key
      ? { ...headers, 'idempotency-key': key }
      : { ...headers };

    try {
      await lastValueFrom(
        this.client.emit(topic, {
          key: key,
          value: JSON.stringify({ ...payload, transactionId: key }),
          headers: eventHeaders,
        }),
      );
      this.logger.debug(`Emitted event "${topic}" with key=${key ?? 'null'}`);
    } catch (error) {
      this.logger.error(
        `Emit failed for topic="${topic}": ${getErrorMessage(error)}`,
      );
      throw error;
    }
  }
}
