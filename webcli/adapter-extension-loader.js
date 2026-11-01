/**
 * v2 Adapter loader — extension 侧纯逻辑（无 chrome 依赖，可单测）
 *
 * Shared contract: docs/adapter_architecture_unification.md
 * 注入顺序：internal/（字母序）→ commands/（manifest 声明序）
 * 命令文件只含 IIFE + `__webcliRegisterCommand(id, handler)`；
 * definition/schema 由本模块从 manifest 合入（单源），经 bootstrap 预埋进页面。
 */

import { adapterPrimaryHost } from './host-scope.js';

/** 单个命令的注册定义（对接 injector 的 __webmcpRegister 协议） */
export function v2CommandDef(manifest, command) {
  const defaultRouteDomain = adapterPrimaryHost(manifest);
  const routeDomain = command.routeDomain || command.tabDomain || defaultRouteDomain;
  return {
    id: command.id,
    aliases: [...(command.aliases || []).map((alias) => manifest.name + '.' + alias), ...(command.legacyNames || [])],
    name: `${manifest.name}.${command.id}`, // 公开名 = handlerName（call_tool 默认按工具名取 handler）
    description: command.description || "",
    parameters: command.schema || { type: "object", properties: {} },
    safety: command.safety || 'read',
    requires_confirmation: command.requires_confirmation ?? command.safety === 'write',
    ...(command.execution?.runtime === 'background' ? { execution: command.execution, ...(command.execution.pageWhenAbsent === undefined ? { directCapable: true, executionMode: 'direct' } : {}) } : {}),
    adapterId: manifest.name,
    routeDomain,
    ...(command.excludeTabDomain ? { excludeTabDomain: command.excludeTabDomain } : {}),
    tabDomain: command.tabDomain || routeDomain,
  };
}

/** 页面命令（runtime=extension）的注册定义，按命令 id 索引 */
export function v2CommandDefs(manifest) {
  const defs = {};
  for (const command of manifest.commands || []) {
    if (command.runtime !== "extension") continue;
    defs[command.id] = v2CommandDef(manifest, command);
  }
  return defs;
}

/**
 * 在页面 isolated world 中定义 __webcliRegisterCommand（幂等）。
 * 必须自包含：既被序列化进 bootstrap 字符串，也直接作为 chrome.scripting 的 func 注入。
 * window.__webcliRegisteredCommands 记录本次注入后成功注册的命令，供注入方核对。
 */
export function installV2Commands(defs) {
  window.__webcliRegisteredCommands = [];
  window.__webcliRegisterCommand = function (id, handler) {
    var def = defs[id];
    if (!def) throw new Error('[v2] unknown command: ' + id);
    if (typeof handler !== 'function') throw new Error('[v2] command "' + id + '" handler is not a function');
    window.__webmcpRegister({
      adapterId: def.adapterId,
      routeDomain: def.routeDomain,
      tabDomain: def.tabDomain,
      excludeTabDomain: def.excludeTabDomain,
      tools: [{
        name: def.name,
        publicName: def.name,
        handlerName: def.name,
        description: def.description,
        parameters: def.parameters,
        handler: function (args) {
          if (def.requires_confirmation && args?.__confirmed !== true) {
            var error = new Error('Explicit confirmation is required for this write command.');
            error.code = 'CONFIRMATION_REQUIRED';
            throw error;
          }
          // Per-invocation compatibility grant for legacy confirmation guards.
          // Never mutate caller arguments or grant it to read/conditional commands.
          if (def.safety === 'write' && def.requires_confirmation === false) {
            return handler.call(this, Object.assign({}, args, { __confirmed: true }));
          }
          return handler.apply(this, arguments);
        },
      }],
    });
    window.__webcliRegisteredCommands.push(id);
  };
}

/** bootstrap 代码：预埋定义 + 定义 __webcliRegisterCommand（幂等） */
export function buildV2Bootstrap(manifest) {
  const header = `/* v2 adapter bootstrap (${manifest.name}) */`;
  return `${header}
(${installV2Commands.toString()})(${JSON.stringify(v2CommandDefs(manifest))});
`;
}

/**
 * 依序返回需要注入的包内相对路径。
 * @param {object} manifest v2 manifest
 * @param {string[]} allFiles adapter 目录下全部相对路径（来自 bridge 列举）
 * @returns {{ internal: string[], commands: string[] }}
 */
export function v2InjectionFiles(manifest, allFiles) {
  const internal = allFiles
    .filter((rel) => /^extension\/internal\/[^/]+\.js$/.test(rel))
    .sort((a, b) => a.localeCompare(b));
  const commands = (manifest.commands || [])
    .filter((command) => command.runtime === "extension")
    .map((command) => command.module);
  return { internal, commands };
}
