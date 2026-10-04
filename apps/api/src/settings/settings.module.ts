import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AiModerationSettingsController } from './ai-moderation-settings.controller';
import { AiModerationSettingsService } from './ai-moderation-settings.service';
import { CustomBlacklistController } from './custom-blacklist.controller';
import { CustomBlacklistService } from './custom-blacklist.service';
import { ModerationSettingsController } from './moderation-settings.controller';
import { ModerationSettingsService } from './moderation-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [
    ModerationSettingsController,
    CustomBlacklistController,
    AiModerationSettingsController,
  ],
  providers: [ModerationSettingsService, CustomBlacklistService, AiModerationSettingsService],
})
export class SettingsModule {}
