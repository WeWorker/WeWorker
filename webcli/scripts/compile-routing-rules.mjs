#!/usr/bin/env node
/**
 * Compile WeWorker's router-config pattern layer into webcli's bundled
 * routing-rules.json (local deterministic routing for `webcli route`).
 *
 * Usage:
 *   node scripts/compile-routing-rules.mjs \
 *     [--config <dir with weworker/router-config>]   default: ../weworker/router-config
 *     [--adapters <dir with adapters/<id>/manifest.json>]   default: ../adapters
 *     [--out <file>]   default: ./routing-rules.json
 *
 * Pipeline (aligned with weworker/backend-ts/src/router-config/validate.ts):
 *   patterns.json (JSONC) → parse → per-tool entries → drop non-read commands
 *   (requires the adapters dir; without manifests every entry is dropped, so
 *   passing --adapters is effectively mandatory) → regex compilability check →
 *   drop the whole entry on any invalid regex → emit compact rules.
 *
 * Output format is self-contained: webcli/local-route.js needs nothing but
 * this file at runtime.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { config: join(__dirname, '../../weworker/router-config'), adapters: join(__dirname, '../../adapters'), out: join(__dirname, '../routing-rules.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') options.config = argv[++i];
    else if (argv[i] === '--adapters') options.adapters = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else { console.error(`Unknown option: ${argv[i]}`); process.exit(2); }
  }
  return options;
}

/** Strip line and block comments plus trailing commas (JSONC), as WeWorker's jsonc parser does. */
function parseJsonc(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

function compileRegex(source, flags) {
  if (typeof source !== 'string' || !source) return null;
  try { return new RegExp(source, flags || 'i'); } catch { return null; }
}

/** Only read-only commands may enter the local routing surface (WeWorker red line). */
function commandIsReadOnly(manifest, commandId) {
  const command = (manifest.commands || []).find(item => item.id === commandId);
  if (!command) return false;
  if (command.safety && command.safety !== 'read') return false;
  const confirmed = command.confirm ?? command.confirmation;
  return !confirmed;
}

function normalizeEntry(tool, config, errors) {
  if (typeof tool !== 'string' || !tool.includes('.')) {
    errors.push(`entry key "${tool}" is not a full tool name`);
    return null;
  }
  const patterns = [];
  for (const pattern of config.patterns || []) {
    if (pattern.type === 'keyword' || Array.isArray(pattern.keywords)) {
      if (!Array.isArray(pattern.keywords) || !pattern.keywords.length) { errors.push(`${tool}: empty keyword pattern`); return null; }
      patterns.push({ type: 'keyword', keywords: pattern.keywords, match_mode: pattern.match_mode || 'any', weight: pattern.weight ?? 1 });
      continue;
    }
    if (!compileRegex(pattern.expression, pattern.flags)) { errors.push(`${tool}: uncompilable regex ${JSON.stringify(pattern.expression)}`); return null; }
    patterns.push({ type: 'regex', expression: pattern.expression, flags: pattern.flags || 'i', weight: pattern.weight ?? 1 });
  }
  if (!patterns.length) { errors.push(`${tool}: no usable patterns`); return null; }
  for (const source of config.negative_patterns || []) {
    if (!compileRegex(source, 'i')) { errors.push(`${tool}: uncompilable negative pattern`); return null; }
  }
  const argExtractors = [];
  for (const extractor of config.arg_extractors || []) {
    if (!compileRegex(extractor.regex, extractor.flags)) { errors.push(`${tool}: uncompilable arg extractor for "${extractor.arg}"`); return null; }
    if (typeof extractor.arg !== 'string' || !extractor.arg) { errors.push(`${tool}: arg extractor without arg name`); return null; }
    argExtractors.push({ regex: extractor.regex, flags: extractor.flags || 'i', arg: extractor.arg, type: extractor.type || 'string',
      ...(Number.isFinite(extractor.min) ? { min: extractor.min } : {}), ...(Number.isFinite(extractor.max) ? { max: extractor.max } : {}),
      ...(Number.isFinite(extractor.max_length) ? { max_length: extractor.max_length } : {}) });
  }
  return { tool, priority: config.priority ?? 0, patterns, negative_patterns: config.negative_patterns || [], arg_extractors: argExtractors, default_args: config.default_args || {} };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = resolve(options.config, 'patterns.json');
  if (!existsSync(configPath)) { console.error(`patterns.json not found: ${configPath}`); process.exit(1); }
  const patterns = parseJsonc(readFileSync(configPath, 'utf8'));
  const configs = patterns.configs || {};
  const minConfidence = patterns.global?.min_confidence_for_match ?? 0.8;

  const errors = [];
  const entries = [];
  let droppedNoManifest = 0, droppedNotRead = 0;
  // configs is two-level keyed: configs.<adapterId>.<full tool name>.
  for (const [adapterId, tools] of Object.entries(configs)) {
    if (!tools || typeof tools !== 'object') continue;
    for (const [tool, config] of Object.entries(tools)) {
      if (!tool.startsWith(adapterId + '.')) { errors.push(`${tool}: tool name does not belong to its section ${adapterId}`); continue; }
      const commandId = tool.slice(adapterId.length + 1);
      const manifestPath = resolve(options.adapters, adapterId, 'manifest.json');
      if (!existsSync(manifestPath)) { droppedNoManifest++; continue; }
      let manifest;
      try { manifest = parseJsonc(readFileSync(manifestPath, 'utf8')); } catch (error) { errors.push(`${tool}: manifest parse failed (${error.message})`); continue; }
      if (!commandIsReadOnly(manifest, commandId)) { droppedNotRead++; continue; }
      const entry = normalizeEntry(tool, config || {}, errors);
      if (entry) entries.push(entry);
    }
  }

  if (errors.length) {
    console.error(`routing-rules compile failed (${errors.length} error(s)):`);
    for (const error of errors) console.error('  - ' + error);
    process.exit(1);
  }
  if (!entries.length) { console.error('routing-rules compile produced no entries; refusing to write an empty rules file.'); process.exit(1); }

  const rules = { version: 1, min_confidence: minConfidence, generated_from: 'weworker/router-config/patterns.json', entries };
  writeFileSync(resolve(options.out), JSON.stringify(rules, null, 2) + '\n');
  console.log(`routing-rules: ${entries.length} entries (${droppedNoManifest} without installed manifest, ${droppedNotRead} non-read dropped) → ${resolve(options.out)}`);
}

main();
