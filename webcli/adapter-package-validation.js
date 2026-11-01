import { normalizeWorkflowOrigin, workflowPermissionTargets } from './page-workflow-origins.js';
/**
 * Adapter Package v2 — 校验、发现与解析
 *
 * Shared contract: docs/adapter_architecture_unification.md (schema_version=2).
 * 结构：adapters/<name>/{manifest.json, extension/{commands,internal}, wewright/{commands,internal}}
 *
 * 两级校验：
 * - validateV2Manifest：结构校验（加载路径用，快）
 * - validateV2AdapterDir：完整包校验（adapter validate / hub 上传用，含文件树封闭性与禁入文件）
 *
 * 存量 v1（extension/adapters、五文件 toolkit）冻结只读，本模块只发现 schema_version=2 的目录。
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { basename, join, resolve, sep } from "path";
import { adapterHelperPatterns, adapterPagePatterns, hostMatchesPattern, isDeclaredRouteHost, siteDomainProblem } from "./host-scope.js";
import { validateHttpContract } from './http-contract.js';
import { normalizePathParameters } from './generation-harness/path-parameters.js';
import { normalizeNavigationQueryParameters, normalizeHashNavigation } from './page-navigation-parameters.js';
import { validatePageWorkflowContract } from './exploration-workflow.js';
import { validateUiWrite } from './exploration-ui-write.js';
import { validatePageWrite } from './exploration-extension-write.js';


const RUNTIMES = ["extension", "wewright", "http"];
export const ADAPTER_ICON_FILES = Object.freeze(['icon.svg', 'icon.png']);

export function validateAdapterIcon(name, bytes) {
  if (!ADAPTER_ICON_FILES.includes(name) || !bytes.length || bytes.length > 512 * 1024) {
    throw new Error('Adapter icon must be icon.svg or icon.png (512 KiB max).');
  }
  if (name === 'icon.png') {
    if (bytes.length < 24 || Buffer.from(bytes).subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw new Error('Adapter icon.png must contain PNG data.');
    }
    return 'image/png';
  }
  const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\s/i.test(svg)
    || /<\s*(?:script|foreignObject|iframe|object|embed)\b|<!|\bon\w+\s*=|\bhref\s*=|\burl\s*\(|@import/i.test(svg)) {
    throw new Error('Adapter icon.svg must be a self-contained SVG image without active or external content.');
  }
  return 'image/svg+xml';
}
const COMMAND_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FORBIDDEN_MANIFEST_FIELDS = [
  "adapter_type",
  "entry",
  "scope",
  "hub_id",
  "support_files",
  "tool_execution",
  "detail_description",
  "author",
];
// spec §7 禁入文件（相对 adapter 根或任意子路径匹配）
const FORBIDDEN_FILE_NAMES = new Set([
  "toolkit_runtime.py",
  "toolkit.py",
  "requirements.txt",
  "SKILL.md",
  "SKILL.generated.md",
  "index.js",
  "WEBCLI_KNOWLEDGE.json",
  "WEBCLI_KNOWLEDGE.md",
  "wecli.generated.json",
]);

function fail(adapterName, message) {
  throw new Error(`Adapter "${adapterName}": ${message}`);
}

function isRegularFile(path) {
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isFile();
}

export function validateAgentGuidance(bytes) {
  let guidance;
  try { guidance = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('Adapter guidance must be UTF-8 text.'); }
  if (bytes.length > 20_000 || !guidance.trim() || /^---\s*(?:\r?\n|$)/.test(guidance)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(guidance)) {
    throw new Error('Adapter guidance must be non-empty Markdown without Skill frontmatter or control characters (20 KB max).');
  }
  return guidance;
}

/** adapter name 不做命名正则，仅要求跨平台目录名可用（spec §3）。 */
function validAdapterName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !/[\x00-\x1f\x7f]/.test(name) &&
    !/[/\\:*?"<>|\s]/.test(name) &&
    !name.startsWith(".") &&
    !name.endsWith(".") &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name) &&
    name.length <= 128 &&
    name !== "." &&
    name !== ".."
  );
}

/**
 * 结构校验（不触盘，除可选的 module 文件存在性由调用方决定）。
 * @returns {{ name, manifest, commands: Array<{id,runtime,module,description,safety,schema,name}> }}
 */
export function validateV2Manifest(manifest, directoryName = "?") {
  const adapterName = String(manifest?.name || directoryName);
  if (manifest?.schema_version !== 2) fail(adapterName, "schema_version must be 2.");
  if (!validAdapterName(manifest?.name)) fail(adapterName, "invalid adapter name.");
  if (directoryName !== "?" && manifest.name !== directoryName) {
    fail(adapterName, `name must match its directory name ("${directoryName}").`);
  }
  for (const field of FORBIDDEN_MANIFEST_FIELDS) {
    if (field in manifest) fail(adapterName, `forbidden field "${field}" (v1 legacy).`);
  }
  if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(manifest.version)) {
    fail(adapterName, "version must be a semantic version.");
  }
  if (typeof manifest.description !== "string" || !manifest.description.trim()) {
    fail(adapterName, "description is required.");
  }
  if (manifest.discovery_terms !== undefined && (!Array.isArray(manifest.discovery_terms)
    || manifest.discovery_terms.length > 16 || manifest.discovery_terms.some((term) =>
      typeof term !== "string" || !term.trim() || term.length > 80 || /[\x00-\x1f\x7f]/.test(term)))) {
    fail(adapterName, "discovery_terms must contain at most 16 non-empty short phrases.");
  }
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    fail(adapterName, "commands must be a non-empty array.");
  }

  const runtimeAllowedHosts = manifest.runtime_allowed_hosts;
  if (runtimeAllowedHosts !== undefined
    && (!Array.isArray(runtimeAllowedHosts) || runtimeAllowedHosts.length > 64)) {
    fail(adapterName, "runtime_allowed_hosts must be an array of at most 64 hosts.");
  }
  for (const host of runtimeAllowedHosts || []) {
    if (typeof host !== "string" || !host.trim() || /[\s,*?"<>|]/.test(host)) {
      fail(adapterName, "runtime_allowed_hosts must contain non-empty host strings.");
    }
  }

  // Site domains: each covers the domain and all of its subdomains (see host-scope.js).
  const domains = manifest.domains;
  if (domains !== undefined && (!Array.isArray(domains) || domains.length === 0 || domains.length > 16)) {
    fail(adapterName, "domains must be an array of 1 to 16 site domains.");
  }
  const seenDomains = new Set();
  for (const domain of domains || []) {
    const problem = siteDomainProblem(domain);
    if (problem) fail(adapterName, `domains entry "${String(domain)}" ${problem}.`);
    if (seenDomains.has(domain)) fail(adapterName, `duplicate domains entry "${domain}".`);
    seenDomains.add(domain);
  }

  const runtimesPresent = new Set();
  const ids = new Set();
  const callIds = new Set();
  const legacyCallNames = new Set();
  const match = manifest.match;
  const commands = manifest.commands.map((command) => {
    const id = String(command?.id || "");
    if (!COMMAND_ID_RE.test(id)) fail(adapterName, `invalid command id "${id}" (kebab-case required).`);
    if (ids.has(id)) fail(adapterName, `duplicate command id "${id}".`);
    ids.add(id);
    if (callIds.has(id)) fail(adapterName, 'Command name conflicts with an alias.');
    callIds.add(id);
    if (command.aliases !== undefined && (!Array.isArray(command.aliases) || command.aliases.length > 64)) {
      fail(adapterName, 'Command aliases must be an array of at most 64 local command names.');
    }
    for (const alias of command.aliases || []) {
      // Local names cannot claim another package or collide with longest-name routing.
      if (typeof alias !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(alias) || callIds.has(alias)) {
        fail(adapterName, 'Invalid or conflicting command alias.');
      }
      callIds.add(alias);
    }
    if (command.legacyNames !== undefined && (!Array.isArray(command.legacyNames) || command.legacyNames.length > 64)) {
      fail(adapterName, 'Command legacy names must be an array of at most 64 full tool names.');
    }
    for (const legacyName of command.legacyNames || []) {
      const normalized = typeof legacyName === 'string' ? legacyName.toLowerCase() : legacyName;
      if (typeof legacyName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(legacyName) || !legacyName.includes('.')
        || legacyName.startsWith(manifest.name + '.') || legacyName === `${manifest.name}.${id}` || legacyCallNames.has(normalized)) {
        fail(adapterName, 'Command legacy names must be non-conflicting full cross-prefix tool names.');
      }
      legacyCallNames.add(normalized);
    }
    if (!RUNTIMES.includes(command?.runtime)) fail(adapterName, `command "${id}": runtime must be extension|wewright|http.`);
    validateHttpContract(command);
    validatePageWrite(command);
    validateUiWrite(command);
    if (command.uiWrite?.frames?.some(frame => !adapterPagePatterns(manifest).some(pattern => hostMatchesPattern(new URL(frame.origin).hostname, pattern)))) fail(adapterName, 'UI write frame hosts must be declared in the page scope.');
    if (command.execution !== undefined && (command.runtime !== 'extension' || !command.execution
      || command.execution.type !== 'api' || command.execution.runtime !== 'background'
      || Object.keys(command.execution).some((key) => !['type', 'runtime'].includes(key)))) {
      fail(adapterName, 'Command execution must be an Extension API background declaration.');
    }
    for (const field of ['routeDomain', 'tabDomain', 'excludeTabDomain']) {
      const value = command[field];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !/^[A-Za-z0-9*_.-]+$/.test(value) || !isDeclaredRouteHost(manifest, value)) {
        fail(adapterName, `Command "${id}" route field "${field}" must be a match host or a host inside domains.`);
      }
    }
    if (command.pageRoute !== undefined) {
      const route = command.pageRoute;
      let url;
      try { url = new URL(route?.origin + route?.pathname); } catch { /* Rejected below. */ }
      if (!route || typeof route !== 'object' || Array.isArray(route)
        || Object.keys(route).some(key => !['origin', 'pathname', 'additionalPaths', 'navigation', 'workflow'].includes(key))
        || typeof route.pathname !== 'string' || !/^\/(?!\/)/.test(route.pathname)
        || command.runtime !== 'extension' || command.execution || (command.safety === 'write' && !command.pageWrite && !command.uiWrite)
        || !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.origin !== route.origin || url.pathname !== route.pathname || url.search || url.hash
        || !adapterPagePatterns(manifest).some(pattern => hostMatchesPattern(url.hostname, pattern))
        || (command.tabDomain && url.hostname !== command.tabDomain)) {
        fail(adapterName, `Command "${id}" pageRoute must be an exact declared HTTP(S) origin and pathname for a foreground read command.`);
      }
    }
    if (command.pageRoute?.navigation !== undefined) {
      const route = command.pageRoute, navigation = route.navigation;
      let valid = command.pageWorkflow === true && navigation && typeof navigation === 'object' && !Array.isArray(navigation)
        && Object.keys(navigation).every(key => ['pathname', 'resultOrigin', 'pathParameters', 'queryParameters', 'hashNavigation'].includes(key)) && typeof navigation.pathname === 'string' && /^\/(?!\/)/.test(navigation.pathname);
      try {
        const resultOrigin = normalizeWorkflowOrigin(navigation.resultOrigin ?? route.origin);
        if (!adapterPagePatterns(manifest).some(pattern => hostMatchesPattern(new URL(resultOrigin).hostname, pattern))) throw new Error('Destination host must be declared.');
        const url = new URL(resultOrigin + navigation.pathname);
        const bindings = normalizePathParameters({ url: url.href }, (navigation.hashNavigation || navigation.queryParameters?.length) && navigation.pathParameters?.length === 0 ? undefined : navigation.pathParameters);
        const queries = normalizeNavigationQueryParameters(navigation.queryParameters, bindings);
        const hash = normalizeHashNavigation(navigation.hashNavigation, [...bindings, ...queries]);
        valid &&= url.origin === resultOrigin && url.pathname === navigation.pathname && !url.search && !url.hash && ((bindings.length + queries.length) > 0 || hash)
          && JSON.stringify(hash) === JSON.stringify(navigation.hashNavigation)
          && JSON.stringify(queries) === JSON.stringify(navigation.queryParameters || [])
          && bindings.every(binding => navigation.pathname.slice(1).split('/')[binding.segmentIndex] === ':id')
          && (!route.pathname.includes(':id') || route.pathname === navigation.pathname);
      } catch { valid = false; }
      if (!valid) fail(adapterName, 'pageRoute.navigation requires a declared same-origin path template and complete path bindings.');
    } else if (command.pageRoute?.pathname.includes(':id')) fail(adapterName, 'Dynamic pageRoute requires explicit navigation bindings.');
    if (command.pageRoute?.workflow !== undefined) {
      try {
        const source = validatePageWorkflowContract(command.pageRoute.workflow);
        const routes = workflowPermissionTargets(source, command.pageRoute.origin, command.pageRoute.pathname);
        if (routes.some(route => !adapterPagePatterns(manifest).some(pattern => hostMatchesPattern(new URL(route.origin).hostname, pattern)))) throw new Error('Workflow hosts must be declared.');
        if (command.pageWorkflow !== true || command.pageRoute.navigation || command.pageRoute.additionalPaths
          || source.steps.find(step => !step.frames) && source.steps.find(step => !step.frames).pathname !== command.pageRoute.pathname) throw new Error('Invalid entry route.');
      } catch { fail(adapterName, 'pageRoute.workflow requires a complete normalized read-only step sequence beginning at pathname.'); }
    }
    if (command.pageRoute?.additionalPaths !== undefined) {
      const paths = command.pageRoute.additionalPaths;
      if (command.pageWorkflow !== true || !Array.isArray(paths) || paths.length > 4 || paths.some(value => {
        try { const url = new URL(value, command.pageRoute.origin); return typeof value !== 'string' || !value.startsWith('/') || url.origin !== command.pageRoute.origin || url.pathname !== value || url.search || url.hash; } catch { return true; }
      })) fail(adapterName, 'additionalPaths must be up to four exact same-origin workflow pathnames.');
    }
    if (command.pageWorkflow !== undefined && (command.pageWorkflow !== true || command.pageStrategy !== 'UI_SELECTOR' || !command.pageRoute)) fail(adapterName, 'pageWorkflow requires a UI_SELECTOR pageRoute.');
    if (command.pageStrategy !== undefined && (!command.pageRoute || !['UI_SELECTOR', 'DOM_STATE', 'INTERCEPT'].includes(command.pageStrategy))) fail(adapterName, 'pageStrategy must name a supported strategy with pageRoute.');
    runtimesPresent.add(command.runtime);
    const ext = command.runtime === "wewright" ? "py" : "js";
    const expectedModule = `${command.runtime}/commands/${id}.${ext}`;
    if (command?.module !== expectedModule) {
      fail(adapterName, `command "${id}": module must be "${expectedModule}".`);
    }
    if (typeof command?.description !== "string" || !command.description.trim()) {
      fail(adapterName, `command "${id}": description is required.`);
    }
    if (command?.safety != null && !["read", "write"].includes(command.safety)) {
      fail(adapterName, `command "${id}": safety must be read|write.`);
    }
    if (command?.requires_confirmation !== undefined && typeof command.requires_confirmation !== 'boolean') {
      fail(adapterName, `command "${id}": requires_confirmation must be a boolean.`);
    }
    const schema = command?.schema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      fail(adapterName, `command "${id}": schema is required (JSON Schema object).`);
    }
    if (schema.properties != null && (typeof schema.properties !== "object" || Array.isArray(schema.properties))) {
      fail(adapterName, `command "${id}": schema.properties must be an object.`);
    }
    return { ...command, safety: command.safety || "read", name: `${manifest.name}.${id}` };
  });

  const hasExtension = runtimesPresent.has("extension");
  if (hasExtension) {
    if (!Array.isArray(match) || match.length === 0 || match.some((d) => typeof d !== "string" || !d.trim())) {
      fail(adapterName, "match (non-empty domain array) is required when extension commands exist.");
    }
  } else if (!runtimesPresent.has('http') && match != null && (!Array.isArray(match) || match.length > 0)) {
    fail(adapterName, "match is forbidden for pure wewright adapters.");
  } else if (domains !== undefined) {
    // `domains` widens the page scope of extension commands; without them it means nothing.
    fail(adapterName, "domains is forbidden for pure wewright adapters.");
  } else if (match != null && (!Array.isArray(match) || match.some(host => typeof host !== 'string' || !host.trim()))) {
    fail(adapterName, 'match must be a domain array.');
  }
  for (const command of commands) {
    if (command.auth !== undefined && !["required", "optional", "none"].includes(command.auth)) {
      fail(adapterName, `command "${command.id}": auth must be required|optional|none.`);
    }
  }
  if (manifest.auth !== undefined) validateAuth(adapterName, manifest, commands, hasExtension);

  return { name: manifest.name, manifest, commands };
}

const AUTH_FIELDS = new Set(["login_url", "login_hosts", "check", "autologin", "display_name", "qr"]);
const AUTH_HOST_RE = /^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/;

const authHostMatches = hostMatchesPattern;

function authUrl(adapterName, value, field, hosts) {
  let url;
  try { url = new URL(String(value)); } catch { fail(adapterName, `auth.${field} must be an absolute URL.`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    fail(adapterName, `auth.${field} must be an HTTP(S) URL without credentials.`);
  }
  if (!hosts.some((pattern) => authHostMatches(url.hostname.toLowerCase(), pattern))) {
    fail(adapterName, `auth.${field} host must be declared in match, domains, runtime_allowed_hosts or auth.login_hosts.`);
  }
  return url;
}

function validateCookieNames(adapterName, value, field) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16 || value.some((name) => typeof name !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name))) {
    fail(adapterName, `auth.check.cookies.${field} must be at most 16 cookie names.`);
  }
}

function validateCookieValues(adapterName, value, field) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16
    || Object.entries(value).some(([name, expected]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || typeof expected !== "string" || expected.length > 256)) {
    fail(adapterName, `auth.check.cookies.${field} must map at most 16 cookie names to string values.`);
  }
}

/**
 * `auth` declares the login page and how to tell that the user is signed in.
 * The host runs the login flow; Adapters never write login or check commands for it.
 */
function validateAuth(adapterName, manifest, commands, hasExtension) {
  const auth = manifest.auth;
  if (!hasExtension) fail(adapterName, "auth requires extension commands.");
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) fail(adapterName, "auth must be an object.");
  for (const key of Object.keys(auth)) if (!AUTH_FIELDS.has(key)) fail(adapterName, `unknown auth field "${key}".`);
  const loginHosts = auth.login_hosts ?? [];
  if (!Array.isArray(loginHosts) || loginHosts.length > 16 || loginHosts.some((host) => typeof host !== "string" || !AUTH_HOST_RE.test(host))) {
    fail(adapterName, "auth.login_hosts must contain at most 16 host names (optionally *.domain).");
  }
  const hosts = [...adapterHelperPatterns(manifest), ...loginHosts];
  if (typeof auth.login_url !== "string") fail(adapterName, "auth.login_url is required.");
  authUrl(adapterName, auth.login_url, "login_url", hosts);
  if (auth.display_name !== undefined && (typeof auth.display_name !== "string" || !auth.display_name.trim() || auth.display_name.length > 40)) {
    fail(adapterName, "auth.display_name must be a short name.");
  }
  if (auth.check !== undefined) {
    const check = auth.check;
    if (!check || typeof check !== "object" || Array.isArray(check) || Object.keys(check).some((key) => !["cookies", "command"].includes(key))) {
      fail(adapterName, "auth.check may only declare cookies and command.");
    }
    if (!check.cookies && !check.command) fail(adapterName, "auth.check must declare cookies or command.");
    if (check.cookies !== undefined) {
      const cookies = check.cookies;
      if (!cookies || typeof cookies !== "object" || Array.isArray(cookies)
        || Object.keys(cookies).some((key) => !["url", "all", "any", "equals", "not"].includes(key))) {
        fail(adapterName, "auth.check.cookies may only declare url, all, any, equals and not.");
      }
      authUrl(adapterName, cookies.url, "check.cookies.url", hosts);
      validateCookieNames(adapterName, cookies.all, "all");
      validateCookieNames(adapterName, cookies.any, "any");
      validateCookieValues(adapterName, cookies.equals, "equals");
      validateCookieValues(adapterName, cookies.not, "not");
      if (!cookies.all?.length && !cookies.any?.length && !Object.keys(cookies.equals || {}).length) {
        fail(adapterName, "auth.check.cookies must require at least one cookie.");
      }
    }
    if (check.command !== undefined) {
      const command = commands.find((entry) => entry.id === check.command);
      if (!command || command.runtime !== "extension" || command.safety !== "read") {
        fail(adapterName, "auth.check.command must name a read Extension command of this package.");
      }
    }
  }
  if (auth.autologin !== undefined) {
    const autologin = auth.autologin;
    const selectorFields = ["switch", "username", "password", "submit"];
    if (!autologin || typeof autologin !== "object" || Array.isArray(autologin)
      || Object.keys(autologin).some((key) => !["mode", ...selectorFields].includes(key))
      || (autologin.mode !== undefined && !["auto", "off"].includes(autologin.mode))
      || selectorFields.some((key) => autologin[key] !== undefined
        && (typeof autologin[key] !== "string" || !autologin[key].trim() || autologin[key].length > 200))) {
      fail(adapterName, "auth.autologin may only declare mode: auto|off and switch, username, password or submit CSS selectors (default: auto).");
    }
  }
  if (auth.qr !== undefined) {
    const qr = auth.qr;
    if (!qr || typeof qr !== "object" || Array.isArray(qr)
      || Object.keys(qr).some((key) => !["mode"].includes(key))
      || (qr.mode !== undefined && !["auto", "off"].includes(qr.mode))) {
      fail(adapterName, "auth.qr may only declare mode: auto|off (default: auto).");
    }
  }
}

function walkFiles(root, relative = "", out = []) {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) out.push({ rel, symlink: true });
    else if (entry.isDirectory()) walkFiles(root, rel, out);
    else if (entry.isFile()) out.push({ rel, symlink: false });
  }
  return out;
}

/**
 * 完整包校验：结构 + 文件树封闭集合 + 禁入文件（spec §2/§7）。
 * @param {string} adapterRoot adapter 目录（名为 <name>）
 */
export function validateV2AdapterDir(adapterRoot) {
  if (!existsSync(adapterRoot) || lstatSync(adapterRoot).isSymbolicLink() || !lstatSync(adapterRoot).isDirectory()) {
    fail("package", "root must be a regular directory.");
  }
  const directoryName = basename(resolve(adapterRoot));
  const manifestPath = join(adapterRoot, "manifest.json");
  if (!existsSync(manifestPath) || !isRegularFile(manifestPath)) {
    fail(directoryName, "manifest.json must be a regular file.");
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    fail(directoryName, "manifest.json is not valid JSON.");
  }
  const { name, commands } = validateV2Manifest(manifest, directoryName);

  const files = walkFiles(adapterRoot);
  const problems = [];
  for (const { rel, symlink } of files) {
    if (symlink) problems.push(`symlink not allowed: ${rel}`);
    const base = rel.split("/").pop();
    if (FORBIDDEN_FILE_NAMES.has(base)) problems.push(`forbidden file: ${rel}`);
    if (rel.split("/").includes("__pycache__")) problems.push(`forbidden directory entry: ${rel}`);
    if (/\.generated\.(js|py|md|txt)$/.test(base)) problems.push(`forbidden generated file: ${rel}`);
  }
  if (problems.length > 0) fail(name, problems.join("; "));
  const guidancePath = join(adapterRoot, 'guidance.md');
  if (existsSync(guidancePath)) {
    if (!isRegularFile(guidancePath)) fail(name, 'guidance.md must be a regular file.');
    try { validateAgentGuidance(readFileSync(guidancePath)); }
    catch (error) { fail(name, error.message); }
  }

  // Root metadata, optional icons, and declared runtime directories only.
  const topEntries = readdirSync(adapterRoot, { withFileTypes: true }).map((e) => e.name);
  const runtimesWithCommands = new Set(commands.map((c) => c.runtime));
  for (const entry of topEntries) {
    if (entry === "manifest.json" || entry === "guidance.md") continue;
    if (ADAPTER_ICON_FILES.includes(entry)) {
      const file = join(adapterRoot, entry);
      if (!isRegularFile(file)) fail(name, `${entry} must be a regular file.`);
      validateAdapterIcon(entry, readFileSync(file));
      continue;
    }
    if (!runtimesWithCommands.has(entry)) {
      fail(name, `unexpected root entry "${entry}" (runtime dir without commands or unknown file).`);
    }
    for (const sub of readdirSync(join(adapterRoot, entry), { withFileTypes: true })) {
      if (sub.name !== "commands" && sub.name !== "internal") {
        fail(name, `runtime "${entry}" may only contain commands/ and internal/, found "${sub.name}".`);
      }
    }
  }
  for (const runtime of runtimesWithCommands) {
    if (!topEntries.includes(runtime)) fail(name, `missing runtime directory "${runtime}/".`);
    const commandsDir = join(adapterRoot, runtime, "commands");
    if (!existsSync(commandsDir)) fail(name, `missing "${runtime}/commands/".`);
    // commands/ 与 internal/ 内文件命名（spec §3/§5）：命令=kebab；internal 按语言习惯不强校验
    for (const f of readdirSync(commandsDir)) {
      if (!/\.(js|py)$/.test(f)) fail(name, `unexpected file in ${runtime}/commands/: ${f}`);
    }
  }
  // module 文件必须真实存在
  for (const command of commands) {
    const modulePath = join(adapterRoot, command.module);
    if (!existsSync(modulePath) || !isRegularFile(modulePath)) {
      fail(name, `command "${command.id}": module file missing: ${command.module}`);
    }
  }

  return { name, root: resolve(adapterRoot), manifest, commands };
}
