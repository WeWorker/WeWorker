import { browserHelp } from './browser-commands.js';
import { explorationHelp } from './exploration-commands.js';
import { profileHelp } from './browser-profiles.js';

const top = ['help', 'list', 'call', 'route', 'adapter', 'adapterhub', 'service', 'trace', 'install', 'extension-path', 'stats', 'mcp', 'mcp-logs', 'completion', 'skills', 'browser', 'exploration', 'profile'];
const portable = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
const ordered = values => [...new Set(values.filter(portable))].sort();

/** Discovery only: never import adapter modules, connect to a Bridge or run tools. */
export async function completionCandidates(words, cursor, { loadViews = async () => (await import('./adapter-cli.js')).loadAdapterViews({ namesOnly: true }) } = {}) {
  if (!Array.isArray(words) || words.length > 100 || words.some(word => typeof word !== 'string' || word.length > 10000)
    || !Number.isInteger(cursor) || cursor < 1 || cursor > words.length + 1) throw new Error('Completion expects argv words and a valid 1-based cursor.');
  const prefix = words[cursor - 1] || '';
  if (cursor > 2) return [];
  if (cursor === 2 && top.includes(words[0]) && !['call', 'browser', 'exploration', 'profile'].includes(words[0])) return [];
  const management = ['profile.help', ...[browserHelp(), explorationHelp(), profileHelp()].flatMap(help => help.commands.map(command => command.name))];
  let adapters = [];
  // Catalog errors do not invent fallback adapter commands. Built-in completion
  // remains available, and normal adapter help reports the actual diagnostics.
  try { adapters = await loadViews(); } catch { /* no adapter candidates */ }
  let values;
  if (cursor === 1) values = [...top, ...adapters.map(adapter => adapter.id)];
  else if (words[0] === 'call') values = [...management, ...adapters.flatMap(adapter => (adapter.tools || []).flatMap(tool => [tool.name, ...(tool.aliases || [])]))];
  else if (['browser', 'exploration', 'profile'].includes(words[0])) values = management.filter(name => name.startsWith(words[0] + '.')).map(name => name.slice(words[0].length + 1));
  else values = adapters.filter(adapter => adapter.id === words[0]).flatMap(adapter => (adapter.tools || []).flatMap(tool => [tool.name, ...(tool.aliases || [])])
    .filter(name => name.startsWith(adapter.id + '.')).map(name => name.slice(adapter.id.length + 1)));
  return ordered(values).filter(value => value.startsWith(prefix));
}

export function completionScript(shell) {
  if (shell === 'bash') return `# WebCLI completion; source this output in Bash.
_webcli_complete() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] && COMPREPLY+=("$candidate")
  done < <(webcli --get-completions --cursor "$COMP_CWORD" "\${COMP_WORDS[@]:1}" 2>/dev/null)
}
complete -F _webcli_complete webcli
`;
  if (shell === 'zsh') return `# WebCLI completion; run compinit before sourcing this output.
_webcli_complete() {
  local -a candidates
  candidates=("\${(@f)$(webcli --get-completions --cursor "$((CURRENT - 1))" "\${words[@]:1}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _webcli_complete webcli
`;
  if (shell === 'fish') return `# WebCLI completion; pipe this output to source in Fish.
function __webcli_candidates
  set -l words (commandline -opc)
  set -l current (commandline -ct)
  webcli --get-completions --cursor (count $words) $words[2..] "$current" 2>/dev/null
end
complete -c webcli -f -a '(__webcli_candidates)'
`;
  throw new Error('Unsupported shell; choose bash, zsh or fish.');
}

export async function runCompletion(args) {
  if (args[0] === 'completion') {
    if (args.length !== 2) throw new Error('Usage: webcli completion bash|zsh|fish');
    return completionScript(args[1]);
  }
  if (args[0] !== '--get-completions' || args[1] !== '--cursor' || !/^[1-9]\d*$/.test(args[2] || '')) throw new Error('Invalid completion cursor.');
  const values = await completionCandidates(args.slice(3), Number(args[2]));
  return values.length ? values.join('\n') + '\n' : '';
}
