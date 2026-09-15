import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';

import type { AppConfig } from '@moderator/config';

import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { ChatModule } from './chat/chat.module';
import { DatabaseModule, type DatabasePool } from './database.module';
import { HealthModule } from './health.module';
import { ApiExceptionFilter, type ApiRequest, type ApiResponse } from './http';
import { MonitoringModule } from './monitoring/monitoring.module';

export async function createApi(config: AppConfig, pool?: DatabasePool) {
  @Module({
    imports: [
      DatabaseModule.register(config, pool),
      AuthModule,
      ChannelsModule,
      HealthModule,
      MonitoringModule,
      ChatModule,
    ],
  })
  class ApiModule {}
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  app.use((request: ApiRequest, response: ApiResponse, next: () => void) => {
    request.traceId = randomUUID();
    response.setHeader('X-Request-Id', request.traceId);
    response.setHeader('Cache-Control', 'no-store');
    const host = request.headers.host;
    const localPort = request.socket.localPort;
    const remote = request.socket.remoteAddress;
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
      ![`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`].includes(
        host ?? '',
      )
    ) {
      response.status(403).json({
        error: {
          code: 'HOST_FORBIDDEN',
          message: 'API development hanya tersedia pada loopback.',
          field_errors: [],
          trace_id: request.traceId,
        },
      });
      return;
    }
    next();
  });
  app.enableCors({
    origin: config.DASHBOARD_ORIGIN,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useBodyParser('json', { limit: '16kb' });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  return app;
}
