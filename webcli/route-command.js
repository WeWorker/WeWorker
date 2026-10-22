import { buildRouteCatalog } from './auto-route-catalog.js';
import { routeRequest } from './auto-route-decision-tree.js';
import { renderCommandHelp } from './progressive-help.js';

export const ROUTE_HELP = `Usage: webcli route [options] [<adapter-id>] <request...>

Recommend an available Adapter command for a natural-language request.
The recommendation does not execute the command or fill its arguments.

Arguments:
  <adapter-id>  Optional exact Adapter ID; skip site selection
  <request...>  Natural-language request

Options:
  --json        Output the routing result as JSON
  -v, --verbose Print stage timings to stderr
  -h, --help    Show this help
  --            Treat the remaining words as request text

Environment:
  WEBCLI_D3_URL  Decision service base URL (no default)

Examples:
  webcli route "Search for browser automation projects"
  webcli route github.com "List repository issues" --json

Site and command confidence must reach 0.85; otherwise up to three candidates
are returned for review. Single candidates need no service request.`;

export async function runRouteCommand(args, { verbose = false, outputFormat, catalogOptions } = {}) {
  const optionArgs = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  if (optionArgs.some(a => ['--help', '-h'].includes(a)) || (args.length === 1 && args[0] === 'help')) {
    console.log(ROUTE_HELP); return;
  }
  const words = [];
  let json = outputFormat === 'json', literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (literal) words.push(arg);
    else if (arg === '--') literal = true;
    else if (arg === '--json') json = true;
    else if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '--output-format=json') json = true;
    else if (arg === '--output-format' && args[i + 1] === 'json') {
      json = true; i++;
    }
    else if (arg.startsWith('-')) {
      console.error('Unknown route option: ' + arg); process.exitCode = 2; return;
    } else words.push(arg);
  }
  if (!words.length || (outputFormat && outputFormat !== 'json')) {
    console.error(ROUTE_HELP); process.exitCode = 2; return;
  }
  try {
    const adapters = buildRouteCatalog(catalogOptions);
    const knownSite = adapters.find(a => a.id === words[0])?.id;
    if (knownSite) words.shift();
    if (!words.length) { console.error(ROUTE_HELP); process.exitCode = 2; return; }
    const result = await routeRequest(words.join(' '), { adapters, knownSite,
      onTrace: verbose ? trace => console.error(`${trace.stage}: ${trace.durationMs}ms`) : undefined });
    if (json) console.log(JSON.stringify(result));
    else if (result.kind === 'routed') {
      const adapter = adapters.find(a => a.id === result.site.adapterId);
      const command = adapter.commands.find(c => c.id === result.command.name);
      console.log(`Recommended: ${result.callCommand}\n\n${renderCommandHelp(adapter, command)}`);
    } else {
      console.log(`Low confidence (${result.stoppedAt.tier}); review candidates:\n` +
        result.stoppedAt.alternatives.map(a => `  ${a.option} (${a.p.toFixed(2)})`).join('\n'));
    }
  } catch (error) {
    // Fetch errors may include deployment URLs in their causes; never serialize them.
    console.error(error instanceof TypeError || error.name === 'AbortError'
      ? 'Decision service request failed or timed out.' : error.message);
    process.exitCode = 1;
  }
}
