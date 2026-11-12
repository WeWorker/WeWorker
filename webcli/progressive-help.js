import { businessSchema } from './business-args.js';
/** Shared Adapter help rendered from the effective catalog. */
import { formatCallOutput } from './output-format.js';
import { cliName } from './cli-name.js';

function schemaToParams(schema) {
  schema = businessSchema(schema);
  const properties = schema?.properties || {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: Array.isArray(property?.enum) ? "enum" : property?.type || "string",
    description: property?.description || "",
    required: required.has(name),
    enum: Array.isArray(property?.enum) ? property.enum.map(String) : [],
    default: property?.default,
  }));
}

function sortParams(params) {
  return [...params].sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
}

/** 统一 adapter 模型：{ id, display, version, description, runtimes, source, commands: [{id, name, description, params, runtime}] } */
export function toAdapterHelpModel(adapter, source = "v1-extension") {
  if (adapter.schema_version === 2 || (adapter.commands && adapter.manifest)) {
    const m = adapter.manifest || adapter;
    return {
      id: adapter.name,
      display: adapter.name,
      version: m.version,
      description: m.description || "",
      match: m.match || [],
      runtimes: [...new Set(adapter.commands.map((c) => c.runtime))],
      source: adapter.source || source,
      commands: adapter.commands.map((c) => ({
        id: c.id,
        name: `${adapter.name}.${c.id}`,
        aliases: [...(c.aliases || []).map((alias) => adapter.name + '.' + alias), ...(c.legacyNames || [])],
        description: c.description || "",
        safety: c.safety || "read",
        runtime: c.runtime,
        execution: c.execution,
        params: schemaToParams(c.schema),
      })),
    };
  }
  // v1 toolkit adapter（loadToolkitAdapters 产物，带 entryPath）
  if (adapter.entryPath || adapter.adapter_type === 'toolkit') {
    const m = adapter.manifest || adapter;
    return {
      id: adapter.id,
      display: m.name || adapter.id,
      version: m.version,
      description: m.description || "",
      match: m.allowed_domains || [],
      runtimes: ["toolkit"],
      source,
      commands: (adapter.tools || m.tools || []).map((t) => ({
        id: t.id,
        name: t.name,
        aliases: t.aliases || [],
        description: t.description || "",
        safety: t.safety || "read",
        runtime: "toolkit",
        params: t.params?.length ? t.params.filter(param => param.name !== '__confirmed') : schemaToParams(t.parameters),
      })),
    };
  }
  // v1 extension adapter（loadExtensionAdapters 产物）
  if (Array.isArray(adapter.tools)) {
    return {
      id: adapter.id,
      display: adapter.name || adapter.id,
      version: adapter.version,
      description: adapter.description || "",
      match: adapter.match || [],
      runtimes: ["extension"],
      source: adapter.source || source,
      commands: adapter.tools.map((t) => ({
        id: String(t.name || "").startsWith(`${adapter.id}.`) ? t.name.slice(adapter.id.length + 1) : t.name,
        name: t.name,
        aliases: t.aliases || [],
        description: t.description || "",
        safety: t.safety || "read",
        runtime: "extension",
        params: t.params?.length ? t.params.filter(param => param.name !== '__confirmed') : schemaToParams(t.parameters),
      })),
    };
  }
  // v1 toolkit adapter（loadToolkitAdapters 产物）
  const m = adapter.manifest || adapter;
  return {
    id: adapter.id,
    display: m.name || adapter.id,
    version: m.version,
    description: m.description || "",
    match: m.allowed_domains || [],
    runtimes: ["toolkit"],
    source,
    commands: (adapter.tools || m.tools || []).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || "",
      safety: t.safety || "read",
      runtime: "toolkit",
      params: t.params?.length ? t.params.filter(param => param.name !== '__confirmed') : schemaToParams(t.parameters),
    })),
  };
}

const RUNTIME_LABEL = { extension: "extension", wewright: "Toolkit", toolkit: "toolkit" };

/** 第一级：全局 adapter 摘要 */
export function renderGlobalHelp(models) {
  if (!models.length) return "No adapters installed.";
  const lines = ["Adapters:"];
  for (const m of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    const tag = m.source === "user" ? " [user]" : "";
    const runtimes = m.runtimes.map((r) => RUNTIME_LABEL[r] || r).join("+");
    const summary = m.description ? ` — ${m.description}` : "";
    lines.push(`  ${m.id}${tag} (${runtimes}, ${m.commands.length} cmd)${summary}`);
  }
  lines.push("", 'Usage: ${cliName()} <adapter> help — 命令列表; ${cliName()} <adapter> <command> help — 参数说明');
  return lines.join("\n");
}

/** Site help lists commands; parameter details belong to command help. */
function summary(text) {
  return String(text || '').split(/\r?\n|[。；]|\.\s/)[0].trim().slice(0, 100);
}

export function renderAdapterHelp(model) {
  const lines = [`Usage: ${cliName()} ${model.id} <command> [options]`, '', summary(model.description) || model.display || model.id, '', 'Commands:'];
  const width = Math.max(0, ...model.commands.map(c => c.id.length));
  for (const c of model.commands) lines.push(`  ${c.id.padEnd(width)}  ${summary(c.description)}`.trimEnd());
  lines.push('', 'Options:', '  -h, --help  Show help', '', `Run "${cliName()} ${model.id} <command> --help" for command options.`);
  return lines.join('\n');
}

/** All business inputs are named options, including required inputs. */
export function renderCommandHelp(adapterModel, command) {
  const lines = [`Usage: ${cliName()} ${adapterModel.id} ${command.id} [options]`, '', command.description || command.name, '', 'Options:'];
  const params = sortParams(command.params || []);
  const labels = params.map(p => `--${p.name}=<${p.type}>`);
  const width = Math.max(10, ...labels.map(label => label.length));
  params.forEach((p, i) => {
    const details = [p.description, p.required ? '(required)' : '', p.enum?.length ? `enum=${p.enum.join('|')}` : '', p.default !== undefined ? `[default=${JSON.stringify(p.default)}]` : ''].filter(Boolean).join(' ');
    lines.push(`  ${labels[i].padEnd(width)}  ${details}`.trimEnd());
  });
  lines.push(`  ${'-h, --help'.padEnd(width)}  Show help`);
  if (command.safety && command.safety !== 'read') lines.push('', `Safety: ${command.safety}`);
  lines.push(`Runtime: ${RUNTIME_LABEL[command.runtime] || command.runtime}`);
  if (command.execution?.runtime === 'background') lines.push('Execution: background API');
  lines.push('', 'Examples:', `  ${cliName()} call ${command.name}${params.filter(p => p.required).map(p => ` --${p.name}=<${p.type}>`).join('')}`);
  return lines.join('\n');
}

/** 模糊候选（不得自动执行，仅提示） */
export function suggestAdapters(models, keyword) {
  const lower = String(keyword || "").toLowerCase();
  return models
    .filter((m) => m.id.toLowerCase().includes(lower) || (m.match || []).some((d) => String(d).toLowerCase().includes(lower)))
    .map((m) => m.id);
}

export async function runAdapterHelp(args, { outputFormat } = {}) {
  const { loadAdapterViews } = await import('./adapter-cli.js');
  const models = (await loadAdapterViews()).map((adapter) => toAdapterHelpModel(adapter));
  if (args.length === 1) return outputFormat !== undefined ? formatCallOutput(models, outputFormat) : renderGlobalHelp(models) + '\n\nBrowser: ${cliName()} call browser.help\nAPI exploration: ${cliName()} call exploration.help (standalone; current agent authors the Adapter).';
  const adapter = models.find((model) => model.id === args[0])
    || models.find((model) => model.commands.some((command) => command.aliases?.includes(args[0])));
  if (!adapter) throw new Error('Adapter unavailable: ' + args[0]);
  if (args.length === 2) return outputFormat !== undefined ? formatCallOutput({ ...adapter, commands: adapter.commands.map(({ params, ...command }) => command) }, outputFormat) : renderAdapterHelp(adapter);
  const command = adapter.commands.find((entry) => entry.id === args[1] || entry.name === args[1]
    || entry.aliases?.includes(args[1]) || entry.aliases?.includes(adapter.id + '.' + args[1]));
  if (!command) throw new Error('Adapter command unavailable: ' + args[1]);
  return outputFormat !== undefined ? formatCallOutput(command, outputFormat) : renderCommandHelp(adapter, command);
}
