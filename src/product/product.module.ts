import { Module } from '@nestjs/common';
import { ProductService } from './product.service';
import { ProductController } from './product.controller';
import { SharedModule } from 'src/shared/shared.module';
import { KafkaModule } from 'src/kafka/kafka.module';

@Module({
  imports: [SharedModule, KafkaModule],
  providers: [ProductService],
  controllers: [ProductController],
})
export class ProductModule {}
