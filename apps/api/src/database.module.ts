import { DynamicModule, Global, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';

import type { AppConfig } from '@moderator/config';
import { createPool } from '@moderator/persistence';

export const APP_CONFIG = Symbol('APP_CONFIG');
export type DatabasePool = ReturnType<typeof createPool>;
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  constructor(readonly pool: DatabasePool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
@Global()
@Module({})
export class DatabaseModule {
  static register(config: AppConfig, pool?: DatabasePool): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DatabaseService,
          useValue: new DatabaseService(pool ?? createPool(config.DATABASE_URL)),
        },
      ],
      exports: [APP_CONFIG, DatabaseService],
    };
  }
}
