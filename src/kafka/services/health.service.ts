// src/kafka/kafka-health.service.ts
import { Injectable } from '@nestjs/common';
import { Kafka, logLevel } from 'kafkajs';

@Injectable()
export class HealthService {
  private readonly enabled = process.env.KAFKA_ENABLED === 'true';

  async checkHealth(): Promise<'ok' | 'error'> {
    if (!this.enabled) return 'ok';

    const clientId = process.env.KAFKA_CLIENT_ID;
    if (!clientId) {
      throw new Error('Missing required environment variable: KAFKA_CLIENT_ID');
    }

    const rawBrokers = process.env.KAFKA_BROKERS;
    if (!rawBrokers) {
      throw new Error('Missing required environment variable: KAFKA_BROKERS');
    }
    const brokers = rawBrokers.split(',');

    const kafka = new Kafka({
      clientId: clientId,
      brokers: brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 0 },
    });

    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.listTopics();
      return 'ok';
    } finally {
      await admin.disconnect();
    }
  }
}
