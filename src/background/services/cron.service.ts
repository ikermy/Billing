// src/background/background-tasks.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/shared/services/prisma.service';
import { LagoService } from 'src/shared/services/lago.service';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { RedisService } from '../../shared/services/redis.service';
import { SagaService } from 'src/billing/saga.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  private readonly cacheTtlSeconds = 15 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lago: LagoService,
    private readonly producer: BillingProducer,
    private readonly redis: RedisService,
    private readonly saga: SagaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async terminateExpiredSubscriptions() {
    try {
      const { count } = await this.lago.terminateExpiredSubscriptions(
        async (subscription) => {
          await this.producer.subscriptionTerminated(subscription);
        },
      );
      this.logger.log(`Terminated ${count} expired subscriptions.`);
    } catch (error) {
      this.logger.error('Error terminating expired subscriptions', error);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async renewProducts() {
    try {
      const products = await this.prisma.product.findMany();
      for (const product of products) {
        await this.redis.set(
          `product:${product.id}`,
          product,
          this.cacheTtlSeconds,
        );
      }
    } catch (error) {
      this.logger.error('Error renewing products', error);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async renewPlans() {
    try {
      const { plans } = await this.lago.getPlans();
      for (const plan of plans) {
        await this.redis.set(
          `lago:plan:${plan.code}`,
          plan,
          this.cacheTtlSeconds,
        );
      }
    } catch (error) {
      this.logger.error('Error renewing plans', error);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async renewCoupons() {
    try {
      const { coupons } = await this.lago.getCoupons();
      for (const coupon of coupons) {
        await this.redis.set(
          `lago:coupon:${coupon.code}`,
          coupon,
          this.cacheTtlSeconds,
        );
      }
    } catch (error) {
      this.logger.error('Error renewing coupons', error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async terminateExpiredCoupons() {
    try {
      const { count } = await this.lago.terminateExpiredCoupons(
        async (coupon) => {
          await this.producer.couponTerminated(coupon);
        },
      );
      this.logger.log(`Terminated ${count} expired coupons.`);
    } catch (error) {
      this.logger.error('Error terminating expired coupons', error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredSagas() {
    try {
      const count = await this.saga.expirePendingSagas();
      if (count > 0) {
        this.logger.warn(`Expired and cancelled ${count} pending sagas.`);
      }
    } catch (error) {
      this.logger.error('Error cleaning up expired sagas', error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupExpiredSubscriptions() {
    try {
      const result = await this.subscriptions.expireEndedSubscriptions();
      if (result.count > 0) {
        this.logger.warn(`Expired ${result.count} local subscriptions.`);
        for (const sub of result.items) {
          try {
            await this.producer.subscriptionExpired({
              userId: sub.userId,
              subscriptionId: sub.id,
              planCode: sub.planCode,
            });
          } catch (err) {
            this.logger.error(
              `Failed to emit subscriptionExpired for id=${sub.id}`,
              err,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error('Error cleaning up expired subscriptions', error);
    }
  }
}
