import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LiveAccessService } from './live-access.service';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [AuthModule],
  providers: [LiveAccessService, LiveGateway],
})
export class LiveModule {}
