import { createHash } from 'node:crypto'
import { Router } from 'express'
import { buildAdapterCatalog } from '../../../webcli/adapter-catalog.js'
import { readPackageDirectory, validatePackageFiles } from '../../../webcli/adapter-package-files.js'
import { installAdapter, removeInstalledAdapter } from '../../../webcli/adapter-install-store.js'
import { describeGeneratedInstall, resolveGeneratedInstallApproval } from '../../../webcli/generation-harness/install-review.js'

const AGENT = 'http://127.0.0.1:8766'
const id = /^[A-Za-z0-9_-]+$/
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type AgentPackage = { name: string; digest: string; files: Record<string, string>; base?: { name: string; profile: string; digest: string; files: Record<string, string> } | null }

function decodePackage(files: Record<string, string>) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Adapter package is missing.')
  return validatePackageFiles(new Map(Object.entries(files).map(([name, value]) => [name, Buffer.from(value, 'base64')])))
}

function retainedFilesUnchanged(base: ReturnType<typeof decodePackage>, updated: ReturnType<typeof decodePackage>) {
  if (base.name !== updated.name) throw new Error('Adapter identity changed.')
  for (const [name, content] of base.files) {
    if (name !== 'manifest.json' && !updated.files.get(name)?.equals(content)) throw new Error('An existing Adapter file changed.')
  }
  for (const command of base.manifest.commands) {
    const retained = updated.manifest.commands.find((item: { id: string }) => item.id === command.id)
    if (JSON.stringify(retained) !== JSON.stringify(command)) throw new Error('An existing Adapter command changed.')
  }
  for (const [key, value] of Object.entries(base.manifest)) {
    if (['version', 'commands', 'runtime_allowed_hosts'].includes(key)) continue
    if (JSON.stringify(updated.manifest[key]) !== JSON.stringify(value)) throw new Error('Existing Adapter metadata changed.')
  }
  for (const host of base.manifest.runtime_allowed_hosts || []) {
    if (!updated.manifest.runtime_allowed_hosts?.includes(host)) throw new Error('An existing Adapter permission was removed.')
  }
}

export function createWebsiteExplorationAdapterRouter({
  instanceId = process.env.WEWORKER_EXPLORATION_INSTANCE_ID,
  fetchAgent = fetch,
  onInstalled = () => {},
}: {
  instanceId?: string
  fetchAgent?: typeof fetch
  onInstalled?: (event: { name: string; revision: number; profile: string }) => void
} = {}) {
  const router = Router()
  const agent = async (path: string, body?: object) => {
    if (!instanceId) throw new Error('网站探索服务尚未就绪')
    const healthResponse = await fetchAgent(AGENT + '/api/health', { signal: AbortSignal.timeout(3000), redirect: 'error' })
    const health = healthResponse.ok ? await healthResponse.json() : null
    if (!health?.ok || health.instance_id !== instanceId) throw new Error('网站探索服务实例不匹配')
    const response = await fetchAgent(AGENT + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result?.error?.message || result?.detail || '网站探索操作失败'), { status: response.status })
    return result
  }
  const handle = (operation: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json(await operation(req)) }
    catch (error) { res.status(409).json({ detail: error instanceof Error ? error.message : String(error) }) }
  }

  const deleting = new Set<string>()
  const deleteCommand = async ({ name, commandId, toolkitId, toolId, expectedDigest }: {
    name: string; commandId: string; toolkitId?: string; toolId?: string; expectedDigest: string | null
  }) => {
    if (!namePattern.test(name) || !id.test(commandId) || (toolkitId && !id.test(toolkitId)) || (toolId && !id.test(toolId))) {
      throw new Error('Invalid Tool identity.')
    }
    if (deleting.has(name)) throw new Error('Adapter deletion is already running.')
    deleting.add(name)
    try {
      const catalog = buildAdapterCatalog()
      const active = catalog.effective.find((entry: any) => entry.name === name)
      if ((active?.digest || null) !== expectedDigest) throw new Error('Adapter 已变化，请刷新后重新确认删除。')
      const command = active?.manifest.commands.find((item: { id: string }) => item.id === commandId)
      if (!toolkitId && !command) throw new Error('已安装命令不存在，请刷新目录。')
      if (command && (active?.source !== 'user' || active.origin?.kind !== 'generated')) {
        throw new Error('只能从网站探索agent生成的用户 Adapter 中删除已安装命令。')
      }
      if (command && command.runtime !== 'wewright') throw new Error('只能删除 Toolkit 命令。')
      const pkg = command ? readPackageDirectory(active!.root) : null
      if (pkg && pkg.digest !== active!.digest) throw new Error('Adapter 已变化，请刷新后重新确认删除。')
      const uninstall = !!pkg && pkg.manifest.commands.length === 1
      if (uninstall && catalog.candidates.some((entry: any) => entry.name === name && entry.source === 'builtin')) {
        throw new Error('卸载后会恢复同名内置 Adapter，无法通过此入口删除该 Tool。')
      }
      let updated: ReturnType<typeof validatePackageFiles> | null = null
      if (pkg && command && !uninstall) {
        const files = new Map(pkg.files)
        const remaining = pkg.manifest.commands.filter((item: { id: string }) => item.id !== commandId)
        files.set('manifest.json', Buffer.from(JSON.stringify({ ...pkg.manifest, commands: remaining }) + '\n'))
        if (!remaining.some((item: { module: string }) => item.module === command.module)) files.delete(command.module)
        if (!remaining.some((item: { runtime: string }) => item.runtime === command.runtime)) {
          for (const path of files.keys()) if (path.startsWith(command.runtime + '/')) files.delete(path)
        }
        updated = validatePackageFiles(files)
      }
      let transactionId: string | null = null
      if (toolkitId && toolId) {
        const toolkit = await agent(`/api/toolkits/${toolkitId}`) as { adapter_name?: string; name: string }
        if ((toolkit.adapter_name || toolkit.name.replaceAll('_', '-')) !== name) throw new Error('Tool 所属 Adapter 已变化。')
        await agent(`/api/toolkits/${toolkitId}/tools/${toolId}`)
        const staged = await agent(`/api/toolkits/${toolkitId}/tools/${toolId}/delete-prepare`, {}) as { transaction_id: string }
        transactionId = staged.transaction_id
      }
      try {
        if (pkg) {
          if (uninstall) removeInstalledAdapter(name, { expectedStateRevision: catalog.revision, expectedSourceDigest: pkg.digest })
          else installAdapter({ files: updated!.files, origin: active!.origin!, activate: true,
            expectedStateRevision: catalog.revision, expectedSourceDigest: pkg.digest })
        }
      } catch (error) {
        const after = buildAdapterCatalog().effective.find((entry: any) => entry.name === name)
        const committed = !!pkg && (uninstall ? !after : after?.digest === updated?.digest)
        if (!committed) {
          if (transactionId) {
            try { await agent(`/api/toolkits/${toolkitId}/tools/${toolId}/delete-finish`, { transaction_id: transactionId, restore: true }) }
            catch (restoreError) { throw new Error(`Adapter 更新失败，Tool 恢复也失败，需要检查：${String(restoreError)}`) }
          }
          throw error
        }
      }
      let cleanupPending = false
      if (transactionId) {
        try { await agent(`/api/toolkits/${toolkitId}/tools/${toolId}/delete-finish`, { transaction_id: transactionId, restore: false }) }
        catch { cleanupPending = true }
      }
      if (pkg) {
        try { onInstalled({ name, revision: buildAdapterCatalog().revision, profile: catalog.profile }) }
        catch { return { ok: true, uninstalled: uninstall, refreshed: false, cleanupPending } }
      }
      return { ok: true, uninstalled: uninstall, refreshed: true, cleanupPending }
    } finally { deleting.delete(name) }
  }

  router.get('/adapter-catalog', handle(async () => {
    const catalog = buildAdapterCatalog()
    if (catalog.diagnostics.some((item: { name?: string; names?: string[] }) => !item.name && !item.names)) throw new Error('Adapter catalog requires inspection.')
    return { profile: catalog.profile, revision: catalog.revision, adapters: catalog.effective.map((entry: any) => ({
      name: entry.name, version: entry.version, digest: entry.digest, source: entry.source,
      canDeleteGeneratedCommands: entry.source === 'user' && entry.origin?.kind === 'generated',
      description: entry.manifest.description,
      commands: entry.commands.map((command: any) => ({ id: command.id, runtime: command.runtime, description: command.description, schema: command.schema })),
    })) }
  }))

  router.delete('/toolkits/:id/tools/:toolId', handle(async req => {
    const toolkitId = req.params.id, toolId = req.params.toolId
    if (!id.test(toolkitId) || !id.test(toolId)) throw new Error('Invalid Tool identity.')
    const toolkit = await agent(`/api/toolkits/${toolkitId}`) as { adapter_name?: string; name: string }
    const name = toolkit.adapter_name || toolkit.name.replaceAll('_', '-')
    if (!Object.hasOwn(req.body || {}, 'expectedDigest')) throw new Error('Adapter digest is required.')
    return deleteCommand({ name, commandId: toolId.replaceAll('_', '-'), toolkitId, toolId, expectedDigest: req.body.expectedDigest })
  }))

  router.delete('/adapters/:name/commands/:commandId', handle(async req => {
    if (!Object.hasOwn(req.body || {}, 'expectedDigest')) throw new Error('Adapter digest is required.')
    return deleteCommand({ name: req.params.name, commandId: req.params.commandId, expectedDigest: req.body.expectedDigest })
  }))

  router.post('/adapters/:name/extend', handle(async req => {
    const name = req.params.name
    if (!namePattern.test(name)) throw new Error('Invalid Adapter name.')
    const catalog = buildAdapterCatalog()
    const active = catalog.effective.find((entry: any) => entry.name === name)
    if (!active) throw new Error('Adapter is unavailable. Refresh the catalog.')
    const pkg = readPackageDirectory(active.root)
    if (pkg.digest !== active.digest) throw new Error('Adapter changed during import.')
    const toolkitId = 'adapter_' + createHash('sha256').update(catalog.profile + ':' + name).digest('hex').slice(0, 16)
    let toolkit
    try { toolkit = await agent('/api/toolkits/' + toolkitId) }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
      const domains = [...new Set([...(pkg.manifest.match || []), ...(pkg.manifest.runtime_allowed_hosts || [])]
        .map((host: string) => host.replace(/^\*\./, ''))
        .filter((host: string) => /^[a-z0-9.-]+$/i.test(host) && host.includes('.')))]
      if (!domains.length) throw new Error('Adapter has no website host for Toolkit development.')
      toolkit = await agent('/api/toolkits', { name: toolkitId, description: pkg.manifest.description, allowed_domains: domains })
    }
    if (!toolkit.adapter_name) {
      await agent(`/api/toolkits/${toolkitId}/bind-adapter`, {
        profile: catalog.profile, digest: pkg.digest,
        files: Object.fromEntries([...pkg.files].map(([path, content]: [string, Buffer]) => [path, content.toString('base64')])),
      })
    }
    if (toolkit.adapter_name && toolkit.adapter_name !== name) throw new Error('Toolkit is bound to another Adapter.')
    if (toolkit.adapter_name) {
      const bound = await agent(`/api/toolkits/${toolkitId}/adapter-base`)
      if (bound.profile !== catalog.profile) throw new Error('Adapter workspace belongs to another build profile.')
    }
    return { toolkit_id: toolkitId, adapter_name: name }
  }))

  const packageFor = async (toolkitId: string) => {
    if (!id.test(toolkitId)) throw new Error('Invalid workspace ID.')
    const payload = await agent(`/api/toolkits/${toolkitId}/v2-package`) as AgentPackage
    const pkg = decodePackage(payload.files)
    if (pkg.name !== payload.name || pkg.digest !== payload.digest) throw new Error('Published Adapter snapshot changed.')
    if (payload.base) {
      if (payload.base.profile !== buildAdapterCatalog().profile) throw new Error('Adapter workspace belongs to another build profile.')
      const base = decodePackage(payload.base.files)
      if (base.name !== payload.base.name || base.digest !== payload.base.digest) throw new Error('Adapter baseline changed.')
      retainedFilesUnchanged(base, pkg)
    }
    return { pkg, base: payload.base }
  }
  const describe = async (toolkitId: string) => {
    const { pkg, base } = await packageFor(toolkitId)
    const review = describeGeneratedInstall({ adapterDir: '' }, { pkg })
    return { pkg, review, baseDigest: base?.digest || null }
  }

  router.get('/toolkits/:id/install-review', handle(async req => {
    const { review, baseDigest } = await describe(req.params.id)
    return { ...review, draftBaseDigest: baseDigest, applied: review.baselineDigest === review.digest,
      overwritesNewerBase: !!baseDigest && review.baselineDigest !== baseDigest && review.baselineDigest !== review.digest }
  }))

  router.post('/toolkits/:id/install-apply', handle(async req => {
    const { pkg, review } = await describe(req.params.id)
    const approval = { reviewId: req.body?.reviewId, acceptChanges: req.body?.acceptChanges === true }
    if (review.reviewId !== approval.reviewId) throw new Error('安装评审已变化，请重新检查。')
    if (review.baselineDigest === pkg.digest) return { name: pkg.name, version: pkg.version, digest: pkg.digest, revision: review.stateRevision, refreshed: true }
    const accepted = resolveGeneratedInstallApproval(review, approval)
    const installed = installAdapter({
      files: pkg.files, origin: { kind: 'generated' }, activate: true,
      expectedSourceDigest: review.baselineDigest, ...accepted,
    })
    let refreshed = true
    try { onInstalled({ name: installed.name, revision: installed.revision, profile: review.profile }) }
    catch { refreshed = false }
    return { name: installed.name, version: installed.version, digest: installed.digest, revision: installed.revision, refreshed }
  }))
  return router
}
