import { HttpException, Injectable } from '@nestjs/common';
import { Prisma, PaymentTransaction, TransactionStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { normalizeJsonValue } from 'src/shared/utils/json.util';

type PaymentLedgerInput = {
  accountId: string;
  amount: number;
  currency?: string;
  operation: string;
  source: string;
  walletBlockId?: string;
  sagaId?: string;
  buildId?: string;
  batchId?: string;
  metadata?: unknown;
};

type PaymentLedgerFailureInput = PaymentLedgerInput & {
  reason?: string;
};

@Injectable()
export class PaymentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async createPending(input: PaymentLedgerInput): Promise<PaymentTransaction> {
    return await this.prisma.paymentTransaction.create({
      data: {
        accountId: input.accountId,
        amount: this.toDecimal(input.amount),
        currency: input.currency ?? 'USD',
        operation: input.operation,
        source: input.source,
        status: TransactionStatus.PENDING,
        walletBlockId: input.walletBlockId,
        sagaId: input.sagaId,
        buildId: input.buildId,
        batchId: input.batchId,
        metadata: normalizeJsonValue(
          input.metadata,
          'Payment metadata must be valid JSON',
        ),
      },
    });
  }

  async createCompleted(
    input: PaymentLedgerInput,
  ): Promise<PaymentTransaction> {
    return await this.prisma.paymentTransaction.create({
      data: {
        accountId: input.accountId,
        amount: this.toDecimal(input.amount),
        currency: input.currency ?? 'USD',
        operation: input.operation,
        source: input.source,
        status: TransactionStatus.COMPLETED,
        walletBlockId: input.walletBlockId,
        sagaId: input.sagaId,
        buildId: input.buildId,
        batchId: input.batchId,
        metadata: normalizeJsonValue(
          input.metadata,
          'Payment metadata must be valid JSON',
        ),
        completedAt: new Date(),
      },
    });
  }

  async createFailed(
    input: PaymentLedgerFailureInput,
  ): Promise<PaymentTransaction> {
    return await this.prisma.paymentTransaction.create({
      data: {
        accountId: input.accountId,
        amount: this.toDecimal(input.amount),
        currency: input.currency ?? 'USD',
        operation: input.operation,
        source: input.source,
        status: TransactionStatus.FAILED,
        walletBlockId: input.walletBlockId,
        sagaId: input.sagaId,
        buildId: input.buildId,
        batchId: input.batchId,
        metadata: this.withReason(
          normalizeJsonValue(
            input.metadata,
            'Payment metadata must be valid JSON',
          ),
          input.reason,
        ),
        failedAt: new Date(),
      },
    });
  }

  async markCompletedByWalletBlock(
    walletBlockId: string,
  ): Promise<PaymentTransaction | null> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { walletBlockId },
    });

    if (!payment) {
      return null;
    }

    if (payment.status !== TransactionStatus.PENDING) {
      return payment;
    }

    return await this.prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        status: TransactionStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  }

  async markCancelledByWalletBlock(
    walletBlockId: string,
    reason?: string,
  ): Promise<PaymentTransaction | null> {
    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { walletBlockId },
    });

    if (!payment) {
      return null;
    }

    if (payment.status !== TransactionStatus.PENDING) {
      return payment;
    }

    return await this.prisma.paymentTransaction.update({
      where: { id: payment.id },
      data: {
        status: TransactionStatus.CANCELLED,
        cancelledAt: new Date(),
        metadata: this.withReason(payment.metadata, reason),
      },
    });
  }

  private toDecimal(amount: number): Prisma.Decimal {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new HttpException(
        'Payment amount must be a non-negative number',
        400,
      );
    }

    return new Prisma.Decimal(Number(amount.toFixed(2)));
  }

  private withReason(
    metadata: Prisma.JsonValue | Prisma.InputJsonValue | null | undefined,
    reason?: string,
  ): Prisma.InputJsonValue | undefined {
    if (!reason) {
      return metadata ?? undefined;
    }

    const base =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Prisma.JsonObject)
        : {};

    return {
      ...base,
      reason,
    };
  }
}
