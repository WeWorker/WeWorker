/**

 * Skill Installer — installs webcli skills to a target directory.

 *

 * Usage:

 *   webcli install --skills                     Install all skills to ~/.claude/skills/

 *   webcli install --skills jd.com              Install base + specific adapter

 *   webcli install --skills --target <dir>      Install to custom directory

 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { copyFile, readFile, writeFile } from "fs/promises";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { generateSkillContent, toolExampleLines } from "./skill-writer.js";
import { loadAdapterTools } from "./adapter-cli.js";
import { resolveAdaptersDir, resolveUserAdaptersDir, resolveAdapterPaths } from "./paths.js";
import { managedAdapterViews } from './adapter-views.js';
import { installManagedRuntimeSkills, isReservedBundledSkillName } from './managed-skill-installer.js';



const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTENSION_ADAPTERS_DIR = resolveAdaptersDir();

const BUNDLED_SKILLS_DIR = resolve(__dirname, "skills");

function readAdapterScenarios(adapterId) {
  const manifestPath = join(EXTENSION_ADAPTERS_DIR, adapterId, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (Array.isArray(manifest?.scenarios)) return manifest.scenarios;
    } catch {
      // fall through to legacy registry.json
    }
  }

  const registryPath = join(EXTENSION_ADAPTERS_DIR, "registry.json");
  if (!existsSync(registryPath)) return [];
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    const entry = (registry.adapters || []).find((item) => item.id === adapterId);
    return Array.isArray(entry?.scenarios) ? entry.scenarios : [];
  } catch {
    return [];
  }
}

const ADAPTER_CONTEXT_FILES = [
  "SKILL.generated.md",
  "WEBCLI_KNOWLEDGE.md",
  "WEBCLI_KNOWLEDGE.json",
];

function isDirectTool(tool) {
  return tool?.directCapable === true
    || tool?.executionMode === "direct"
    || (tool?.execution?.type === "api" && tool?.execution?.runtime === "background");
}

function formatDirectToolAppendix(tool) {
  const lines = [
    `### ${tool.name}`,
    "",
  ];
  if (tool.description) lines.push(tool.description, "");
  lines.push("Execution: type=api, runtime=background", "", "Execution: mode=direct", "");
  if (Array.isArray(tool.params) && tool.params.length > 0) {
    lines.push("Parameters:", "");
    for (const param of tool.params) {
      const required = param.required ? " **(required)**" : "";
      const description = param.description ? ` — ${param.description}` : "";
      lines.push(`- \`${param.name}\`: ${param.type || "string"}${required}${description}`);
    }
    lines.push("");
  }
  lines.push(...toolExampleLines(tool), "");
  return lines;
}

export function mergeDirectExecutionIntoSkill(content, manifest, tools) {
  const directTools = (tools || []).filter(isDirectTool);
  if (directTools.length === 0) return content;

  const startMarker = "<!-- webcli-direct-execution:start -->";
  const endMarker = "<!-- webcli-direct-execution:end -->";
  const withoutExistingBlock = String(content || "").replace(
    new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\s*`, "g"),
    "",
  ).trimEnd();
  const missingTools = directTools.filter((tool) => !withoutExistingBlock.includes(tool.name));
  const lines = [
    startMarker,
    "## API Direct Execution",
    "",
    `This adapter exposes ${directTools.length} API tool${directTools.length === 1 ? "" : "s"} with \`type=api, runtime=background\` and \`mode=direct\`.`,
    "",
    "- Call these tools before opening the target website or running a login check.",
    "- Open the Homepage only after a direct call reports a login or page-context error.",
    `- Direct tools: ${directTools.map((tool) => `\`${tool.name}\``).join(", ")}`,
    "",
  ];
  for (const tool of missingTools) lines.push(...formatDirectToolAppendix(tool));
  lines.push(endMarker);
  return `${withoutExistingBlock}\n\n${lines.join("\n")}\n`;
}

/**

 * Parse tool definitions from adapter source code (regex-based, no eval).

 * Duplicated from adapter-cli.js to avoid circular dependency.

 */

function parseToolsFromSource(source) {

  const tools = [];

  const registerMatch = source.match(/window\.__webmcpRegister\s*\(\s*\{/);

  if (!registerMatch) return tools;



  const afterRegister = source.slice(registerMatch.index);

  const toolsArrayMatch = afterRegister.match(/tools\s*:\s*\[/);

  if (!toolsArrayMatch) return tools;



  const toolsStart = registerMatch.index + toolsArrayMatch.index + toolsArrayMatch[0].length;

  const remaining = source.slice(toolsStart);



  const toolNameRe = /\{\s*\n?\s*name\s*:\s*['"`]([^'"`]+)['"`]/g;

  let match;

  const toolPositions = [];

  while ((match = toolNameRe.exec(remaining)) !== null) {

    toolPositions.push({ index: match.index, name: match[1] });

  }



  for (let i = 0; i < toolPositions.length; i++) {

    const { index, name } = toolPositions[i];

    const end = i + 1 < toolPositions.length ? toolPositions[i + 1].index : remaining.length;

    const block = remaining.slice(index, end);



    let description = "";

    const descSingle = block.match(/description\s*:\s*\n?\s*'([^']*(?:'\s*\+\s*'[^']*)*)'/);

    const descDouble = block.match(/description\s*:\s*\n?\s*"([^"]*)"/);

    const descTmpl = block.match(/description\s*:\s*\n?\s*`([^`]*)`/);

    if (descSingle) description = descSingle[1].replace(/'\s*\+\s*'/g, "");

    else if (descDouble) description = descDouble[1];

    else if (descTmpl) description = descTmpl[1].replace(/\s+/g, " ").trim();



    const params = parseParams(block);

    tools.push({ name, description, params });

  }

  return tools;

}



function parseParams(block) {

  const params = [];

  const propsMatch = block.match(/properties\s*:\s*\{/);

  if (!propsMatch) return params;



  const start = propsMatch.index + propsMatch[0].length - 1;

  let depth = 0, end = start;

  for (let i = start; i < block.length; i++) {

    if (block[i] === "{") depth++;

    else if (block[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }

  }

  const propsBlock = block.slice(start + 1, end - 1);



  const propRe = /(\w+)\s*:\s*\{([^}]*)\}/g;

  let m;

  while ((m = propRe.exec(propsBlock)) !== null) {

    const propName = m[1];

    const propBody = m[2];

    const typeMatch = propBody.match(/type\s*:\s*['"`](\w+)['"`]/);

    const descMatch = propBody.match(/description\s*:\s*['"`]([^'"`]*)['"`]/);

    params.push({

      name: propName,

      type: typeMatch ? typeMatch[1] : "string",

      description: descMatch ? descMatch[1] : "",

      required: false,

    });

  }



  const reqMatch = block.match(/required\s*:\s*\[([^\]]*)\]/);

  if (reqMatch) {

    const reqNames = reqMatch[1].split(",").map((s) => s.trim().replace(/^['"`]|['"`]$/g, "")).filter(Boolean);

    for (const p of params) {

      if (reqNames.includes(p.name)) p.required = true;

    }

  }

  return params;

}



/**

 * Get all installed adapters with their manifest and parsed tools.

 */

async function getInstalledAdapters(snapshot) {

  const USER_ADAPTERS_DIR = resolveUserAdaptersDir();
  const roots = [EXTENSION_ADAPTERS_DIR, USER_ADAPTERS_DIR];
  if (!roots.some((dir) => existsSync(dir))) return [];



  const adapters = [];
  const seen = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => {
      return existsSync(join(root, d, "manifest.json"));
    });
    for (const d of dirs) {
      if (snapshot.managedNames.has(d)) continue;
      if (seen.has(d)) continue;
      seen.add(d);
      try {
        const manifest = JSON.parse(await readFile(join(root, d, "manifest.json"), "utf-8"));
        if (manifest.schema_version === 2) continue;
        const skillPath = join(root, d, "SKILL.md");
        const tools = await loadAdapterTools(d, { adapterDir: join(root, d) });
        const adapterDir = join(root, d);
        adapters.push({ manifest, tools, adapterDir, skillPath: existsSync(skillPath) ? skillPath : "" });
      } catch {}
    }
  }

  return adapters;

}



/**

 * Install skills to target directory.

 * @param {object} options

 * @param {string} options.target - Target directory (default: ~/.claude/skills)

 * @param {string|null} options.adapterId - Specific adapter to install (null = all)

 */

export async function installSkills({ target, adapterId }) {
  const snapshot = managedAdapterViews();
  const managed = installManagedRuntimeSkills({
    target,
    snapshot,
    profile: resolveAdapterPaths().profile,
    bundledSkillsDir: BUNDLED_SKILLS_DIR,
    adapterId,
  });

  mkdirSync(target, { recursive: true });



  // 1. Install bundled skills from webcli/skills/* (webcli, complex-task-planner, …)

  if (existsSync(BUNDLED_SKILLS_DIR)) {

    for (const entry of readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })) {

      if (!entry.isDirectory() || isReservedBundledSkillName(entry.name)) continue;

      const skillSrc = join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md");

      if (!existsSync(skillSrc)) continue;

      const skillDir = join(target, entry.name);

      mkdirSync(skillDir, { recursive: true });

      const content = await readFile(skillSrc, "utf-8");

      await writeFile(join(skillDir, existsSync(join(skillDir, "SKILL.md.disabled")) ? "SKILL.md.disabled" : "SKILL.md"), content, "utf-8");

    }

  }



  // 2. Install adapter skills + standalone custom skills

  const adapters = await getInstalledAdapters(snapshot);

  let installed = managed.installed;

  for (const { manifest, tools, adapterDir, skillPath } of adapters) {
    if (adapterId && manifest.id !== adapterId) continue;

    if (tools.length === 0 && !skillPath) continue;

    const adapterSkillDir = join(target, `webcli-${manifest.id}`);
    mkdirSync(adapterSkillDir, { recursive: true });

    const targetMarkdown = join(adapterSkillDir, existsSync(join(adapterSkillDir, "SKILL.md.disabled")) ? "SKILL.md.disabled" : "SKILL.md");
    if (skillPath) {
      const existingSkill = await readFile(skillPath, "utf-8");
      await writeFile(
        targetMarkdown,
        mergeDirectExecutionIntoSkill(existingSkill, manifest, tools),
        "utf-8",
      );
    } else if (tools.length > 0) {
      const skillContent = generateSkillContent(manifest, tools, { skillsDir: target });
      await writeFile(targetMarkdown, skillContent, "utf-8");
    }

    await copyAdapterContextFiles(adapterDir, adapterSkillDir);
    installed++;
  }



  return { installed, total: adapters.length + snapshot.adapters.length, retired: managed.retired, preserved: managed.preserved };

}

async function copyAdapterContextFiles(adapterDir, skillDir) {
  for (const filename of ADAPTER_CONTEXT_FILES) {
    const source = join(adapterDir, filename);
    if (!existsSync(source)) continue;
    await copyFile(source, join(skillDir, filename));
  }
}
