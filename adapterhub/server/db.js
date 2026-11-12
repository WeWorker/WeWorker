
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createHubId, normalizeCommandName, normalizeDomain } from '../lib/adapt-package.js'

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
}

export function openCatalog(file = 'adapterhub.db') {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sites (
      hub_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      allowed_domains_json TEXT NOT NULL DEFAULT '[]',
      runtimes_json TEXT NOT NULL DEFAULT '{}',
      current_release_id INTEGER,
      site_download_count INTEGER NOT NULL DEFAULT 0,
      listed INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL REFERENCES sites(hub_id),
      version TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      base_path TEXT NOT NULL,
      base_sha256 TEXT NOT NULL,
      site_path TEXT NOT NULL,
      site_sha256 TEXT NOT NULL,
      site_size INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE(site_id, version, site_sha256)
    );
    CREATE TABLE IF NOT EXISTS commands (
      hub_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL REFERENCES sites(hub_id),
      command_name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      runtime TEXT NOT NULL CHECK(runtime IN ('extension','toolkit')),
      parameters_schema_json TEXT NOT NULL DEFAULT '{}',
      result_schema_json TEXT NOT NULL DEFAULT '{}',
      current_release_id INTEGER,
      download_count INTEGER NOT NULL DEFAULT 0,
      listed INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(site_id, command_name)
    );
    CREATE TABLE IF NOT EXISTS command_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL REFERENCES commands(hub_id),
      version TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      artifact_size INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE(command_id, version, artifact_sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_commands_site ON commands(site_id, listed);
    CREATE INDEX IF NOT EXISTS idx_commands_downloads ON commands(download_count DESC);
    CREATE TABLE IF NOT EXISTS adapters (
      name TEXT PRIMARY KEY,
      display TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      match_json TEXT NOT NULL DEFAULT '[]',
      runtimes_json TEXT NOT NULL DEFAULT '[]',
      current_release_id INTEGER,
      download_count INTEGER NOT NULL DEFAULT 0,
      listed INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS adapter_owners (
      adapter_name TEXT NOT NULL REFERENCES adapters(name) ON DELETE CASCADE,
      userid TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (adapter_name, userid)
    );
    CREATE INDEX IF NOT EXISTS idx_adapter_owners_userid ON adapter_owners(userid);
    CREATE TABLE IF NOT EXISTS adapter_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adapter_name TEXT NOT NULL REFERENCES adapters(name),
      version TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL,
      artifact_size INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      UNIQUE(adapter_name, version, artifact_sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_adapters_downloads ON adapters(download_count DESC);
    CREATE TABLE IF NOT EXISTS user_settings (
      userid TEXT PRIMARY KEY,
      apikey TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS favorites (
      userid TEXT NOT NULL,
      adapter_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (userid, adapter_name)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_adapter ON favorites(adapter_name);
    CREATE TABLE IF NOT EXISTS access_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      userid TEXT NOT NULL,
      name TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_access_tokens_userid ON access_tokens(userid, revoked);
    PRAGMA user_version = 5;
  `)
  // v5 迁移：adapter_releases 增加 published_by / publisher_role（最后更新人 + 管理员统一标签）。
  // 发布时间即事实记录，历史数据保持 NULL（前端/CLI 显示「未知」）。
  if (!tableColumns(db, 'adapter_releases').includes('published_by')) {
    db.exec("ALTER TABLE adapter_releases ADD COLUMN published_by TEXT NOT NULL DEFAULT ''")
  }
  if (!tableColumns(db, 'adapter_releases').includes('publisher_role')) {
    db.exec("ALTER TABLE adapter_releases ADD COLUMN publisher_role TEXT NOT NULL DEFAULT ''")
  }
  // v4 迁移：origin 区分官方内置/用户上传；归属人表支撑「我管理的」与上传权限。
  // 防重入：存量库可能已手工加过 origin 列，ALTER 前先检查。
  if (!tableColumns(db, 'adapters').includes('origin')) {
    db.exec("ALTER TABLE adapters ADD COLUMN origin TEXT NOT NULL DEFAULT 'official'")
  }
  if (!tableColumns(db, 'adapters').includes('scenarios_json')) {
    db.exec("ALTER TABLE adapters ADD COLUMN scenarios_json TEXT NOT NULL DEFAULT '[]'")
  }
  // 官方内置站点回填：每个站点在 adapters 表建立同维记录（name=domain，origin=official），
  // 收藏/归属/筛选统一挂在 v2 adapters 模型上；站点目录展示仍走 sites 表不受影响。
  syncOfficialAdapters(db)
  return db
}

// 官方内置站点默认归属人（管理员团队兜底）；优先级：config.json > ADAPTERHUB_ADMINS 环境变量 > 内置默认
const DEFAULT_ADMINS = []  // 开源默认无管理员：经 config.json admins 或 ADAPTERHUB_ADMINS 配置

// ── config.json 动态配置（管理员等），文件改动即时生效（mtime 缓存），无需重启 ──
// 路径：<ADAPTERHUB_DATA_DIR>/config.json，可用 ADAPTERHUB_CONFIG 环境变量覆盖。
// 形如 { "admins": ["userid1", "userid2"], "review_required": false }
const configCache = { mtimeMs: null, path: null, data: {} }

function loadHubConfig() {
  const file = process.env.ADAPTERHUB_CONFIG || path.join(process.env.ADAPTERHUB_DATA_DIR || path.join(process.cwd(), 'data'), 'config.json')
  if (configCache.path === file) {
    try {
      const mtimeMs = statSync(file).mtimeMs
      if (mtimeMs === configCache.mtimeMs) return configCache.data
      configCache.mtimeMs = mtimeMs
    } catch {
      // 文件被删除：清缓存，回退 env/内置默认
      configCache.path = null
      configCache.data = {}
      return configCache.data
    }
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    configCache.path = file
    configCache.mtimeMs = statSync(file).mtimeMs
    configCache.data = raw && typeof raw === 'object' ? raw : {}
  } catch {
    // 不存在/非法 JSON：视为无配置（合法回退），不缓存坏状态
    configCache.path = null
    configCache.data = {}
  }
  return configCache.data
}

/** 管理员 userid 列表：config.json admins 字段优先，其次 env，最后内置默认。 */
function adminUserids() {
  const fromConfig = loadHubConfig().admins
  if (Array.isArray(fromConfig)) {
    const list = fromConfig.map((s) => String(s).trim()).filter(Boolean)
    if (list.length) return list
  }
  const raw = process.env.ADAPTERHUB_ADMINS
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
    if (list.length) return list
  }
  return DEFAULT_ADMINS
}

/** 审核模式开关（预留给后续审核流）：config.json review_required 字段，默认关闭。 */
export function reviewRequired() {
  return loadHubConfig().review_required === true
}

export function isAdmin(db, userid) {
  return Boolean(userid) && adminUserids().includes(String(userid))
}

/**
 * 站点 → official adapter 记录同步（幂等，可重复调用）：
 * - openCatalog 启动时对存量站点执行一次；
 * - importSite 导入新站点后由调用方再次执行，保证新增站点也进入 adapter 维度。
 */
// 官方站点的推荐提示词（源：weworker extension/adapters/*/manifest.json 的 scenarios，回填用）
// ── 官方推荐场景（运行时数据文件，mtime 缓存动态读，与 config.json 同模式）──
// 生效值 = server/scenarios.default.json（随包的公开站点基线）逐 domain 浅合并
// <ADAPTERHUB_DATA_DIR>/scenarios.json（部署侧覆盖/新增；置 [] 可屏蔽默认场景）。
// ADAPTERHUB_SCENARIOS 可指定覆盖文件路径。改动免重启，syncOfficialAdapters 触发时生效。
const SCENARIOS_DEFAULT_FILE = fileURLToPath(new URL('./scenarios.default.json', import.meta.url))
const scenariosCache = { mtimeMs: null, data: null }

function readScenariosFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  } catch {
    return null
  }
}

export function loadOfficialScenarios() {
  const overrideFile = process.env.ADAPTERHUB_SCENARIOS
    || path.join(process.env.ADAPTERHUB_DATA_DIR || path.join(process.cwd(), 'data'), 'scenarios.json')
  let mtimeMs = null
  try { mtimeMs = statSync(overrideFile).mtimeMs } catch { /* 无覆盖文件 */ }
  if (scenariosCache.data && scenariosCache.mtimeMs === mtimeMs) return scenariosCache.data
  const merged = { ...(readScenariosFile(SCENARIOS_DEFAULT_FILE) || {}) }
  const override = readScenariosFile(overrideFile)
  if (override) for (const [domain, value] of Object.entries(override)) merged[domain] = value
  scenariosCache.mtimeMs = mtimeMs
  scenariosCache.data = merged
  return merged
}

export function syncOfficialAdapters(db) {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    // 站点 → official adapter 记录（幂等）：display/description 同步站点最新元数据；
    // 无 release 时同步补一条占位 release，让 official adapter 在 INNER JOIN 视图中立即可见
    const sites = db.prepare('SELECT domain,name,description,runtimes_json FROM sites').all()
    for (const site of sites) {
      db.prepare(`INSERT INTO adapters (name,display,description,match_json,runtimes_json,origin,scenarios_json,created_at,updated_at)
        VALUES (?,?,?,?,?,'official',?,?,?)
        ON CONFLICT(name) DO UPDATE SET display=excluded.display, description=excluded.description,
          runtimes_json=excluded.runtimes_json, scenarios_json=excluded.scenarios_json, updated_at=excluded.updated_at`)
        .run(site.domain, site.name, site.description, JSON.stringify([site.domain]), site.runtimes_json, json(loadOfficialScenarios()[site.domain] || []), now, now)
      const adapter = db.prepare('SELECT name,current_release_id FROM adapters WHERE name=?').get(site.domain)
      if (!adapter.current_release_id) {
        db.prepare(`INSERT OR IGNORE INTO adapter_releases
          (adapter_name,version,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at)
          VALUES (?,?,?,?,?,?,?)`)
          .run(site.domain, '0.0.0', '', 'placeholder-no-artifact', 0, json({ commands: [] }), now)
        const release = db.prepare('SELECT id FROM adapter_releases WHERE adapter_name=? AND version=?').get(site.domain, '0.0.0')
        if (release) db.prepare('UPDATE adapters SET current_release_id=? WHERE name=?').run(release.id, site.domain)
      }
    }
    // 官方站点归属人 = 管理员团队（幂等，INSERT OR IGNORE 保留已有指派）
    const insertOwner = db.prepare('INSERT OR IGNORE INTO adapter_owners (adapter_name,userid,created_at) VALUES (?,?,?)')
    for (const site of sites) for (const userid of adminUserids()) insertOwner.run(site.domain, userid, now)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// ── 归属人（我管理的）──

export function listManagedAdapters(db, userid) {
  return db.prepare(`SELECT a.name FROM adapter_owners o JOIN adapters a ON a.name=o.adapter_name
                     WHERE o.userid=? AND a.listed=1 ORDER BY a.name`).all(String(userid || '')).map((r) => r.name)
}

export function isAdapterOwner(db, userid, adapterName) {
  if (!userid) return false
  return Boolean(db.prepare('SELECT 1 FROM adapter_owners WHERE adapter_name=? AND userid=?').get(String(adapterName), String(userid)))
}

export function canManageAdapter(db, userid, adapterName) {
  return isAdapterOwner(db, userid, adapterName) || isAdmin(db, userid)
}

export function addAdapterOwner(db, adapterName, userid) {
  db.prepare('INSERT OR IGNORE INTO adapter_owners (adapter_name,userid,created_at) VALUES (?,?,?)')
    .run(String(adapterName), String(userid), Date.now())
}

function json(value) { return JSON.stringify(value ?? {}) }
function parsed(value, fallback) { try { return JSON.parse(value) } catch { return fallback } }

export function getOrCreateSiteId(db, domain) {
  const normalized = normalizeDomain(domain)
  const row = db.prepare('SELECT hub_id FROM sites WHERE domain = ?').get(normalized)
  return row?.hub_id || createHubId('site', (id) => Boolean(db.prepare('SELECT 1 FROM sites WHERE hub_id = ?').get(id)))
}

export function getOrCreateCommandId(db, siteId, commandName) {
  const normalized = normalizeCommandName(commandName)
  const row = db.prepare('SELECT hub_id FROM commands WHERE site_id = ? AND command_name = ?').get(siteId, normalized)
  return row?.hub_id || createHubId('command', (id) => Boolean(db.prepare('SELECT 1 FROM commands WHERE hub_id = ?').get(id)))
}

export function importSite(db, record) {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`INSERT INTO sites
      (hub_id,domain,name,description,allowed_domains_json,runtimes_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(domain) DO UPDATE SET name=excluded.name, description=excluded.description,
        allowed_domains_json=excluded.allowed_domains_json, runtimes_json=excluded.runtimes_json,
        listed=1, updated_at=excluded.updated_at`)
      .run(record.hubId, record.domain, record.name, record.description || '', json(record.allowedDomains || []), json(record.runtimes), now, now)
    const site = db.prepare('SELECT hub_id FROM sites WHERE domain = ?').get(record.domain)
    if (site.hub_id !== record.hubId) throw new Error(`Site ID mismatch for ${record.domain}`)
    db.prepare(`INSERT OR IGNORE INTO site_releases
      (site_id,version,base_hash,base_path,base_sha256,site_path,site_sha256,site_size,published_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.hubId, record.version, record.baseHash, record.basePath, record.baseSha256, record.sitePath, record.siteSha256, record.siteSize, now)
    const siteRelease = db.prepare('SELECT id FROM site_releases WHERE site_id=? AND version=? AND site_sha256=?').get(record.hubId, record.version, record.siteSha256)
    db.prepare('UPDATE sites SET current_release_id=? WHERE hub_id=?').run(siteRelease.id, record.hubId)

    const imported = []
    for (const command of record.commands) {
      db.prepare(`INSERT INTO commands
        (hub_id,site_id,command_name,full_name,description,runtime,parameters_schema_json,result_schema_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(site_id,command_name) DO UPDATE SET full_name=excluded.full_name,
          description=excluded.description,runtime=excluded.runtime,
          parameters_schema_json=excluded.parameters_schema_json,result_schema_json=excluded.result_schema_json,
          listed=1,updated_at=excluded.updated_at`)
        .run(command.hubId, record.hubId, command.commandName, command.fullName, command.description || '', command.runtime, json(command.parametersSchema), json(command.resultSchema), now, now)
      const existing = db.prepare('SELECT hub_id FROM commands WHERE site_id=? AND command_name=?').get(record.hubId, command.commandName)
      if (existing.hub_id !== command.hubId) throw new Error(`Command name is already owned: ${record.domain}/${command.commandName}`)
      db.prepare(`INSERT OR IGNORE INTO command_releases
        (command_id,version,base_hash,artifact_hash,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(command.hubId, command.version, record.baseHash, command.artifactHash, command.artifactPath, command.artifactSha256, command.artifactSize, json(command.manifest), now)
      const release = db.prepare('SELECT id FROM command_releases WHERE command_id=? AND version=? AND artifact_sha256=?').get(command.hubId, command.version, command.artifactSha256)
      db.prepare('UPDATE commands SET current_release_id=? WHERE hub_id=?').run(release.id, command.hubId)
      imported.push(command.hubId)
    }
    if (imported.length) {
      const placeholders = imported.map(() => '?').join(',')
      db.prepare(`UPDATE commands SET listed=0 WHERE site_id=? AND hub_id NOT IN (${placeholders})`).run(record.hubId, ...imported)
    } else db.prepare('UPDATE commands SET listed=0 WHERE site_id=?').run(record.hubId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const SITE_SELECT = `SELECT s.hub_id,s.domain,s.name,s.description,s.allowed_domains_json,s.runtimes_json,
  COALESCE(a.origin,'official') origin,
  s.site_download_count,sr.version,sr.base_hash,sr.base_path,sr.base_sha256,sr.site_path,sr.site_sha256,sr.site_size,
  (SELECT COUNT(*) FROM commands c WHERE c.site_id=s.hub_id AND c.listed=1) command_count,
  (SELECT COALESCE(SUM(download_count),0) FROM commands c WHERE c.site_id=s.hub_id AND c.listed=1) command_download_count
  FROM sites s
  LEFT JOIN adapters a ON a.name = s.domain
  JOIN site_releases sr ON sr.id=s.current_release_id`

function mapSite(row) {
  return row && { id: row.hub_id, domain: row.domain, name: row.name, description: row.description,
    allowedDomains: parsed(row.allowed_domains_json, []), runtimes: parsed(row.runtimes_json, {}), version: row.version,
    origin: row.origin === 'user' ? 'user' : 'official',
    baseHash: row.base_hash, siteDownloads: row.site_download_count, commandDownloads: row.command_download_count,
    commandCount: row.command_count, artifact: { sha256: row.site_sha256, size: row.site_size } }
}

function mapCommand(row) {
  return row && { id: row.hub_id, siteId: row.site_id, siteDomain: row.domain, siteName: row.site_name,
    commandName: row.command_name, fullName: row.full_name, description: row.description, runtime: row.runtime,
    parametersSchema: parsed(row.parameters_schema_json, {}), resultSchema: parsed(row.result_schema_json, {}),
    version: row.version, baseHash: row.base_hash, artifactHash: row.artifact_hash,
    downloads: row.download_count, artifact: { sha256: row.artifact_sha256, size: row.artifact_size } }
}

function paging(options) {
  const page = Math.max(1, Number(options.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(options.pageSize) || 20))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function listSites(db, options = {}) {
  const { page, pageSize, offset } = paging(options)
  const q = String(options.q || '').trim().slice(0, 100)
  const where = ['s.listed=1']
  const params = []
  if (q) { where.push('(s.name LIKE ? ESCAPE \'\\\' OR s.domain LIKE ? ESCAPE \'\\\' OR s.description LIKE ? ESCAPE \'\\\')'); const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; params.push(like, like, like) }
  if (options.runtime) { where.push(`json_type(s.runtimes_json, '$.' || ?) IS NOT NULL`); params.push(options.runtime) }
  if (options.origin === 'official' || options.origin === 'user') { where.push("COALESCE(a.origin,'official')=?"); params.push(options.origin) }
  const orders = { name: 's.name COLLATE NOCASE ASC', commands: 'command_count DESC, s.name ASC', command_downloads: 'command_download_count DESC, s.name ASC', site_downloads: 's.site_download_count DESC, s.name ASC' }
  const order = orders[options.sort] || orders.site_downloads
  const sql = `${SITE_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...params, pageSize, offset).map(mapSite)
  const total = db.prepare(`SELECT COUNT(*) total FROM sites s LEFT JOIN adapters a ON a.name = s.domain WHERE ${where.join(' AND ')}`).get(...params).total
  return { items: rows, page, pageSize, total }
}

export function getSite(db, ref) {
  const row = db.prepare(`${SITE_SELECT} WHERE s.listed=1 AND (s.hub_id=? OR s.domain=?)`).get(ref, normalizeDomain(ref.startsWith('s-') ? 'invalid.local' : ref))
  return mapSite(row)
}

const COMMAND_SELECT = `SELECT c.*,s.domain,s.name site_name,cr.version,cr.base_hash,cr.artifact_hash,
  cr.artifact_path,cr.artifact_sha256,cr.artifact_size FROM commands c
  JOIN sites s ON s.hub_id=c.site_id JOIN command_releases cr ON cr.id=c.current_release_id`

export function listCommands(db, options = {}) {
  const { page, pageSize, offset } = paging(options)
  const where = ['c.listed=1', 's.listed=1']
  const params = []
  if (options.siteRef) { where.push('(s.hub_id=? OR s.domain=?)'); params.push(options.siteRef, options.siteRef) }
  if (options.runtime) { where.push('c.runtime=?'); params.push(options.runtime) }
  const q = String(options.q || '').trim().slice(0, 100)
  if (q) { const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; where.push('(c.command_name LIKE ? ESCAPE \'\\\' OR c.full_name LIKE ? ESCAPE \'\\\' OR c.description LIKE ? ESCAPE \'\\\' OR s.name LIKE ? ESCAPE \'\\\' OR s.domain LIKE ? ESCAPE \'\\\')'); params.push(like, like, like, like, like) }
  const order = options.sort === 'name' ? 'c.command_name COLLATE NOCASE ASC' : 'c.download_count DESC,c.command_name ASC'
  const items = db.prepare(`${COMMAND_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, pageSize, offset).map(mapCommand)
  const total = db.prepare(`SELECT COUNT(*) total FROM commands c JOIN sites s ON s.hub_id=c.site_id WHERE ${where.join(' AND ')}`).get(...params).total
  return { items, page, pageSize, total }
}

export function getCommand(db, { commandId, siteRef, commandName }) {
  let row
  if (commandId) row = db.prepare(`${COMMAND_SELECT} WHERE c.listed=1 AND c.hub_id=?`).get(commandId)
  else row = db.prepare(`${COMMAND_SELECT} WHERE c.listed=1 AND (s.hub_id=? OR s.domain=?) AND c.command_name=?`).get(siteRef, siteRef, normalizeCommandName(commandName))
  return mapCommand(row)
}

export function artifactForSite(db, ref, scope = 'site', baseHash = null) {
  const row = db.prepare(`${SITE_SELECT} WHERE s.listed=1 AND (s.hub_id=? OR s.domain=?)`).get(ref, ref)
  if (!row || (baseHash && row.base_hash !== baseHash)) return null
  if (scope === 'base') return { path: row.base_path, sha256: row.base_sha256, filename: `${row.domain}-${row.version}-base.adapt`, siteId: row.hub_id }
  return { path: row.site_path, sha256: row.site_sha256, filename: `${row.domain}-${row.version}.adapt`, siteId: row.hub_id }
}

export function artifactForCommand(db, query) {
  let row
  if (query.commandId) row = db.prepare(`${COMMAND_SELECT} WHERE c.listed=1 AND c.hub_id=?`).get(query.commandId)
  else row = db.prepare(`${COMMAND_SELECT} WHERE c.listed=1 AND (s.hub_id=? OR s.domain=?) AND c.command_name=?`).get(query.siteRef, query.siteRef, normalizeCommandName(query.commandName))
  return row && { path: row.artifact_path, sha256: row.artifact_sha256, filename: `${row.domain}-${row.command_name}-${row.version}.adapt`, commandId: row.hub_id }
}

export function incrementSiteDownload(db, siteId) { db.prepare('UPDATE sites SET site_download_count=site_download_count+1 WHERE hub_id=?').run(siteId) }
export function incrementCommandDownload(db, commandId) { db.prepare('UPDATE commands SET download_count=download_count+1 WHERE hub_id=?').run(commandId) }

// ── v2：Adapter 维度（站点整包，无命令/基座子包）──

export function importAdapter(db, record) {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const runtimes = record.runtimes || [...new Set((record.commands || []).map((command) => command.runtime))]
    const scenarios = sanitizeScenarios(record.scenarios)
    db.prepare(`INSERT INTO adapters (name,display,description,match_json,runtimes_json,origin,scenarios_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET display=excluded.display, description=excluded.description,
        match_json=excluded.match_json, runtimes_json=excluded.runtimes_json, scenarios_json=excluded.scenarios_json, listed=1, updated_at=excluded.updated_at`)
      .run(record.name, record.display || '', record.description || '', json(record.match || []), json(runtimes), record.origin === 'user' ? 'user' : 'official', json(scenarios), now, now)
    // 最后更新人：发布时间的事实记录（who/role 由调用方按鉴权结果传入；管理员统一标签 role='admin'）
    db.prepare(`INSERT OR IGNORE INTO adapter_releases
      (adapter_name,version,artifact_path,artifact_sha256,artifact_size,manifest_json,published_at,published_by,publisher_role)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(record.name, record.version, record.artifactPath, record.artifactSha256, record.artifactSize, json(record.manifest), now,
        String(record.publishedBy || '').slice(0, 100), record.publisherRole === 'admin' ? 'admin' : (record.publishedBy ? 'owner' : ''))
    const release = db.prepare('SELECT id FROM adapter_releases WHERE adapter_name=? AND version=? AND artifact_sha256=?').get(record.name, record.version, record.artifactSha256)
    db.prepare('UPDATE adapters SET current_release_id=? WHERE name=?').run(release.id, record.name)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * 上传前检查：返回 {ok, reason?, latest?}。
 * 规则：同 name+version+sha 重复上传 → ok:'duplicate'（幂等 no-op）；
 * 同 version 不同 sha → 拒绝（必须递增 version）；
 * 已有更高版本 → 拒绝降级。
 */
export function checkAdapterPublish(db, name, version, sha256WithPrefix) {
  const releases = db.prepare('SELECT version,artifact_sha256 FROM adapter_releases WHERE adapter_name=?').all(name)
  const same = releases.find((r) => r.version === version)
  if (same) return same.artifact_sha256 === sha256WithPrefix ? { ok: true, duplicate: true } : { ok: false, reason: `版本 ${version} 已存在且内容不同，请递增版本号` }
  const versionRank = (v) => String(v).split('.').map((n) => Number(n) || 0)
  const newer = releases.find((r) => {
    const a = versionRank(r.version); const b = versionRank(version)
    const len = Math.max(a.length, b.length)
    for (let i = 0; i < len; i++) { const diff = (a[i] || 0) - (b[i] || 0); if (diff !== 0) return diff > 0 }
    return false
  })
  if (newer) return { ok: false, reason: `线上已有更高版本 ${newer.version}，不允许降级发布 ${version}` }
  return { ok: true }
}

/**
 * 批量发布预检：只读取权限和 release 元数据，不写 Adapter/release/artifact。
 * 返回状态：publishable | duplicate | forbidden | conflict | downgrade-blocked | invalid。
 */
export function preflightAdapterPublish(db, userid, items) {
  const input = Array.isArray(items) ? items.slice(0, 100) : []
  const results = input.map((raw) => {
    const name = String(raw?.name || '')
    const version = String(raw?.version || '')
    const sha256 = String(raw?.sha256 || '')
    const size = Number(raw?.size)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')
      || !/^v?\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(version)
      || !/^sha256:[0-9a-f]{64}$/i.test(sha256)
      || !Number.isSafeInteger(size) || size <= 0 || size > 32 * 1024 * 1024) {
      return { name, version, status: 'invalid', canManage: false, reason: 'invalid metadata' }
    }
    const existing = db.prepare('SELECT origin FROM adapters WHERE name=?').get(name)
    const officialSite = Boolean(db.prepare('SELECT 1 FROM sites WHERE domain=?').get(name))
    const canManage = !existing && !officialSite ? true : canManageAdapter(db, userid, name)
    const latest = db.prepare(`SELECT version FROM adapter_releases
      WHERE adapter_name=? AND artifact_sha256 != 'placeholder-no-artifact'
      ORDER BY published_at DESC,id DESC LIMIT 1`).get(name)?.version || null
    if (!canManage) return { name, version, status: 'forbidden', canManage: false, existingOrigin: existing?.origin || (officialSite ? 'official' : null), latestVersion: latest }
    const check = checkAdapterPublish(db, name, version, sha256)
    let status = 'publishable'
    if (check.duplicate) status = 'duplicate'
    else if (!check.ok) status = String(check.reason || '').includes('不允许降级') ? 'downgrade-blocked' : 'conflict'
    return { name, version, status, canManage: true, existingOrigin: existing?.origin || null, latestVersion: latest, ...(check.reason ? { reason: check.reason } : {}) }
  })
  const summary = { publishable: 0, duplicate: 0, forbidden: 0, conflict: 0, downgradeBlocked: 0, invalid: 0 }
  for (const item of results) {
    if (item.status === 'downgrade-blocked') summary.downgradeBlocked++
    else if (Object.hasOwn(summary, item.status)) summary[item.status]++
  }
  return { authorized: summary.forbidden === 0 && summary.conflict === 0 && summary.downgradeBlocked === 0 && summary.invalid === 0, items: results, summary }
}

const ADAPTER_SELECT = `SELECT a.name,a.display,a.description,a.match_json,a.runtimes_json,a.origin,a.scenarios_json,
  a.download_count,ar.version,ar.artifact_path,ar.artifact_sha256,ar.artifact_size,ar.published_at,ar.published_by,ar.publisher_role,
  (SELECT o.userid FROM adapter_owners o WHERE o.adapter_name=a.name ORDER BY o.created_at ASC, o.userid ASC LIMIT 1) author,
  (SELECT COUNT(*) FROM json_each(a.runtimes_json)) runtime_count,
  COALESCE(
    NULLIF((SELECT json_array_length(ar.manifest_json,'$.commands')), 0),
    (SELECT COUNT(*) FROM commands c JOIN sites s ON s.hub_id=c.site_id WHERE s.domain=a.name AND c.listed=1),
    0
  ) command_count,
  (SELECT COUNT(*) FROM favorites f WHERE f.adapter_name=a.name) favorite_count
  FROM adapters a JOIN adapter_releases ar ON ar.id=a.current_release_id`

// 场景/推荐提示词清洗：[{title, summary, prompts:[{text}]}]，剔除空项，防任意字段注入
export function sanitizeScenarios(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 12).map((s) => ({
    title: String(s?.title || '').slice(0, 120),
    summary: String(s?.summary || '').slice(0, 500),
    prompts: Array.isArray(s?.prompts) ? s.prompts.slice(0, 8).map((p) => ({ text: String(p?.text || '').slice(0, 2000) })).filter((p) => p.text) : [],
  })).filter((s) => s.title || s.prompts.length)
}

function mapAdapter(row) {
  return row && { name: row.name, display: row.display, description: row.description,
    match: parsed(row.match_json, []), runtimes: parsed(row.runtimes_json, []), version: row.version,
    origin: row.origin === 'user' ? 'user' : 'official',
    ...(row.origin === 'user' && row.author ? { author: row.author } : {}),
    scenarios: sanitizeScenarios(parsed(row.scenarios_json, [])),
    commandCount: row.command_count, downloads: row.download_count, favoriteCount: row.favorite_count,
    publishedAt: row.published_at,
    ...(row.published_by ? { publishedBy: row.published_by, publisherRole: row.publisher_role || 'owner' } : {}),
    installable: Boolean(row.artifact_path) && row.artifact_sha256 !== 'placeholder-no-artifact',
    artifact: { sha256: row.artifact_sha256, size: row.artifact_size } }
}

export function listAdapters(db, options = {}) {
  const { page, pageSize, offset } = paging(options)
  const where = ['a.listed=1']
  const params = []
  const q = String(options.q || '').trim().slice(0, 100)
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`
    where.push('(a.name LIKE ? ESCAPE \'\\\' OR a.display LIKE ? ESCAPE \'\\\' OR a.description LIKE ? ESCAPE \'\\\' OR a.match_json LIKE ? ESCAPE \'\\\')')
    params.push(like, like, like, like)
  }
  if (options.runtime) { where.push('EXISTS (SELECT 1 FROM json_each(a.runtimes_json) r WHERE r.value=?)'); params.push(options.runtime) }
  if (options.origin === 'official' || options.origin === 'user') { where.push('a.origin=?'); params.push(options.origin) }
  const orders = { name: 'a.name COLLATE NOCASE ASC', favorites: 'favorite_count DESC, a.download_count DESC, a.name ASC', downloads: 'a.download_count DESC, a.name ASC', recent: 'ar.published_at DESC, a.name ASC' }
  const order = orders[options.sort] || orders.favorites
  const items = db.prepare(`${ADAPTER_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, pageSize, offset).map(mapAdapter)
  const total = db.prepare(`SELECT COUNT(*) total FROM adapters a WHERE ${where.join(' AND ')}`).get(...params).total
  return { items, page, pageSize, total }
}

export function getAdapter(db, name) {
  return mapAdapter(db.prepare(`${ADAPTER_SELECT} WHERE a.listed=1 AND a.name=?`).get(String(name || '')))
}

/**
 * Adapter 的命令清单（从当前 release manifest 读取）。
 * 官方站点（迁移占位，manifest.commands 为空）回退到 sites/commands 表（v1 冻结数据）。
 */
export function listAdapterCommands(db, name) {
  const row = db.prepare("SELECT ar.manifest_json FROM adapters a JOIN adapter_releases ar ON ar.id=a.current_release_id WHERE a.listed=1 AND a.name=?").get(String(name || ''))
  if (row) {
    const commands = parsed(row.manifest_json, {}).commands
    if (Array.isArray(commands) && commands.length > 0) {
      return { items: commands.map((c, i) => ({
        id: c.id || `cmd-${i + 1}`,
        commandName: c.id || `cmd-${i + 1}`,
        fullName: `${name}.${c.id || i + 1}`,
        description: c.description || '',
        runtime: c.runtime === 'wewright' ? 'toolkit' : 'extension',
        parametersSchema: c.schema || {},
      })), source: 'manifest' }
    }
  }
  // v1 冻结数据回退（官方站点）；注意 paging() 读 camelCase pageSize（历史 bug：传 page_size 导致固定截断 20 条）
  const legacy = listCommands(db, { siteRef: String(name || ''), pageSize: 100 })
  return { items: legacy.items, source: 'legacy' }
}

export function artifactForAdapter(db, name) {
  const row = db.prepare(`${ADAPTER_SELECT} WHERE a.listed=1 AND a.name=?`).get(String(name || ''))
  if (!row) return null
  // 占位 release（官方站点迁移尚未灌包）不可下载
  if (!row.artifact_path || row.artifact_sha256 === 'placeholder-no-artifact') return null
  return { path: row.artifact_path, sha256: row.artifact_sha256, filename: `${row.name}-${row.version}.adapt`, adapterName: row.name }
}

export function incrementAdapterDownload(db, name) { db.prepare('UPDATE adapters SET download_count=download_count+1 WHERE name=?').run(name) }

/** Adapter 版本历史（发布时间倒序，过滤迁移占位 release）——供 CLI `versions` 命令。 */
export function listAdapterReleases(db, name) {
  const rows = db.prepare(`SELECT ar.version, ar.artifact_sha256, ar.artifact_size, ar.published_at, ar.published_by, ar.publisher_role
    FROM adapters a JOIN adapter_releases ar ON ar.adapter_name=a.name
    WHERE a.listed=1 AND a.name=? AND ar.artifact_sha256 != 'placeholder-no-artifact'
    ORDER BY ar.published_at DESC, ar.id DESC`).all(String(name || ''))
  return { items: rows.map((r) => ({ version: r.version, sha256: r.artifact_sha256, size: r.artifact_size, publishedAt: r.published_at,
    ...(r.published_by ? { publishedBy: r.published_by, publisherRole: r.publisher_role || 'owner' } : {}) })), total: rows.length }
}

/** 客户端联动版本索引：全部已列出 Adapter 的 name/version/sha256 轻量清单（无元数据）。 */
export function adapterVersionIndex(db) {
  return db.prepare(`SELECT a.name, ar.version, ar.artifact_sha256
    FROM adapters a JOIN adapter_releases ar ON ar.id=a.current_release_id
    WHERE a.listed=1 AND ar.artifact_sha256 != 'placeholder-no-artifact'
    ORDER BY a.name`).all()
    .map((r) => ({ name: r.name, version: r.version, sha256: r.artifact_sha256 }))
}

/** 指定版本的 artifact（下载 name@version 用；占位/不存在返回 null）。 */
export function artifactForAdapterVersion(db, name, version) {
  const row = db.prepare(`SELECT ar.version, ar.artifact_path, ar.artifact_sha256, ar.artifact_size
    FROM adapters a JOIN adapter_releases ar ON ar.adapter_name=a.name
    WHERE a.listed=1 AND a.name=? AND ar.version=?
    AND ar.artifact_sha256 != 'placeholder-no-artifact'`).get(String(name || ''), String(version || ''))
  if (!row || !row.artifact_path) return null
  return { path: row.artifact_path, sha256: row.artifact_sha256, filename: `${name}-${row.version}.adapt`, adapterName: name }
}

// ── 用户设置（apikey，登录态才可读写）──

export function getApikey(db, userid) {
  const row = db.prepare('SELECT apikey FROM user_settings WHERE userid=?').get(userid)
  return row ? row.apikey : ''
}

export function setApikey(db, userid, apikey) {
  db.prepare(`INSERT INTO user_settings (userid, apikey, updated_at) VALUES (?,?,?)
              ON CONFLICT(userid) DO UPDATE SET apikey=excluded.apikey, updated_at=excluded.updated_at`)
    .run(userid, String(apikey || '').slice(0, 512), Date.now())
}

// ── 收藏（登录态才可读写）──

export function listFavorites(db, userid) {
  // 收藏键可能指向 adapters.name 或 sites.domain；LEFT JOIN 两边补齐展示字段
  return db.prepare(`SELECT f.adapter_name, f.created_at,
                     COALESCE(a.display, s.name, f.adapter_name) display,
                     COALESCE(a.description, s.description, '') description,
                     COALESCE(s.hub_id, f.adapter_name) site_hub_id
                     FROM favorites f
                     LEFT JOIN adapters a ON a.name = f.adapter_name
                     LEFT JOIN sites s ON s.domain = f.adapter_name
                     WHERE f.userid=? ORDER BY f.created_at DESC`).all(userid)
    .map(r => ({ adapterName: r.adapter_name, display: r.display, description: r.description,
                 siteId: r.site_hub_id, favoritedAt: r.created_at }))
}

export function addFavorite(db, userid, adapterName) {
  // 适配 site 维度：adapters 表为空时允许以 sites.domain 作为收藏键；两表都无才拒绝
  const known = db.prepare('SELECT 1 FROM adapters WHERE name=?').get(adapterName)
    || db.prepare('SELECT 1 FROM sites WHERE domain=?').get(adapterName)
    || db.prepare('SELECT 1 FROM sites WHERE hub_id=?').get(adapterName)
  if (!known) throw new Error('adapter not found')
  db.prepare('INSERT OR IGNORE INTO favorites (userid, adapter_name, created_at) VALUES (?,?,?)')
    .run(userid, adapterName, Date.now())
}

export function removeFavorite(db, userid, adapterName) {
  db.prepare('DELETE FROM favorites WHERE userid=? AND adapter_name=?').run(userid, adapterName)
}

// ── 个人访问令牌（PAT）：服务端签发，存哈希，用于 webcli 上传/下载 Adapter ──

function sha256hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function createAccessToken(db, userid, name, ttlMs) {
  const token = 'ahp_' + randomBytes(24).toString('base64url')
  const now = Date.now()
  const hash = sha256hex(token)
  const safeName = String(name || '默认令牌').trim().slice(0, 100) || '默认令牌'
  db.prepare('INSERT INTO access_tokens (token_hash,userid,name,expires_at,created_at) VALUES (?,?,?,?,?)')
    .run(hash, userid, safeName, now + ttlMs, now)
  const row = db.prepare('SELECT id FROM access_tokens WHERE token_hash=?').get(hash)
  return { id: row.id, name: safeName, token, expires_at: now + ttlMs, created_at: now }
}

export function listAccessTokens(db, userid) {
  return db.prepare('SELECT id,name,expires_at,created_at,last_used_at,revoked FROM access_tokens WHERE userid=? ORDER BY created_at DESC').all(userid)
}

export function revokeAccessToken(db, userid, id) {
  const r = db.prepare('UPDATE access_tokens SET revoked=1 WHERE id=? AND userid=? AND revoked=0').run(Number(id), userid)
  return r.changes > 0
}

export function useridFromAccessToken(db, token) {
  const hash = sha256hex(String(token || ''))
  const row = db.prepare('SELECT userid FROM access_tokens WHERE token_hash=? AND revoked=0 AND expires_at>?').get(hash, Date.now())
  if (!row) return null
  db.prepare('UPDATE access_tokens SET last_used_at=? WHERE token_hash=?').run(Date.now(), hash)
  return row.userid
}
