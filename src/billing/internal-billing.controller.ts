import {
  Body,
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalApiKeyGuard } from 'src/shared/guards/internal-api-key.guard';
import { IdempotencyInterceptor } from 'src/shared/interceptors/idempotency.interceptor';
import { BlockRequestDto } from './dto/block.dto';
import { QuoteRequestDto } from './dto/quote.dto';
import { QuoteService } from './quote.service';
import {
  BlockBatchRequestDto,
  CaptureRequestDto,
  ReleaseRequestDto,
  SagaService,
} from './saga.service';
import {
  WaivedCheckRequestDto,
  WaivedCompleteRequestDto,
  WaivedReleaseRequestDto,
} from './dto/waived.dto';
import { WaivedService } from './waived.service';

@Controller('internal/billing')
@SkipThrottle()
@UseGuards(InternalApiKeyGuard)
@UseInterceptors(IdempotencyInterceptor)
export class InternalBillingController {
  constructor(
    private readonly quoteService: QuoteService,
    private readonly sagaService: SagaService,
    private readonly waivedService: WaivedService,
  ) {}

  /** POST /internal/billing/quote — internal quote for Bulk Service */
  @Post('quote')
  async quote(@Body() request: QuoteRequestDto): Promise<unknown> {
    return await this.quoteService.quote(request);
  }

  /** POST /internal/billing/block — reserve funds (Saga Phase 1) */
  @Post('block')
  async block(@Body() request: BlockRequestDto): Promise<unknown> {
    return await this.sagaService.block(request);
  }

  /**
   * POST /internal/billing/capture
   * BFF calls this after successful barcode generation.
   * Body: { sagaId: string, units: number }
   * Replaces legacy POST saga/:id/complete
   */
  @Post('capture')
  async capture(@Body() body: CaptureRequestDto): Promise<unknown> {
    return await this.sagaService.capture(body.sagaId, body.units);
  }

  /**
   * POST /internal/billing/release
   * BFF calls this when generation fails or is cancelled.
   * Body: { sagaId: string, units?: number, reason?: string }
   * Replaces legacy POST saga/:id/cancel
   */
  @Post('release')
  async release(@Body() body: ReleaseRequestDto): Promise<unknown> {
    return await this.sagaService.release(body.sagaId, body.units, body.reason);
  }

  /**
   * POST /internal/billing/block-batch
   * BFF calls this for bulk generation — reserves N sagas at once.
   * Body: { userId: string, count: number, batchId: string }
   * Response: { transactionIds: string[] }
   */
  @Post('block-batch')
  async blockBatch(@Body() body: BlockBatchRequestDto): Promise<unknown> {
    return await this.sagaService.blockBatch(body);
  }

  /** POST /internal/billing/waived/check */
  @Post('waived/check')
  async checkWaived(@Body() request: WaivedCheckRequestDto): Promise<unknown> {
    return await this.waivedService.checkAndReserve(request);
  }

  /** POST /internal/billing/waived/release — decrement waived counter on generation failure */
  @Post('waived/release')
  async releaseWaived(
    @Body() request: WaivedReleaseRequestDto,
  ): Promise<unknown> {
    await this.waivedService.release(request.userId, request.operation);
    return { released: true };
  }

  /** POST /internal/billing/waived/complete — audit $0 payment after successful free generation */
  @Post('waived/complete')
  async completeWaived(
    @Body() request: WaivedCompleteRequestDto,
  ): Promise<unknown> {
    await this.waivedService.complete({
      userId: request.userId,
      operation: request.operation,
      generationId: request.generationId,
    });
    return { completed: true };
  }
}
