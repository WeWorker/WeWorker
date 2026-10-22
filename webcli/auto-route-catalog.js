import { managedAdapterViews } from './adapter-views.js';
import { toAdapterHelpModel } from './progressive-help.js';

/** Use exactly the selected host-managed catalog; aliases are not new commands. */
export function buildRouteCatalog(options = {}) {
  return managedAdapterViews(options).adapters.map(adapter => toAdapterHelpModel(adapter))
    .filter(adapter => adapter.commands.length)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildSiteGroups(sites) {
  const sorted = [...new Set(sites)].sort();
  const groups = Array.from({ length: Math.ceil(sorted.length / 9) }, () => []);
  sorted.forEach((site, i) => groups[i % groups.length].push(site));
  return groups;
}
