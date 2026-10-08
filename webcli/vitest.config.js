import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 20000,
    // Pinned upstream tests use their own module aliases and dedicated config.
    exclude: [...configDefaults.exclude, 'scripts/opencli-xiaohongshu/upstream/**', 'scripts/opencli-wave4/upstream/**'],
  },
})
