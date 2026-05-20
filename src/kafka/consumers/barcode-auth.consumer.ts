// barcode-events.controller.ts
import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { LagoService } from 'src/shared/services/lago.service';
import { PrismaService } from 'src/shared/services/prisma.service';
import { User } from '../dto/user.dto';
import { randomUUID } from 'crypto';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';

@Controller()
export class BarcodeAuthConsumer {
  private readonly logger = new Logger(BarcodeAuthConsumer.name);
  constructor(
    private readonly lago: LagoService,
    private readonly prisma: PrismaService,
    private readonly creditLedger: CreditLedgerService,
  ) {}

  @EventPattern('user.new')
  async createAccount(
    @Payload() data: User,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    let customerId: string | null = null;
    let accountId: string | null = null;
    try {
      const { key } = this.getMeta(context);
      const id = randomUUID();
      const customer = await this.lago.createCustomer(id);
      customerId = customer.lago_id;

      await this.prisma.account.create({
        data: {
          id: id,
          userId: data.id,
          lagoCustomerId: customerId,
        },
      });
      accountId = id;
      await this.creditLedger.ensureAccountBalances(id);

      this.logger.log(
        `Account created for userId=${data.id}, customer=${customerId}; key=${key}`,
      );
    } catch {
      this.logger.error(
        `Error creating account for new user with id=${data.id}`,
      );

      if (accountId) {
        try {
          await this.prisma.account.delete({
            where: { id: accountId },
          });
          this.logger.warn(`Rolled back account ${accountId}`);
        } catch (error) {
          this.logger.error(
            `deleteAccount(${accountId}) failed: ${getErrorMessage(error)}`,
          );
        }
      }

      if (customerId) {
        try {
          await this.lago.deleteCustomer(customerId);
          this.logger.warn(`Rolled back Lago customer ${customerId}`);
        } catch (error) {
          this.logger.error(
            `deleteCustomer(${customerId}) failed: ${getErrorMessage(error)}`,
          );
        }
      }
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
