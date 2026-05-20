import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { Product } from '@prisma/client';
import { lastValueFrom } from 'rxjs';
import { getErrorMessage } from 'src/shared/utils/error.util';

type ProductEventPayload = Record<string, unknown>;

@Injectable()
export class ProductProducer implements OnModuleInit {
  private readonly logger = new Logger(ProductProducer.name);
  private readonly enabled = process.env.KAFKA_ENABLED === 'true';
  private connected = false;

  private readonly topics = {
    productUpdated: 'billing.product.updated',
  };

  constructor(@Inject('KAFKA_BILLING') private readonly client: ClientKafka) {}

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('Kafka producer disabled via KAFKA_ENABLED !== "true"');
      return;
    }
    try {
      await this.client.connect();
      this.connected = true;
      this.logger.log('Kafka billing producer connected');
    } catch (error: unknown) {
      this.connected = false;
      this.logger.error(
        `Kafka producer connect failed: ${getErrorMessage(error)}`,
      );
    }
  }

  private canEmit(): boolean {
    if (!this.enabled) {
      return false;
    }

    return Boolean(this.client && this.connected);
  }

  async productUpdated(product: Product): Promise<void> {
    if (!this.canEmit()) {
      this.logger.warn(
        'Skipping productUpdated emit because Kafka producer is not ready',
      );
      return;
    }
    try {
      await this.emit(this.topics.productUpdated, product.id, product, {
        eventType: this.topics.productUpdated,
        source: 'billing-service',
        timestamp: Date.now().toString(),
      });
    } catch (error) {
      this.logger.error(
        `Emit failed for product updated event: ${getErrorMessage(error)}`,
      );
    }
  }

  async emit<T extends ProductEventPayload>(
    topic: string,
    key: string,
    payload: T,
    headers: Record<string, string>,
  ): Promise<void> {
    if (!this.canEmit()) {
      return;
    }
    try {
      await lastValueFrom(
        this.client.emit(topic, {
          key: key,
          value: JSON.stringify({ ...payload, transactionId: key }),
          headers: { ...headers, 'idempotency-key': key },
        }),
      );
      this.logger.debug(`Emitted event "${topic}" with key=${key}`);
    } catch (error) {
      this.logger.error(
        `Emit failed for topic="${topic}": ${getErrorMessage(error)}`,
      );
      throw error;
    }
  }
}
