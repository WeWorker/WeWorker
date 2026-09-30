import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: {
    '@jackwener/opencli/download/media-download': fileURLToPath(new URL('./scripts/opencli-xiaohongshu/download.js', import.meta.url)),
    '@jackwener/opencli/download': fileURLToPath(new URL('./scripts/opencli-xiaohongshu/download.js', import.meta.url)),
    '@jackwener/opencli/registry': fileURLToPath(new URL('./scripts/opencli-xiaohongshu/registry.js', import.meta.url)),
    '@jackwener/opencli/errors': fileURLToPath(new URL('./scripts/opencli-xiaohongshu/errors.js', import.meta.url)),
  } },
  test: { include: ['scripts/opencli-xiaohongshu/upstream/*.test.js', '__tests__/opencli-xiaohongshu-adapter.test.js'], testTimeout: 20000 },
});
