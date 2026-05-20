import { Test, TestingModule } from '@nestjs/testing';
import { InternalBillingController } from './internal-billing.controller';
import { QuoteService } from './quote.service';
import { CreditType, QuoteSource } from './dto/quote.dto';
import { SagaService } from './saga.service';
import { WaivedService } from './waived.service';
import { InternalApiKeyGuard } from 'src/shared/guards/internal-api-key.guard';
import { RedisService } from 'src/shared/services/redis.service';

describe('InternalBillingController', () => {
  let controller: InternalBillingController;
  let quoteService: jest.Mocked<QuoteService>;
  let sagaService: jest.Mocked<SagaService>;
  let waivedService: jest.Mocked<WaivedService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InternalBillingController],
      providers: [
        {
          provide: QuoteService,
          useValue: {
            quote: jest.fn(),
          },
        },
        {
          provide: SagaService,
          useValue: {
            block: jest.fn(),
            capture: jest.fn(),
            release: jest.fn(),
            blockBatch: jest.fn(),
            completeSaga: jest.fn(),
            cancelSaga: jest.fn(),
          },
        },
        {
          provide: WaivedService,
          useValue: {
            checkAndReserve: jest.fn(),
          },
        },
        {
          provide: InternalApiKeyGuard,
          useValue: {
            canActivate: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: RedisService,
          useValue: {
            getJson: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<InternalBillingController>(
      InternalBillingController,
    );
    quoteService = module.get(QuoteService);
    sagaService = module.get(SagaService);
    waivedService = module.get(WaivedService);
  });

  it('returns quote response from service', async () => {
    (quoteService.quote as any).mockResolvedValue({
      canGenerate: true,
      allowedTotal: 5,
    });

    const result = await controller.quote({
      userId: 'u1',
      count: 5,
      creditType: CreditType.BARCODE,
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
        source: QuoteSource.BULK,
      },
    });

    expect(quoteService.quote).toHaveBeenCalled();
    expect(result).toEqual({
      canGenerate: true,
      allowedTotal: 5,
    });
  });

  it('returns block response from saga service', async () => {
    (sagaService.block as any).mockResolvedValue({
      sagaId: 'saga-1',
      blocked: { subscription: 0, credits: 2, wallet: 1.5 },
      expiresAt: '2026-03-15T00:00:00.000Z',
    });

    const result = await controller.block({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      units: 5,
      operation: 'barcode_generation',
      buildId: 'build-1',
      context: {
        product: 'barcode_pdf417',
        revision: 'US_CA_08292017',
      },
    });

    expect(sagaService.block).toHaveBeenCalled();
    expect((result as { sagaId: string }).sagaId).toBe('saga-1');
  });

  it('delegates capture and release to saga service', async () => {
    (sagaService.capture as jest.Mock).mockResolvedValue({
      sagaId: 'saga-1',
      capturedUnits: 5,
      status: 'COMPLETED',
    });
    (sagaService.release as any).mockResolvedValue({ id: 'saga-1' });

    await controller.capture({ sagaId: 'saga-1', units: 5 });
    await controller.release({ sagaId: 'saga-1', units: 2 });

    expect(sagaService.capture).toHaveBeenCalledWith('saga-1', 5);
    expect(sagaService.release).toHaveBeenCalledWith('saga-1', 2, undefined);
  });

  it('delegates waived checks to waived service', async () => {
    (waivedService.checkAndReserve as any).mockResolvedValue({
      allowed: true,
      currentCount: 1,
      limit: 5,
      resetsAt: '2026-03-15T00:00:00.000Z',
    });

    const result = await controller.checkWaived({
      userId: 'u1',
      operation: 'ai_generation',
    });

    expect(waivedService.checkAndReserve).toHaveBeenCalledWith({
      userId: 'u1',
      operation: 'ai_generation',
    });
    expect(result as { allowed: boolean }).toMatchObject({ allowed: true });
  });
});
