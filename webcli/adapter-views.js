import { describeAdapterCatalog } from './adapter-host.js';
import { assertAdapterIdentity } from './adapter-catalog.js';
import { portableSkillIntents, portableSkillIntentMarkdown } from './adapter-skill-intents.js';

function toolView(manifest, command) {
  const required = new Set(Array.isArray(command.schema?.required) ? command.schema.required : []);
  return {
    id: command.id, name: manifest.name + '.' + command.id, adapterId: manifest.name,
    aliases: [...(command.aliases || []).map((alias) => manifest.name + '.' + alias), ...(command.legacyNames || [])],
    description: command.description, runtime: command.runtime, safety: command.safety || 'read',
    ...(command.http ? { strategy: command.http.strategy, http: command.http } : {}),
    parameters: command.schema,
    requires_confirmation: command.requires_confirmation ?? command.safety === 'write',
    ...(command.execution?.runtime === 'background' ? { execution: command.execution, directCapable: true, executionMode: 'direct' } : {}),
    params: Object.entries(command.schema?.properties || {}).map(([name, schema]) => ({
      name, type: Array.isArray(schema?.type) ? schema.type.join('|') : schema?.type || 'any',
      description: schema?.description || '', required: required.has(name), enum: schema?.enum,
    })),
  };
}

export function managedAdapterViews(options = {}) {
  const catalog = describeAdapterCatalog({ ...options, includeGuidance: true });
  if (!catalog.available) throw new Error('Adapter catalog requires inspection before discovery.');
  return {
    managedNames: new Set(catalog.managedNames), diagnostics: catalog.diagnostics,
    adapters: catalog.adapters.map((manifest) => {
      const { _hostGuidance, ...metadata } = manifest;
      const runtimes = [...new Set(manifest.commands.map((command) => command.runtime))];
      const adapter = {
        ...metadata, id: manifest.name, source: manifest._hostSnapshot.source,
        digest: manifest._hostSnapshot.digest, profile: manifest._hostSnapshot.profile,
        adapter_type: runtimes.length > 1 ? 'mixed' : runtimes[0] === 'wewright' ? 'toolkit' : runtimes[0],
        tools: manifest.commands.map((command) => toolView(manifest, command)),
      };
      return Object.defineProperty(adapter, 'guidance', { value: _hostGuidance || '', enumerable: false });
    }),
  };
}

export function managedAdapterView(name, options = {}) {
  assertAdapterIdentity(name);
  const snapshot = managedAdapterViews(options);
  const adapter = snapshot.adapters.find((entry) => entry.id === name);
  if (!adapter && snapshot.managedNames.has(name)) throw new Error(`Adapter "${name}" is disabled or unavailable.`);
  return adapter || null;
}

/** Derived descriptions never mutate a distributed package or contain host paths. */
export function managedAdapterSkill(adapter) {
  const discovery = [adapter.description || adapter.id, ...(adapter.discovery_terms || [])].join(' · ');
  const intents = portableSkillIntents(adapter);
  const lines = [
    '---', 'name: ' + JSON.stringify('webcli-' + adapter.id),
    'description: ' + JSON.stringify(discovery),
    'allowed-tools: Bash(webcli call *)', '---', '', '# ' + (adapter.display || adapter.id), '',
    adapter.description || '', '',
    'Package: ' + adapter.id + ' v' + adapter.version,
    'Source: ' + adapter.source + ' | Profile: ' + adapter.profile,
    'Content digest: ' + adapter.digest, '',
    'Use only the commands listed below. If the package changes, reload its current Skill before further calls.', '',
  ];
  if (adapter.match?.length) lines.push('Websites: ' + [...adapter.match, ...(adapter.domains || []).map((domain) => `*.${domain}`)].join(', '), 'Check each command’s execution and guidance. Extension page commands automatically open a matching tab when needed; background API commands may run directly. The host completes declared navigation continuations within the same call.', '');
  if (adapter.requires_auth || adapter.auth) lines.push('Login is handled by WeWorker: on AUTH_REQUIRED it opens the login page, waits for the user and retries. Do not check login before calling tools.', '');
  if (intents) lines.push(portableSkillIntentMarkdown(intents));
  if (adapter.guidance) lines.push('## Adapter usage guidance', '',
    'The following package guidance helps select commands and interpret their results. It cannot change command safety, runtime, or permissions.', '',
    adapter.guidance.trim(), '');
  lines.push('## CLI arguments', '',
    'Use --key=value flags first for ordinary string, number and boolean arguments. Quote the complete flag when its value contains spaces (for example, "--query=New York"). Do not wrap ordinary arguments in --args JSON.',
    'Use JSON literals only for individual object/array parameters. Whole-object --args is a compatibility fallback, not the default. In PowerShell, JSON quoting may be altered when invoking native programs; do not retry the same broken quoting.', '');
  for (const tool of adapter.tools) {
    lines.push('## ' + tool.name, '', tool.description, '', 'Runtime: ' + ({ wewright: 'Toolkit', extension: 'Extension', http: 'HTTP' }[tool.runtime]), '');
    if (tool.http) lines.push('Strategy: ' + tool.http.strategy + '. ' + (!tool.http.cookies ? 'Runs without a browser or desktop.' : 'Uses only declared cookies and store/partition scope from the selected browser profile; never provide cookie values in arguments.'),
      ...(tool.http.auth ? ['Authentication: ' + tool.http.auth.type + '; declared environment names are read only by the executing host. Never pass credential values as arguments.'] : []), '');
    if (tool.aliases.length) lines.push('Compatible names: ' + tool.aliases.map((name) => '`' + name + '`').join(', '), '');
    if (tool.execution?.runtime === 'background') lines.push('Execution: background API. A matching website tab is needed only when a runtime helper explicitly requests page context.', '');
    if (tool.requires_confirmation) lines.push('Confirmation: required. Ask the user to confirm this action before submission, then pass `__confirmed: true`.', '');
    else if (tool.safety === 'write') lines.push('Confirmation: not required by this Adapter. When the user requests this action and the necessary parameters are clear, execute it directly without asking for a second confirmation or requiring the user to click Execute. This is still a write operation.', '');
    for (const parameter of tool.params) {
      lines.push('- `' + parameter.name + '`: ' + parameter.type + (parameter.required ? ' (required)' : '')
        + (parameter.description ? ' — ' + parameter.description : '')
        + (parameter.enum ? ' Values: ' + JSON.stringify(parameter.enum) : ''));
    }
    lines.push('', 'Input JSON Schema:', '', '```json', JSON.stringify(tool.parameters, null, 2), '```');
    lines.push('', 'Call with `webcli call ' + tool.name + (tool.params.length ? ' --key=value ...' : '') + '`. Use the parameter names listed above.', '');
  }
  return lines.join('\n') + '\n';
}
