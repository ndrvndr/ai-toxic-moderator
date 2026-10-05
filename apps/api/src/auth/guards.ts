import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AppConfig } from '@moderator/config';
import { uuid } from '@moderator/contracts';

import { APP_CONFIG, DatabaseService } from '../database.module';
import { failure, type ApiRequest } from '../http';
import { cookieToken, SessionService, tokenHash } from './session.service';

const PUBLIC = Symbol('PUBLIC');
export const Public = () => SetMetadata(PUBLIC, true);
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') &&
      request.headers.origin !== this.config.DASHBOARD_ORIGIN
    )
      throw failure(403, 'ORIGIN_FORBIDDEN', 'The request origin is not allowed.');
    return true;
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}
  async canActivate(context: ExecutionContext) {
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])
    )
      return true;
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const token = cookieToken(request.headers.cookie);
    const account = await this.sessions.resolve(token);
    if (!account || !token)
      throw failure(401, 'UNAUTHENTICATED', 'Your session is unavailable or has expired.');
    request.account = account;
    request.sessionHash = tokenHash(token);
    return true;
  }
}
@Injectable()
export class ChannelGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const channelId = request.params.channel_id;
    if (channelId === undefined) return true;
    if (!uuid.safeParse(channelId).success)
      throw failure(422, 'VALIDATION_ERROR', 'The channel ID is invalid.', [
        { field: 'channel_id', code: 'invalid_format' },
      ]);
    if (!request.account) throw failure(401, 'UNAUTHENTICATED', 'A session is required.');
    const result = await this.database.pool.query(
      'SELECT role FROM channel_memberships WHERE channel_id=$1 AND account_id=$2',
      [channelId, request.account.id],
    );
    // Operators do not receive channel-content access just by having an operator role.
    if (!['OWNER', 'MODERATOR'].includes(result.rows[0]?.role))
      throw failure(403, 'CHANNEL_FORBIDDEN', 'You do not have access to this channel.');
    return true;
  }
}
