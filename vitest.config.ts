import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': path.resolve('apps/web/src') } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/web/src/**/*.test.ts', 'apps/web/src/**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
