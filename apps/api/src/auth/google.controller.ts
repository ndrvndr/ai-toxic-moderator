import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';

import type { AppConfig } from '@moderator/config';

import { APP_CONFIG } from '../database.module';
import type { ApiRequest, ApiResponse } from '../http';
import { GoogleService, oauthBrowserToken, oauthCookie } from './google.service';
import { Public } from './guards';
import { cookieToken, sessionCookie } from './session.service';

@Controller('v1')
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('auth/providers')
  providers() {
    return { google: this.config.GOOGLE_AUTH_ENABLED };
  }

  @Public()
  @Get('auth/google')
  async start(@Req() request: ApiRequest, @Res() response: ApiResponse) {
    const attempt = await this.google.start(oauthBrowserToken(request.headers.cookie));
    response.setHeader('Set-Cookie', oauthCookie(attempt.browser));
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.writeHead(302, { Location: attempt.url }).end();
  }

  @Public()
  @Get('auth/google/callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: ApiRequest,
    @Res() response: ApiResponse,
  ) {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Set-Cookie', oauthCookie('', 0));
    try {
      const token = await this.google.complete(
        typeof query.state === 'string' ? query.state : '',
        oauthBrowserToken(request.headers.cookie),
        typeof query.code === 'string' ? query.code : undefined,
        query.error !== undefined,
        cookieToken(request.headers.cookie),
      );
      response.setHeader('Set-Cookie', [
        oauthCookie('', 0),
        sessionCookie(token, this.config.SESSION_TTL_SECONDS),
      ]);
      response
        .writeHead(303, { Location: `${this.config.DASHBOARD_ORIGIN}/?auth=connected` })
        .end();
    } catch {
      // Never reflect provider descriptions, authorization codes, or credentials into the browser URL.
      response.writeHead(303, { Location: `${this.config.DASHBOARD_ORIGIN}/?auth=failed` }).end();
    }
  }

  @Get('youtube/broadcasts')
  broadcasts(@Req() request: ApiRequest) {
    return this.google.broadcasts(request.account!.id);
  }
}
