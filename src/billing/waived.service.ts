import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { RedisService } from 'src/shared/services/redis.service';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';
import { BillingMetricsService } from 'src/shared/services/billing-metrics.service';
import {
  WaivedCheckRequestDto,
  WaivedCheckResponseDto,
} from './dto/waived.dto';

type WaivedOperationPayload = {
  userId: string;
  operation: string;
  generationId?: string;
};

@Injectable()
export class WaivedService {
  private readonly logger = new Logger(WaivedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly billingConfig: BillingConfigService,
    private readonly producer: BillingProducer,
    private readonly paymentLedger: PaymentLedgerService,
    private readonly metrics: BillingMetricsService,
  ) {}

  async checkAndReserve(
    request: WaivedCheckRequestDto,
  ): Promise<WaivedCheckResponseDto> {
    const limit = await this.billingConfig.getWaivedLimit();
    const ttlSeconds = await this.billingConfig.getWaivedWindowSeconds();
    const result = await this.redis.checkAndIncrementLimit(
      this.getKey(request.userId, request.operation),
      limit,
      ttlSeconds,
    );

    if (result.allowed) {
      this.metrics.incWaivedOperation(request.operation);
    } else {
      this.metrics.incWaivedLimitExceeded(request.operation);
    }

    return {
      allowed: result.allowed,
      currentCount: result.currentCount,
      limit,
      resetsAt: new Date(
        Date.now() + Math.max(result.ttlSeconds, 1) * 1000,
      ).toISOString(),
    };
  }

  async complete(request: WaivedOperationPayload): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const account: { id: string } | null = await this.prisma.account.findUnique(
      {
        where: { userId: request.userId },
      },
    );

    if (account) {
      try {
        await this.paymentLedger.createCompleted({
          accountId: account.id,
          amount: 0,
          currency: 'USD',
          operation: `${request.operation}_waived`,
          source: 'waived',
          metadata: {
            waived: true,
            generationId: request.generationId,
          },
        });
      } catch (error) {
        this.logger.error(
          `Failed to persist waived payment audit for userId=${request.userId}: ${getErrorMessage(error)}`,
        );
      }
    }

    await this.producer.paymentCompleted({
      userId: request.userId,
      amount: 0,
      currency: 'USD',
      operation: `${request.operation}_waived`,
      metadata: {
        waived: true,
        generationId: request.generationId,
      },
    });
  }

  async release(userId: string, operation: string): Promise<void> {
    await this.redis.decrementIfPositive(this.getKey(userId, operation));
  }

  private getKey(userId: string, operation: string): string {
    return `billing:waived:${operation}:${userId}`;
  }
}
