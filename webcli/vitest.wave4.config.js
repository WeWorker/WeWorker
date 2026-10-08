import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@jackwener/opencli/registry': fileURLToPath(new URL('./scripts/opencli-wave4/registry.js', import.meta.url)),
    '@jackwener/opencli/errors': fileURLToPath(new URL('./scripts/opencli-wave4/errors.js', import.meta.url)),
  } },
  test: { include: ['scripts/opencli-wave4/upstream/toutiao/*.test.js', 'scripts/opencli-wave4/upstream/arxiv/*.test.js', '__tests__/opencli-wave4-adapters.test.js'], testTimeout: 20000 },
});
