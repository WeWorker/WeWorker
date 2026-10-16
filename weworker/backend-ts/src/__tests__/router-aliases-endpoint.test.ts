/**
 * `GET /router/aliases` 单测。
 *
 * 这个接口是「输入框 `!别名` 与后端同源」的唯一入口：它一旦返回错东西，输入框就会把
 * shell 命令误判成路由命令（或反之）。所以除了正常路径，**配置坏掉必须返回空数组而不是
 * 500**——输入框据此回退到随包静态清单，`!` 命令不会整体失灵。
 *
 * 与 `generation-install-routes.test.ts` 同法：从 `server.ts` 抽出该 handler 源码在 VM 里跑，
 * 依赖用 stub 注入，不启动真实 Express。
 */

import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

function endpoint(options: {
  adapters: Array<{ id: string; enabled: boolean }>
  aliases?: string[]
  configThrows?: boolean
}) {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8')
  const start = source.indexOf("app.get('/router/aliases'")
  const end = source.indexOf('\n})', start) + 3
  expect(start).toBeGreaterThanOrEqual(0)

  let handler: (req: unknown, res: unknown) => void
  const warn = vi.fn()
  const getScopedRouterConfig = vi.fn((_adapterIds: ReadonlySet<string>) => {
    if (options.configThrows) throw new Error('bad config')
    return { bundle: { aliases: { aliases: (options.aliases ?? []).map((alias) => ({ id: alias, tool: 'x' })) } } }
  })
  const adapterMap = new Map(
    options.adapters.map((adapter) => [
      adapter.id,
      // `managed` 留空 → 真实 `getSiteEnabled` 就是回落到 defaultEnabled，stub 与之同形。
      { id: adapter.id, defaultEnabled: adapter.enabled, managed: undefined },
    ]),
  )
  const context = vm.createContext({
    app: {
      get: (_route: string, callback: typeof handler) => {
        handler = callback
      },
    },
    parseAllAdapters: () => adapterMap,
    getSiteEnabled: (_id: string, _default: boolean, _managed: unknown) => _default,
    getScopedRouterConfig,
    listAliasTexts: (entries: Array<{ id: string }> | undefined) =>
      (entries ?? []).map((entry) => `!${entry.id}`),
    log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  })

  vm.runInContext(
    ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  )

  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
  return { invoke: () => handler({}, res), res, warn, getScopedRouterConfig, adapterMap }
}

it('返回当前生效的别名清单', () => {
  const fixture = endpoint({ adapters: [{ id: 'example.com', enabled: true }], aliases: ['inbox', 'repos'] })
  fixture.invoke()
  expect(fixture.res.json).toHaveBeenCalledWith({ aliases: ['!inbox', '!repos'] })
})

it('只把已启用 Adapter 交给配置作用域（禁用站点的别名不该出现在输入框）', () => {
  const fixture = endpoint({
    adapters: [
      { id: 'example.com', enabled: true },
      { id: 'gone.example.org', enabled: false },
    ],
    aliases: ['inbox'],
  })
  fixture.invoke()
  const scoped = fixture.getScopedRouterConfig.mock.calls[0][0] as Set<string>
  expect([...scoped]).toEqual(['example.com'])
})

it('配置坏掉时返回空数组而不是 500（输入框据此回退静态清单）', () => {
  const fixture = endpoint({ adapters: [{ id: 'example.com', enabled: true }], configThrows: true })
  fixture.invoke()
  expect(fixture.res.json).toHaveBeenCalledWith({ aliases: [] })
  expect(fixture.res.status).not.toHaveBeenCalled()
  expect(fixture.warn).toHaveBeenCalled()
})

it('没有任何别名 → 空数组（公开基线就是这样）', () => {
  const fixture = endpoint({ adapters: [{ id: 'example.com', enabled: true }] })
  fixture.invoke()
  expect(fixture.res.json).toHaveBeenCalledWith({ aliases: [] })
})
