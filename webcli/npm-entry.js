#!/usr/bin/env node
/**
 * npm executable entry.
 *
 * Runs before the shared CLI core so the npm package gets its own Bridge port,
 * browser profile and writable state, while WeWorker desktop keeps using 3711.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareNpmEnvironment } from './npm-environment.js'
import { packagedMetricsEnvironment } from './npm-metrics.js'

const entry = fileURLToPath(new URL('./index.js', import.meta.url))
const packageDir = path.dirname(entry)
try {
  Object.assign(process.env, prepareNpmEnvironment(process.env))
  Object.assign(process.env, packagedMetricsEnvironment({ packageDir, env: process.env }))
} catch (error) {
  console.error(`[WebCLI] ${error.message}`)
  process.exit(1)
}

process.argv[1] = entry
await import(pathToFileURL(entry).href)
