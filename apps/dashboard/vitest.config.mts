import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      '@moderator/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.mts'],
    include: ['tests/**/*.test.mts'],
    clearMocks: true,
    environmentOptions: {
      jsdom: {
        url: 'http://127.0.0.1:3000',
      },
    },
  },
});
