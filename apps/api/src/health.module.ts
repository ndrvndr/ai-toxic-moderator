import { Controller, Get, Module } from '@nestjs/common';

import { Public } from './auth/guards';
import { DatabaseService } from './database.module';
import { failure } from './http';

@Public()
@Controller('health')
class HealthController {
  constructor(private readonly database: DatabaseService) {}
  @Get('live') live() {
    return { status: 'alive', stage: 'dev-session-access', mode: 'SIMULATION' };
  }
  @Get('ready') async ready() {
    try {
      await this.database.pool.query('SELECT 1 FROM configuration_bundles LIMIT 1');
      await this.database.pool.query('SELECT 1 FROM dashboard_sessions LIMIT 1');
      await this.database.pool.query('SELECT auth_provider FROM dashboard_sessions LIMIT 1');
      await this.database.pool.query('SELECT 1 FROM google_oauth_attempts LIMIT 1');
    } catch {
      throw failure(503, 'NOT_READY', 'The database or migrations are not ready.');
    }
    return {
      status: 'ready',
      stage: 'dev-session-access',
      checks: { database: 'available' },
      moderation_pipeline: 'not_implemented',
    };
  }
}
@Module({ controllers: [HealthController] })
export class HealthModule {}
