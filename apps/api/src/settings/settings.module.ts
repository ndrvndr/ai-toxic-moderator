import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AiModerationSettingsController } from './ai-moderation-settings.controller';
import { AiModerationSettingsService } from './ai-moderation-settings.service';
import { CustomBlacklistController } from './custom-blacklist.controller';
import { CustomBlacklistService } from './custom-blacklist.service';

@Module({
  imports: [AuthModule],
  controllers: [CustomBlacklistController, AiModerationSettingsController],
  providers: [CustomBlacklistService, AiModerationSettingsService],
})
export class SettingsModule {}
