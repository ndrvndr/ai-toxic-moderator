import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';

import type { ApiRequest } from '../http';
import { AiModerationSettingsService } from './ai-moderation-settings.service';

@Controller('v1/channels/:channel_id/ai-moderation-settings')
export class AiModerationSettingsController {
  constructor(private readonly settings: AiModerationSettingsService) {}

  @Get()
  read(@Param('channel_id') channelId: string, @Req() request: ApiRequest) {
    return this.settings.read(request.account!.id, channelId);
  }

  @Post()
  @HttpCode(200)
  save(@Param('channel_id') channelId: string, @Body() body: unknown, @Req() request: ApiRequest) {
    return this.settings.save(request.account!.id, channelId, body);
  }
}
