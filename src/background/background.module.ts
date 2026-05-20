import { Module } from '@nestjs/common';
import { KafkaModule } from 'src/kafka/kafka.module';
import { BillingModule } from 'src/billing/billing.module';
import { CronService } from './services/cron.service';

@Module({
  imports: [KafkaModule, BillingModule],
  providers: [CronService],
})
export class BackgroundModule {}
