import 'reflect-metadata';
import { Controller, Get, Module, ServiceUnavailableException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@moderator/config';
import { createPool } from '@moderator/persistence';

@Injectable()
class DatabaseService implements OnApplicationShutdown {
  readonly pool=createPool(loadConfig().DATABASE_URL);
  async onApplicationShutdown() { await this.pool.end(); }
}
@Controller('health')
class HealthController {
  constructor(private readonly database:DatabaseService) {}
  @Get('live') live() { return {status:'alive',stage:'foundation',mode:'SIMULATION'}; }
  @Get('ready') async ready() {
    try { await this.database.pool.query('SELECT 1 FROM configuration_bundles LIMIT 1'); }
    catch { throw new ServiceUnavailableException({status:'not_ready',stage:'foundation'}); }
    return {status:'ready',stage:'foundation',checks:{database:'available'},moderation_pipeline:'not_implemented'};
  }
}
@Module({controllers:[HealthController],providers:[DatabaseService]})
class ApiModule {}
async function bootstrap() {
  const config=loadConfig();
  const app=await NestFactory.create(ApiModule);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT,'127.0.0.1');
}
bootstrap().catch(()=>{ console.error('API startup failed. Check local configuration and dependencies.'); process.exitCode=1; });
