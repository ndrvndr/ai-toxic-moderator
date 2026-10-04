import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AiOperationalStatusController } from './ai-operational-status.controller';
import { LiveAccessService } from './live-access.service';
import { LiveGateway } from './live.gateway';
import { SavedSessionsController } from './saved-sessions.controller';

@Module({
  imports: [AuthModule],
  controllers: [SavedSessionsController, AiOperationalStatusController],
  providers: [LiveAccessService, LiveGateway],
})
export class LiveModule {}
