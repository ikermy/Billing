// main.ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationError } from 'class-validator';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { getErrorMessage } from 'src/shared/utils/error.util';

export const clientId = process.env.KAFKA_CLIENT_ID;
export const brokers = process.env.KAFKA_BROKERS?.split(',');
export const groupId = process.env.KAFKA_GROUP_ID;

type HttpAdapterInstance = {
  disable?: (setting: string) => void;
};

type SwaggerOperation = {
  get(field: 'method' | 'path'): string;
};

function getCorsOrigins(): string[] {
  const raw =
    process.env.CORS_ORIGINS ??
    (process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : '');

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const NODE_ENV = process.env.NODE_ENV;
  const corsOrigins = getCorsOrigins();
  const swaggerEnabled =
    process.env.ENABLE_SWAGGER === 'true' || NODE_ENV === 'development';
  const httpAdapter = app
    .getHttpAdapter()
    .getInstance() as unknown as HttpAdapterInstance;

  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  if (typeof httpAdapter?.disable === 'function') {
    httpAdapter.disable('x-powered-by');
  }
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // для Swagger static
    }),
  );
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb', parameterLimit: 50 }));
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    exposedHeaders: ['Authorization'],
  });

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Barcode API')
      .setDescription('Barcode endpoints')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          in: 'header',
        },
        'JWT',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: {
        operationsSorter: (a: SwaggerOperation, b: SwaggerOperation) => {
          const order: Record<string, number> = {
            post: 1,
            patch: 2,
            delete: 3,
            get: 4,
          };

          const methodA = a.get('method').toLowerCase();
          const methodB = b.get('method').toLowerCase();
          const rankA = order[methodA] ?? 99;
          const rankB = order[methodB] ?? 99;

          if (rankA < rankB) return -1;
          if (rankA > rankB) return 1;
          const pathA = a.get('path');
          const pathB = b.get('path');
          return pathA.localeCompare(pathB);
        },
      },
    });
  }

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: {
        target: false,
        value: false,
      },
      exceptionFactory: (errors) => {
        logger.error(errors.map((error) => summarizeValidationError(error)));
        return new BadRequestException(errors);
      },
    }),
  );

  const kafkaEnabled = process.env.KAFKA_ENABLED === 'true';

  if (kafkaEnabled) {
    if (!clientId) logger.warn('KAFKA_CLIENT_ID not set');
    if (!brokers) logger.warn('KAFKA_BROKERS not set');
    if (!groupId) logger.warn('KAFKA_GROUP_ID not set');

    if (clientId && brokers && groupId) {
      app.connectMicroservice<MicroserviceOptions>({
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId,
            brokers,
            connectionTimeout: 3000,
            requestTimeout: 5000,
            retry: {
              retries: 2,
              initialRetryTime: 300,
              factor: 2,
            },
          },
          consumer: { groupId },
          subscribe: { fromBeginning: false },
        },
      });

      try {
        await app.startAllMicroservices();
        logger.log('Kafka microservice started');
      } catch (error) {
        logger.error(
          `Kafka disabled (failed to start): ${getErrorMessage(error)}`,
        );
      }
    } else {
      logger.warn(
        'Kafka is enabled but required env vars are missing; skipping Kafka startup.',
      );
    }
  } else {
    logger.log('Kafka disabled via KAFKA_ENABLED !== "true"');
  }

  const port = Number(process.env.PORT ?? 6001);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  await app.listen(port);
  logger.log(`HTTP server listening on http://localhost:${port}`);
}

function summarizeValidationError(
  error: ValidationError,
): Record<string, unknown> {
  return {
    property: error.property,
    constraints: error.constraints
      ? Object.values(error.constraints)
      : undefined,
    children: error.children?.map((child) => summarizeValidationError(child)),
  };
}

void bootstrap();
