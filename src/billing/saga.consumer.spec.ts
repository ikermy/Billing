import { KafkaContext } from '@nestjs/microservices';
import { SagaStatus } from '@prisma/client';
import { SagaConsumer } from './saga.consumer';
import { SagaService } from './saga.service';
import { WaivedService } from './waived.service';

describe('SagaConsumer', () => {
  let consumer: SagaConsumer;

  const sagaService = {
    completeSaga: jest.fn(),
    cancelSaga: jest.fn(),
  } as unknown as jest.Mocked<SagaService>;

  const waivedService = {
    complete: jest.fn(),
    release: jest.fn(),
  } as unknown as jest.Mocked<WaivedService>;

  const context: Pick<KafkaContext, 'getMessage'> = {
    getMessage: () =>
      ({
        key: Buffer.from('saga-key'),
        headers: { 'x-request-id': Buffer.from('req-1') },
      }) as ReturnType<KafkaContext['getMessage']>,
  };

  beforeEach(() => {
    process.env.ENABLE_SAGA_KAFKA = 'true';
    jest.clearAllMocks();
    consumer = new SagaConsumer(sagaService, waivedService);
  });

  afterAll(() => {
    delete process.env.ENABLE_SAGA_KAFKA;
  });

  it('completes ai saga on ai.generation.completed', async () => {
    (sagaService.completeSaga as any).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.COMPLETED,
    });

    await consumer.handleAiGenerationCompleted(
      { sagaId: 'saga-1', success: true },
      context as any,
    );

    expect(sagaService.completeSaga).toHaveBeenCalledWith('saga-1');
    expect(sagaService.cancelSaga).not.toHaveBeenCalled();
  });

  it('cancels ai saga on ai.generation.failed', async () => {
    (sagaService.cancelSaga as any).mockResolvedValue({
      id: 'saga-1',
      status: SagaStatus.CANCELLED,
    });

    await consumer.handleAiGenerationFailed(
      { sagaId: 'saga-1', success: false, reason: 'timeout' },
      context as any,
    );

    expect(sagaService.cancelSaga).toHaveBeenCalledWith('saga-1', 'timeout');
    expect(sagaService.completeSaga).not.toHaveBeenCalled();
  });

  it('completes waived ai without saga', async () => {
    await consumer.handleAiGenerationCompleted(
      {
        generationId: 'gen-1',
        waived: true,
        userId: 'u1',
        operation: 'ai_generation',
      },
      context as any,
    );

    expect(sagaService.completeSaga).not.toHaveBeenCalled();
    expect(waivedService.complete).toHaveBeenCalledWith({
      userId: 'u1',
      operation: 'ai_generation',
      generationId: 'gen-1',
    });
  });

  it('releases waived reservation on ai.generation.failed without sagaId', async () => {
    await consumer.handleAiGenerationFailed(
      {
        waived: true,
        userId: 'u1',
        operation: 'ai_generation',
        generationId: 'gen-2',
      },
      context as any,
    );

    expect(waivedService.release).toHaveBeenCalledWith('u1', 'ai_generation');
    expect(sagaService.cancelSaga).not.toHaveBeenCalled();
  });

  it('skips when feature flag is disabled', async () => {
    process.env.ENABLE_SAGA_KAFKA = 'false';
    consumer = new SagaConsumer(sagaService, waivedService);

    await consumer.handleAiGenerationCompleted(
      { sagaId: 'saga-2', success: true },
      context as any,
    );

    expect(sagaService.completeSaga).not.toHaveBeenCalled();
  });
});
