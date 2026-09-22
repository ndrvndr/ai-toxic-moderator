import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';

import { failure, type ApiRequest } from '../http';
import { MonitoringService } from './monitoring.service';

@Controller('v1')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Post('monitoring/start')
  @HttpCode(200)
  start(@Body() body: unknown, @Req() request: ApiRequest) {
    const requestKey = request.headers['idempotency-key'];

    if (typeof requestKey !== 'string') {
      throw failure(422, 'VALIDATION_ERROR', 'Provide a UUID in the Idempotency-Key header.');
    }

    return this.monitoring.start(request.account!.id, requestKey, body);
  }

  @Get('channels/:channel_id/monitoring/:run_id')
  status(
    @Param('channel_id') channelId: string,
    @Param('run_id') runId: string,
    @Req() request: ApiRequest,
  ) {
    return this.monitoring.status(request.account!.id, channelId, runId);
  }

  @Post('channels/:channel_id/monitoring/:run_id/stop')
  @HttpCode(200)
  stop(
    @Param('channel_id') channelId: string,
    @Param('run_id') runId: string,
    @Body() body: unknown,
    @Req() request: ApiRequest,
  ) {
    return this.monitoring.stop(request.account!.id, channelId, runId, body);
  }

  @Get('youtube/broadcasts/:broadcast_id/monitoring')
  latest(@Param('broadcast_id') broadcastId: string, @Req() request: ApiRequest) {
    return this.monitoring.latest(request.account!.id, broadcastId);
  }
}
