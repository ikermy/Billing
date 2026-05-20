import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaService } from './shared/services/prisma.service';
import { HealthService } from './kafka/services/health.service';
import { LagoService } from './shared/services/lago.service';
import { WalletBalanceService } from './shared/services/wallet-balance.service';

describe('AppController', () => {
  let appController: AppController;
  const prisma = {
    $queryRaw: jest.fn(),
  };
  const kafka = {
    checkHealth: jest.fn(),
  };
  const lago = {
    checkHealth: jest.fn(),
  };
  const wallet = {
    checkHealth: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (prisma.$queryRaw as any).mockResolvedValue([{ '?column?': 1 }]);
    (kafka.checkHealth as any).mockResolvedValue('ok');
    (lago.checkHealth as any).mockResolvedValue('ok');
    (wallet.checkHealth as any).mockResolvedValue('ok');

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: PrismaService,
          useValue: prisma,
        },
        {
          provide: HealthService,
          useValue: kafka,
        },
        {
          provide: LagoService,
          useValue: lago,
        },
        {
          provide: WalletBalanceService,
          useValue: wallet,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('healthz', () => {
    it('should return ok status', () => {
      expect(appController.liveness()).toEqual({ status: 'ok' });
    });
  });

  describe('readyz', () => {
    it('returns ready when dependencies are healthy', async () => {
      await expect(appController.readiness()).resolves.toEqual({
        status: 'ready',
        database: 'ok',
        kafka: 'ok',
        lago: 'ok',
        wallet: 'ok',
      });
    });

    it('throws 503 when lago health returns error', async () => {
      (lago.checkHealth as any).mockResolvedValue('error');

      await expect(appController.readiness()).rejects.toBeInstanceOf(
        HttpException,
      );

      try {
        await appController.readiness();
      } catch (error) {
        const exception = error as HttpException;
        expect(exception.getStatus()).toBe(503);
        expect(exception.getResponse()).toEqual({
          status: 'error',
          database: 'ok',
          kafka: 'ok',
          lago: 'error',
          wallet: 'ok',
        });
      }
    });
  });
});
