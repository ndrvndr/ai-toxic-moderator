import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';

import type { AppConfig } from '@moderator/config';
import { uuid } from '@moderator/contracts';
import type { LiveEventPage } from '@moderator/persistence';

import { cookieToken } from '../auth/session.service';
import { APP_CONFIG } from '../database.module';
import { LiveAccessError, LiveAccessService, type LiveSubscription } from './live-access.service';

@Injectable()
export class LiveGateway implements OnModuleInit, OnModuleDestroy {
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });

  private readonly shutdown = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private readonly pending = new Set<Duplex>();
  private server: Server | undefined;

  constructor(
    private readonly adapter: HttpAdapterHost,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: LiveAccessService,
  ) {}

  onModuleInit(): void {
    this.server = this.adapter.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.onUpgrade);
  }

  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    this.server?.off('upgrade', this.onUpgrade);

    for (const socket of this.pending) {
      socket.destroy();
    }

    for (const socket of this.sockets.clients) {
      socket.terminate();
    }

    await Promise.allSettled([...this.tasks]);

    await new Promise<void>((resolve) => {
      this.sockets.close(() => resolve());
    });
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);

    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    this.track(this.upgrade(request, socket, head));
  };

  private reject(socket: Duplex, status: number): void {
    if (socket.destroyed) return;

    const reason =
      {
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        503: 'Service Unavailable',
      }[status] ?? 'Service Unavailable';

    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` + 'Connection: close\r\n' + 'Content-Length: 0\r\n\r\n',
    );
  }

  private subscription(request: IncomingMessage): LiveSubscription {
    const port = request.socket.localPort;
    const remote = request.socket.remoteAddress;

    if (
      request.headers.origin !== this.config.DASHBOARD_ORIGIN ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
      ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(
        request.headers.host ?? '',
      )
    ) {
      throw new LiveAccessError(403, 4003, 'Connection origin denied.');
    }

    if (
      request.method !== 'GET' ||
      !request.url ||
      request.url.length > 1024 ||
      !request.url.startsWith('/')
    ) {
      throw new LiveAccessError(400, 4000, 'Invalid connection request.');
    }

    const url = new URL(request.url, 'http://127.0.0.1');

    if (url.pathname !== '/v1/live') {
      throw new LiveAccessError(404, 4004, 'Endpoint not found.');
    }

    const allowed = new Set(['channel_id', 'session_id', 'after']);

    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
        throw new LiveAccessError(400, 4000, 'Invalid subscription parameters.');
      }
    }

    const channelId = url.searchParams.get('channel_id');
    const sessionId = url.searchParams.get('session_id');
    const after = url.searchParams.get('after');

    if (!uuid.safeParse(channelId).success || !uuid.safeParse(sessionId).success) {
      throw new LiveAccessError(400, 4000, 'Invalid subscription scope.');
    }

    if (
      after !== null &&
      (after.length > 19 ||
        !/^(0|[1-9][0-9]*)$/.test(after) ||
        BigInt(after) > 9223372036854775807n)
    ) {
      throw new LiveAccessError(400, 4000, 'Invalid live event cursor.');
    }

    return {
      channelId: channelId!,
      sessionId: sessionId!,
      after,
    };
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const onError = () => socket.destroy();
    socket.on('error', onError);

    const timeout = setTimeout(() => socket.destroy(), 15_000);
    timeout.unref();

    try {
      if (this.shutdown.signal.aborted || this.pending.size + this.sockets.clients.size >= 100) {
        this.reject(socket, 503);
        return;
      }

      this.pending.add(socket);

      const subscription = this.subscription(request);
      const token = cookieToken(request.headers.cookie);
      const initial = await this.access.read(token, subscription);

      if (socket.destroyed || this.shutdown.signal.aborted) return;

      this.sockets.handleUpgrade(request, socket, head, (client) => {
        this.track(this.stream(client, token, subscription, initial));
      });
    } catch (error) {
      this.reject(socket, error instanceof LiveAccessError ? error.status : 503);
    } finally {
      clearTimeout(timeout);
      this.pending.delete(socket);
      socket.off('error', onError);
    }
  }

  private send(socket: WebSocket, message: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false;

    if (socket.bufferedAmount > 256 * 1024) {
      socket.terminate();
      return false;
    }

    socket.send(JSON.stringify(message), (error) => {
      if (error) socket.terminate();
    });

    return true;
  }

  private async stream(
    socket: WebSocket,
    token: string | null,
    subscription: LiveSubscription,
    initial: LiveEventPage,
  ): Promise<void> {
    const disconnected = new AbortController();
    const signal = AbortSignal.any([disconnected.signal, this.shutdown.signal]);

    let alive = true;
    let cursor = subscription.after ?? initial.watermark;

    socket.on('error', () => socket.terminate());
    socket.once('close', () => disconnected.abort());
    socket.on('message', () => socket.close(1008, 'This connection is read-only.'));
    socket.on('pong', () => {
      alive = true;
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;

      if (!alive) {
        socket.terminate();
        return;
      }

      alive = false;
      socket.ping();
    }, 15_000);

    heartbeat.unref();

    const scope = {
      channel_id: subscription.channelId,
      session_id: subscription.sessionId,
    };

    try {
      if (
        !this.send(socket, {
          type: 'ready',
          ...scope,
          cursor,
        })
      ) {
        return;
      }

      let page = initial;

      while (!signal.aborted && socket.readyState === WebSocket.OPEN) {
        if (page.items.length > 0) {
          if (
            !this.send(socket, {
              type: 'events',
              ...scope,
              items: page.items,
              cursor: page.next_cursor,
            })
          ) {
            return;
          }

          cursor = page.next_cursor;
        }

        await delay(page.has_more ? 0 : 500, undefined, { signal });

        if (socket.readyState !== WebSocket.OPEN) return;

        page = await this.access.read(token, {
          ...subscription,
          after: cursor,
        });
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof LiveAccessError) {
          socket.close(error.closeCode, error.message);
        } else {
          socket.close(1011, 'Live feed unavailable.');
        }
      }
    } finally {
      clearInterval(heartbeat);
    }
  }
}
