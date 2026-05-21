import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BillingSaga,
  CreditOperation,
  CreditType,
  Prisma,
  SagaStatus,
  SubscriptionStatus,
  TransactionStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/shared/services/prisma.service';
import { CreditLedgerService } from 'src/shared/services/credit-ledger.service';
import { WalletBalanceService } from 'src/shared/services/wallet-balance.service';
import { RedisService } from 'src/shared/services/redis.service';
import { BillingConfigService } from 'src/shared/services/billing-config.service';
import { SubscriptionService } from 'src/shared/services/subscription.service';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { PaymentLedgerService } from 'src/shared/services/payment-ledger.service';
import { BillingProducer } from 'src/kafka/producers/billing.producer';
import { BillingMetricsService } from 'src/shared/services/billing-metrics.service';
import { QuoteService } from './quote.service';
import { BlockRequestDto, BlockResponseDto } from './dto/block.dto';
import { QuoteSource } from './dto/quote.dto';

// ─── DTOs for new BFF endpoints ──────────────────────────────────────────────

export class CaptureRequestDto {
  sagaId: string;
  units: number;
}

export class ReleaseRequestDto {
  sagaId: string;
  /** BFF may send units for the unreleased remainder */
  units?: number;
  /** optional backward-compatible reason */
  reason?: string;
}

export class BlockBatchRequestDto {
  userId: string;
  count: number;
  batchId: string;
}

export class BlockBatchResponseDto {
  transactionIds: string[];
}

export type CaptureResponseDto = {
  sagaId: string;
  capturedUnits: number;
  status: string;
};

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SagaService {
  private readonly logger = new Logger(SagaService.name);
  private readonly defaultTtlMinutes = 5;
  private readonly finalizeLockTtlSeconds = 30;

  constructor(
    private readonly prisma: PrismaService,
    private readonly quoteService: QuoteService,
    private readonly creditLedger: CreditLedgerService,
    private readonly wallet: WalletBalanceService,
    private readonly redis: RedisService,
    private readonly billingConfig: BillingConfigService,
    private readonly subscriptions: SubscriptionService,
    private readonly paymentLedger: PaymentLedgerService,
    private readonly billingProducer: BillingProducer,
    private readonly metrics: BillingMetricsService,
  ) {}

  // ─── Block (Saga Phase 1) ─────────────────────────────────────────────────

  async block(request: BlockRequestDto): Promise<BlockResponseDto> {
    const account = await this.prisma.account.findUnique({
      where: { userId: request.userId },
    });
    if (!account) throw new NotFoundException('Account not found');

    // If units == 0, it's a free edit (Waived flow) – no saga needed
    if (request.units === 0) {
      const freeId = request.sagaId ?? randomUUID();
      return {
        sagaId: freeId,
        blocked: { subscription: 0, credits: 0, wallet: 0 },
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    }

    const effectiveCreditType = request.creditType ?? CreditType.BARCODE;
    const effectiveOperation = request.operation ?? 'generate';

    await this.ensureNoDuplicateSaga(request);

    const reservation = await this.resolveBlockReservation(
      request,
      effectiveCreditType,
    );

    let walletBlockId: string | null = null;
    const rollbackActions: Array<() => Promise<void>> = [];

    try {
      if (reservation.walletAmount > 0) {
        const walletBlock = await this.wallet.blockFunds({
          userId: request.userId,
          amount: reservation.walletAmount,
          currency: reservation.currency,
          reason: effectiveOperation,
          metadata: {
            buildId: request.buildId,
            batchId: request.batchId,
            units: request.units,
            product: request.context?.product,
            revision: request.context?.revision,
          },
        });
        walletBlockId = walletBlock.blockId;
        rollbackActions.push(async () => {
          await this.tryCancelWalletBlock(walletBlock.blockId);
        });
      }

      // Use BFF-provided sagaId or generate a new one
      const sagaId = request.sagaId ?? randomUUID();
      const expiresAt = await this.getExpiresAt(request.ttl);
      const saga = await this.prisma.$transaction(
        async (tx) => {
          const subscriptionId = await this.reserveSubscriptionInTx(
            tx,
            account.id,
            reservation.subscriptionAmount,
          );
          await this.reserveCreditsInTx(tx, {
            accountId: account.id,
            creditType: effectiveCreditType,
            amount: reservation.creditsAmount,
            operation: CreditOperation.BLOCK,
            buildId: request.buildId,
            batchId: request.batchId,
            metadata: {
              operation: effectiveOperation,
              source: 'internal.block',
            },
          });

          return await tx.billingSaga.create({
            data: {
              id: sagaId,
              accountId: account.id,
              subscriptionId,
              subscriptionAmount: reservation.subscriptionAmount,
              creditsAmount: reservation.creditsAmount,
              creditType:
                reservation.creditsAmount > 0 ? effectiveCreditType : null,
              walletBlockId,
              walletAmount: new Prisma.Decimal(reservation.walletAmount),
              status: SagaStatus.PENDING,
              operation: effectiveOperation,
              buildId: request.buildId,
              batchId: request.batchId,
              expiresAt,
              metadata: {
                requestAmount: request.units,
                product: request.context?.product,
                revision: request.context?.revision,
                pricing: {
                  unitPrice: reservation.unitPrice,
                  currency: reservation.currency,
                  totalCost: reservation.walletAmount,
                },
                bySource: {
                  subscription: reservation.subscriptionAmount,
                  credits: reservation.creditsAmount,
                  wallet: reservation.walletAmount,
                },
              },
            },
          });
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      if (reservation.subscriptionAmount > 0 && saga.subscriptionId) {
        rollbackActions.push(async () => {
          await this.tryReleaseSubscription(
            saga.subscriptionId,
            reservation.subscriptionAmount,
          );
        });
      }
      if (reservation.creditsAmount > 0) {
        rollbackActions.push(async () => {
          await this.tryReleaseCredits(
            account.id,
            effectiveCreditType,
            reservation.creditsAmount,
          );
        });
      }

      if (reservation.walletAmount > 0 && walletBlockId) {
        await this.paymentLedger.createPending({
          accountId: account.id,
          amount: reservation.walletAmount,
          currency: reservation.currency,
          operation: effectiveOperation,
          source: 'wallet',
          walletBlockId,
          sagaId: saga.id,
          buildId: request.buildId,
          batchId: request.batchId,
          metadata: { requestAmount: request.units, source: 'saga.block' },
        });
      }

      this.metrics.incSagaBlock(request.units === 0 ? 'free' : 'success');
      return this.toBlockResponse(saga);
    } catch (error) {
      for (const rollback of [...rollbackActions].reverse()) {
        await rollback();
      }
      this.metrics.incSagaBlock('failed');
      throw error;
    }
  }

  // ─── Capture (BFF calls instead of complete) ─────────────────────────────

  async capture(sagaId: string, units: number): Promise<CaptureResponseDto> {
    return (await this.withSagaFinalizationLock(sagaId, async () => {
      const saga = await this.getSagaOrThrow(sagaId);

      if (saga.status === SagaStatus.COMPLETED) {
        return { sagaId: saga.id, capturedUnits: units, status: saga.status };
      }
      if (saga.status !== SagaStatus.PENDING) {
        this.logger.warn(
          `Ignoring capture for saga id=${sagaId} because status=${saga.status}`,
        );
        return { sagaId: saga.id, capturedUnits: 0, status: saga.status };
      }

      const metadata = saga.metadata as Record<string, unknown> | null;
      const requestAmount: number =
        (metadata?.requestAmount as number | undefined) ?? units;

      if (units >= requestAmount) {
        // Full capture – same as original completeSaga
        const completed = await this.completePendingSaga(saga);
        this.metrics.incSagaConfirm(false);
        await this.tryEmitSagaCompleted(completed, units);
        return {
          sagaId: completed.id,
          capturedUnits: units,
          status: completed.status,
        };
      }

      // ── Partial capture (Waterfall) ────────────────────────────────────────
      let remaining = Math.max(0, units);
      const subCapture = Math.min(saga.subscriptionAmount, remaining);
      remaining -= subCapture;
      const credCapture = Math.min(saga.creditsAmount, remaining);
      remaining -= credCapture;

      const unitPrice: number =
        ((metadata?.pricing as Record<string, unknown> | undefined)
          ?.unitPrice as number | undefined) ?? 0;
      // Integer-cents arithmetic to avoid float precision loss
      const walletCaptureCents = Math.round(remaining * unitPrice * 100);
      const walletCapture = walletCaptureCents / 100;
      const sagaWalletCents = Math.round(Number(saga.walletAmount) * 100);
      const walletRelease =
        Math.max(0, sagaWalletCents - walletCaptureCents) / 100;

      const subRelease = saga.subscriptionAmount - subCapture;
      const credRelease = saga.creditsAmount - credCapture;

      // 1. Wallet: cancel existing block and recharge exact amount if needed
      if (saga.walletBlockId) {
        await this.wallet.cancelBlock(saga.walletBlockId);
        await this.tryMarkPaymentCancelled(
          saga.walletBlockId,
          'partial_capture_adjustment',
        );

        if (walletCapture > 0) {
          // Fetch account to get userId for wallet API
          const account = await this.prisma.account.findUnique({
            where: { id: saga.accountId },
          });
          if (account) {
            const newBlock = await this.wallet.blockFunds({
              userId: account.userId,
              amount: walletCapture,
              currency:
                ((metadata?.pricing as Record<string, unknown> | undefined)
                  ?.currency as string) ?? 'USD',
              reason: saga.operation ?? 'capture',
              metadata: { sagaId: saga.id, source: 'partial_capture' },
            });
            await this.wallet.confirmBlock(newBlock.blockId);
            await this.paymentLedger.createCompleted({
              accountId: saga.accountId,
              amount: walletCapture,
              currency:
                ((metadata?.pricing as Record<string, unknown> | undefined)
                  ?.currency as string) ?? 'USD',
              operation: saga.operation ?? 'capture',
              source: 'wallet',
              walletBlockId: newBlock.blockId,
              sagaId: saga.id,
              buildId: saga.buildId ?? undefined,
              batchId: saga.batchId ?? undefined,
              metadata: { source: 'partial_capture' },
            });
          }
        }
      }

      // 2. Credits
      const effectiveCreditType = saga.creditType ?? CreditType.BARCODE;
      if (credCapture > 0 && saga.creditType) {
        await this.creditLedger.commitReservedCredits({
          accountId: saga.accountId,
          creditType: effectiveCreditType,
          amount: credCapture,
          operation: CreditOperation.CHARGE,
          buildId: saga.buildId ?? undefined,
          batchId: saga.batchId ?? undefined,
          metadata: { sagaId: saga.id, source: 'partial_capture' },
        });
      }
      if (credRelease > 0 && saga.creditType) {
        await this.creditLedger.releaseReservedCredits({
          accountId: saga.accountId,
          creditType: effectiveCreditType,
          amount: credRelease,
          operation: CreditOperation.UNBLOCK,
          buildId: saga.buildId ?? undefined,
          batchId: saga.batchId ?? undefined,
          metadata: { sagaId: saga.id, source: 'partial_capture_release' },
        });
      }

      // 3. Subscription: release excess
      if (subRelease > 0 && saga.subscriptionId) {
        await this.subscriptions.releaseGenerations(
          saga.subscriptionId,
          subRelease,
        );
      }

      const updated = await this.prisma.billingSaga.update({
        where: { id: saga.id },
        data: { status: SagaStatus.COMPLETED, completedAt: new Date() },
      });

      this.logger.log(
        `Partial capture sagaId=${saga.id} requested=${requestAmount} captured=${units} subCapture=${subCapture} credCapture=${credCapture} walletCapture=${walletCapture} walletRelease=${walletRelease}`,
      );

      this.metrics.incSagaConfirm(true);
      await this.tryEmitSagaCompleted(updated, units);

      return {
        sagaId: updated.id,
        capturedUnits: units,
        status: updated.status,
      };
    })) as CaptureResponseDto;
  }

  // ─── Release (BFF calls instead of cancel) ───────────────────────────────

  async release(
    sagaId: string,
    units?: number,
    reason?: string,
  ): Promise<BillingSaga> {
    const saga = await this.getSagaOrThrow(sagaId);
    const metadata = saga.metadata as Record<string, unknown> | null;
    const requestedUnits =
      typeof metadata?.requestAmount === 'number' ? metadata.requestAmount : 0;

    if (typeof units === 'number' && units > 0 && requestedUnits > 0) {
      this.logger.log(
        `Release requested for sagaId=${sagaId} with units=${units}; remaining reservation will be fully cancelled`,
      );
    }

    return await this.cancelSaga(sagaId, reason ?? 'released_by_bff');
  }

  // ─── BlockBatch – reserve N sagas for Bulk Service ───────────────────────

  async blockBatch(
    request: BlockBatchRequestDto,
  ): Promise<BlockBatchResponseDto> {
    const account = await this.prisma.account.findUnique({
      where: { userId: request.userId },
    });
    if (!account) throw new NotFoundException('Account not found');

    const quote = await this.quoteService.quote({
      userId: request.userId,
      units: request.count,
    });

    if (!quote.canProcess || quote.allowedTotal < request.count) {
      throw new HttpException(
        `Insufficient funds: need ${request.count}, available ${quote.allowedTotal}`,
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const creditType = CreditType.BARCODE;
    const subscriptionAmount = quote.bySource.subscription.units;
    const creditsAmount = quote.bySource.credits.units;
    const walletTotalCost = Number(quote.totalWalletCost.toFixed(2));
    const currency = quote.currency;

    // Distribute reservations proportionally per unit
    const subPerUnit = subscriptionAmount / request.count;
    const credPerUnit = creditsAmount / request.count;
    const walletPerUnit = walletTotalCost / request.count;

    const transactionIds: string[] = [];
    const expiresAt = await this.getExpiresAt();

    for (let i = 0; i < request.count; i++) {
      const sagaId = `${request.batchId}-tx-${i + 1}`;
      const subAmt = Math.round(subPerUnit);
      const credAmt = Math.round(credPerUnit);
      const walletAmt = Number(walletPerUnit.toFixed(2));

      // Reserve per-unit resources
      let subscriptionId: string | null = null;
      let walletBlockId: string | null = null;

      try {
        if (subAmt > 0) {
          const sub = await this.subscriptions.reserveGenerations(
            account.id,
            subAmt,
          );
          if (sub) subscriptionId = sub.id;
        }
        if (credAmt > 0) {
          await this.creditLedger.reserveCredits({
            accountId: account.id,
            creditType,
            amount: credAmt,
            operation: CreditOperation.BLOCK,
            batchId: request.batchId,
            metadata: { source: 'block_batch', sagaId },
          });
        }
        if (walletAmt > 0) {
          const wb = await this.wallet.blockFunds({
            userId: request.userId,
            amount: walletAmt,
            currency,
            reason: 'bulk_generate',
            metadata: { batchId: request.batchId, sagaId },
          });
          walletBlockId = wb.blockId;
        }

        await this.prisma.billingSaga.create({
          data: {
            id: sagaId,
            accountId: account.id,
            subscriptionId,
            subscriptionAmount: subAmt,
            creditsAmount: credAmt,
            creditType: credAmt > 0 ? creditType : null,
            walletBlockId,
            walletAmount: new Prisma.Decimal(walletAmt),
            status: SagaStatus.PENDING,
            operation: 'bulk_generate',
            batchId: request.batchId,
            expiresAt,
            metadata: {
              requestAmount: 1,
              batchTotal: request.count,
              pricing: {
                unitPrice: quote.unitPrice,
                currency,
                totalCost: walletAmt,
              },
            },
          },
        });

        transactionIds.push(sagaId);
      } catch (err) {
        this.logger.error(
          `blockBatch unit ${i} failed: ${getErrorMessage(err)}`,
        );
        if (walletBlockId) await this.tryCancelWalletBlock(walletBlockId);
        if (subscriptionId)
          await this.tryReleaseSubscription(subscriptionId, subAmt);
        if (credAmt > 0)
          await this.tryReleaseCredits(account.id, creditType, credAmt);
        // Break – rollback already-created sagas
        throw new HttpException(
          `Failed to allocate resources for batch unit ${i + 1}`,
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }
    }

    return { transactionIds };
  }

  // ─── Legacy complete/cancel (kept for AI Kafka consumer) ─────────────────

  async completeSaga(sagaId: string): Promise<BillingSaga> {
    return (await this.withSagaFinalizationLock(sagaId, async () => {
      const saga = await this.getSagaOrThrow(sagaId);
      if (saga.status === SagaStatus.COMPLETED) return saga;
      if (saga.status !== SagaStatus.PENDING) {
        this.logger.warn(
          `Ignoring complete for saga id=${sagaId} because status=${saga.status}`,
        );
        return saga;
      }
      const completed = await this.completePendingSaga(saga);
      this.metrics.incSagaConfirm(false);
      await this.tryEmitSagaCompleted(
        completed,
        saga.subscriptionAmount + saga.creditsAmount,
      );
      return completed;
    })) as BillingSaga;
  }

  async cancelSaga(sagaId: string, reason?: string): Promise<BillingSaga> {
    return (await this.withSagaFinalizationLock(sagaId, async () => {
      const saga = await this.getSagaOrThrow(sagaId);
      if (
        saga.status === SagaStatus.CANCELLED ||
        saga.status === SagaStatus.EXPIRED
      ) {
        return saga;
      }
      if (saga.status !== SagaStatus.PENDING) {
        this.logger.warn(
          `Ignoring cancel for saga id=${sagaId} because status=${saga.status}`,
        );
        return saga;
      }
      const cancelled = await this.cancelPendingSaga(saga, reason);
      this.metrics.incSagaCancel(reason ?? 'cancelled');
      await this.tryEmitSagaCancelled(cancelled, reason);
      return cancelled;
    })) as BillingSaga;
  }

  async expirePendingSagas(): Promise<number> {
    const sagas = await this.prisma.billingSaga.findMany({
      where: { status: SagaStatus.PENDING, expiresAt: { lte: new Date() } },
    });
    for (const saga of sagas) {
      try {
        await this.expireSaga(saga.id, 'timeout');
      } catch (error) {
        this.logger.error(`Failed to expire saga id=${saga.id}`, error);
      }
    }
    if (sagas.length > 0) {
      this.metrics.incSagaExpired(sagas.length);
    }
    return sagas.length;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async ensureNoDuplicateSaga(request: BlockRequestDto): Promise<void> {
    // If BFF provided explicit sagaId – check by that first
    if (request.sagaId) {
      const existing = await this.prisma.billingSaga.findUnique({
        where: { id: request.sagaId },
      });
      if (existing) {
        if (
          existing.status === SagaStatus.PENDING ||
          existing.status === SagaStatus.COMPLETED
        ) {
          throw new HttpException(
            'Saga already exists for this operation',
            HttpStatus.CONFLICT,
          );
        }
      }
      return;
    }

    if (!request.buildId && !request.batchId) return;

    const existing = await this.prisma.billingSaga.findFirst({
      where: {
        OR: (
          [
            request.buildId ? { buildId: request.buildId } : undefined,
            request.batchId ? { batchId: request.batchId } : undefined,
          ] as Array<Prisma.BillingSagaWhereInput | undefined>
        ).filter((x): x is Prisma.BillingSagaWhereInput => x !== undefined),
        status: { in: [SagaStatus.PENDING, SagaStatus.COMPLETED] },
      },
    });
    if (existing) {
      throw new HttpException(
        'Saga already exists for this operation',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async getSagaOrThrow(sagaId: string): Promise<BillingSaga> {
    const saga = await this.prisma.billingSaga.findUnique({
      where: { id: sagaId },
    });
    if (!saga) throw new NotFoundException('Saga not found');
    return saga;
  }

  private async completePendingSaga(saga: BillingSaga): Promise<BillingSaga> {
    if (saga.walletBlockId) {
      await this.wallet.confirmBlock(saga.walletBlockId);
      await this.tryMarkPaymentCompleted(saga.walletBlockId);
    }
    if (saga.creditsAmount > 0 && saga.creditType) {
      const committed = await this.creditLedger.commitReservedCredits({
        accountId: saga.accountId,
        creditType: saga.creditType,
        amount: saga.creditsAmount,
        operation: CreditOperation.CHARGE,
        buildId: saga.buildId ?? undefined,
        batchId: saga.batchId ?? undefined,
        metadata: {
          sagaId: saga.id,
          operation: saga.operation,
          source: 'saga.complete',
        },
      });
      if (!committed) {
        throw new HttpException(
          'Unable to commit reserved credits',
          HttpStatus.CONFLICT,
        );
      }
      if (committed.balance === 0) {
        void this.tryEmitCreditsEmpty(
          saga.accountId,
          saga.creditType.toString(),
        );
      }
    }
    return await this.prisma.billingSaga.update({
      where: { id: saga.id },
      data: { status: SagaStatus.COMPLETED, completedAt: new Date() },
    });
  }

  private async cancelPendingSaga(
    saga: BillingSaga,
    reason?: string,
    finalStatus: SagaStatus = SagaStatus.CANCELLED,
  ): Promise<BillingSaga> {
    if (saga.walletBlockId) {
      await this.wallet.cancelBlock(saga.walletBlockId);
      await this.tryMarkPaymentCancelled(saga.walletBlockId, reason);
    }
    if (saga.subscriptionAmount > 0 && saga.subscriptionId) {
      const released = await this.subscriptions.releaseGenerations(
        saga.subscriptionId,
        saga.subscriptionAmount,
      );
      if (!released) {
        throw new HttpException(
          'Unable to release reserved subscription usage',
          HttpStatus.CONFLICT,
        );
      }
    }
    if (saga.creditsAmount > 0 && saga.creditType) {
      const released = await this.creditLedger.releaseReservedCredits({
        accountId: saga.accountId,
        creditType: saga.creditType,
        amount: saga.creditsAmount,
        operation: CreditOperation.UNBLOCK,
        buildId: saga.buildId ?? undefined,
        batchId: saga.batchId ?? undefined,
        metadata: {
          sagaId: saga.id,
          operation: saga.operation,
          reason: reason ?? 'cancelled',
          source: 'saga.cancel',
        },
      });
      if (!released) {
        throw new HttpException(
          'Unable to release reserved credits',
          HttpStatus.CONFLICT,
        );
      }
    }
    return await this.prisma.billingSaga.update({
      where: { id: saga.id },
      data: { status: finalStatus, cancelledAt: new Date() },
    });
  }

  private async expireSaga(
    sagaId: string,
    reason = 'timeout',
  ): Promise<BillingSaga> {
    return (await this.withSagaFinalizationLock(sagaId, async () => {
      const saga = await this.getSagaOrThrow(sagaId);
      if (saga.status === SagaStatus.EXPIRED) return saga;
      if (saga.status === SagaStatus.CANCELLED) {
        return await this.prisma.billingSaga.update({
          where: { id: saga.id },
          data: { status: SagaStatus.EXPIRED },
        });
      }
      if (saga.status !== SagaStatus.PENDING) {
        this.logger.warn(
          `Ignoring expire for saga id=${sagaId} because status=${saga.status}`,
        );
        return saga;
      }
      return await this.cancelPendingSaga(saga, reason, SagaStatus.EXPIRED);
    })) as BillingSaga;
  }

  private toBlockResponse(saga: BillingSaga): BlockResponseDto {
    return {
      sagaId: saga.id,
      blocked: {
        subscription: saga.subscriptionAmount,
        credits: saga.creditsAmount,
        wallet: Number(saga.walletAmount),
      },
      expiresAt: saga.expiresAt.toISOString(),
    };
  }

  private async getExpiresAt(ttl?: number): Promise<Date> {
    const defaultTtlSeconds =
      (await this.billingConfig.getNumber(
        'saga_timeout_minutes',
        this.defaultTtlMinutes,
      )) * 60;
    const ttlSeconds = ttl ?? defaultTtlSeconds;
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  private async withSagaFinalizationLock(
    sagaId: string,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    const lockKey = `billing:saga:lock:${sagaId}`;
    const lockValue = randomUUID();
    const acquired = await this.redis.acquireLock(
      lockKey,
      lockValue,
      this.finalizeLockTtlSeconds,
    );

    if (!acquired) {
      const existingSaga = await this.prisma.billingSaga.findUnique({
        where: { id: sagaId },
      });
      if (existingSaga && existingSaga.status !== SagaStatus.PENDING)
        return existingSaga;
      throw new HttpException(
        'Saga is already being processed',
        HttpStatus.CONFLICT,
      );
    }

    try {
      return await action();
    } finally {
      try {
        await this.redis.releaseLock(lockKey, lockValue);
      } catch (error) {
        this.logger.warn(
          `Failed to release saga lock id=${sagaId}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private async tryCancelWalletBlock(blockId: string): Promise<void> {
    try {
      await this.wallet.cancelBlock(blockId);
    } catch (error) {
      this.logger.error(`Failed to rollback wallet blockId=${blockId}`, error);
    }
  }

  private async tryReleaseCredits(
    accountId: string,
    creditType: CreditType,
    amount: number,
  ): Promise<void> {
    if (amount <= 0) return;
    try {
      await this.creditLedger.releaseReservedCredits({
        accountId,
        creditType,
        amount,
        operation: CreditOperation.UNBLOCK,
        metadata: { reason: 'block_failed', source: 'saga.rollback' },
      });
    } catch (error) {
      this.logger.error(
        `Failed to rollback reserved credits accountId=${accountId}`,
        error,
      );
    }
  }

  private async resolveBlockReservation(
    request: BlockRequestDto,
    creditType: CreditType,
  ): Promise<{
    subscriptionAmount: number;
    creditsAmount: number;
    walletUnits: number;
    walletAmount: number;
    currency: string;
    unitPrice: number;
  }> {
    if (request.bySource) {
      const subscriptionAmount = this.ensureNonNegativeInteger(
        request.bySource.subscription.units,
        'bySource.subscription.units',
      );
      const creditsAmount = this.ensureNonNegativeInteger(
        request.bySource.credits.units,
        'bySource.credits.units',
      );
      const walletUnits = this.ensureNonNegativeInteger(
        request.bySource.wallet.units,
        'bySource.wallet.units',
      );
      const walletAmount = this.normalizeMoney(
        request.bySource.wallet.amount ?? 0,
        'bySource.wallet.amount',
      );
      const totalUnits = subscriptionAmount + creditsAmount + walletUnits;

      if (totalUnits < request.units) {
        throw new HttpException(
          'Insufficient funds for requested amount',
          HttpStatus.PAYMENT_REQUIRED,
        );
      }

      if (totalUnits > request.units) {
        throw new HttpException(
          'Block source breakdown exceeds requested units',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (walletUnits > 0 && walletAmount <= 0) {
        throw new HttpException(
          'Wallet amount must be provided when wallet units are requested',
          HttpStatus.BAD_REQUEST,
        );
      }

      const unitPrice = walletUnits > 0 ? walletAmount / walletUnits : 0;
      return {
        subscriptionAmount,
        creditsAmount,
        walletUnits,
        walletAmount,
        currency: 'USD',
        unitPrice,
      };
    }

    const quote = await this.quoteService.quote({
      userId: request.userId,
      units: request.units,
      creditType,
      revision: request.context?.revision,
      context: {
        product: request.context?.product,
        revision: request.context?.revision,
        source: request.batchId ? QuoteSource.BULK : QuoteSource.SINGLE,
        batchId: request.batchId,
      },
    });

    if (!quote.canProcess || quote.allowedTotal < request.units) {
      throw new HttpException(
        'Insufficient funds for requested amount',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return {
      subscriptionAmount: quote.bySource.subscription.units,
      creditsAmount: quote.bySource.credits.units,
      walletUnits: quote.bySource.wallet.units,
      walletAmount: Number(quote.totalWalletCost.toFixed(2)),
      currency: quote.currency,
      unitPrice: quote.unitPrice,
    };
  }

  private ensureNonNegativeInteger(
    value: number | undefined,
    field: string,
  ): number {
    const normalized = value ?? 0;
    if (!Number.isInteger(normalized) || normalized < 0) {
      throw new HttpException(
        `${field} must be a non-negative integer`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return normalized;
  }

  private normalizeMoney(value: number, field: string): number {
    if (!Number.isFinite(value) || value < 0) {
      throw new HttpException(
        `${field} must be a non-negative number`,
        HttpStatus.BAD_REQUEST,
      );
    }

    return Number(value.toFixed(2));
  }

  private async reserveCreditsInTx(
    tx: Prisma.TransactionClient,
    input: Parameters<CreditLedgerService['reserveCredits']>[0],
  ): Promise<void> {
    if (input.amount <= 0) {
      return;
    }

    await tx.creditBalance.createMany({
      data: [CreditType.BARCODE, CreditType.AI].map((type) => ({
        accountId: input.accountId,
        creditType: type,
      })),
      skipDuplicates: true,
    });

    const updated = await tx.$executeRaw`
      UPDATE "CreditBalance"
      SET "reserved" = "reserved" + ${input.amount},
          "updatedAt" = NOW()
      WHERE "accountId" = ${input.accountId}
        AND "creditType" = ${input.creditType}::"CreditType"
        AND ("balance" - "reserved") >= ${input.amount}
    `;

    if (updated === 0) {
      throw new HttpException(
        'Unable to reserve credits for saga',
        HttpStatus.PAYMENT_REQUIRED,
      );
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
  }

  private async reserveSubscriptionInTx(
    tx: Prisma.TransactionClient,
    accountId: string,
    amount: number,
  ): Promise<string | null> {
    if (amount <= 0) {
      return null;
    }

    const subscription = await tx.subscription.findFirst({
      where: {
        accountId,
        status: SubscriptionStatus.ACTIVE,
        currentPeriodStart: { lte: new Date() },
        currentPeriodEnd: { gt: new Date() },
      },
      orderBy: [{ currentPeriodEnd: 'desc' }, { createdAt: 'desc' }],
    });

    if (!subscription) {
      throw new HttpException(
        'Unable to reserve subscription usage for saga',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const updated = await tx.$executeRaw`
      UPDATE "Subscription"
      SET "creditsUsed" = "creditsUsed" + ${amount},
          "updatedAt" = NOW()
      WHERE "id" = ${subscription.id}
        AND "status" = ${SubscriptionStatus.ACTIVE}::"SubscriptionStatus"
        AND "currentPeriodStart" <= NOW()
        AND "currentPeriodEnd" > NOW()
        AND ("creditsAllocated" - "creditsUsed") >= ${amount}
    `;

    if (updated === 0) {
      throw new HttpException(
        'Unable to reserve subscription usage for saga',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return subscription.id;
  }

  private async tryReleaseSubscription(
    subscriptionId: string,
    amount: number,
  ): Promise<void> {
    if (amount <= 0) return;
    try {
      await this.subscriptions.releaseGenerations(subscriptionId, amount);
    } catch (error) {
      this.logger.error(
        `Failed to rollback subscription subscriptionId=${subscriptionId}`,
        error,
      );
    }
  }

  private async tryMarkPaymentCompleted(walletBlockId: string): Promise<void> {
    try {
      await this.paymentLedger.markCompletedByWalletBlock(walletBlockId);
    } catch (error) {
      this.logger.error(
        `Failed to finalize payment for walletBlockId=${walletBlockId}: ${getErrorMessage(error)}`,
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
        `Failed to cancel payment for walletBlockId=${walletBlockId}: ${getErrorMessage(error)}`,
      );
    }
  }

  // ─── Kafka emit helpers ───────────────────────────────────────────────────

  private async tryEmitCreditsEmpty(
    accountId: string,
    creditType: string,
  ): Promise<void> {
    try {
      const account = await this.prisma.account.findUnique({
        where: { id: accountId },
      });
      if (!account) return;
      await this.billingProducer.creditsEmpty({
        userId: account.userId,
        accountId,
        creditType,
      });
    } catch (error) {
      this.logger.warn(
        `tryEmitCreditsEmpty failed for accountId=${accountId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryEmitSagaCompleted(
    saga: BillingSaga,
    capturedUnits: number,
  ): Promise<void> {
    try {
      const account = await this.prisma.account.findUnique({
        where: { id: saga.accountId },
      });
      if (!account) return;
      await this.billingProducer.sagaCompleted({
        sagaId: saga.id,
        userId: account.userId,
        capturedUnits,
        buildId: saga.buildId ?? undefined,
        batchId: saga.batchId ?? undefined,
      });
      if (saga.creditsAmount > 0 && saga.creditType) {
        await this.billingProducer.creditsCharged({
          userId: account.userId,
          accountId: saga.accountId,
          creditType: saga.creditType,
          amount: saga.creditsAmount,
          operation: saga.operation ?? 'generate',
          buildId: saga.buildId ?? undefined,
          batchId: saga.batchId ?? undefined,
        });
        if (saga.subscriptionAmount > 0) {
          await this.billingProducer.subscriptionCreditsUsed({
            userId: account.userId,
            subscriptionId: saga.subscriptionId ?? '',
            unitsUsed: saga.subscriptionAmount,
            creditsRemaining: 0,
            buildId: saga.buildId ?? undefined,
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        `tryEmitSagaCompleted failed for sagaId=${saga.id}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async tryEmitSagaCancelled(
    saga: BillingSaga,
    reason?: string,
  ): Promise<void> {
    try {
      const account = await this.prisma.account.findUnique({
        where: { id: saga.accountId },
      });
      if (!account) return;
      await this.billingProducer.sagaCancelled({
        sagaId: saga.id,
        userId: account.userId,
        reason,
        buildId: saga.buildId ?? undefined,
        batchId: saga.batchId ?? undefined,
      });
    } catch (error) {
      this.logger.warn(
        `tryEmitSagaCancelled failed for sagaId=${saga.id}: ${getErrorMessage(error)}`,
      );
    }
  }
}
