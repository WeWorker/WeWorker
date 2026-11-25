import { defineConfig, configDefaults } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Local publishing helpers import pinned upstream code with the same error
  // binding used by the Adapter build and its dedicated upstream test suite.
  resolve: { alias: {
    '@jackwener/opencli/errors': fileURLToPath(new URL('./scripts/opencli-xiaohongshu/errors.js', import.meta.url)),
  } },
  plugins: [{
    name: 'cli-test-import',
    transform(code, id, options) {
      // Vitest wraps SSR imports in a function, where a CLI hashbang is invalid.
      if (options?.ssr && id.endsWith('/webcli/index.js')) return code.replace(/^#![^\r\n]*(?:\r?\n|$)/, '\n');
    },
  }],
  test: {
    globals: true,
    testTimeout: 20000,
    // Tests never launch WeWorker 浏览器 unless a test opts in explicitly.
    env: { WEWORKER_BROWSER_MODE: 'system' },
    // Pinned upstream tests use their own module aliases and dedicated config.
    exclude: [...configDefaults.exclude, 'scripts/opencli-xiaohongshu/upstream/**', 'scripts/opencli-wave4/upstream/**'],
  },
})
