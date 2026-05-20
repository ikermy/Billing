import { Module } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { SharedModule } from 'src/shared/shared.module';
import { KafkaModule } from 'src/kafka/kafka.module';
import { InternalBillingController } from './internal-billing.controller';
import { QuoteService } from './quote.service';
import { SagaService } from './saga.service';
import { SagaConsumer } from './saga.consumer';
import { BillingAdminController } from './billing-admin.controller';
import { WaivedService } from './waived.service';
import { BillingV1Controller } from './billing-v1.controller';
import { BillingAdminV1Controller } from './billing-admin-v1.controller';
import { WalletTopupConsumer } from 'src/kafka/consumers/wallet-topup.consumer';
import { IdempotencyInterceptor } from 'src/shared/interceptors/idempotency.interceptor';

@Module({
  imports: [SharedModule, KafkaModule],
  providers: [
    BillingService,
    QuoteService,
    SagaService,
    WaivedService,
    IdempotencyInterceptor,
    // BillingProducer and BillingMetricsService come from KafkaModule/SharedModule exports
  ],
  controllers: [
    BillingController,
    BillingV1Controller,
    InternalBillingController,
    SagaConsumer,
    WalletTopupConsumer,
    BillingAdminController,
    BillingAdminV1Controller,
  ],
  exports: [SagaService, BillingService, QuoteService],
})
export class BillingModule {}
