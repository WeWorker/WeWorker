import { defineConfig } from 'vitest/config'
import modelConfig from '../model.json'
import optionalProviders from './src/__tests__/fixtures/optional-model-providers.json'

export default defineConfig({
  define: {
    // Protocol and legacy-settings tests exercise optional deployment providers.
    // Production builds load only model.json through model-provider-config.cjs.
    __BUILD_PROVIDERS__: JSON.stringify([
      ...modelConfig.providers.map(({ encryptedApiKey, ...provider }) => provider),
      ...optionalProviders,
    ]),
    __BUILD_DEFAULT_PROVIDER__: JSON.stringify('anthropic'),
  },
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
    forks: {
      execArgv: ['--experimental-sqlite'],
    },
  },
})
