import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';

import type { ApiRequest } from '../http';
import { CustomBlacklistService } from './custom-blacklist.service';

@Controller('v1/channels/:channel_id/blacklist')
export class CustomBlacklistController {
  constructor(private readonly blacklist: CustomBlacklistService) {}

  @Get()
  read(@Param('channel_id') channelId: string, @Req() request: ApiRequest) {
    return this.blacklist.read(request.account!.id, channelId);
  }

  @Post()
  @HttpCode(200)
  save(@Param('channel_id') channelId: string, @Body() body: unknown, @Req() request: ApiRequest) {
    return this.blacklist.save(request.account!.id, channelId, body);
  }
}
