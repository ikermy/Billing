import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { SharedModule } from './shared/shared.module';
import { BillingModule } from './billing/billing.module';
import { ProductModule } from './product/product.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BackgroundModule } from './background/background.module';
import { KafkaModule } from './kafka/kafka.module';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: { enabled: true },
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    SharedModule,
    BillingModule,
    ProductModule,
    KafkaModule,
    BackgroundModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
