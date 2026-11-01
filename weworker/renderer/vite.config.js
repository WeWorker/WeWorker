import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { loadBuildDefines, publicProviders } = require('../scripts/model-provider-config.cjs')
const { normalizeDeploymentConfig } = require('../deployment-config.cjs')
const deploymentPath = fileURLToPath(new URL('../deployment.json', import.meta.url))
const deploymentConfigPath = fileURLToPath(new URL('../deployment-config.cjs', import.meta.url))

// Read git commit hash for dev mode
let devCommitHash = 'dev'
try {
  const { execSync } = await import('child_process')
  devCommitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
} catch {}

export default defineConfig(({ command }) => {
  const buildDefines = loadBuildDefines({ development: command === 'serve' })
  const deploymentConfig = normalizeDeploymentConfig(JSON.parse(fs.readFileSync(deploymentPath, 'utf8')))
  return {
    plugins: [{
      name: 'model-public-metadata',
      enforce: 'pre',
      configResolved(config) {
        // These files are read through CommonJS/fs, outside Vite's import graph.
        // Treat them as config dependencies so edits rebuild injected flags too.
        const profilePath = fileURLToPath(new URL('../build-profile.json', import.meta.url))
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
        const dependencies = [profilePath, deploymentPath, deploymentConfigPath]
        if (profile.modelProviders) dependencies.push(path.resolve(path.dirname(profilePath), profile.modelProviders))
        config.configFileDependencies.push(...dependencies.map(file => file.replaceAll('\\', '/')))
      },
      load(id) {
        const modelPath = fileURLToPath(new URL('../model.json', import.meta.url))
        if (id.split('?')[0].replaceAll('\\', '/') !== modelPath.replaceAll('\\', '/')) return null
        const config = JSON.parse(fs.readFileSync(modelPath, 'utf8'))
        return JSON.stringify({ ...config, providers: publicProviders(config.providers) })
      },
    }, react()],
    base: './',
    server: { port: 5173 },
    build: { outDir: 'dist' },
    define: {
      '__BUILD_PROVIDERS__': JSON.stringify(publicProviders(buildDefines.providers)),
      '__BUILD_DEFAULT_PROVIDER__': JSON.stringify(buildDefines.defaultProvider),
      '__BUILD_COMMIT_HASH__': JSON.stringify(buildDefines.commitHash || devCommitHash),
      '__BUILD_DEPLOYMENT_CONFIG__': JSON.stringify(deploymentConfig),
    },
  }
})
