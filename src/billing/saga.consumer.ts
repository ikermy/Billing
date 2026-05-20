import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { SagaService } from './saga.service';
import { getErrorMessage } from 'src/shared/utils/error.util';
import { WaivedService } from './waived.service';

type SagaResultEvent = {
  sagaId?: string;
  success?: boolean;
  status?: string;
  reason?: string;
  error?: string;
  waived?: boolean;
  buildId?: string;
  batchId?: string;
  generationId?: string;
  userId?: string;
  operation?: string;
};

type SagaOutcomeOptions = {
  defaultSuccess: boolean;
  defaultReason?: string;
};

/**
 * NOTE: barcode.generated and bulk.batch.completed consumers were removed.
 * BFF orchestrates saga lifecycle via HTTP (POST /internal/billing/capture and /release).
 * Those Kafka events do NOT carry sagaId, so the consumers generated noise-only warnings.
 * Only AI-generation events remain here because AI Service uses Kafka for async callbacks.
 */
@Controller()
export class SagaConsumer {
  private readonly logger = new Logger(SagaConsumer.name);
  private readonly enabled = process.env.ENABLE_SAGA_KAFKA === 'true';

  constructor(
    private readonly sagaService: SagaService,
    private readonly waivedService: WaivedService,
  ) {}

  @EventPattern('ai.generation.completed')
  async handleAiGenerationCompleted(
    @Payload() data: SagaResultEvent,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (data.waived && !data.sagaId) {
      if (!data.userId) {
        this.logger.warn(
          `[ai.generation.completed] waived generationId=${data.generationId ?? 'unknown'} missing userId`,
        );
        return;
      }

      await this.waivedService.complete({
        userId: data.userId,
        operation: data.operation ?? 'ai_generation',
        generationId: data.generationId,
      });
      this.logger.log(
        `[ai.generation.completed] waived generationId=${data.generationId ?? 'unknown'} does not require saga finalization`,
      );
      return;
    }

    await this.processOutcome('ai.generation.completed', data, context, {
      defaultSuccess: true,
      defaultReason: 'ai_generation_failed',
    });
  }

  @EventPattern('ai.generation.failed')
  async handleAiGenerationFailed(
    @Payload() data: SagaResultEvent,
    @Ctx() context: KafkaContext,
  ): Promise<void> {
    if (!this.enabled) {
      return;
    }

    if (data.waived && !data.sagaId) {
      if (!data.userId) {
        this.logger.warn(
          `[ai.generation.failed] waived generationId=${data.generationId ?? 'unknown'} missing userId`,
        );
        return;
      }

      await this.waivedService.release(
        data.userId,
        data.operation ?? 'ai_generation',
      );
      this.logger.log(
        `[ai.generation.failed] released waived reservation for generationId=${data.generationId ?? 'unknown'}`,
      );
      return;
    }

    await this.processOutcome(
      'ai.generation.failed',
      {
        ...data,
        success: false,
      },
      context,
      {
        defaultSuccess: false,
        defaultReason: 'ai_generation_failed',
      },
    );
  }

  private async processOutcome(
    topic: string,
    data: SagaResultEvent,
    context: KafkaContext,
    options: SagaOutcomeOptions,
  ): Promise<void> {
    const { key, headers } = this.getMeta(context);
    if (!data.sagaId) {
      this.logger.warn(
        `[${topic}] Missing sagaId; key=${key ?? 'null'} headers=${JSON.stringify(headers)}`,
      );
      return;
    }

    const success = this.resolveSuccess(data, options.defaultSuccess);
    try {
      const saga = (success
        ? await this.sagaService.completeSaga(data.sagaId)
        : await this.sagaService.cancelSaga(
            data.sagaId,
            data.reason ?? data.error ?? options.defaultReason,
          )) as unknown as { status?: string };

      this.logger.log(
        `[${topic}] sagaId=${data.sagaId} resolved=${saga.status} key=${key ?? 'null'}`,
      );
    } catch (err: unknown) {
      this.logger.error(
        `[${topic}] sagaId=${data.sagaId} failed: ${getErrorMessage(err)}`,
      );
      throw err;
    }
  }

  private resolveSuccess(
    data: SagaResultEvent,
    defaultSuccess: boolean,
  ): boolean {
    if (typeof data.success === 'boolean') {
      return data.success;
    }

    const normalized = data.status?.trim().toLowerCase();
    if (!normalized) {
      return defaultSuccess;
    }

    if (['success', 'completed', 'complete', 'ok'].includes(normalized)) {
      return true;
    }

    if (
      ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(
        normalized,
      )
    ) {
      return false;
    }

    return defaultSuccess;
  }

  private getMeta(context: KafkaContext): {
    key: string | undefined;
    headers: Record<string, string | undefined>;
  } {
    const message = context.getMessage();
    const key = message.key?.toString();
    const headers = Object.fromEntries(
      Object.entries(message.headers ?? {}).map(([header, value]) => [
        header,
        value?.toString(),
      ]),
    );

    return { key, headers };
  }
}
