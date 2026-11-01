import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "fs";
import { join, resolve, sep } from "path";
import { assertManagedFile } from './adapter-package-files.js';

const TOOLKIT_FILES = [
  "manifest.json",
  "SKILL.md",
  "scripts/toolkit.py",
  "scripts/toolkit_runtime.py",
  "scripts/requirements.txt",
];
const EXECUTABLE_FILES = ["scripts/toolkit.py", "scripts/toolkit_runtime.py"];

export function resolveToolkitAdaptersDir({ cwd = process.cwd(), env = process.env } = {}) {
  return resolve(env.WEWORKER_ADAPTERS_DIR || join(cwd, ".claude", "skills"));
}

function fail(adapterId, message, code = 'INVALID_TOOLKIT_PACKAGE') {
  throw Object.assign(new Error(`Toolkit Adapter "${adapterId}": ${message}`), { code });
}

function assertRegularFile(adapterId, adapterRoot, relativePath) {
  let filePath;
  try { filePath = assertManagedFile(adapterRoot, relativePath); }
  catch (error) {
    if (['UNSAFE_ADAPTER_FILE', 'UNSAFE_ADAPTER_DIRECTORY'].includes(error.code)) {
      fail(adapterId, `required file "${relativePath}" must be a regular file with no linked parent directory.`, 'UNSAFE_TOOLKIT_FILE');
    }
    throw error;
  }
  if (!filePath.startsWith(`${resolve(adapterRoot)}${sep}`)) {
    fail(adapterId, `invalid file path "${relativePath}".`);
  }
  if (!existsSync(filePath)) fail(adapterId, `missing required file "${relativePath}".`, 'TOOLKIT_FILE_MISSING');
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(adapterId, `required file "${relativePath}" must be a regular file.`, 'UNSAFE_TOOLKIT_FILE');
  }
  return filePath;
}

export function toolkitArtifactHash(adapterRoot) {
  const digest = createHash("sha256");
  for (const name of EXECUTABLE_FILES) {
    digest.update(name, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(readFileSync(join(adapterRoot, name)));
  }
  return `sha256:${digest.digest("hex")}`;
}

function validateToolkitManifest(manifest, adapterRoot, directoryName) {
  const adapterId = String(manifest?.id || directoryName);
  if (manifest?.schema_version !== 1) fail(adapterId, "unsupported schema_version.");
  if (manifest?.adapter_type !== "toolkit") fail(adapterId, "adapter_type must be toolkit.");
  if (adapterId !== directoryName || !/^[a-z0-9][a-z0-9.-]*$/.test(adapterId)) {
    fail(adapterId, "id must match its direct child directory name.");
  }
  if (manifest.entry !== "scripts/toolkit.py") {
    fail(adapterId, "entry must be scripts/toolkit.py.");
  }
  for (const name of TOOLKIT_FILES) assertRegularFile(adapterId, adapterRoot, name);
  if (manifest.artifact_hash !== toolkitArtifactHash(adapterRoot)) {
    fail(adapterId, "artifact_hash does not match executable files.", 'TOOLKIT_DIGEST_MISMATCH');
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    fail(adapterId, "tools must be a non-empty array.");
  }

  const names = new Set();
  const tools = manifest.tools.map((tool) => {
    const id = String(tool?.id || "");
    const name = String(tool?.name || "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || name !== `${adapterId}.${id}`) {
      fail(adapterId, `invalid tool registration "${name || id}".`);
    }
    if (names.has(name)) fail(adapterId, `duplicate tool registration "${name}".`);
    names.add(name);
    return {
      ...tool,
      id,
      name,
      adapterId,
      parameters: tool.parameters_schema || { type: "object", properties: {} },
    };
  });

  return {
    id: adapterId,
    root: adapterRoot,
    entryPath: join(adapterRoot, manifest.entry),
    manifest: { ...manifest, tools },
    tools,
  };
}

/** Same registration/hash checks as the runner, without executing Python. */
export function inspectToolkitDirectory(adapterRoot, directoryName) {
  const file = assertManagedFile(adapterRoot, 'manifest.json');
  if (!lstatSync(file).isFile() || lstatSync(file).size > 2 * 1024 * 1024) fail(directoryName, 'invalid manifest file.');
  return validateToolkitManifest(JSON.parse(readFileSync(file, 'utf8')), adapterRoot, directoryName);
}

export function loadToolkitAdapters(options = {}) {
  const adaptersDir = resolveToolkitAdaptersDir(options);
  if (!existsSync(adaptersDir)) return [];
  const rootStat = lstatSync(adaptersDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Toolkit Adapter root must be a regular directory.");
  }

  const adapters = [];
  for (const entry of readdirSync(adaptersDir, { withFileTypes: true })) {
    if (options.excludedNames?.has(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const adapterRoot = join(adaptersDir, entry.name);
    const manifestPath = join(adapterRoot, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifestStat = lstatSync(manifestPath);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      fail(entry.name, "manifest.json must be a regular file.");
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      if (options.ignoreInvalid) continue;
      fail(entry.name, "manifest.json is not valid JSON.");
    }
    if (manifest?.adapter_type !== "toolkit") continue;
    try {
      adapters.push(validateToolkitManifest(manifest, adapterRoot, entry.name));
    } catch (error) {
      if (!options.ignoreInvalid) throw error;
    }
  }
  return adapters.sort((left, right) => left.id.localeCompare(right.id));
}

export function findToolkitAdapter(adapterId, options = {}) {
  return loadToolkitAdapters(options).find((adapter) => adapter.id === adapterId) || null;
}

export function resolveToolkitTool(toolName, options = {}) {
  let match = null;
  for (const adapter of loadToolkitAdapters(options)) {
    for (const tool of adapter.tools) {
      if (tool.name !== toolName) continue;
      if (match) throw new Error(`Duplicate Toolkit tool registration: "${toolName}".`);
      match = { adapter, tool };
    }
  }
  return match;
}
