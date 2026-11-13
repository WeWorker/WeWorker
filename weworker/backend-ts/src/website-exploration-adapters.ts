import { createHash } from 'node:crypto'
import { Router } from 'express'
import { buildAdapterCatalog } from '../../../webcli/adapter-catalog.js'
import { readPackageDirectory, validatePackageFiles } from '../../../webcli/adapter-package-files.js'
import { installAdapter, removeInstalledAdapter } from '../../../webcli/adapter-install-store.js'
import { describeGeneratedInstall, resolveGeneratedInstallApproval } from '../../../webcli/generation-harness/install-review.js'

const AGENT = process.env.WEWORKER_WEBWRIGHT_URL || 'http://127.0.0.1:8766'
const id = /^[A-Za-z0-9_-]+$/
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

type AgentPackage = { operation_id: string; install_baseline_digest?: string | null; profile?: string; changed_tools?: string[]; name: string; digest: string; files: Record<string, string>; base?: { name: string; profile: string; digest: string; files: Record<string, string> } | null }

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
  onDevelopmentHandoff,
  onListDevelopmentChats,
}: {
  instanceId?: string
  fetchAgent?: typeof fetch
  onListDevelopmentChats?: () => unknown | Promise<unknown>
  onDevelopmentHandoff?: (input: unknown) => unknown | Promise<unknown>
  onInstalled?: (event: { name: string; revision: number; profile: string }) => void | Promise<void>
} = {}) {
  const router = Router()
  const agent = async (path: string, body?: object) => {
    if (!instanceId) throw new Error('网站探索服务尚未就绪')
    const healthResponse = await fetchAgent(AGENT + '/api/health', { signal: AbortSignal.timeout(3000), redirect: 'error' })
    const health = healthResponse.ok ? await healthResponse.json() : null
    if (!health?.ok || health.instance_id !== instanceId) throw new Error('网站探索服务实例不匹配')
    const response = await fetchAgent(AGENT + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-WeWorker-Exploration-Instance': instanceId }, body: JSON.stringify(body) }),
    })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result?.error?.message || result?.detail || '网站探索操作失败'), { status: response.status })
    return result
  }
  const handle = (operation: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json(await operation(req)) }
    catch (error) { res.status(409).json({ detail: error instanceof Error ? error.message : String(error) }) }
  }

  router.get('/development/chats', handle(async () => {
    if (!onListDevelopmentChats) throw new Error('网站适配器生成入口不可用')
    return onListDevelopmentChats()
  }))

  router.post('/explorations/:id/development/chat', handle(async req => {
    if (!onDevelopmentHandoff) throw new Error('网站适配器生成入口不可用')
    if (!id.test(req.params.id)) throw new Error('无效的探索记录')
    // run_id is a host-side concurrency token, not a Python input field.
    const { run_id: expectedRunId, ...payload } = req.body || {}
    const input = await agent(`/api/explorations/${req.params.id}/development/input`, payload)
    if (input?.source_exploration?.exploration_id !== req.params.id) {
      throw new Error('网站适配器生成输入目标不匹配')
    }
    if (expectedRunId !== undefined && expectedRunId !== (input.source_exploration.run_id ?? null)) {
      throw new Error('探索轮次已变化，请刷新后重试')
    }
    return onDevelopmentHandoff(input)
  }))

  const deleting = new Set<string>()
  const applying = new Set<string>()
  const deleteCommand = async ({ name, commandId, toolkitId, toolId, expectedDigest }: {
    name: string; commandId: string; toolkitId?: string; toolId?: string; expectedDigest: string | null
  }) => {
    if (!namePattern.test(name) || !id.test(commandId) || (toolkitId && !id.test(toolkitId)) || (toolId && !id.test(toolId))) {
      throw new Error('Invalid Tool identity.')
    }
    if (deleting.has(name) || applying.has(name)) throw new Error('Adapter deletion is already running.')
    deleting.add(name)
    try {
      const catalog = buildAdapterCatalog()
      const active = catalog.effective.find((entry: any) => entry.name === name)
      if ((active?.digest || null) !== expectedDigest) throw new Error('Adapter 已变化，请刷新后重新确认删除。')
      const command = active?.manifest.commands.find((item: { id: string }) => item.id === commandId)
      if (!toolkitId && !command) throw new Error('已安装命令不存在，请刷新目录。')
      if (command && (active?.source !== 'user' || active.origin?.kind !== 'generated')) {
        throw new Error('只能从Adapter工坊生成的用户 Adapter 中删除已安装命令。')
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
        const afterCatalog = pkg ? buildAdapterCatalog() : null
        try {
          await agent(`/api/toolkits/${toolkitId}/tools/${toolId}/delete-finish`, {
            transaction_id: transactionId,
            restore: false,
            ...(pkg ? (uninstall
              ? { host_uninstalled: true, host_revision: afterCatalog!.revision }
              : {
                  host_revision: afterCatalog!.revision,
                  host_package: {
                    digest: updated!.digest,
                    files: Object.fromEntries([...updated!.files].map(([path, content]) => [path, content.toString('base64')])),
                  },
                }) : {}),
          })
        }
        catch { cleanupPending = true }
      }
      if (pkg) {
        try { await onInstalled({ name, revision: buildAdapterCatalog().revision, profile: catalog.profile }) }
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

  const extendAdapter = async (name: string, expectedDigest?: string) => {
    if (!namePattern.test(name)) throw new Error('Invalid Adapter name.')
    const catalog = buildAdapterCatalog()
    const active = catalog.effective.find((entry: any) => entry.name === name)
    if (!active) throw new Error('Adapter is unavailable. Refresh the catalog.')
    const pkg = readPackageDirectory(active.root)
    if (pkg.digest !== active.digest || (expectedDigest && pkg.digest !== expectedDigest)) throw new Error('Adapter changed during import.')
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
  }
  router.post('/adapters/:name/extend', handle(async req => extendAdapter(req.params.name)))

  router.post('/adapters/:name/development-prepare', handle(async req => {
    const name = req.params.name
    const { expectedDigest, toolkitId } = req.body || {}
    if (!namePattern.test(name) || typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest)
        || (toolkitId !== undefined && (typeof toolkitId !== 'string' || !id.test(toolkitId)))
        || Object.keys(req.body || {}).some(key => !['expectedDigest', 'toolkitId'].includes(key))) throw new Error('无效的 Adapter 准备参数')
    const catalog = buildAdapterCatalog()
    const active = catalog.effective.find((entry: any) => entry.name === name)
    if (!active || active.digest !== expectedDigest) throw new Error('Adapter 已变化，请重新读取目录')
    const readWorkspaces = async () => {
      const response = await agent('/api/development/commands/list', {})
      if (response.ok !== true || !Array.isArray(response.data?.workspaces)) throw new Error('无法读取开发工作区')
      return response.data.workspaces as Array<any>
    }
    let workspaces = await readWorkspaces()
    const matches = workspaces.filter(item => item.adapter_id === name && (!item.profile || item.profile === catalog.profile))
    let workspace = toolkitId ? matches.find(item => item.toolkit_id === toolkitId) : matches.length === 1 ? matches[0] : undefined
    if (toolkitId && !workspace) throw new Error('指定工作区不属于当前 Adapter 或 profile')
    if (!toolkitId && matches.length > 1) throw new Error('存在多个工作区，请根据 development.list 指定 toolkit_id，不能自动覆盖')
    if (!workspace) {
      const created = await extendAdapter(name, expectedDigest)
      workspaces = await readWorkspaces()
      workspace = workspaces.find(item => item.toolkit_id === created.toolkit_id && item.adapter_id === name)
    }
    if (!workspace || workspace.install_baseline_digest !== expectedDigest) throw new Error('工作区基线与已安装 Adapter 不一致，请先处理版本冲突；未覆盖现有内容')
    const current = buildAdapterCatalog()
    if (current.profile !== catalog.profile || current.effective.find((entry: any) => entry.name === name)?.digest !== expectedDigest) throw new Error('准备期间 Adapter 已变化，请重新读取目录')
    const retainedIds = new Set((workspace.retained_commands || []).map((command: any) => command.id))
    const editable = workspace.tools.filter((tool: any) => {
      const command = active.manifest.commands.find((command: any) => command.id === tool.command_id)
      return !retainedIds.has(tool.command_id) && (!command || (command.runtime === 'wewright' && (tool.has_formal || tool.has_development)))
    })
    const editableIds = new Set(editable.map((tool: any) => tool.command_id))
    return { toolkit_id: workspace.toolkit_id, adapter_id: name, digest: expectedDigest, profile: catalog.profile,
      revision: workspace.revision, allowed_domains: workspace.allowed_domains, editable_tools: editable,
      retained_commands: active.manifest.commands.filter((command: any) => !editableIds.has(command.id)),
      installation_changed: false, mode: editable.length ? 'edit_and_extend' : 'extend_only' }
  }))

  const packageFor = async (toolkitId: string) => {
    if (!id.test(toolkitId)) throw new Error('Invalid workspace ID.')
    const payload = await agent(`/api/toolkits/${toolkitId}/v2-package`) as AgentPackage
    const pkg = decodePackage(payload.files)
    if (typeof payload.operation_id !== 'string' || !/^[a-f0-9]{64}-[0-9]+$/.test(payload.operation_id) || !payload.operation_id.startsWith(pkg.digest + '-')) {
      throw new Error('网站探索服务未返回有效的安装操作，请更新并重启服务。')
    }
    if (pkg.name !== payload.name || pkg.digest !== payload.digest) throw new Error('Published Adapter snapshot changed.')
    if (payload.base) {
      if (payload.base.profile !== buildAdapterCatalog().profile) throw new Error('Adapter workspace belongs to another build profile.')
      const base = decodePackage(payload.base.files)
      if (base.name !== payload.base.name || base.digest !== payload.base.digest) throw new Error('Adapter baseline changed.')
      retainedFilesUnchanged(base, pkg)
    }
    if (payload.profile && payload.profile !== buildAdapterCatalog().profile) throw new Error('Adapter workspace belongs to another build profile.')
    return { pkg, base: payload.base, baselineDigest: payload.install_baseline_digest, changedTools: payload.changed_tools || [], operationId: payload.operation_id }
  }
  const describe = async (toolkitId: string) => {
    let candidate = await packageFor(toolkitId)
    let review = describeGeneratedInstall({ adapterDir: '' }, { pkg: candidate.pkg })
    // Reconcile a prior host commit before reviewing a newer draft. This also
    // advances its version when the earlier installation response was lost.
    if (review.baselineDigest && review.baselineDigest !== candidate.baselineDigest && review.baselineDigest !== candidate.pkg.digest) {
      const recovered = await agent(`/api/toolkits/${toolkitId}/installation-reconcile`, {
        digest: review.baselineDigest, revision: review.stateRevision, profile: review.profile,
      })
      if (recovered.reconciled === true) {
        candidate = await packageFor(toolkitId)
        review = describeGeneratedInstall({ adapterDir: '' }, { pkg: candidate.pkg })
      }
    }
    return { pkg: candidate.pkg, review, baseDigest: candidate.baselineDigest ?? candidate.base?.digest ?? null,
      changedTools: candidate.changedTools, operationId: candidate.operationId }
  }

  router.get('/toolkits/:id/install-review', handle(async req => {
    const { review, baseDigest, changedTools } = await describe(req.params.id)
    return { ...review, changedTools, draftBaseDigest: baseDigest, applied: review.baselineDigest === review.digest,
      overwritesNewerBase: !!baseDigest && review.baselineDigest !== baseDigest && review.baselineDigest !== review.digest }
  }))

  router.post('/toolkits/:id/install-apply', handle(async req => {
    const { pkg, review, operationId, baseDigest } = await describe(req.params.id)
    if (applying.has(pkg.name) || deleting.has(pkg.name)) throw new Error('Adapter 正在应用，请稍后重试。')
    applying.add(pkg.name)
    try {
      const approval = { reviewId: req.body?.reviewId, acceptChanges: req.body?.acceptChanges === true }
      if (review.reviewId !== approval.reviewId) throw new Error('安装评审已变化，请重新检查。')
      if (baseDigest && review.baselineDigest !== baseDigest && review.baselineDigest !== pkg.digest && !approval.acceptChanges) {
        throw new Error('将覆盖草稿创建后安装的更新，请确认后应用。')
      }
      const installed = review.baselineDigest === pkg.digest
        ? { name: pkg.name, version: pkg.version, digest: pkg.digest, revision: review.stateRevision }
        : installAdapter({ files: pkg.files, origin: { kind: 'generated' }, activate: true,
          expectedSourceDigest: review.baselineDigest, ...resolveGeneratedInstallApproval(review, approval) })
      let refreshed = true
      let acknowledged = true
      try { await onInstalled({ name: installed.name, revision: installed.revision, profile: review.profile }) }
      catch { refreshed = false }
      try { await agent(`/api/toolkits/${req.params.id}/installation-ack`, {
        digest: installed.digest, revision: installed.revision, profile: review.profile, operation_id: operationId,
      }) } catch { acknowledged = false }
      return { name: installed.name, version: installed.version, digest: installed.digest,
        revision: installed.revision, refreshed, acknowledged }
    } finally { applying.delete(pkg.name) }
  }))
  return router
}
