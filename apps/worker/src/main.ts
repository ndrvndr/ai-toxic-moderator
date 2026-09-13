import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { loadConfig } from '@moderator/config';

async function bootstrap() {
  const config=loadConfig();
  // Registration only: do not consume messages until M1-07 has a durable processor.
  @Module({imports:config.WORKER_ENABLED ? [BullModule.forRoot({connection:{host:config.REDIS_HOST,port:config.REDIS_PORT}}),BullModule.registerQueue({name:'moderation.process'})] : []})
  class WorkerModule {}
  const app=await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('Nest worker foundation initialized; processor not implemented; no jobs consumed.');
  await app.close();
}
bootstrap().catch(()=>{console.error('Worker startup failed. Check local configuration.');process.exitCode=1;});
