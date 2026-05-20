import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from './shared/services/prisma.service';
import { HealthService } from './kafka/services/health.service';
import { LagoService } from './shared/services/lago.service';
import { WalletBalanceService } from './shared/services/wallet-balance.service';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: HealthService,
    private readonly lago: LagoService,
    private readonly wallet: WalletBalanceService,
  ) {}

  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'Service is alive' })
  @SkipThrottle()
  @Get('/health')
  @Get('/health/live')
  @Get('/healthz') // Я х.з что это и зачем он здесь
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @ApiOperation({ summary: 'Readiness probe' })
  @SkipThrottle()
  @Get('/health/ready')
  @Get('/readyz')
  async readiness() {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    let lago: 'ok' | 'error';
    try {
      lago = await this.lago.checkHealth();
    } catch {
      lago = 'error';
    }

    let kafka: 'ok' | 'error';
    try {
      kafka = await this.kafka.checkHealth();
    } catch {
      kafka = 'error';
    }

    let wallet: 'ok' | 'error';
    try {
      wallet = await this.wallet.checkHealth();
    } catch {
      wallet = 'error';
    }

    const allOk = [db, kafka, lago, wallet].every((x) => x === 'ok');
    const status = allOk ? 'ready' : 'error';

    if (!allOk) {
      throw new HttpException(
        { status, database: db, kafka: kafka, lago: lago, wallet: wallet },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status, database: db, kafka: kafka, lago: lago, wallet: wallet };
  }
}
