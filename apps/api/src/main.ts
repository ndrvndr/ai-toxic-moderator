import { loadConfig } from '@moderator/config';

import { createApi } from './app';

async function bootstrap() {
  const config = loadConfig();
  const app = await createApi(config);
  await app.listen(config.API_PORT, '127.0.0.1');
  console.log(
    'API development listening on localhost port ' +
      config.API_PORT +
      '; dev auth ' +
      (config.DEV_AUTH_ENABLED ? 'enabled' : 'disabled') +
      '.',
  );
}
bootstrap().catch(() => {
  console.error('API startup failed. Check local configuration and dependencies.');
  process.exitCode = 1;
});
