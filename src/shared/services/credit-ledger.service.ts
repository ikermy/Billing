import { HttpException, Injectable, Logger } from '@nestjs/common';
import {
  CreditBalance,
  CreditOperation,
  CreditType,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { PrismaService } from './prisma.service';

type CreditMutationInput = {
  accountId: string;
  creditType: CreditType;
  amount: number;
  operation: CreditOperation;
  buildId?: string;
  batchId?: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class CreditLedgerService {
  private readonly logger = new Logger(CreditLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ensureAccountBalances(accountId: string): Promise<void> {
    await this.prisma.creditBalance.createMany({
      data: [CreditType.BARCODE, CreditType.AI].map((creditType) => ({
        accountId,
        creditType,
      })),
      skipDuplicates: true,
    });
  }

  async getBalance(
    accountId: string,
    creditType: CreditType,
  ): Promise<CreditBalance> {
    await this.ensureAccountBalances(accountId);

    return await this.prisma.creditBalance.findUniqueOrThrow({
      where: {
        accountId_creditType: {
          accountId,
          creditType,
        },
      },
    });
  }

  async getAvailableCredits(
    accountId: string,
    creditType: CreditType,
  ): Promise<number> {
    const balance = await this.getBalance(accountId, creditType);
    return Math.max(0, balance.balance - balance.reserved);
  }

  async getAllBalances(
    accountId: string,
  ): Promise<Record<CreditType, CreditBalance>> {
    await this.ensureAccountBalances(accountId);

    const balances = await this.prisma.creditBalance.findMany({
      where: { accountId },
    });

    const barcode =
      balances.find((item) => item.creditType === CreditType.BARCODE) ??
      (await this.getBalance(accountId, CreditType.BARCODE));
    const ai =
      balances.find((item) => item.creditType === CreditType.AI) ??
      (await this.getBalance(accountId, CreditType.AI));

    return {
      [CreditType.BARCODE]: barcode,
      [CreditType.AI]: ai,
    };
  }

  async addCredits(input: CreditMutationInput): Promise<CreditBalance> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const balance = await tx.creditBalance.update({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
        data: {
          balance: {
            increment: input.amount,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: input.amount,
          balanceAfter: balance.balance,
          operation: input.operation,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.COMPLETED,
          metadata: input.metadata,
        },
      });

      this.logger.log(
        `Added ${input.amount} ${input.creditType} credits to accountId=${input.accountId}`,
      );

      return balance;
    });
  }

  async reserveCredits(
    input: CreditMutationInput,
  ): Promise<CreditBalance | null> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "CreditBalance"
        SET "reserved" = "reserved" + ${input.amount},
            "updatedAt" = NOW()
        WHERE "accountId" = ${input.accountId}
          AND "creditType" = ${input.creditType}::"CreditType"
          AND ("balance" - "reserved") >= ${input.amount}
      `;

      if (updated === 0) {
        return null;
      }

      const balance = await tx.creditBalance.findUniqueOrThrow({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: input.amount,
          balanceAfter: balance.balance,
          operation: input.operation,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.PENDING,
          metadata: input.metadata,
        },
      });

      return balance;
    });
  }

  async chargeCredits(
    input: CreditMutationInput,
  ): Promise<CreditBalance | null> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "CreditBalance"
        SET "balance" = "balance" - ${input.amount},
            "updatedAt" = NOW()
        WHERE "accountId" = ${input.accountId}
          AND "creditType" = ${input.creditType}::"CreditType"
          AND ("balance" - "reserved") >= ${input.amount}
      `;

      if (updated === 0) {
        return null;
      }

      const balance = await tx.creditBalance.findUniqueOrThrow({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: input.amount,
          balanceAfter: balance.balance,
          operation: input.operation,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.COMPLETED,
          metadata: input.metadata,
        },
      });

      this.logger.log(
        `Charged ${input.amount} ${input.creditType} credits from accountId=${input.accountId}`,
      );

      return balance;
    });
  }

  async refundGrantedCredits(
    input: Omit<CreditMutationInput, 'operation'>,
  ): Promise<CreditBalance | null> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.creditBalance.updateMany({
        where: {
          accountId: input.accountId,
          creditType: input.creditType,
          balance: {
            gte: input.amount,
          },
        },
        data: {
          balance: {
            decrement: input.amount,
          },
        },
      });

      if (updated.count === 0) {
        return null;
      }

      const balance = await tx.creditBalance.findUniqueOrThrow({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: -input.amount,
          balanceAfter: balance.balance,
          operation: CreditOperation.REFUND,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.COMPLETED,
          metadata: input.metadata,
        },
      });

      this.logger.warn(
        `Refunded previously granted ${input.amount} ${input.creditType} credits from accountId=${input.accountId}`,
      );

      return balance;
    });
  }

  async commitReservedCredits(
    input: CreditMutationInput,
  ): Promise<CreditBalance | null> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.creditBalance.updateMany({
        where: {
          accountId: input.accountId,
          creditType: input.creditType,
          reserved: {
            gte: input.amount,
          },
          balance: {
            gte: input.amount,
          },
        },
        data: {
          reserved: {
            decrement: input.amount,
          },
          balance: {
            decrement: input.amount,
          },
        },
      });

      if (updated.count === 0) {
        return null;
      }

      const balance = await tx.creditBalance.findUniqueOrThrow({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: input.amount,
          balanceAfter: balance.balance,
          operation: input.operation,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.COMPLETED,
          metadata: input.metadata,
        },
      });

      return balance;
    });
  }

  async releaseReservedCredits(
    input: CreditMutationInput,
  ): Promise<CreditBalance | null> {
    this.assertPositiveAmount(input.amount);
    await this.ensureAccountBalances(input.accountId);

    return await this.prisma.$transaction(async (tx) => {
      const updated = await tx.creditBalance.updateMany({
        where: {
          accountId: input.accountId,
          creditType: input.creditType,
          reserved: {
            gte: input.amount,
          },
        },
        data: {
          reserved: {
            decrement: input.amount,
          },
        },
      });

      if (updated.count === 0) {
        return null;
      }

      const balance = await tx.creditBalance.findUniqueOrThrow({
        where: {
          accountId_creditType: {
            accountId: input.accountId,
            creditType: input.creditType,
          },
        },
      });

      await tx.creditTransaction.create({
        data: {
          accountId: input.accountId,
          creditType: input.creditType,
          amount: input.amount,
          balanceAfter: balance.balance,
          operation: input.operation,
          buildId: input.buildId,
          batchId: input.batchId,
          status: TransactionStatus.CANCELLED,
          metadata: input.metadata,
        },
      });

      return balance;
    });
  }

  private assertPositiveAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new HttpException('Credits amount must be a positive integer', 400);
    }
  }
}
