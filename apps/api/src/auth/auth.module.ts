import { Body, Controller, Get, HttpCode, Inject, Module, Post, Req, Res } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import type { AppConfig } from '@moderator/config';
import { devSessionInput, devSessionResponse } from '@moderator/contracts';

import { APP_CONFIG } from '../database.module';
import { failure, type ApiRequest, type ApiResponse } from '../http';
import { ChannelGuard, OriginGuard, Public, SessionGuard } from './guards';
import { cookieToken, sessionCookie, SessionService } from './session.service';

@Controller('v1')
class AuthController {
  constructor(
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  @Public()
  @Post('auth/dev-session')
  async login(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    const result = devSessionInput.safeParse(body);
    if (!result.success)
      throw failure(422, 'VALIDATION_ERROR', 'Body login harus berupa object kosong.');
    const session = await this.sessions.create(cookieToken(request.headers.cookie));
    response.setHeader('Set-Cookie', sessionCookie(session.token, this.config.SESSION_TTL_SECONDS));
    return devSessionResponse.parse({ expires_at: session.expires_at });
  }
  @Get('me')
  me(@Req() request: ApiRequest) {
    return this.sessions.me(request.account!);
  }
  @Post('auth/logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() request: ApiRequest,
    @Res({ passthrough: true }) response: ApiResponse,
  ) {
    if (!devSessionInput.safeParse(body).success)
      throw failure(422, 'VALIDATION_ERROR', 'Body logout harus berupa object kosong.');
    await this.sessions.revoke(request.sessionHash!);
    response.setHeader('Set-Cookie', sessionCookie('', 0));
  }
}
@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: ChannelGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
