import {
  createConfiguredQueryRoute,
  loadQueryRouteConfig,
  type QueryRouteConfig,
  type QueryRouteContext,
  type QueryRouteDeps,
} from './query-router/configurable-query-route.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type BackendProfileQueryRoute = (context: QueryRouteContext) => Promise<boolean>

let queryRoute: BackendProfileQueryRoute | null = null
let defaultConfigLoaded = false

export function registerBackendProfileQueryRoute(route: BackendProfileQueryRoute): void {
  if (typeof route !== 'function') throw new TypeError('Backend profile query route must be a function')
  queryRoute = route
}

export function registerBackendProfileQueryRouteConfig(
  config: QueryRouteConfig,
  deps?: QueryRouteDeps,
): void {
  queryRoute = createConfiguredQueryRoute(config, deps)
}

export async function tryBackendProfileQueryRoute(context: QueryRouteContext): Promise<boolean> {
  loadDefaultQueryRouteConfigOnce()
  return queryRoute ? queryRoute(context) : false
}

export function resetBackendProfileQueryRouteForTests(): void {
  queryRoute = null
  defaultConfigLoaded = true
}

function loadDefaultQueryRouteConfigOnce(): void {
  if (defaultConfigLoaded || queryRoute) return
  defaultConfigLoaded = true
  const configPath = findDefaultQueryRouteConfigPath()
  if (!configPath) return
  queryRoute = createConfiguredQueryRoute(loadQueryRouteConfig(configPath))
}

function findDefaultQueryRouteConfigPath(): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const envPath = process.env.WEWORKER_QUERY_ROUTES_CONFIG
  const candidates = [
    ...(envPath ? [path.resolve(envPath)] : []),
    path.resolve(currentDir, 'query-routes.json'),
    path.resolve(process.cwd(), 'query-routes.public.json'),
    path.resolve(process.cwd(), '..', 'query-routes.public.json'),
    path.resolve(currentDir, '..', '..', 'query-routes.public.json'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
}
