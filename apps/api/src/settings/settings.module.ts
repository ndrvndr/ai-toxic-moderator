import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CustomBlacklistController } from './custom-blacklist.controller';
import { CustomBlacklistService } from './custom-blacklist.service';
import { ModerationSettingsController } from './moderation-settings.controller';
import { ModerationSettingsService } from './moderation-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [ModerationSettingsController, CustomBlacklistController],
  providers: [ModerationSettingsService, CustomBlacklistService],
})
export class SettingsModule {}
