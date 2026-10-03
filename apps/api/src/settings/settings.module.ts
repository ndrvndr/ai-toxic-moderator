import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ModerationSettingsController } from './moderation-settings.controller';
import { ModerationSettingsService } from './moderation-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [ModerationSettingsController],
  providers: [ModerationSettingsService],
})
export class SettingsModule {}
