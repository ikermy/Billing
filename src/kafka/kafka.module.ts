import { Module } from '@nestjs/common';
import { HealthService } from './services/health.service';
import { BarcodeAuthConsumer } from './consumers/barcode-auth.consumer';
import { BarcodeGenConsumer } from './consumers/barcode-gen.consumer';
import { SharedModule } from 'src/shared/shared.module';
import { BillingProducer } from './producers/billing.producer';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { brokers, clientId } from 'src/main';
import { ProductProducer } from './producers/product.producer';

@Module({
  imports: [
    SharedModule,
    ClientsModule.register([
      {
        name: 'KAFKA_BILLING',
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId,
            brokers,
            connectionTimeout: 3000,
            requestTimeout: 5000,
            retry: { retries: 2, initialRetryTime: 300, factor: 2 },
          },
          producer: {
            idempotent: true,
            allowAutoTopicCreation: false,
          },
        },
      },
    ]),
  ],
  controllers: [BarcodeAuthConsumer, BarcodeGenConsumer],
  providers: [HealthService, BillingProducer, ProductProducer],
  exports: [HealthService, BillingProducer, ProductProducer],
})
export class KafkaModule {}
